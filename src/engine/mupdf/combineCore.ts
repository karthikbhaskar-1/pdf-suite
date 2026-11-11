/**
 * Combine Files, inside the job worker (blueprint §2, B1, B2, B3, §6).
 *
 * The inputs are read one at a time (the worker asks the page for each with `need`), turned into pages of ONE new document, and
 * let go before the next is read. PDF pages come through `graftPages` (one graft map per input, so a font shared by many
 * pages is copied once) with `PageCarrier` carrying comments, markup and links; form fields were flattened when the file was
 * opened (pdfInput.ts). Pictures and text files become pages with imagePage.ts and textPage.ts. Bookmarks are remapped
 * (outlineCarry.ts) and, by default, nested under one bookmark per file.
 *
 * Carried: page content, boxes, rotation, comments and markup, web links, internal links whose target is in the output, bookmarks,
 * the Title, Author, Subject and Keywords of the first PDF. Flattened: form fields and signatures. Dropped, knowingly: attachments,
 * page labels, tags and the structure tree, scripts and actions, named destinations, layer settings (hidden layers become
 * visible), output intents and XMP metadata, and the password (the output is not encrypted). Producer is "PDF Suite" and the
 * dates are the time of the run.
 *
 * Nothing here touches a file: the bytes leave through the sink. The saved output is reopened and compared with what was built
 * before it goes to the page, as a split part is (splitCore.ts).
 */
import type * as Mu from 'mupdf';
import { JobFault, MAX_TOTAL_INPUT_BYTES, type CombineSpec, type JobPhase } from './jobProtocol';
import { addPicturePage, openPicture, type WebpDecoder } from './imagePage';
import { type BookmarkNode, readBookmarks, remapBookmarksBy, writeBookmarks } from './outlineCarry';
import { graftPages } from './pageCopy';
import { pageFingerprints } from './pageFingerprint';
import { openPdfInput } from './pdfInput';
import { pdfDate, verifyPart, type BuiltPartBytes } from './splitCore';
import { CourierFonts, addTextPages } from './textPage';
import { MAX_TEXT_BYTES, decodeText, layoutText } from './textLayout';

type MuModule = typeof Mu;

export interface CombineSink {
  checkCancel(): Promise<void>;
  progress(phase: JobPhase, done: number, total: number, unit: 'files' | 'pages'): void;
  /** The bytes of input `index` (the worker asks the page with `need`). */
  fetchInput(index: number): Promise<ArrayBuffer>;
  /** Sends the finished file. `bytes` is read in pieces, so it can stay in WASM memory until the last piece has gone. */
  emitFile(leafName: string, bytes: ByteSource, pages: number): Promise<void>;
}

/** A file that is read in slices. A Uint8Array is one. */
export interface ByteSource {
  length: number;
  slice(start: number, end: number): Uint8Array;
}

export interface CombineDeps {
  decodeWebp: WebpDecoder | null;
  /** Test hook: called right after the heap reserve, before the save. */
  afterReserve?: () => void;
}

export interface CombineResult {
  files: number;
  pages: number;
}

/**
 * Grows the heap by `bytes` in one piece and frees it, so the save buffer (which grows by 1.5 times at each step) grows in place at
 * the top of the heap instead of leaving a generation of old buffers behind (docs/milestone-1.5/combine-memory-ruling.md, change A).
 * A pixmap of one row of 32 KB bytes per 32768 gives one allocation of the size asked for.
 */
export function reserveHeap(mu: MuModule, bytes: number): void {
  try {
    new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, 32768, Math.ceil(bytes / 32768)], false).destroy();
  } catch {
    // Not enough memory for the reserve: the save decides.
  }
}

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords'] as const;

/** A file name without its extension, for the file's bookmark. */
export function bookmarkTitleOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.trim() === '' ? name : stem;
}

function withItem(error: unknown, item: number): unknown {
  if (error instanceof JobFault && error.item === undefined) {
    return new JobFault(error.kind, error.message, { item, ...(error.page !== undefined ? { page: error.page } : {}), ...(error.limit !== undefined ? { limit: error.limit } : {}) });
  }
  return error;
}

