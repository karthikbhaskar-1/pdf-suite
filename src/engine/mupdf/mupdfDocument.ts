/**
 * The MuPDF implementation of EngineDocument. One document is one worker. Page sizes arrive as worker events,
 * and text is read in batches, so a search does a few round trips rather than one per page.
 */
import { parsePdfDate } from '../fileInfo';
import { MAX_EDIT_BYTES } from './fileLimitBytes';
import { bitmapReport } from '../memoryReport';
import { SizedLru } from '../lru';
import { knobs } from '../testKnobs';
import { Priority as ScheduleLane, abortError, renderScheduler } from '../renderScheduler';
import type { DocumentCapabilities, DocumentMetadata, EngineDocument, OutlineItem, OpenOptions, PageSize, RenderOptions, TextRun } from '../types';
import { WorkerClient, liveWorkerClients } from './client';
import {
  Priority,
  type EditOutcome,
  type MetadataResult,
  type OpenResult,
  type OutlineNode,
  type XfaFacts,
  type PageEdit,
  type PageTextData,
  type RunData,
  type SaveOutcome,
  type WorkerEvent,
} from './protocol';

/** The `pages` event: the page list after an open or an edit. */
export type PagesEvent = Extract<WorkerEvent, { event: 'pages' }>;
/** The `progress` event of a long edit. */
export type ProgressEvent = Extract<WorkerEvent, { event: 'progress' }>;
import { workerPool } from './pool';
import { buildTextLayer, rotateRun } from './textLayer';

/** Pages whose text one request reads. The batch is one job in the worker. */
const TEXT_BATCH = 16;
/** Text runs kept in memory, by estimated bytes. A page that was evicted is read again in one batch. */
const TEXT_CACHE_BYTES = 16 * 1024 * 1024;

/**
 * Estimated memory of a page's text runs: the characters (UTF-16), the packed boundaries (4 bytes for each character and one
 * more for each run, the page's array counted once per run it serves) and each run's own fields.
 */
export function runsBytes(runs: readonly RunData[]): number {
  let bytes = 64;
  for (const run of runs) bytes += 128 + run.text.length * 6 + 4;
  return bytes;
}

/** Each document has its own prefix for scheduler keys, so closing it cancels only its own text jobs. */
let documentSeq = 0;
/** Text layers are built once the viewer has been still this long, so fast scrolling builds none. */
const LAYER_SETTLE_MS = knobs.layerSettleMs;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody may be waiting on every page, so an unobserved rejection is not an error.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Every open MuPDF document, for the WASM heap test hook below. */
let generationSeq = 0;
const openDocuments = new Set<MupdfDocument>();

