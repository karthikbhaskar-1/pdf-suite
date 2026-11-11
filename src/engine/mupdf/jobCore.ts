/**
 * The job worker's logic, without the worker: a `JobSession` takes the page's messages (`ToJob`) and answers with `FromJob`
 * messages through `post`. The worker file (jobWorker.ts) is a thin shell around it, and the unit tests drive it directly.
 *
 * One session holds at most one probed input (blueprint A2). Probing, analysing and running are done one after another;
 * `ack`, `input` and `cancel` are handled at once, even while a job is running, because a running job yields between pages
 * and chunks. A cancel makes the next check throw, and every wait for the page (an ack, an input) fail with Cancelled.
 *
 * Jobs read files that main handed over as bytes (never a live document): `probe` and `input` carry the bytes of a file on
 * disk. The probed copy is flattened in memory (formFlatten.ts) and is never written back anywhere.
 */
import type * as Mu from 'mupdf';
import { blankMeasure } from './blankDetect';
import { combineFiles } from './combineCore';
import { addPicturePage, openPicture, type Picture, type WebpDecoder } from './imagePage';
import {
  CHUNK_BYTES,
  JobFault,
  MAX_TOTAL_INPUT_BYTES,
  isOutOfMemory,
  type AnalysisResult,
  type CombineSpec,
  type FromJob,
  type JobPhase,
  type PageDims,
  type SplitSpec,
  type ToJob,
} from './jobProtocol';
import { readBookmarks, topLevelEntries } from './outlineCarry';
import { openPdfInput } from './pdfInput';
import { splitByRanges, splitBySize, type SplitResult, type SplitSink, type SplitSource } from './splitCore';
import { createYielder } from './textJob';
import { CourierFonts, addTextPages } from './textPage';
import { MAX_TEXT_BYTES, decodeText, layoutText, type LaidOutText } from './textLayout';

type MuModule = typeof Mu;

/** Progress messages are sent at most this often, except for the last one of a phase. */
const PROGRESS_INTERVAL_MS = 100;

interface Input {
  doc: Mu.Document;
  pdf: Mu.PDFDocument;
  pages: number;
  encrypted: boolean;
  password: string | undefined;
  byteLength: number;
  /** Combine: the list row this input is. */
  item: number | undefined;
}

/** A picture or a text file that was probed (Combine). Its pages are made when a preview asks for one. */
interface BuiltInput {
  item: number | undefined;
  pages: number;
  /** A new one-page document holding page `page` (0-based) as it will be made. The caller destroys it. */
  previewPage(page: number): Mu.PDFDocument;
  dispose(): void;
}

export interface SessionOptions {
  /** Test hook: milliseconds clock for the progress throttle. */
  now?: () => number;
  /** Test hook: called with every chunk before it is posted, to inject a failure. May throw. */
  beforeChunk?: (file: number, seq: number) => void;
  /** Decodes a WebP picture to PNG (the worker passes one built on createImageBitmap). Null: WebP cannot be read. */
  decodeWebp?: WebpDecoder | null;
  /** Test hook: called right after Combine's heap reserve, before the save. */
  afterReserve?: () => void;
}

export class JobSession {
  private input: Input | null = null;
  private built: BuiltInput | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly cancelled = new Set<number>();
  private readonly yieldTurn = createYielder();
  private readonly acks = new Map<string, () => void>();
  private readonly earlyAcks = new Set<string>();
  private readonly inputs = new Map<number, (bytes: ArrayBuffer) => void>();
  private readonly waiting = new Set<(error: JobFault) => void>();
  private fileSeq = 0;
  private lastProgress = 0;
  private lastPhase: JobPhase | null = null;
  private readonly now: () => number;

