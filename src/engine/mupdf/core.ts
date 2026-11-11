/**
 * The MuPDF document logic that runs inside the worker. It holds one open document. Nothing here touches
 * messages or the DOM except ImageBitmap creation, so the worker stays a thin shell around it.
 *
 * Page coordinates: mupdf's page bounds already include the page's own /Rotate, so they are the page's
 * display space. An extra rotation is applied on top of that, the same way for rendering and text.
 */
import type * as Mu from 'mupdf';
import { readPageRuns } from './fastText';
import { cleanOutlineTitle } from '../outlineTitle';
import { EditCore, type ApplyResult, type Tick } from './editCore';
import { pageFingerprints } from './pageFingerprint';
import { drawOverlayGroup, differenceInto } from './overlayCompose';
import { clampOpacity, coveredArea, placementMatrix, validScale, type PlaceMatrix } from '../overlayPlacement';
import { graftPages } from './pageCopy';
import { SIZE_FALLBACK } from './workerJobs';
import { copyOut, decideSave, encryptionKept, extractEncryptedOptions, opensWithPassword, saveOptions } from './saveCore';
import {
  WorkerFault,
  parsePageRef,
  type MetadataResult,
  type OutlineNode,
  type PageEdit,
  type PageTextData,
  type RenderArgs,
  type SaveOutcome,
  type XfaFacts,
} from './protocol';

type MuModule = typeof Mu;
type MuPage = Mu.Page;
type Matrix6 = [number, number, number, number, number, number];

/** Canvas size cap: 16 megapixels. Larger renders are scaled down, as the pdf.js adapter does. */
export const MAX_CANVAS_PIXELS = 16_000_000;

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'] as const;

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Rounds any angle to the nearest quarter turn, in 0..270. */
export function normalizeRotation(degrees: number): 0 | 90 | 180 | 270 {
  const quarters = Math.round(degrees / 90);
  return ((((quarters % 4) + 4) % 4) * 90) as 0 | 90 | 180 | 270;
}

/**
 * The matrix that maps a page's display space onto the page shown with an extra rotation, and the size of
 * that shown page. Clockwise, as the viewer rotates. The matrix maps the top-left corner to (0, 0).
 */
export function displayTransform(bounds: Bounds, turn: 0 | 90 | 180 | 270): { matrix: Matrix6; width: number; height: number } {
  const { x0, y0, x1, y1 } = bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  switch (turn) {
    case 90:
      // (x, y) -> (h - (y - y0), x - x0)
      return { matrix: [0, 1, -1, 0, h + y0, -x0], width: h, height: w };
    case 180:
      // (x, y) -> (x1 - x, y1 - y)
      return { matrix: [-1, 0, 0, -1, x1, y1], width: w, height: h };
    case 270:
      // (x, y) -> (y - y0, x1 - x)
      return { matrix: [0, -1, 1, 0, -y0, x1], width: h, height: w };
    default:
      return { matrix: [1, 0, 0, 1, -x0, -y0], width: w, height: h };
  }
}

/** Reads the XFA markers of a PDF catalog. Missing or unreadable parts count as absent. */
export function readXfaFacts(pdf: Mu.PDFDocument | null): XfaFacts {
  const none: XfaFacts = { needsRendering: false, xfaPresent: false, fieldCount: 0 };
  if (!pdf) return none;
  try {
    const root = pdf.getTrailer().get('Root');
    const needs = root.get('NeedsRendering');
    const acro = root.get('AcroForm');
    const fields = acro.get('Fields');
    return {
      needsRendering: needs.isBoolean() && needs.asBoolean(),
      xfaPresent: !acro.get('XFA').isNull(),
      fieldCount: fields.isArray() ? fields.length : 0,
    };
  } catch {
    return none;
  }
}

/**
 * The RGBA pixels of a pixmap as a tight array (the rows of a pixmap can be padded). When the rows are already
 * tight this is a view of the pixmap's own memory, with no copy: it is valid only until the pixmap is destroyed.
 */
function tightRgba(pixmap: Mu.Pixmap, width: number, height: number): Uint8ClampedArray {
  const src = pixmap.getPixels();
  const stride = pixmap.getStride();
  const row = width * 4;
  if (stride === row) return new Uint8ClampedArray(src.buffer, src.byteOffset, row * height);
  const out = new Uint8ClampedArray(row * height);
  for (let y = 0; y < height; y++) out.set(src.subarray(y * stride, y * stride + row), y * row);
  return out;
}