export class MupdfDocument implements EngineDocument {
  private count: number;
  readonly capabilities: DocumentCapabilities;
  readonly isEncrypted: boolean;
  private sizes: Array<Deferred<PageSize>>;
  /** Told each time the page list changes (an open, an edit, an undo or a redo). */
  private readonly pageListeners = new Set<(event: PagesEvent) => void>();
  private readonly progressListeners = new Set<(event: ProgressEvent) => void>();
  /** The last page list, so a listener that subscribes later still gets the current one. */
  private lastPages: PagesEvent | null = null;
  /** Text runs of pages already read, keyed by the page's "uid@rev", least recently used first, within TEXT_CACHE_BYTES. */
  private readonly runCache = new SizedLru<RunData[]>(TEXT_CACHE_BYTES);
  /** Pages whose batch is queued or running, keyed by "uid@rev". */
  private readonly pendingRuns = new Map<string, Promise<RunData[]>>();
  private readonly jobPrefix = `mupdf-${++documentSeq}|`;
  /** Text layers waiting for the viewer to settle. One per container: the newest request wins. */
  private readonly layerQueue = new Map<HTMLElement, { index: number; rotation: number; scale: number; done: (cleanup: () => void) => void }>();
  private layerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly client: WorkerClient,
    opened: { pages: number; encrypted: boolean; xfa?: XfaFacts; viewOnly?: boolean },
  ) {
    this.count = opened.pages;
    this.isEncrypted = opened.encrypted;
    // A form MuPDF can only show as XFA is not edited (the worker refuses edits for it too). Nor is a file over the edit limit.
    const viewOnly = opened.viewOnly === true;
    this.capabilities = { canEdit: !viewOnly && !(opened.xfa?.xfaPresent || opened.xfa?.needsRendering), htmlLayer: false, ...(viewOnly ? { viewOnly: true } : {}) };
    this.sizes = Array.from({ length: opened.pages }, () => deferred<PageSize>());
    openDocuments.add(this);
    client.onEvent((event: WorkerEvent) => {
      if (event.event === 'sizes') this.acceptSizes(event.from, event.sizes);
      else if (event.event === 'pages') this.acceptPages(event);
      else if (event.event === 'history') this.acceptHistory(event.history);
      else if (event.event === 'progress') for (const listener of this.progressListeners) listener(event);
    });
  }

  /**
   * One number per document instance (one worker), never reused in the app's life. Cache keys carry it, because a new
   * worker starts its uids at 0 again: without it a save or a reload would find the old worker's bitmaps by key.
   */
  readonly generation = ++generationSeq;

  get pageCount(): number {
    return this.count;
  }

  /** The document version the worker reported last (0 before the first page list). Edits name it as their base. */
  get version(): number {
    return this.lastPages?.version ?? 0;
  }

  /**
   * Applies page edits as one step. `baseVersion` is the version the edits were made against: a stale one is a
   * Conflict, and nothing changes. Resolves with the new version and the undo state.
   */
  applyEdits(edits: PageEdit[], baseVersion: number, options: { signal?: AbortSignal; uidSeed?: number } = {}): Promise<EditOutcome> {
    return this.client.request<EditOutcome>({ op: 'apply', baseVersion, edits, uidSeed: options.uidSeed }, Priority.Visible, { signal: options.signal, settleOnAbort: true });
  }

  /**
   * Calls `listener` with the progress of a long edit (over 100 pages or 2 s). Returns the unsubscribe function.
   */
  onProgress(listener: (event: ProgressEvent) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  /**
   * The page at this index as "uid@rev", in the page list the document last reported. A page's rev changes with its
   * content, so this names one content for the life of the worker. Caches and requests use it.
   */
  contentOf(index: number): string {
    const last = this.lastPages;
    if (!last) return `${index}@0`;
    return `${last.uids[index]}@${last.revs[index]}`;
  }

  /** Reads a PDF as a source for insertFrom and replace. Resolves with the source id, which lives until detached. */
  attachSource(bytes: ArrayBuffer, password?: string): Promise<{ sourceDocId: string; pages: number; xfa: XfaFacts }> {
    return this.client.request({ op: 'attachSource', bytes, password }, Priority.Visible, { transfer: [bytes] });
  }

  /** The display size of a page of an attached source, in points. */
  sourceSize(sourceDocId: string, page: number): Promise<{ width: number; height: number }> {
    return this.client.request({ op: 'sourceSize', sourceDocId, page }, Priority.Visible);
  }

  detachSource(sourceDocId: string): Promise<unknown> {
    return this.client.request({ op: 'detachSource', sourceDocId }, Priority.Visible);
  }

  /** The pages with these uids, as a new PDF. Resolves with its bytes. */
  extract(uids: string[], options: { dropEncryption?: boolean; password?: string } = {}): Promise<ArrayBuffer> {
    return this.client
      .request<{ bytes: ArrayBuffer }>({ op: 'extract', uids, dropEncryption: options.dropEncryption, password: options.password }, Priority.Visible)
      .then((out) => out.bytes);
  }

  undo(): Promise<EditOutcome> {
    return this.client.request<EditOutcome>({ op: 'undo' }, Priority.Visible);
  }

  /** Takes back the latest step as if it had never been made: no redo step is left. */
  discardLast(): Promise<EditOutcome> {
    return this.client.request<EditOutcome>({ op: 'discardLast' }, Priority.Visible);
  }

  redo(): Promise<EditOutcome> {
    return this.client.request<EditOutcome>({ op: 'redo' }, Priority.Visible);
  }

  /** A fingerprint of each page, in order. A save checks the bytes it produced against these once they are reopened. */
  fingerprints(): Promise<number[]> {
    return this.client.request<number[]>({ op: 'fingerprints' }, Priority.Visible);
  }

  /** Saves to bytes. See MupdfCore.save for the choice of incremental or full. */
  save(samePath: boolean, diskUnchanged: boolean, dropEncryption = false): Promise<SaveOutcome> {
    return this.client.request<SaveOutcome>({ op: 'save', samePath, diskUnchanged, dropEncryption }, Priority.Visible);
  }

  /**
   * Calls `listener` with each new page list, and at once with the current one when there is one. Returns the
   * unsubscribe function.
   */
  onPages(listener: (event: PagesEvent) => void): () => void {
    this.pageListeners.add(listener);
    if (this.lastPages) listener(this.lastPages);
    return () => {
      this.pageListeners.delete(listener);
    };
  }

  pageSize(index: number): Promise<PageSize> {
    this.checkIndex(index);
    return this.sizes[index]!.promise;
  }

  renderBitmap(index: number, options: RenderOptions): Promise<ImageBitmap> {
    this.checkIndex(index);
    return this.client.request<ImageBitmap>(
      { op: 'render', args: { page: index, expect: this.contentOf(index), scale: options.scale, rotation: options.rotation, region: options.region, overlay: options.overlay } },
      Priority.Visible,
      { signal: options.signal },
    );
  }

  /**
   * Resolves with the cleanup of a text layer built once scrolling has settled. While the viewer is still
   * moving, nothing is built. A container that left the page before then gets no layer.
   */
  renderTextLayer(index: number, container: HTMLElement, options: { scale: number; rotation: number }): Promise<() => void> {
    return new Promise((resolve) => {
      this.layerQueue.get(container)?.done(() => undefined);
      this.layerQueue.set(container, { index, rotation: options.rotation, scale: options.scale, done: resolve });
      clearTimeout(this.layerTimer);
      this.layerTimer = setTimeout(() => void this.flushLayers(), LAYER_SETTLE_MS);
    });
  }

  private async flushLayers(): Promise<void> {
    const jobs = [...this.layerQueue.entries()];
    this.layerQueue.clear();
    for (const [container, job] of jobs) {
      if (!container.isConnected) {
        job.done(() => undefined);
        continue;
      }
      try {
        const runs = await this.pageText(job.index, job.rotation);
        job.done(buildTextLayer(container, runs, job.scale));
      } catch {
        job.done(() => undefined);
      }
    }
  }

  async pageText(index: number, rotation: number): Promise<TextRun[]> {
    this.checkIndex(index);
    const [size, runs] = await Promise.all([this.pageSize(index), this.runsOf(index)]);
    // A copy per call: a run handed out is the caller's own, and the cached one keeps only text, geometry and the packed boundaries.
    return runs.map((run) => rotateRun({ ...run }, size.width, size.height, rotation));
  }

  async outline(): Promise<OutlineItem[]> {
    const nodes = await this.client.request<OutlineNode[]>({ op: 'outline' }, Priority.Visible);
    const convert = (list: OutlineNode[]): OutlineItem[] =>
      list.map((node) => ({ title: node.title, pageIndex: node.page, children: convert(node.children) }));
    return convert(nodes);
  }

  async metadata(): Promise<DocumentMetadata> {
    const result = await this.client.request<MetadataResult>({ op: 'metadata' }, Priority.Visible);
    const info = result.info;
    const text = (key: string): string | undefined => info[key];
    return {
      title: text('Title'),
      author: text('Author'),
      subject: text('Subject'),
      keywords: text('Keywords'),
      creator: text('Creator'),
      producer: text('Producer'),
      created: parsePdfDate(text('CreationDate')),
      modified: parsePdfDate(text('ModDate')),
      pdfVersion: result.pdfVersion,
    };
  }

  /** Bytes of WASM memory this document's worker has allocated. */
  async wasmHeapBytes(): Promise<number> {
    const stats = await this.client.request<{ wasmHeapBytes: number }>({ op: 'stats' }, Priority.Visible);
    return stats.wasmHeapBytes;
  }

  /** DIAGNOSTICS ONLY (1.2.1 probe): the worker's full stats (heap, journal, queue, recent jobs). */
  workerStats(): Promise<unknown> {
    return this.client.request<unknown>({ op: 'stats' }, Priority.Visible);
  }

  /** Bytes of text runs held for this document (the run cache is byte-capped). */
  get textCacheBytes(): number {
    return this.runCache.bytes;
  }

  /**
   * Calls `handler` when the document's worker has stopped answering while requests wait (see WorkerClient.watchSilence). Nothing
   * is ended: the page asks the user (Wait or Reopen).
   */
  onUnresponsive(handler: () => void): void {
    this.client.watchSilence(handler);
  }

  async destroy(): Promise<void> {
    openDocuments.delete(this);
    renderScheduler.cancelWhere((key) => key.startsWith(this.jobPrefix));
    for (const entry of this.sizes) entry.reject(abortError());
    await this.client.shutdown();
  }

  /**
   * A new page list. Indices have moved, so everything keyed by index is dropped: the sizes, the text runs and the text
   * batches still in flight. Each page's size is then known from the event, so the new sizes resolve at once.
   */
  private acceptPages(event: PagesEvent): void {
    this.lastPages = event;
    this.count = event.uids.length;
    for (const entry of this.sizes) entry.reject(abortError());
    this.sizes = Array.from({ length: this.count }, () => deferred<PageSize>());
    if (event.sizes) this.acceptSizes(0, event.sizes);
    this.runCache.deleteWhere(() => true);
    this.pendingRuns.clear();
    renderScheduler.cancelWhere((key) => key.startsWith(`${this.jobPrefix}text|`));
    for (const listener of this.pageListeners) listener(event);
  }

  /** The undo state changed with the same pages: listeners get the page list again with the new state. */
  private acceptHistory(history: PagesEvent['history']): void {
    if (!this.lastPages) return;
    this.lastPages = { ...this.lastPages, history };
    for (const listener of this.pageListeners) listener(this.lastPages);
  }

  private acceptSizes(from: number, sizes: Float32Array): void {
    for (let i = 0; i * 3 < sizes.length; i++) {
      const entry = this.sizes[from + i];
      if (!entry) continue;
      entry.resolve({ width: sizes[i * 3] ?? 0, height: sizes[i * 3 + 1] ?? 0, rotation: sizes[i * 3 + 2] ?? 0 });
    }
  }

  /**
   * Text runs of one page, in the page's own display space. A page not yet read is read in a batch that starts at
   * this page. The batch is a job on the render scheduler, at text priority, so a scrolling viewer's text does not
   * wait behind pages that have left the screen, and a cancelled batch is dropped before it reaches the worker.
   */
  private runsOf(index: number): Promise<RunData[]> {
    // Keyed by content, so runs read for an old version of a page are never served for the new one.
    const content = this.contentOf(index);
    const cached = this.runCache.get(content);
    if (cached) return Promise.resolve(cached);
    const pending = this.pendingRuns.get(content);
    if (pending) return pending;
    const count = Math.min(TEXT_BATCH, this.pageCount - index);
    const contents = Array.from({ length: count }, (_unused, i) => this.contentOf(index + i));
    const job = renderScheduler.schedule(`${this.jobPrefix}text|${index}`, ScheduleLane.Text, (signal) =>
      this.client.request<PageTextData[]>({ op: 'text', from: index, count, expects: contents }, Priority.Prefetch, { signal }),
    );
    for (let i = 0; i < count; i++) {
      const pageContent = contents[i]!;
      const entry: Promise<RunData[]> = job.promise
        .then((list) => {
          const runs = list[i]?.runs ?? [];
          this.runCache.set(pageContent, runs, runsBytes(runs));
          return runs;
        })
        // A failed or cancelled batch must not stay pending, or the page would never be read again.
        .finally(() => {
          if (this.pendingRuns.get(pageContent) === entry) this.pendingRuns.delete(pageContent);
        });
      // Nobody waits on every page of a batch, so an unobserved rejection is not an error.
      entry.catch(() => undefined);
      this.pendingRuns.set(pageContent, entry);
    }
    return this.pendingRuns.get(content)!;
  }

  private checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) {
      throw new RangeError(`Page ${index} is not in this document`);
    }
  }
}