/** Builds the combined document in memory, saves it once, checks it, and sends it out. */
export async function combineFiles(mu: MuModule, spec: CombineSpec, deps: CombineDeps, sink: CombineSink): Promise<CombineResult> {
  if (spec.items.length === 0) throw new JobFault('Internal', 'No files to combine');
  const out = new mu.PDFDocument();
  let fonts: CourierFonts | null = null;
  const bookmarks: BookmarkNode[] = [];
  const info = new Map<string, string>();
  let sawPdf = false;
  let fetched = 0;
  const total = spec.items.reduce((n, item) => n + Math.max(0, item.count ?? 0), 0);
  const counted = total > 0 && spec.items.every((item) => (item.count ?? 0) > 0);
  const report = (phase: JobPhase, done: number, index: number) =>
    counted ? sink.progress(phase, done, total, 'pages') : sink.progress(phase, index, spec.items.length, 'files');
  let built: BuiltPartBytes | null = null;
  let saved: Mu.Buffer | null = null;
  try {
    for (let i = 0; i < spec.items.length; i++) {
      const item = spec.items[i]!;
      await sink.checkCancel();
      report('reading', out.countPages(), i);
      let bytes: ArrayBuffer;
      try {
        bytes = await sink.fetchInput(i);
      } catch (error) {
        throw withItem(error, i);
      }
      fetched += bytes.byteLength;
      if (fetched > MAX_TOTAL_INPUT_BYTES) throw new JobFault('TotalTooLarge', 'The inputs are over the limit', { item: i });
      await sink.checkCancel();
      report('copying', out.countPages(), i);
      const first = out.countPages();
      let mapped: BookmarkNode[] = [];
      try {
        if (item.kind === 'pdf') {
          const input = openPdfInput(mu, bytes, item.password, { flatten: true, stream: true });
          try {
            if (input.xfa) throw new JobFault('Xfa');
            if (!input.formValuesKept) throw new JobFault('FormValuesLost');
            const indices = item.pages ? item.pages.map((p) => p - 1) : Array.from({ length: input.pages }, (_v, k) => k);
            if (indices.length === 0 || indices.some((n) => !Number.isInteger(n) || n < 0 || n >= input.pages)) throw new JobFault('Internal', 'A page range is outside the file');
            graftPages(out, input.pdf, indices, undefined, { carry: true, withForms: false });
            const position = new Map<number, number>();
            indices.forEach((index, k) => {
              if (!position.has(index)) position.set(index, first + k);
            });
            mapped = remapBookmarksBy(readBookmarks(input.doc, input.pages), (page) => position.get(page) ?? null);
            if (!sawPdf) {
              sawPdf = true;
              for (const key of INFO_KEYS) {
                const value = input.doc.getMetaData(`info:${key}`);
                if (value !== undefined && value.trim() !== '') info.set(key, value);
              }
            }
          } finally {
            input.doc.destroy();
          }
        } else if (item.kind === 'image') {
          const picture = await openPicture(mu, new Uint8Array(bytes), deps.decodeWebp, i);
          try {
            const frames = item.pages ? item.pages.map((p) => p - 1) : picture.frames.map((_f, k) => k);
            if (frames.length === 0 || frames.some((n) => !picture.frames[n])) throw new JobFault('Internal', 'A page range is outside the picture');
            for (const n of frames) addPicturePage(mu, out, picture.frames[n]!, spec.imagePage);
          } finally {
            picture.dispose();
          }
        } else {
          if (bytes.byteLength > MAX_TEXT_BYTES) throw new JobFault('TextTooLarge');
          const laid = layoutText(decodeText(new Uint8Array(bytes)).text, spec.textPage);
          fonts ??= new CourierFonts(mu, out);
          addTextPages(out, fonts, laid, spec.textPage);
        }
      } catch (error) {
        throw withItem(error, i);
      }
      const added = out.countPages() - first;
      if (added === 0) throw new JobFault('Internal', 'A file added no pages', { item: i });
      if (spec.fileBookmarks) bookmarks.push({ title: bookmarkTitleOf(item.name), page: first, open: mapped.length > 0, children: mapped });
      else bookmarks.push(...mapped);
      mu.shrinkStore(100);
      report('copying', out.countPages(), i + 1);
    }

    await sink.checkCancel();
    writeBookmarks(mu, out, bookmarks);
    for (const [key, value] of info) out.setMetaData(`info:${key}`, value);
    out.setMetaData('info:Producer', 'PDF Suite');
    const now = pdfDate(new Date());
    out.setMetaData('info:CreationDate', now);
    out.setMetaData('info:ModDate', now);
    const pages = out.countPages();
    const fingerprints = pageFingerprints(out);
    sink.progress('saving', pages, pages, 'pages');
    // The saved file stays in WASM memory: the check opens it from there and the pieces are copied out one at a time, so the
    // output is held once (not also as a JS copy), which keeps the peak inside the memory ceiling for a big combine.
    reserveHeap(mu, Math.ceil(1.5 * fetched) + 1024 * 1024);
    deps.afterReserve?.();
    saved = out.saveToBuffer('garbage=compact');
    built = { bytes: new Uint8Array(0), buffer: saved, pages, fingerprints };
  } finally {
    fonts?.destroy();
    out.destroy();
  }
  try {
    await sink.checkCancel();
    sink.progress('checking', built.pages, built.pages, 'pages');
    verifyPart(mu, built, { encrypted: false, password: undefined, dropEncryption: false });
    sink.progress('writing', built.pages, built.pages, 'pages');
    const file = saved!;
    // Each piece is read through a fresh view: growing the WASM memory (the check did) detaches an older one.
    await sink.emitFile(spec.leafName, { length: file.getLength(), slice: (start, end) => file.asUint8Array().slice(start, end) }, built.pages);
    return { files: 1, pages: built.pages };
  } finally {
    saved?.destroy();
  }
}
