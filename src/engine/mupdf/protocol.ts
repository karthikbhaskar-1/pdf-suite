/**
 * Messages between the page (client.ts) and the MuPDF worker (worker.ts). One worker holds one
 * document. Requests carry an id, a priority and, for edits, the document version the caller saw.
 * Every request gets exactly one reply, except `cancel` and the internal `sizes` job, which only
 * post events.
 *
 * Nothing here imports mupdf, so the page can use these types without loading the WASM.
 */
import type { PageRegion } from '../types';
import type { AppliedMode, OverlayMode } from '../overlayPlacement';

/** Lower number = more urgent. Renders the page is waiting on run before text and background work. */
export const Priority = {
  Visible: 0,
  Prefetch: 1,
  Thumbnail: 2,
  Background: 3,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/** Error kinds a reply can carry. The first five match PdfErrorKind so the page can reuse them. */
export type ErrorKind =
  | 'PasswordNeeded'
  | 'WrongPassword'
  | 'Corrupt'
  | 'NotPdf'
  | 'Empty'
  | 'Cancelled'
  | 'Conflict'
  | 'Unsupported'
  /** The file is encrypted and the save could not keep its encryption. The UI asks the user how to save. */
  | 'NeedsEncryptionChoice'
  | 'Internal';

/** Thrown inside the worker. The kind travels back in the reply. */
export class WorkerFault extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string = kind) {
    super(message);
    this.name = 'WorkerFault';
    this.kind = kind;
  }
}

export interface RenderArgs {
  /** Engine page index. Ignored when `expect` is given: the page is then found by its uid. */
  page: number;
  /** Pixels per point. */
  scale: number;
  /** Extra rotation in degrees, on top of the page's own rotation. */
  rotation: number;
  region?: PageRegion;
  /**
   * The page the caller expects, as "uid@rev". The worker renders the page with that uid, and answers Cancelled when
   * the uid is gone or its content has changed since (its rev differs). Without it the render uses `page` as an index.
   */
  expect?: string;
  /**
   * Compare view (1.3.4): lay page `sourcePage` (0-based) of the attached source `sourceDocId` over this page, in the same
   * bitmap. The placement is in points of this page's display space (see overlayPlacement.ts). The result is one bitmap, so
   * the bitmap budget does not change. Without it the render is the plain page.
   */
  overlay?: OverlayArgs;
}

/** What the render of a page in the Compare view adds to the plain page. */
export interface OverlayArgs {
  sourceDocId: string;
  sourcePage: number;
  dx: number;
  dy: number;
  scale: number;
  mode: OverlayMode;
  /** The share of the overlay that shows, 0 to 1. Used by the 'blend' mode only. */
  opacity: number;
}

/**
 * One line of text in a page's display space, before any extra rotation. Matches a TextRun without measuring.
 *
 * The character boundaries are packed: `bounds` is one Float32Array for the whole page, shared by all of its runs, and the
 * run's `text.length + 1` boundaries start at `boundsAt`. Boundary i is where UTF-16 unit i starts along the run (points from
 * `origin`), and the last one is where the run ends, so the boxes are contiguous: unit i spans bounds[i] to bounds[i + 1].
 * The worker transfers the buffer instead of copying an object per character.
 */
export interface RunData {
  text: string;
  origin: { x: number; y: number };
  along: { x: number; y: number };
  up: { x: number; y: number };
  /** Packed character boundaries of the whole page (shared by its runs). */
  bounds: Float32Array;
  /** Index in `bounds` of this run's first boundary. */
  boundsAt: number;
}

/** The buffers to transfer with a text reply: one per page that has text (its runs share one). */
export function textTransferList(pages: readonly PageTextData[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const page of pages) {
    const first = page.runs[0];
    if (first && first.bounds.buffer instanceof ArrayBuffer) buffers.push(first.bounds.buffer);
  }
  return buffers;
}

export interface PageTextData {
  page: number;
  runs: RunData[];
}

export interface OutlineNode {
  title: string;
  /** Engine page index, or null for a target outside this file. */
  page: number | null;
  children: OutlineNode[];
}