  constructor(
    private readonly mu: MuModule,
    private readonly post: (message: FromJob, transfer?: Transferable[]) => void,
    private readonly options: SessionOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** The page's message. Probe, analyse and start queue behind the one that is running; the others take effect now. */
  handle(message: ToJob): void {
    switch (message.t) {
      case 'init':
        return;
      case 'ack': {
        const key = `${message.file}:${message.seq}`;
        const resolve = this.acks.get(key);
        if (resolve) {
          this.acks.delete(key);
          resolve();
        } else {
          this.earlyAcks.add(key);
        }
        return;
      }
      case 'input': {
        const resolve = this.inputs.get(message.index);
        if (resolve) {
          this.inputs.delete(message.index);
          resolve(message.bytes);
        }
        return;
      }
      case 'cancel': {
        this.cancelled.add(message.id);
        const stop = [...this.waiting];
        this.waiting.clear();
        for (const reject of stop) reject(new JobFault('Cancelled'));
        return;
      }
      default: {
        const run = message;
        this.chain = this.chain.then(() => this.run(run)).catch(() => undefined);
      }
    }
  }

  /** Resolves when every queued message has been handled. For tests. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Releases the probed input. The worker is terminated after this, which is what returns the memory. */
  dispose(): void {
    this.closeInput();
  }

  private closeInput(): void {
    if (this.built) {
      this.built.dispose();
      this.built = null;
    }
    if (!this.input) return;
    try {
      this.input.doc.destroy();
    } catch {
      // Already released.
    }
    this.input = null;
  }

  private async run(message: Extract<ToJob, { t: 'probe' | 'analyse' | 'start' | 'thumb' }>): Promise<void> {
    const id = message.id;
    try {
      if (message.t === 'probe') await this.probe(message);
      else if (message.t === 'thumb') this.thumb(message);
      else if (message.t === 'analyse') await this.analyse(message.id, message.what);
      else await this.start(message.id, message.spec);
    } catch (error) {
      this.fail(id, error);
    } finally {
      this.cancelled.delete(id);
    }
  }

  private fail(id: number, error: unknown): void {
    if (error instanceof JobFault) {
      this.post({
        t: 'error',
        id,
        kind: error.kind,
        ...(error.item !== undefined ? { item: error.item } : {}),
        ...(error.page !== undefined ? { page: error.page } : {}),
        ...(error.limit !== undefined ? { limit: error.limit } : {}),
        detail: error.message,
      });
      return;
    }
    this.post({ t: 'error', id, kind: isOutOfMemory(error) ? 'OutOfMemory' : 'Internal', detail: error instanceof Error ? error.message : String(error) });
  }

  // ---- probe ---------------------------------------------------------------------------------------------------------

  private async probe(message: Extract<ToJob, { t: 'probe' }>): Promise<void> {
    const { id, kind, bytes, password } = message;
    this.closeInput();
    if (bytes.byteLength > MAX_TOTAL_INPUT_BYTES) throw new JobFault('TotalTooLarge', 'The file is over the limit');
    if (kind === 'image') return this.probePicture(message);
    if (kind === 'text') return this.probeText(message);
    const opened = openPdfInput(this.mu, bytes, password, { flatten: message.preview !== true });
    this.input = { doc: opened.doc, pdf: opened.pdf, pages: opened.pages, encrypted: opened.encrypted, password, byteLength: bytes.byteLength, item: message.item };
    this.post({
      t: 'probed',
      id,
      pages: opened.pages,
      encrypted: opened.encrypted,
      fields: opened.fields,
      formValuesKept: opened.formValuesKept,
      xfa: opened.xfa,
      layers: opened.layers,
      attachments: opened.attachments,
      unprintable: 0,
      byteLength: bytes.byteLength,
    });
  }

  private async probePicture(message: Extract<ToJob, { t: 'probe' }>): Promise<void> {
    const mu = this.mu;
    const target = message.imagePage ?? 'image';
    const picture: Picture = await openPicture(mu, new Uint8Array(message.bytes), this.options.decodeWebp ?? null, message.item);
    this.built = {
      item: message.item,
      pages: picture.frames.length,
      previewPage: (page) => {
        const doc = new mu.PDFDocument();
        addPicturePage(mu, doc, picture.frames[page]!, target);
        return doc;
      },
      dispose: () => picture.dispose(),
    };
    this.post({
      t: 'probed',
      id: message.id,
      pages: picture.frames.length,
      encrypted: false,
      fields: 0,
      formValuesKept: true,
      xfa: false,
      layers: false,
      attachments: 0,
      unprintable: 0,
      byteLength: message.bytes.byteLength,
    });
  }

  private probeText(message: Extract<ToJob, { t: 'probe' }>): void {
    const mu = this.mu;
    if (message.bytes.byteLength > MAX_TEXT_BYTES) throw new JobFault('TextTooLarge');
    const dims: PageDims = message.textPage ?? { width: 612, height: 792 };
    const laid: LaidOutText = layoutText(decodeText(new Uint8Array(message.bytes)).text, dims);
    this.built = {
      item: message.item,
      pages: laid.pages.length,
      previewPage: (page) => {
        const doc = new mu.PDFDocument();
        const fonts = new CourierFonts(mu, doc);
        try {
          addTextPages(doc, fonts, { pages: [laid.pages[page]!], unprintable: 0 }, dims);
        } finally {
          fonts.destroy();
        }
        return doc;
      },
      dispose: () => undefined,
    };
    this.post({
      t: 'probed',
      id: message.id,
      pages: laid.pages.length,
      encrypted: false,
      fields: 0,
      formValuesKept: true,
      xfa: false,
      layers: false,
      attachments: 0,
      unprintable: laid.unprintable,
      byteLength: message.bytes.byteLength,
    });
  }

  // ---- thumb (Combine's preview) -------------------------------------------------------------------------------------------

  private thumb(message: Extract<ToJob, { t: 'thumb' }>): void {
    const { id, item, page, maxPx } = message;
    let doc: Mu.Document | null = null;
    let temp: Mu.PDFDocument | null = null;
    if (this.input && this.input.item === item) {
      if (!(page >= 0 && page < this.input.pages)) throw new JobFault('Internal', 'No such page');
      doc = this.input.doc;
    } else if (this.built && this.built.item === item) {
      if (!(page >= 0 && page < this.built.pages)) throw new JobFault('Internal', 'No such page');
      temp = this.built.previewPage(page);
      doc = temp;
    }
    // The page asked about a file that is not the one probed last (it moved on to another row): nothing to draw.
    if (!doc) throw new JobFault('Internal', 'The file is no longer open');
    try {
      const loaded = doc.loadPage(temp ? 0 : page);
      try {
        const bounds = loaded.getBounds();
        const longest = Math.max(1, bounds[2] - bounds[0], bounds[3] - bounds[1]);
        const scale = Math.max(0.01, maxPx / longest);
        const pixmap = loaded.toPixmap(this.mu.Matrix.scale(scale, scale), this.mu.ColorSpace.DeviceRGB, false, true);
        try {
          const width = pixmap.getWidth();
          const height = pixmap.getHeight();
          const stride = pixmap.getStride();
          const n = pixmap.getNumberOfComponents();
          const from = pixmap.getPixels();
          const rgba = new Uint8ClampedArray(width * height * 4);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const s = y * stride + x * n;
              const d = (y * width + x) * 4;
              rgba[d] = from[s]!;
              rgba[d + 1] = from[s + 1]!;
              rgba[d + 2] = from[s + 2]!;
              rgba[d + 3] = 255;
            }
          }
          this.post({ t: 'thumbed', id, item, page, width, height, pixels: rgba.buffer as ArrayBuffer }, [rgba.buffer as ArrayBuffer]);
        } finally {
          pixmap.destroy();
        }
      } finally {
        loaded.destroy();
      }
    } finally {
      temp?.destroy();
    }
  }

  // ---- analyse -------------------------------------------------------------------------------------------------------

  private async analyse(id: number, what: 'blank' | 'outline'): Promise<void> {
    const input = this.requireInput();
    let result: AnalysisResult;
    if (what === 'outline') {
      result = { what, entries: topLevelEntries(readBookmarks(input.doc, input.pages)) };
    } else {
      const ink: number[] = [];
      const mark: number[] = [];
      for (let i = 0; i < input.pages; i++) {
        await this.checkCancel(id);
        const measured = blankMeasure(this.mu, input.pdf, i);
        ink.push(measured.ink);
        mark.push(measured.mark);
        this.progress(id, 'looking', i + 1, input.pages, 'pages');
      }
      result = { what, ink, mark };
    }
    this.post({ t: 'analysed', id, result });
  }

  // ---- start ---------------------------------------------------------------------------------------------------------

  private async start(id: number, spec: SplitSpec | CombineSpec): Promise<void> {
    if (spec.kind === 'combine') return this.startCombine(id, spec);
    if (this.input === null) {
      // The page did not probe first: ask for the file.
      this.post({ t: 'need', id, index: 0 });
      const bytes = await this.waitFor(this.inputs, 0);
      await this.probe({ t: 'probe', id, kind: 'pdf', bytes, ...(spec.password !== undefined ? { password: spec.password } : {}) });
    }
    const input = this.requireInput();
    const source: SplitSource = {
      doc: input.doc,
      pdf: input.pdf,
      pages: input.pages,
      encrypted: input.encrypted,
      bookmarks: readBookmarks(input.doc, input.pages),
    };
    const options = { encrypted: input.encrypted, password: spec.password ?? input.password, dropEncryption: spec.dropEncryption === true };
    const sink: SplitSink = {
      checkCancel: () => this.checkCancel(id),
      progress: (phase, done, total, unit) => this.progress(id, phase, done, total, unit),
      emitFile: (leafName, bytes, pages) => this.emitFile(id, leafName, bytes, pages),
    };
    let result: SplitResult;
    if (spec.plan.by === 'ranges') {
      result = await splitByRanges(this.mu, source, spec.plan.parts, options, sink);
    } else {
      result = await splitBySize(this.mu, source, spec.baseName, spec.plan.maxBytes, spec.nameWidth ?? 2, options, sink);
    }
    this.post({ t: 'done', id, files: result.files, pages: result.pages, notes: result.notes });
  }

  private async startCombine(id: number, spec: CombineSpec): Promise<void> {
    // The probed input is let go first: the run reads every file again, one at a time.
    this.closeInput();
    const result = await combineFiles(
      this.mu,
      spec,
      { decodeWebp: this.options.decodeWebp ?? null, ...(this.options.afterReserve ? { afterReserve: this.options.afterReserve } : {}) },
      {
        checkCancel: () => this.checkCancel(id),
        progress: (phase, done, total, unit) => this.progress(id, phase, done, total, unit),
        fetchInput: async (index) => {
          this.post({ t: 'need', id, index });
          return this.waitFor(this.inputs, index);
        },
        emitFile: (leafName, bytes, pages) => this.emitFile(id, leafName, bytes, pages),
      },
    );
    this.post({ t: 'done', id, files: result.files, pages: result.pages, notes: [] });
  }

  private requireInput(): Input {
    if (!this.input) throw new JobFault('Internal', 'No file has been read');
    return this.input;
  }

  // ---- plumbing ------------------------------------------------------------------------------------------------------

  /** Lets queued messages (a cancel, an ack) run, then throws when the job was cancelled. */
  private async checkCancel(id: number): Promise<void> {
    await this.yieldTurn();
    if (this.cancelled.has(id)) throw new JobFault('Cancelled');
  }

  private progress(id: number, phase: JobPhase, done: number, total: number, unit: 'files' | 'pages'): void {
    const time = this.now();
    // At most ten a second; the first one, and the one that completes a count, always go.
    const last = done >= total;
    if (this.lastPhase !== null && !last && time - this.lastProgress < PROGRESS_INTERVAL_MS) return;
    this.lastProgress = time;
    this.lastPhase = phase;
    this.post({ t: 'progress', id, phase, done, total, unit });
  }

  private waitFor<T>(table: Map<number, (value: T) => void>, key: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const fail = (error: JobFault) => reject(error);
      this.waiting.add(fail);
      table.set(key, (value) => {
        this.waiting.delete(fail);
        resolve(value);
      });
    });
  }

  private waitAck(file: number, seq: number): Promise<void> {
    const key = `${file}:${seq}`;
    if (this.earlyAcks.delete(key)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const fail = (error: JobFault) => reject(error);
      this.waiting.add(fail);
      this.acks.set(key, () => {
        this.waiting.delete(fail);
        resolve();
      });
    });
  }

  /** Sends one file: `file`, then chunks of CHUNK_BYTES (chunk n + 1 only after the ack of n), then `fileEnd`. */
  private async emitFile(id: number, leafName: string, bytes: { length: number; slice(start: number, end: number): Uint8Array }, pages: number): Promise<void> {
    this.fileSeq += 1;
    const file = this.fileSeq;
    this.post({ t: 'file', id, file, leafName });
    let seq = 0;
    for (let offset = 0; offset < bytes.length || seq === 0; offset += CHUNK_BYTES) {
      await this.checkCancel(id);
      this.options.beforeChunk?.(file, seq);
      const piece = bytes.slice(offset, Math.min(bytes.length, offset + CHUNK_BYTES));
      const wait = this.waitAck(file, seq);
      this.post({ t: 'chunk', id, file, seq, bytes: piece.buffer as ArrayBuffer }, [piece.buffer as ArrayBuffer]);
      await wait;
      seq += 1;
      if (bytes.length === 0) break;
    }
    this.post({ t: 'fileEnd', id, file, byteLength: bytes.length, pages });
  }
}