/** One opened MuPDF worker, before the router decides whether it keeps the document. */
export interface MupdfSession {
  readonly xfa: OpenResult['xfa'];
  /** The bytes handed back from the worker. */
  readonly bytes: ArrayBuffer;
  /** Keeps the document. Call once. */
  document(): EngineDocument;
  /** Gives the worker back without keeping the document. Call instead of `document()`. */
  discard(): void;
}

/**
 * Opens bytes in a worker. Throws the typed open errors (PasswordNeeded, WrongPassword, Corrupt). The
 * caller's bytes are copied, so the caller keeps them.
 */
export async function openMupdf(bytes: Uint8Array, options: OpenOptions): Promise<MupdfSession> {
  options.onProgress?.(0);
  const client = await workerPool.take();
  const copy = bytes.slice().buffer;
  let opened: OpenResult;
  try {
    opened = await client.request<OpenResult>(
      { op: 'open', bytes: copy, password: options.password },
      Priority.Visible,
      { transfer: [copy] },
    );
  } catch (error) {
    client.terminate();
    throw error;
  }
  options.onProgress?.(1);
  return {
    xfa: opened.xfa,
    bytes: opened.bytes,
    // A file over the edit limit opens view-only (see core/fileLimits.ts); the size is the bytes this open was given.
    document: () => new MupdfDocument(client, { ...opened, viewOnly: bytes.byteLength > MAX_EDIT_BYTES }),
    discard: () => client.terminate(),
  };
}