export interface MetadataResult {
  /** Raw info-dictionary strings by key (Title, Author, CreationDate, ...). */
  info: Record<string, string>;
  /** PDF format version as "1.7", when known. */
  pdfVersion?: string;
  /** MuPDF's encryption description, or "None". */
  encryption?: string;
}

/** Facts the router needs to tell an XFA form apart. */
export interface XfaFacts {
  /** Catalog NeedsRendering is true. */
  needsRendering: boolean;
  /** AcroForm/XFA is present. */
  xfaPresent: boolean;
  /** Number of AcroForm/Fields entries. */
  fieldCount: number;
}

export interface OpenResult {
  pages: number;
  encrypted: boolean;
  xfa: XfaFacts;
  /** The bytes that were sent in, handed back so the router can give them to another engine. */
  bytes: ArrayBuffer;
}

/** Undo and redo state after an edit. `dirty` is true while the journal position is above zero. */
export interface HistoryState {
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** "Delete 3 pages" and so on, for the Undo and Redo labels. Null when there is nothing to undo or redo. */
  undoLabel: string | null;
  redoLabel: string | null;
  /**
   * Why the changes made so far cannot be undone, when they cannot: they went into a save that did not reach the disk
   * (see EditCore.markSaved). Absent or null otherwise. The page shows it as the Undo command's disabled reason.
   */
  undoBlockedReason?: string | null;
}

/** The reply to apply, undo and redo. */
export interface EditOutcome {
  version: number;
  history: HistoryState;
  /** apply only: false when the edit changed nothing, so no step was made. */
  changed?: boolean;
  /** apply only: the uid counter the step started from. A replay passes it back as `uidSeed`. */
  uidSeed?: number;
}

/** The reply to save: the file's bytes, and which way they were written. */
export interface SaveOutcome {
  bytes: ArrayBuffer;
  mode: 'incremental' | 'full';
  /** A fingerprint of each page as it is in the worker now, in order. The page checks the reopened bytes against it. */
  fingerprints: number[];
}

/**
 * A page's stable id. The pages of the file as opened are "0".."n-1" (their index at open). A page added by an edit
 * gets "n<seq>", where seq counts up for the life of the worker. A uid is never reused, so it names one page for good.
 * Edits name pages by uid, never by index, so an edit made against an old version cannot hit the wrong page.
 */
export type PageUid = string;

/** A page's content revision, as a `uid@rev` string. The rev changes only when the page's content changes. */
export type PageRef = `${PageUid}@${number}`;

/** Splits "uid@rev". Returns null when the text is not of that form. */
export function parsePageRef(text: string): { uid: PageUid; rev: number } | null {
  const at = text.lastIndexOf('@');
  if (at <= 0) return null;
  const rev = Number(text.slice(at + 1));
  if (!Number.isInteger(rev) || rev < 0) return null;
  return { uid: text.slice(0, at), rev };
}

/** Template of a blank page inserted by an edit. */
export type PageTemplate = 'blank' | 'lined' | 'grid';

/** A page size in PDF points. */
export interface PageDims {
  width: number;
  height: number;
}

/**
 * One page edit, for 1.2.1. `afterUid` and `beforeUid` take null for the start or the end of the document.
 * Every edit is applied in order inside one `apply` request, which carries the base version.
 */
export type PageEdit =
  | { op: 'insertBlank'; afterUid: PageUid | null; size: PageDims; template: PageTemplate; count?: number }
  | { op: 'insertFrom'; afterUid: PageUid | null; sourceDocId: string; sourceUids: PageUid[] }
  | { op: 'delete'; uids: PageUid[] }
  | { op: 'move'; uids: PageUid[]; beforeUid: PageUid | null }
  | { op: 'duplicate'; uids: PageUid[] }
  | { op: 'rotate'; uids: PageUid[]; degrees: number }
  /** box: the crop in display space of each page, relative to its top-left; 'auto' finds the content; null removes the crop. */
  | { op: 'crop'; uids: PageUid[]; box: PageRegion | 'auto' | null; margin?: number }
  | { op: 'resize'; uids: PageUid[]; size: PageDims; fit: 'scale' | 'center' }
  | { op: 'replace'; uid: PageUid; sourceDocId: string; sourceUid: PageUid }
  | { op: 'reverse'; uids: PageUid[] }
  /**
   * Cuts each page in half. `cut` 'vertical' makes a left and a right page, 'horizontal' a top and a bottom page; `at` is the
   * cut's share of the page width or height (0.3 to 0.7). `first` says which half comes first ('right' for books read right to
   * left; a horizontal cut is always top first). The page keeps its uid as the first half; the second half gets a new uid.
   */
  | { op: 'slice'; uids: PageUid[]; cut: 'vertical' | 'horizontal'; at: number; first: 'left' | 'right' }
  /**
   * Lays a page of another PDF over each page, for good (1.3.4 "Add overlay to pages"). `uids[i]` gets page `sourceUids[i]` of
   * the source (the two lists are as long as each other; the page pairs them, so a page without a partner is simply not
   * listed). Every page gets the same placement. The pages keep their uids, with a new rev. 'difference' is for viewing only.
   */
  | { op: 'overlay'; uids: PageUid[]; sourceDocId: string; sourceUids: PageUid[]; dx: number; dy: number; scale: number; mode: AppliedMode; opacity: number };