/**
 * Makes an ImageBitmap from pixels. The pixels go into an OffscreenCanvas, which hands over its bitmap with
 * transferToImageBitmap. That bitmap is GPU-shareable, while createImageBitmap(ImageData) makes a CPU-backed
 * bitmap that every draw has to upload. putImageData copies the pixels synchronously, so a view of the pixmap
 * is safe here. Without a 2D context the older path is used, on a copy that the bitmap owns.
 */
async function bitmapFromPixels(rgba: Uint8ClampedArray, width: number, height: number): Promise<ImageBitmap> {
  const canvas = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(width, height);
  const context = canvas?.getContext('2d') ?? null;
  if (canvas && context) {
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas.transferToImageBitmap();
  }
  return createImageBitmap(new ImageData(rgba.slice(), width, height));
}

/** The store is emptied when the WASM heap has grown this much since the last full shrink. */
export const SHRINK_GROWTH_BYTES = 16 * 1024 * 1024;
/** Otherwise the store is trimmed this often, in jobs. */
export const PERIODIC_SHRINK_JOBS = 32;

export class MupdfCore {
  private doc: Mu.Document | null = null;
  private jobs = 0;
  /** WASM heap size at the last full shrink. -1 until the first job sets the baseline. */
  private heapAtShrink = -1;
  private pdf: Mu.PDFDocument | null = null;
  /** The page list and the journal of the open document. The worker owns the page truth through it. */
  private edits: EditCore | null = null;
  /** PDFs attached as sources for insertFrom and replace, by source id. They live in this worker until detached. */
  private readonly sourcePdfs = new Map<string, Mu.PDFDocument>();
  private readonly sourceDocs = new Map<string, Mu.Document>();
  private sourceSeq = 0;
  /** Whether the file was encrypted when it opened. A save must keep that. */
  private encrypted = false;
  private pages = 0;
  /**
   * True once a save of this document has produced bytes. MuPDF's incremental save appends only what changed since the
   * previous save and then forgets it, so a second incremental save returns the original file. When the bytes of the
   * first save did not reach the disk (a failed write, a cancelled Save As), the retry must therefore be a full save,
   * which writes every edit. A save that does reach the disk replaces this document with a fresh one.
   */
  private savedOnce = false;

  /**
   * @param mu the mupdf.js module (its public API)
   * @param wasm the loaded WASM module, which exposes the stext accessors used by fastText
   */
  constructor(
    private readonly mu: MuModule,
    private readonly wasm: unknown,
  ) {}

  get pageCount(): number {
    return this.edits?.pageCount ?? this.pages;
  }

  /** The page list and undo state of the open document. Null when no document is open. */
  get editState(): EditCore | null {
    return this.edits;
  }

  /**
   * Opens bytes. Throws Corrupt when mupdf cannot read the file or it has no pages, PasswordNeeded when a
   * password is required but none was given, and WrongPassword when the given one does not open it.
   */
  open(bytes: Uint8Array, password: string | undefined): { pages: number; encrypted: boolean; xfa: XfaFacts } {
    this.close();
    let doc: Mu.Document;
    try {
      doc = this.mu.Document.openDocument(bytes, 'application/pdf');
    } catch {
      throw new WorkerFault('Corrupt', 'MuPDF could not open the file');
    }
    try {
      const needed = doc.needsPassword();
      if (needed) {
        if (password === undefined) throw new WorkerFault('PasswordNeeded');
        if (!doc.authenticatePassword(password)) throw new WorkerFault('WrongPassword');
      }
      const pages = doc.countPages();
      if (!(pages > 0)) throw new WorkerFault('Corrupt', 'The file has no pages');
      const pdf = doc.asPDF();
      const encryption = doc.getMetaData('encryption');
      const encrypted = needed || (encryption !== undefined && encryption !== '' && encryption !== 'None');
      const xfa = readXfaFacts(pdf);
      this.doc = doc;
      this.pdf = pdf;
      this.pages = pages;
      this.encrypted = encrypted;
      // A form that MuPDF can only show as XFA is not edited here.
      this.edits = pdf ? new EditCore(pdf, pages, !(xfa.xfaPresent || xfa.needsRendering), { mu: this.mu, sources: this.sourcePdfs }) : null;
      return { pages, encrypted, xfa };
    } catch (error) {
      doc.destroy();
      if (error instanceof WorkerFault) throw error;
      throw new WorkerFault('Corrupt', 'MuPDF could not read the file');
    }
  }

