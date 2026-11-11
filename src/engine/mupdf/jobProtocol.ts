/**
 * Messages between the page (src/features/jobs/jobRunner.ts) and the job worker (jobWorker.ts). The job worker is separate
 * from the document workers: it is started for one dialog or job and terminated when that ends, which is the only way to
 * give its WASM memory back. Shapes are the blueprint's Appendix A2 with the kinds of the Amendment 2026-11-10.
 *
 * Nothing here imports mupdf, so the page can use these types without loading the WASM.
 */
import { MAX_EDIT_BYTES } from './fileLimitBytes';

export type InputKind = 'pdf' | 'image' | 'text';

/** A page size in points, for the picture and text pages of Combine (1.3.3). */
export interface PageDims {
  width: number;
  height: number;
}

/** What the worker is doing, for the status bar. */
export type JobPhase = 'reading' | 'copying' | 'looking' | 'saving' | 'checking' | 'writing';

/** A fact about a finished job that the result notice mentions. */
export type JobNote = { kind: 'oversizePage'; file: number; page: number; limitBytes: number };

export type JobErrorKind =
  | 'Cancelled'
  | 'InputUnreadable'
  | 'InputChanged'
  | 'PasswordNeeded'
  | 'WrongPassword'
  | 'Damaged'
  | 'Xfa'
  | 'FormValuesLost'
  | 'ImageTooLarge'
  | 'TextTooLarge'
  | 'TotalTooLarge'
  | 'CannotKeepPassword'
  | 'NoBookmarks'
  | 'CheckFailed'
  /** The WASM heap could not grow (MuPDF: "realloc (n bytes) failed"). No file was made. */
  | 'OutOfMemory'
  | 'Internal';

export interface CombineItem {
  kind: InputKind;
  /** The file's name, for its bookmark. */
  name: string;
  /** 1-based pages (frames of a multi-page TIFF); all of them when absent. */
  pages?: number[];
  /** How many pages the item adds, for the progress count. */
  count?: number;
  /** The password of an encrypted PDF. Used to open it and never stored or logged. */
  password?: string;
}

export interface CombineSpec {
  kind: 'combine';
  items: CombineItem[];
  fileBookmarks: boolean;
  imagePage: 'image' | PageDims;
  textPage: PageDims;
  /** The name of the one output file (the leaf of the path from the Save dialog). */
  leafName: string;
}

export interface SplitPart {
  /** 1-based, inclusive. */
  from: number;
  to: number;
  leafName: string;
  /** Bookmark titles do not matter to the worker; the part's own bookmarks are rebuilt from the source's outline. */
}

export interface SplitSpec {
  kind: 'split';
  baseName: string;
  password?: string;
  dropEncryption?: boolean;
  plan: { by: 'ranges'; parts: SplitPart[] } | { by: 'size'; maxBytes: number };
  /** Size splits only: how many digits the part number has ("part 01"). The page works it out from the page count. */
  nameWidth?: number;
}

export type ToJob =
  | { t: 'init'; module: WebAssembly.Module }
  | {
      t: 'probe';
      id: number;
      kind: InputKind;
      bytes: ArrayBuffer;
      password?: string;
      /** Combine: the list row this input is, so a `thumb` can say which row it asks about. */
      item?: number;
      /** Combine: how pictures and text files become pages (changes the page count and the preview). */
      imagePage?: 'image' | PageDims;
      textPage?: PageDims;
      /** A PDF is opened for its pages only (a preview): form fields are not checked. */
      preview?: boolean;
    }
  /** Combine's preview: page `page` (0-based) of the input probed last, as a picture at most `maxPx` on its longer side. */
  | { t: 'thumb'; id: number; item: number; page: number; maxPx: number }
  | { t: 'analyse'; id: number; what: 'blank' | 'outline' }
  | { t: 'start'; id: number; spec: CombineSpec | SplitSpec }
  | { t: 'input'; id: number; index: number; bytes: ArrayBuffer }
  | { t: 'ack'; id: number; file: number; seq: number }
  | { t: 'cancel'; id: number };

/** One top-level bookmark of the probed document, for Split by bookmarks. `page` is 1-based. */
export interface OutlineEntry {
  title: string;
  page: number;
}

export type AnalysisResult =
  /** One entry per page: the ink share and the largest mark in pixels (see blankDetect.ts). */
  | { what: 'blank'; ink: number[]; mark: number[] }
  /** Top-level bookmarks in document order, only those that point into the document. */
  | { what: 'outline'; entries: OutlineEntry[] };

export type FromJob =
  | { t: 'ready' }
  | {
      t: 'probed';
      id: number;
      pages: number;
      encrypted: boolean;
      fields: number;
      /** False when flattening would lose what is filled in (the file is refused). */
      formValuesKept: boolean;
      xfa: boolean;
      layers: boolean;
      attachments: number;
      unprintable: number;
      /** Bytes of the probed file. */
      byteLength: number;
    }
  | { t: 'analysed'; id: number; result: AnalysisResult }
  /** RGBA pixels of a page preview. */
  | { t: 'thumbed'; id: number; item: number; page: number; width: number; height: number; pixels: ArrayBuffer }
  | { t: 'need'; id: number; index: number }
  | { t: 'progress'; id: number; phase: JobPhase; done: number; total: number; unit: 'files' | 'pages' }
  | { t: 'file'; id: number; file: number; leafName: string }
  | { t: 'chunk'; id: number; file: number; seq: number; bytes: ArrayBuffer }
  | { t: 'fileEnd'; id: number; file: number; byteLength: number; pages: number }
  | { t: 'done'; id: number; files: number; pages: number; notes: JobNote[] }
  | { t: 'error'; id: number; kind: JobErrorKind; item?: number; page?: number; limit?: number; detail?: string };

/** Output leaves the worker in chunks of this size, each acknowledged by the page before the next is sent (blueprint §1). */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Total input a job accepts (blueprint §1). */
export const MAX_TOTAL_INPUT_BYTES = MAX_EDIT_BYTES;
/** Files one job may make. */
export const MAX_JOB_FILES = 2000;
/** A job that sends no message for this long is terminated and reported as not responding. */
export const JOB_SILENCE_MS = 120_000;
/** After a cancel the worker has this long to answer before it is terminated. */
export const JOB_CANCEL_GRACE_MS = 2000;

/** Raised inside the worker; the kind travels to the page. */
export class JobFault extends Error {
  readonly kind: JobErrorKind;
  readonly item: number | undefined;
  readonly page: number | undefined;
  readonly limit: number | undefined;

  constructor(kind: JobErrorKind, detail: string = kind, extra: { item?: number; page?: number; limit?: number } = {}) {
    super(detail);
    this.name = 'JobFault';
    this.kind = kind;
    this.item = extra.item;
    this.page = extra.page;
    this.limit = extra.limit;
  }
}

/** True for the errors MuPDF and WebAssembly raise when the heap cannot grow, so the job can say "not enough memory". */
export function isOutOfMemory(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /\b(realloc|malloc|calloc)\b.*\bfailed\b|out of memory|cannot allocate|cannot enlarge memory|could not allocate|memory\.grow|Array buffer allocation failed/i.test(text);
}