/**
 * Whether a slice of this kind suits a page of this display size: wide pages are cut left and right, tall pages top and
 * bottom, and a square page is neither. The "Wide pages only" and "Tall pages only" choices of the Cut sheet use it.
 */
/** Most pages one insert adds, so one request cannot grow the document without bound. The sheets and the engine read this one number. */
export const MAX_INSERT_COUNT = 1000;

export function sliceFits(size: PageDims, cut: 'vertical' | 'horizontal'): boolean {
  return cut === 'horizontal' ? size.height > size.width : size.width > size.height;
}

/**
 * How a rotation is applied. A multiple of 90 degrees is `native`: the page's /Rotate entry is set, which every
 * viewer honours. Any other angle is `custom`: the page content is turned by that angle, and the page is
 * flagged so the UI can tell the user it is not a native rotation.
 */
export type RotationKind = 'native' | 'custom';

export function rotationKind(degrees: number): RotationKind {
  return Number.isInteger(degrees) && degrees % 90 === 0 ? 'native' : 'custom';
}

/** Edit operations, defined for 1.2.1. The 1.2.0 worker answers each with `Unsupported`. */
export type EditBody =
  | { op: 'apply'; baseVersion: number; edits: PageEdit[]; uidSeed?: number }
  | { op: 'undo' }
  | { op: 'redo' }
  /** Takes back the latest step as if it had never been made (no redo is left). For a cancelled preview. */
  | { op: 'discardLast' }
  /**
   * Saves the document to bytes. `samePath` and `diskUnchanged` come from the page, which knows the target and
   * stats the file. The worker chooses incremental or full from them and from the document (see saveCore.ts).
   */
  | { op: 'save'; samePath: boolean; diskUnchanged: boolean; dropEncryption?: boolean };

export type RequestBody =
  | { op: 'init'; module: WebAssembly.Module }
  | { op: 'open'; bytes: ArrayBuffer; password?: string }
  | { op: 'render'; args: RenderArgs }
  /** `expects` holds the "uid@rev" of each page read, in order. A page whose content changed cancels the read. */
  | { op: 'text'; from: number; count: number; expects?: string[] }
  /** Reads a PDF as a source for insertFrom and replace. The source lives in this worker until detached. */
  | { op: 'attachSource'; bytes: ArrayBuffer; password?: string }
  | { op: 'detachSource'; sourceDocId: string }
  /** The display size of page `page` (0-based) of an attached source, in points. For "Fit to page" in the Compare sheet. */
  | { op: 'sourceSize'; sourceDocId: string; page: number }
  /** Copies the pages into a new document and returns its bytes. */
  | { op: 'extract'; uids: PageUid[]; dropEncryption?: boolean; password?: string }
  | { op: 'outline' }
  | { op: 'metadata' }
  | { op: 'stats' }
  /** One fingerprint per page, in order (see pageFingerprint.ts). Used to check saved bytes after they are reopened. */
  | { op: 'fingerprints' }
  | { op: 'close' }
  /**
   * Cancels request `target`. A job still queued is removed and never runs. A job already running is not
   * interrupted: its result is dropped when it finishes, and nothing it did is undone. A long text job checks
   * for cancellation between pages, so it stops early.
   */
  | { op: 'cancel'; target: number }
  /** Internal: the worker computes sizes for pages [from, from + count) and posts a `sizes` event. */
  | { op: 'sizes'; from: number; count: number }
  | EditBody;