/**
 * Test hook (read only): the WASM heap size, in bytes, of each open MuPDF document. The memory loop reads it.
 */
if (typeof window !== 'undefined' && window.__pdfSuiteTestMode === true) {
  (window as unknown as { __pdfSuiteEngine?: unknown }).__pdfSuiteEngine = {
    wasmHeapBytes: () => Promise.all([...openDocuments].map((doc) => doc.wasmHeapBytes())),
    /** DIAGNOSTICS ONLY (1.2.1 probe): live workers, open documents, and each document's worker stats. */
    diag: async () => ({
      liveWorkers: liveWorkerClients.size,
      openDocuments: openDocuments.size,
      renderQueue: renderScheduler.pendingCount,
      docs: await Promise.all([...openDocuments].map(async (doc) => ({ generation: doc.generation, version: doc.version, pages: doc.pageCount, stats: await doc.workerStats() }))),
    }),
    /** Where the renderer's memory goes: bitmap bytes by kind, text runs, the JS heap and each WASM heap. */
    memory: async () => {
      const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
      return {
        bitmaps: bitmapReport(),
        textCacheBytes: [...openDocuments].reduce((sum, doc) => sum + doc.textCacheBytes, 0),
        jsHeapBytes: perf.memory?.usedJSHeapSize ?? null,
        wasmHeapBytes: await Promise.all([...openDocuments].map((doc) => doc.wasmHeapBytes())),
      };
    },
  };
}