  close(): void {
    try {
      this.doc?.destroy();
    } catch {
      // Already released.
    }
    this.doc = null;
    this.pdf = null;
    this.edits = null;
    this.encrypted = false;
    this.savedOnce = false;
    this.pages = 0;
    this.detachAll();
  }

  /**
   * Opens another PDF in this worker, as a source for insertFrom and replace. Grafting needs both documents in one
   * worker. Returns the source id and its page count.
   */
  attachSource(bytes: Uint8Array, password: string | undefined): { sourceDocId: string; pages: number; xfa: XfaFacts } {
    let doc: Mu.Document;
    try {
      doc = this.mu.Document.openDocument(bytes, 'application/pdf');
    } catch {
      throw new WorkerFault('Corrupt', 'The source file could not be opened');
    }
    try {
      if (doc.needsPassword()) {
        if (password === undefined) throw new WorkerFault('PasswordNeeded');
        if (!doc.authenticatePassword(password)) throw new WorkerFault('WrongPassword');
      }
      const pages = doc.countPages();
      const pdf = doc.asPDF();
      if (!pdf || !(pages > 0)) throw new WorkerFault('Corrupt', 'The source file has no pages');
      this.sourceSeq += 1;
      const sourceDocId = `src${this.sourceSeq}`;
      this.sourceDocs.set(sourceDocId, doc);
      this.sourcePdfs.set(sourceDocId, pdf);
      // The facts of the source's form, so the Compare sheet can refuse an XFA form as an overlay (it cannot be drawn here).
      return { sourceDocId, pages, xfa: readXfaFacts(pdf) };
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }

  /** The display size of page `page` (0-based) of an attached source, in points (its CropBox turned by its /Rotate). */
  sourceSize(sourceDocId: string, page: number): { width: number; height: number } {
    const page0 = this.overlayPageOf(sourceDocId, page);
    try {
      const b = page0.getBounds();
      return { width: b[2]! - b[0]!, height: b[3]! - b[1]! };
    } finally {
      page0.destroy();
    }
  }

  /** Loads a page of an attached source for the Compare view. A source that is gone, or a page it does not have, is a Conflict. */
  private overlayPageOf(sourceDocId: string, page: number): MuPage {
    const source = this.sourceDocs.get(sourceDocId);
    if (!source) throw new WorkerFault('Conflict', 'The overlay file is no longer attached');
    if (!Number.isInteger(page) || page < 0 || page >= source.countPages()) throw new WorkerFault('Conflict', 'The overlay file has no such page');
    return source.loadPage(page);
  }

  detachSource(sourceDocId: string): void {
    this.sourcePdfs.delete(sourceDocId);
    const doc = this.sourceDocs.get(sourceDocId);
    this.sourceDocs.delete(sourceDocId);
    doc?.destroy();
  }

  private detachAll(): void {
    for (const id of [...this.sourceDocs.keys()]) this.detachSource(id);
  }

  /**
   * The pages with these uids, copied in document order into a new PDF. The source document is left as it was. When the
   * source is encrypted the extract is encrypted too, with the password the document was opened with, unless the user
   * chose to drop the encryption. When that cannot be done this throws NeedsEncryptionChoice, as a save does, and
   * nothing is written.
   */
  extract(uids: readonly string[], options: { dropEncryption?: boolean; password?: string } = {}): { bytes: ArrayBuffer } {
    const edits = this.requireEdits();
    const pdf = this.pdf!;
    const wanted = new Set(uids);
    const positions = edits.pages().uids.flatMap((uid, index) => (wanted.has(uid) ? [index] : []));
    if (positions.length === 0) throw new WorkerFault('Unsupported', 'No pages to extract');
    const out = new this.mu.PDFDocument();
    try {
      // One graft map for all pages: fonts and images the pages share are copied once (see pageCopy.ts).
      graftPages(out, pdf, positions, undefined, { carry: true });
      if (this.encrypted && options.dropEncryption !== true) {
        const password = options.password ?? '';
        const saveAs = extractEncryptedOptions(password);
        const refuse = (): never => {
          throw new WorkerFault('NeedsEncryptionChoice', "This file's password protection cannot be kept when extracting.");
        };
        if (saveAs === null) return refuse();
        const kept = copyOut(out.saveToBuffer(saveAs));
        if (!opensWithPassword(this.mu, kept, password)) return refuse();
        return { bytes: kept.buffer as ArrayBuffer };
      }
      const bytes = copyOut(out.saveToBuffer('garbage=compact')).buffer as ArrayBuffer;
      return { bytes };
    } finally {
      out.destroy();
    }
  }

  /** Applies page edits as one journal operation. See EditCore.apply. */
  applyEdits(edits: readonly PageEdit[], tick?: Tick, uidSeed?: number): Promise<ApplyResult> {
    return this.requireEdits().apply(edits, tick, uidSeed);
  }

  undo(): void {
    this.requireEdits().undo();
  }

  redo(): void {
    this.requireEdits().redo();
  }

  /** Takes back the latest step completely, with nothing left to redo. See EditCore.discardTop. */
  discardLast(): void {
    this.requireEdits().discardTop();
  }

  /**
   * Saves the document to bytes. The mode comes from decideSave, using the document and what the page knows about
   * the target. An encrypted file must stay encrypted: when that cannot be done this throws NeedsEncryptionChoice.
   */
  save(samePath: boolean, diskUnchanged: boolean, dropEncryption = false): SaveOutcome {
    const edits = this.requireEdits();
    const pdf = this.pdf!;
    const decision = decideSave({
      samePath,
      canBeSavedIncrementally: pdf.canBeSavedIncrementally(),
      wasRepaired: pdf.wasRepaired(),
      diskUnchanged,
      removesPages: edits.removesPages,
    });
    // Saving without encryption rewrites the whole file, so the incremental append (which keeps the encryption) is not used.
    // A document that has already produced a save is saved in full, whatever the facts say (see savedOnce).
    const mode = dropEncryption || this.savedOnce ? 'full' : decision.mode;
    const keepsEncryption = this.encrypted && !dropEncryption;
    // Set before the call: whether or not MuPDF finishes, an incremental baseline may have been spent.
    this.savedOnce = true;
    // Any save, whatever happens to its bytes afterwards, empties MuPDF's journal (probed: after saveToBuffer,
    // undo() changes nothing), so the steps made so far are spent from here on, and the page is told the truth
    // (the history event the worker posts after a save, also when it throws).
    edits.markSaved();
    // Copied out of the WASM heap at once, and the MuPDF buffer given back: the encryption check below reopens the bytes,
    // which can grow the heap and detach any view into it.
    const bytes = copyOut(pdf.saveToBuffer(saveOptions(mode, keepsEncryption)));
    if (keepsEncryption && !encryptionKept(this.mu, bytes)) {
      throw new WorkerFault('NeedsEncryptionChoice', "This file's password protection cannot be kept when saving.");
    }
    const copy = bytes.buffer as ArrayBuffer;
    // What the pages look like now, for the page to check the saved bytes against (see pageFingerprint.ts).
    return { bytes: copy, mode, fingerprints: pageFingerprints(pdf) };
  }

  /** One fingerprint per page, in page order. A save compares these with the document it reopens (see save). */
  fingerprints(): number[] {
    this.requireEdits();
    return pageFingerprints(this.pdf!);
  }

  /** The uid and rev of each page, in order, and the page sizes after the change. */
  pageSizesNow(): Float32Array {
    return this.sizes(0, this.pageCount);
  }

  /** The index of the page with this "uid@rev", or -1 when the uid is gone or its rev has moved on. */
  locate(expect: string): number {
    const ref = parsePageRef(expect);
    if (!ref || !this.edits) return -1;
    return this.edits.locate(ref.uid, ref.rev);
  }

  private requireEdits(): EditCore {
    if (!this.edits || !this.pdf) throw new WorkerFault('Internal', 'No document is open');
    return this.edits;
  }

  /** Sizes of pages [from, from + count) as triples: width, height and the page's own /Rotate. */
  sizes(from: number, count: number): Float32Array {
    return this.sizesChecked(from, count).sizes;
  }

  /**
   * sizes() that never throws for one page: a page that cannot be loaded or measured gets the fallback size (letter, upright)
   * and its index is listed in `failed`, so the page side still settles every size it asked for.
   */
  sizesChecked(from: number, count: number): { sizes: Float32Array; failed: number[] } {
    const out = new Float32Array(count * 3);
    const failed: number[] = [];
    for (let i = 0; i < count; i++) {
      const index = from + i;
      if (index >= this.pageCount) break;
      try {
        const page = this.loadPage(index);
        let width: number;
        let height: number;
        try {
          const b = page.getBounds();
          width = b[2]! - b[0]!;
          height = b[3]! - b[1]!;
        } finally {
          page.destroy();
        }
        out.set([width, height, this.rotationOf(index)], i * 3);
      } catch {
        failed.push(index);
        out.set([SIZE_FALLBACK.width, SIZE_FALLBACK.height, 0], i * 3);
      }
    }
    return { sizes: out, failed };
  }

  /**
   * Renders a page (or a region of it) to an opaque RGBA bitmap on a white background. In the Compare view (`args.overlay`) a
   * page of an attached source is blended over it first (see overlayCompose.ts); the bitmap is still the one bitmap of the page.
   */
  async render(args: RenderArgs): Promise<ImageBitmap> {
    const { pixmap, w, h } = this.renderPixmap(args);
    try {
      // The bitmap is made before the pixmap is destroyed, so the view is still valid when it is read.
      return await bitmapFromPixels(tightRgba(pixmap, w, h), w, h);
    } finally {
      pixmap.destroy();
    }
  }

  /** The pixels of `render`, as a pixmap the caller destroys. Split out so the overlay's pixels can be tested without a canvas. */
  renderPixmap(args: RenderArgs): { pixmap: Mu.Pixmap; w: number; h: number } {
    const page = this.loadPage(this.resolvePage(args.page, args.expect));
    try {
      const b = page.getBounds();
      const bounds: Bounds = { x0: b[0]!, y0: b[1]!, x1: b[2]!, y1: b[3]! };
      const { matrix, width, height } = displayTransform(bounds, normalizeRotation(args.rotation));
      const region = args.region ?? { x: 0, y: 0, width, height };
      const area = Math.max(1, region.width * region.height);
      const scale = Math.min(Math.max(args.scale, 0.01), Math.sqrt(MAX_CANVAS_PIXELS / area));
      const w = Math.max(1, Math.floor(region.width * scale));
      const h = Math.max(1, Math.floor(region.height * scale));
      const m: Matrix6 = [
        matrix[0] * scale,
        matrix[1] * scale,
        matrix[2] * scale,
        matrix[3] * scale,
        matrix[4] * scale - region.x * scale,
        matrix[5] * scale - region.y * scale,
      ];
      // The overlay page and its placement, found before anything is drawn so a missing source is an error, not a half page.
      const overlay = args.overlay ? this.overlayFor(args.overlay, [bounds.x0, bounds.y0, bounds.x1, bounds.y1]) : null;
      try {
        const pixmap = new this.mu.Pixmap(this.mu.ColorSpace.DeviceRGB, [0, 0, w, h], true);
        try {
          pixmap.clear(255);
          const device = new this.mu.DrawDevice(m, pixmap);
          try {
            page.run(device, this.mu.Matrix.identity);
            if (overlay && args.overlay && args.overlay.mode !== 'difference' && overlay.area) {
              drawOverlayGroup(this.mu, device, overlay.page, overlay.placement, overlay.area, args.overlay.mode, clampOpacity(args.overlay.opacity));
            }
          } finally {
            device.close();
            device.destroy();
          }
          if (overlay && args.overlay?.mode === 'difference') differenceInto(this.mu, pixmap, w, h, overlay.page, m, overlay.placement);
          return { pixmap, w, h };
        } catch (error) {
          pixmap.destroy();
          throw error;
        }
      } finally {
        overlay?.page.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** The overlay page of a render, its placement on the base page, and the part of the base page it covers (null: none). */
  private overlayFor(
    overlay: NonNullable<RenderArgs['overlay']>,
    baseBounds: [number, number, number, number],
  ): { page: MuPage; placement: PlaceMatrix; area: [number, number, number, number] | null } {
    if (!validScale(overlay.scale) || !Number.isFinite(overlay.dx) || !Number.isFinite(overlay.dy)) {
      throw new WorkerFault('Unsupported', 'The overlay placement is not valid.');
    }
    const page = this.overlayPageOf(overlay.sourceDocId, overlay.sourcePage);
    const raw = page.getBounds();
    const bounds: [number, number, number, number] = [Math.min(raw[0]!, raw[2]!), Math.min(raw[1]!, raw[3]!), Math.max(raw[0]!, raw[2]!), Math.max(raw[1]!, raw[3]!)];
    return { page, placement: placementMatrix(baseBounds, bounds, overlay), area: coveredArea(baseBounds, bounds, overlay) };
  }

  /** Text runs of one page, one run per line, in the page's own display space. */
  textPage(index: number, expect?: string): PageTextData {
    const page = this.loadPage(this.resolvePage(index, expect));
    try {
      const stext = page.toStructuredText('');
      try {
        return { page: index, runs: readPageRuns(stext, this.wasm) };
      } finally {
        stext.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  outline(): OutlineNode[] {
    type Item = NonNullable<ReturnType<Mu.Document['loadOutline']>>[number];
    const convert = (items: Item[] | null | undefined): OutlineNode[] =>
      (items ?? []).map((item) => ({
        title: cleanOutlineTitle(item.title ?? ''),
        page: typeof item.page === 'number' && item.page >= 0 && item.page < this.pageCount ? item.page : null,
        children: convert(item.down),
      }));
    return convert(this.requireDoc().loadOutline());
  }

  metadata(): MetadataResult {
    const doc = this.requireDoc();
    const info: Record<string, string> = {};
    for (const key of INFO_KEYS) {
      const value = doc.getMetaData(`info:${key}`);
      if (value !== undefined && value.trim() !== '') info[key] = value;
    }
    const version = this.pdf?.getVersion();
    return {
      info,
      pdfVersion: version ? `${Math.floor(version / 10)}.${version % 10}` : undefined,
      encryption: doc.getMetaData('encryption'),
    };
  }

  /** Pages, XFA facts, and the size of the WASM linear memory (the heap mupdf allocates from). */
  stats(): { pages: number; xfa: XfaFacts; wasmHeapBytes: number } {
    this.requireDoc();
    const heap = (this.wasm as { HEAPU8?: Uint8Array } | null)?.HEAPU8;
    // DIAGNOSTICS ONLY (1.2.1 probe): the journal, the xref size and the job count, read by the memory probes.
    let journal: { position: number; steps: number } | null = null;
    let xrefObjects: number | null = null;
    try {
      const j = this.pdf?.getJournal();
      journal = j ? { position: j.position, steps: j.steps.length } : null;
      xrefObjects = this.pdf?.countObjects() ?? null;
    } catch {
      // Left null.
    }
    return {
      pages: this.pageCount,
      xfa: readXfaFacts(this.pdf),
      wasmHeapBytes: heap?.byteLength ?? 0,
      diag: { journal, xrefObjects, jobs: this.jobs, heapAtShrink: this.heapAtShrink, editHistory: this.edits?.history ?? null },
    } as { pages: number; xfa: XfaFacts; wasmHeapBytes: number };
  }

  /**
   * Bytes of WASM linear memory. The browser never returns this memory, so the size is the peak the document
   * has needed, and only growing it is a cost to act on.
   */
  heapBytes(): number {
    return (this.wasm as { HEAPU8?: Uint8Array } | null)?.HEAPU8?.byteLength ?? 0;
  }

  /**
   * Runs after every job. mupdf's store holds decoded images and fonts, and it is emptied when the heap has grown
   * by SHRINK_GROWTH_BYTES since the last time, so a page with large images releases them at once. Otherwise
   * the store is trimmed every PERIODIC_SHRINK_JOBS jobs, so the caches stay bounded.
   */
  afterJob(): void {
    this.jobs += 1;
    const heap = this.heapBytes();
    if (this.heapAtShrink < 0) this.heapAtShrink = heap;
    if (heap - this.heapAtShrink >= SHRINK_GROWTH_BYTES) {
      this.mu.shrinkStore(100);
      this.heapAtShrink = heap;
    } else if (this.jobs % PERIODIC_SHRINK_JOBS === 0) {
      this.mu.shrinkStore(50);
    }
  }

  private requireDoc(): Mu.Document {
    if (!this.doc) throw new WorkerFault('Internal', 'No document is open');
    return this.doc;
  }

  /**
   * The page index to read. With `expect` ("uid@rev") the page is found by uid. A page that is gone, or has changed
   * since the caller saw it, is Cancelled: its result would not match what the caller asked for.
   */
  private resolvePage(page: number, expect: string | undefined): number {
    if (expect === undefined) return page;
    const index = this.locate(expect);
    if (index < 0) throw new WorkerFault('Cancelled', `Page ${expect} has changed`);
    return index;
  }

  private loadPage(index: number): MuPage {
    const doc = this.requireDoc();
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) {
      throw new WorkerFault('Internal', `Page ${index} is not in this document`);
    }
    return doc.loadPage(index);
  }

  private rotationOf(index: number): number {
    if (!this.pdf) return 0;
    const pageObject = this.pdf.findPage(index);
    try {
      const rotate = pageObject.getInheritable('Rotate');
      return rotate.isNull() ? 0 : normalizeRotation(rotate.asNumber());
    } finally {
      pageObject.destroy();
    }
  }
}