export type Op = RequestBody['op'];

export type Request = { id: number; pri: Priority; baseVersion?: number } & RequestBody;

export type Reply =
  | { id: number; ok: true; version: number; result: unknown }
  | { id: number; ok: false; version: number; error: { kind: ErrorKind; message: string } };

export type WorkerEvent =
  /**
   * The document's pages after an open or an edit: one event per change, with the uid and rev of each page in order.
   * `sizes` (three numbers per page, as the sizes event) is present after an edit; the open sends the sizes separately.
   */
  | { event: 'pages'; version: number; uids: string[]; revs: number[]; sizes?: Float32Array; history: HistoryState }
  /**
   * Sizes for pages from `from` on, as triples of width, height and the page's own rotation. `failed` lists the page indices
   * (absolute) that could not be measured and carry the fallback size (see workerJobs.ts); absent when none failed.
   */
  | { event: 'sizes'; from: number; sizes: Float32Array; failed?: number[] }
  /**
   * Progress of a long edit: `done` of `total` pages, under `label`. Sent only for an edit over 100 pages or running
   * for over 2 s. `requestId` is the request it belongs to. It is not `id`: a message with an `id` is read as a reply.
   */
  | { event: 'progress'; requestId: number; label: string; done: number; total: number }
  /** The undo state changed without the pages changing (a save that did not reach the disk stops earlier steps being undone). */
  | { event: 'history'; history: HistoryState };

export type FromWorker = Reply | WorkerEvent;

export function isReply(message: FromWorker): message is Reply {
  return 'id' in message;
}

let lastRequestId = 0;

/** A request id, unique within this page and increasing. Replies are matched to requests by it. */
export function nextRequestId(): number {
  lastRequestId += 1;
  return lastRequestId;
}

/** Counts the document's versions. Each edit bumps it, and a reply reports the version it was made at. */
export class VersionCounter {
  private value = 0;

  get current(): number {
    return this.value;
  }

  bump(): number {
    this.value += 1;
    return this.value;
  }
}

/** Throws `Conflict` when an edit was made against a version that is no longer current. */
export function checkBaseVersion(current: number, baseVersion: number | undefined): void {
  if (baseVersion !== undefined && baseVersion !== current) {
    throw new WorkerFault('Conflict', `Document is at version ${current}, edit was made at ${baseVersion}`);
  }
}

/**
 * Jobs waiting for the worker. Lowest priority number first, first in first out within a priority.
 * A cancelled job is removed, so it can never run.
 */
export class JobQueue<T extends { id: number; pri: number }> {
  private readonly items: Array<{ job: T; seq: number }> = [];
  private seq = 0;

  get size(): number {
    return this.items.length;
  }

  push(job: T): void {
    this.items.push({ job, seq: this.seq });
    this.seq += 1;
  }

  /** Removes and returns the most urgent job, or undefined when the queue is empty. */
  take(): T | undefined {
    let best = -1;
    for (let i = 0; i < this.items.length; i++) {
      const candidate = this.items[i];
      if (!candidate) continue;
      const current = best >= 0 ? this.items[best] : undefined;
      if (!current || candidate.job.pri < current.job.pri || (candidate.job.pri === current.job.pri && candidate.seq < current.seq)) {
        best = i;
      }
    }
    if (best < 0) return undefined;
    const [entry] = this.items.splice(best, 1);
    return entry?.job;
  }

  /** Removes every queued job that matches. Returns them, in queue order. */
  removeWhere(predicate: (job: T) => boolean): T[] {
    const removed: T[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const entry = this.items[i];
      if (entry && predicate(entry.job)) {
        this.items.splice(i, 1);
        removed.unshift(entry.job);
      }
    }
    return removed;
  }

  /** Removes the queued job with this id. Returns it, or undefined when it is not queued (already running or done). */
  cancel(target: number): T | undefined {
    const at = this.items.findIndex((entry) => entry.job.id === target);
    if (at < 0) return undefined;
    const [entry] = this.items.splice(at, 1);
    return entry?.job;
  }
}
