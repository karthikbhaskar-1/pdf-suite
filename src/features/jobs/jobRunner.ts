/**
 * The page side of a batch job: it owns the job worker (started for one dialog or job, terminated when it ends), moves the
 * worker's output to the main process in acknowledged chunks, and turns every ending into one of three outcomes:
 * done (the files exist), cancelled, or failed (nothing exists). It never keeps a file: bytes pass through.
 *
 *  - `JobWorkerClient` speaks the protocol of jobProtocol.ts to a worker (a real Worker, or in tests a JobSession in-process).
 *  - `runSplit` runs one split: begin (main checks the folder token and the free space), the worker's files written through
 *    openFile / append / closeFile, a check that the source file did not change, commit (main gives the files their names in
 *    one step). On any other ending main removes what it created (abort).
 *  - A job that sends no message for 120 s is terminated (a worker that hangs). After Cancel the worker has 2 s to answer
 *    before it is terminated.
 */
import {
  JOB_CANCEL_GRACE_MS,
  JOB_SILENCE_MS,
  type AnalysisResult,
  type CombineSpec,
  type FromJob,
  type InputKind,
  type JobErrorKind,
  type JobNote,
  type PageDims,
  type SplitSpec,
  type ToJob,
} from '../../engine/mupdf/jobProtocol';
import type { JobFailReason, JobResultFile, PdfSuiteApi } from '../../platform/desktop/contract';

/** The part of a Worker the client uses. A test passes an in-process session. */
export interface WorkerLike {
  postMessage(message: ToJob, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: FromJob }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type ProbedFacts = Extract<FromJob, { t: 'probed' }>;

/** A job error: the worker's kind, or one of the page's own endings. */
export class JobError extends Error {
  constructor(
    readonly kind: JobErrorKind | 'Stopped' | 'MainFailure',
    readonly info: { item?: number; page?: number; limit?: number; reason?: JobFailReason; drive?: string; detail?: string } = {},
  ) {
    super(info.detail ?? kind);
    this.name = 'JobError';
  }
}

interface Waiter {
  onMessage: (message: FromJob) => void;
  fail: (error: JobError) => void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export class JobWorkerClient {
  private nextId = 1;
  private readonly waiters = new Map<number, Waiter>();
  private closed = false;
  private silence: unknown = null;
  private cancelTimer: unknown = null;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: JobError) => void;

  constructor(
    private readonly worker: WorkerLike,
    private readonly timers: Timers = realTimers,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A rejection nobody awaits yet (init is not called) is not an unhandled one.
    this.ready.catch(() => undefined);
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = () => this.failAll(new JobError('Internal', { detail: 'The job worker stopped unexpectedly' }));
  }

  /** Starts the worker with the compiled engine and resolves when it is ready. */
  async init(module: WebAssembly.Module): Promise<void> {
    this.worker.postMessage({ t: 'init', module });
    await this.ready;
  }

  /** Marks the worker ready without an init (a test session is ready at once). */
  markReady(): void {
    this.resolveReady();
  }

  /** Reads a file the page got from main. The bytes move to the worker; the page keeps nothing. */
  probe(bytes: ArrayBuffer, password?: string): Promise<ProbedFacts> {
    return this.probeInput('pdf', bytes, { ...(password !== undefined ? { password } : {}) });
  }

  /** Reads an input of any kind (Combine). `item` is the list row, which a later `thumb` names. */
  probeInput(
    kind: InputKind,
    bytes: ArrayBuffer,
    options: { password?: string; item?: number; imagePage?: 'image' | PageDims; textPage?: PageDims; preview?: boolean } = {},
  ): Promise<ProbedFacts> {
    return this.request((id) => ({ t: 'probe', id, kind, bytes, ...options }), [bytes], (message, done) => {
      if (message.t === 'probed') done(message);
    });
  }

  /** A preview of page `page` (0-based) of the input probed last, which must be row `item`. RGBA pixels. */
  thumb(item: number, page: number, maxPx: number): Promise<{ width: number; height: number; pixels: ArrayBuffer }> {
    return this.request((id) => ({ t: 'thumb', id, item, page, maxPx }), [], (message, done) => {
      if (message.t === 'thumbed') done({ width: message.width, height: message.height, pixels: message.pixels });
    });
  }

  /** The blank-page search or the bookmark list of the probed file. `onProgress` gets done and total. */
  analyse(what: 'blank' | 'outline', onProgress?: (done: number, total: number) => void): { promise: Promise<AnalysisResult>; cancel: () => void } {
    let jobId = 0;
    const promise = this.request<AnalysisResult>(
      (id) => {
        jobId = id;
        return { t: 'analyse', id, what };
      },
      [],
      (message, done) => {
        if (message.t === 'progress') onProgress?.(message.done, message.total);
        else if (message.t === 'analysed') done(message.result);
      },
    );
    return { promise, cancel: () => this.cancel(jobId) };
  }

  /**
   * Runs a split on the probed file. `sink` receives the worker's output in order and each call resolves when main has taken
   * the data; the chunk is acknowledged to the worker after that, so the worker never runs ahead of the disk.
   */
  run(spec: SplitSpec | CombineSpec, sink: RunSink): { promise: Promise<{ files: number; pages: number; notes: JobNote[] }>; cancel: () => void } {
    let jobId = 0;
    let chain: Promise<void> = Promise.resolve();
    const promise = this.request<{ files: number; pages: number; notes: JobNote[] }>(
      (id) => {
        jobId = id;
        return { t: 'start', id, spec };
      },
      [],
      (message, done, fail) => {
        // Output is handled one message at a time, in order: the worker posts `file` and its first chunk back to back.
        const handle = (action: () => Promise<void>) => {
          chain = chain.then(action).catch((error) => {
            fail(error instanceof JobError ? error : new JobError('Internal', { detail: String(error) }));
          });
        };
        switch (message.t) {
          case 'progress':
            sink.onProgress(message.phase, message.done, message.total, message.unit);
            break;
          case 'need':
            // Combine: the worker asks for input `index`; the page reads the file and hands the bytes over.
            handle(async () => {
              if (!sink.onNeed) throw new JobError('Internal', { detail: 'unexpected need' });
              const bytes = await sink.onNeed(message.index);
              this.send({ t: 'input', id: message.id, index: message.index, bytes }, [bytes]);
            });
            break;
          case 'file':
            handle(() => sink.onFile(message.file, message.leafName));
            break;
          case 'chunk':
            handle(async () => {
              await sink.onChunk(message.file, message.seq, message.bytes);
              this.send({ t: 'ack', id: message.id, file: message.file, seq: message.seq });
            });
            break;
          case 'fileEnd':
            handle(() => sink.onFileEnd(message.file, message.byteLength));
            break;
          case 'done':
            // `done` comes after the last fileEnd; the chain makes sure main has every file before the caller commits.
            handle(async () => done({ files: message.files, pages: message.pages, notes: message.notes }));
            break;
        }
      },
    );
    return { promise, cancel: () => this.cancel(jobId) };
  }

  /** Tells the worker to stop. If it has not answered in JOB_CANCEL_GRACE_MS it is terminated and the job ends as cancelled. */
  cancel(id: number): void {
    if (this.closed || id === 0) return;
    this.send({ t: 'cancel', id });
    if (this.cancelTimer === null) {
      this.cancelTimer = this.timers.setTimeout(() => {
        this.cancelTimer = null;
        this.failAll(new JobError('Cancelled'));
        this.terminate();
      }, JOB_CANCEL_GRACE_MS);
    }
  }

  /** Ends the worker now. Its WASM memory goes with it. */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.worker.terminate();
    this.failAll(new JobError('Cancelled'));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  private request<T>(
    make: (id: number) => ToJob,
    transfer: Transferable[],
    onMessage: (message: FromJob, done: (value: T) => void, fail: (error: JobError) => void) => void,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new JobError('Cancelled'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        this.waiters.delete(id);
        if (this.waiters.size === 0) this.clearTimers();
      };
      const done = (value: T) => {
        finish();
        resolve(value);
      };
      const fail = (error: JobError) => {
        finish();
        reject(error);
      };
      this.waiters.set(id, {
        onMessage: (message) => {
          if (message.t === 'error') {
            fail(new JobError(message.kind, { ...(message.item !== undefined ? { item: message.item } : {}), ...(message.page !== undefined ? { page: message.page } : {}), ...(message.limit !== undefined ? { limit: message.limit } : {}), ...(message.detail !== undefined ? { detail: message.detail } : {}) }));
            return;
          }
          onMessage(message, done, fail);
        },
        fail,
      });
      this.armSilence();
      this.send(make(id), transfer);
    });
  }

  private send(message: ToJob, transfer: Transferable[] = []): void {
    if (!this.closed) this.worker.postMessage(message, transfer);
  }

  private receive(message: FromJob): void {
    if (message.t === 'ready') {
      this.resolveReady();
      return;
    }
    if (message.t === 'error' && message.id === 0) {
      // The worker could not start (its engine did not load): init and every request fail, instead of waiting for ready.
      const error = new JobError(message.kind, message.detail !== undefined ? { detail: message.detail } : {});
      this.rejectReady(error);
      this.failAll(error);
      return;
    }
    this.armSilence();
    const waiter = this.waiters.get((message as { id: number }).id);
    waiter?.onMessage(message);
  }

  /** Any message restarts the clock. 120 s without one ends the job as "stopped responding". */
  private armSilence(): void {
    if (this.silence !== null) this.timers.clearTimeout(this.silence);
    this.silence = this.waiters.size === 0 ? null : this.timers.setTimeout(() => {
      this.silence = null;
      this.failAll(new JobError('Stopped'));
      this.terminate();
    }, JOB_SILENCE_MS);
  }

  private clearTimers(): void {
    if (this.silence !== null) this.timers.clearTimeout(this.silence);
    if (this.cancelTimer !== null) this.timers.clearTimeout(this.cancelTimer);
    this.silence = null;
    this.cancelTimer = null;
  }

  private failAll(error: JobError): void {
    for (const waiter of [...this.waiters.values()]) waiter.fail(error);
    this.waiters.clear();
  }
}

/** What a run hands the page's output to. Each call resolves when main has the data. */
export interface RunSink {
  onProgress(phase: Extract<FromJob, { t: 'progress' }>['phase'], done: number, total: number, unit: 'files' | 'pages'): void;
  /** Combine: the bytes of input `index`. May throw a JobError (the file changed, or cannot be read). */
  onNeed?(index: number): Promise<ArrayBuffer>;
  onFile(file: number, leafName: string): Promise<void>;
  onChunk(file: number, seq: number, bytes: ArrayBuffer): Promise<void>;
  onFileEnd(file: number, byteLength: number): Promise<void>;
}

// ---- One split run ----------------------------------------------------------------------------------------------------------

export type JobBridge = PdfSuiteApi['jobs'] & { stat(path: string): Promise<{ size: number; modified: number } | null> };

export type SplitOutcome =
  | { status: 'done'; files: JobResultFile[]; pages: number; notes: JobNote[] }
  | { status: 'cancelled' }
  | { status: 'failed'; error: JobError };

export interface SplitRunParams {
  worker: JobWorkerClient;
  bridge: JobBridge;
  folderToken: string;
  /** The saved file the split reads, and its size and modified time when it was read. */
  source: { path: string; size: number; modified: number };
  spec: SplitSpec;
  onProgress: RunSink['onProgress'];
  /** Gives the caller the cancel function as soon as the run has started. */
  onStart?: (cancel: () => void) => void;
  /**
   * True once the user pressed Cancel. Checked before the worker starts, and again after it finishes and before the source is
   * checked and the files are committed: a Cancel that comes when there is no worker call to stop still ends the job, and no
   * file is created.
   */
  isCancelled?: () => boolean;
}

/** Wraps a main-process failure as an error of the run. */
function mainFailure(result: { reason: JobFailReason; drive?: string }): JobError {
  return new JobError('MainFailure', { reason: result.reason, ...(result.drive !== undefined ? { drive: result.drive } : {}) });
}

/**
 * Runs one split from begin to commit. Whatever the ending, main is told to abort unless it committed, and the caller decides
 * what happens to the worker (a failed run keeps it only for CannotKeepPassword, which makes no file).
 */
export async function runSplit(params: SplitRunParams): Promise<SplitOutcome> {
  const { worker, bridge, source } = params;
  const begun = await bridge.begin({ folderToken: params.folderToken }, [source.path]);
  if (!begun.ok) return { status: 'failed', error: mainFailure(begun) };
  const token = begun.jobToken;
  const stop = () => {
    if (params.isCancelled?.()) throw new JobError('Cancelled');
  };
  const fileIds = new Map<number, number>();
  let committed = false;
  let keepsWorker = false;
  try {
    stop();
    const run = worker.run(params.spec, {
      onProgress: params.onProgress,
      async onFile(file, leafName) {
        const opened = await bridge.openFile(token, leafName);
        if (!opened.ok) throw mainFailure(opened);
        fileIds.set(file, opened.fileId);
      },
      async onChunk(file, seq, bytes) {
        const id = fileIds.get(file);
        if (id === undefined) throw new JobError('Internal', { detail: 'chunk before file' });
        const written = await bridge.append(token, id, seq, bytes);
        if (!written.ok) throw mainFailure(written);
      },
      async onFileEnd(file, byteLength) {
        const id = fileIds.get(file);
        if (id === undefined) throw new JobError('Internal', { detail: 'fileEnd before file' });
        const closed = await bridge.closeFile(token, id, byteLength);
        if (!closed.ok) throw mainFailure(closed);
      },
    });
    params.onStart?.(run.cancel);
    // A Cancel pressed before onStart had a function to call reaches the worker now.
    if (params.isCancelled?.()) run.cancel();
    let finished: { files: number; pages: number; notes: JobNote[] };
    try {
      finished = await run.promise;
    } catch (error) {
      if (error instanceof JobError && error.kind === 'MainFailure') run.cancel();
      throw error;
    }
    // Cancel pressed while the last file was being written, or while the source is checked: nothing is committed.
    stop();
    // The source must still be the file that was split.
    const now = await bridge.stat(source.path);
    if (!now || now.size !== source.size || now.modified !== source.modified) throw new JobError('InputChanged');
    stop();
    const committedResult = await bridge.commit(token);
    if (!committedResult.ok) throw mainFailure(committedResult);
    committed = true;
    return { status: 'done', files: committedResult.results, pages: finished.pages, notes: finished.notes };
  } catch (error) {
    if (error instanceof JobError && error.kind === 'Cancelled') return { status: 'cancelled' };
    keepsWorker = error instanceof JobError && error.kind === 'CannotKeepPassword';
    return { status: 'failed', error: error instanceof JobError ? error : new JobError('Internal', { detail: String(error) }) };
  } finally {
    if (!committed) await bridge.abort(token).catch(() => undefined);
    // The worker's WASM heap never shrinks: ending the worker is what returns it. Only a password that cannot be kept makes no file and
    // leaves the sheet open on its probed file, so that one keeps its worker.
    if (!keepsWorker) worker.terminate();
  }
}

// ---- One combine run --------------------------------------------------------------------------------------------------------------

/** What a combine knows about each input file when the list was made: where it is and what it looked like. */
export interface CombineInputRef {
  path: string;
  size: number;
  modified: number;
}

export interface CombineRunParams {
  worker: JobWorkerClient;
  bridge: JobBridge;
  /** The path the user chose in the Save dialog (write-granted). */
  outputPath: string;
  inputs: CombineInputRef[];
  spec: CombineSpec;
  onProgress: RunSink['onProgress'];
  /** Called once main has accepted the target and the job is about to start (the window can close). */
  onBegun?: () => void;
  onStart?: (cancel: () => void) => void;
  /** True once the user pressed Cancel: checked before the worker starts and again before the commit. */
  isCancelled?: () => boolean;
}

export type CombineOutcome =
  | { status: 'done'; file: JobResultFile; pages: number }
  | { status: 'cancelled' }
  /** `notStarted` is true when main refused the target before anything began: the window stays as it is. */
  | { status: 'failed'; error: JobError; notStarted: boolean };

/**
 * Runs one combine from begin to commit. Main checks the target before anything starts (not an input, not open in a tab, a
 * folder that can be written, free space). Each input is read from main when the worker asks, and compared with its size and
 * modified time from when it was added: a file that changed since is InputChanged, one that is gone is InputUnreadable. Whatever
 * the ending, main is told to abort unless it committed.
 */
export async function runCombine(params: CombineRunParams): Promise<CombineOutcome> {
  const { worker, bridge } = params;
  const begun = await bridge.begin({ pickedPath: params.outputPath }, params.inputs.map((i) => i.path));
  if (!begun.ok) return { status: 'failed', error: mainFailure(begun), notStarted: true };
  params.onBegun?.();
  const token = begun.jobToken;
  let fileId: number | null = null;
  let committed = false;
  const stop = () => {
    if (params.isCancelled?.()) throw new JobError('Cancelled');
  };
  try {
    stop();
    const run = worker.run(params.spec, {
      onProgress: params.onProgress,
      async onNeed(index) {
        const ref = params.inputs[index];
        if (!ref) throw new JobError('Internal', { detail: 'no such input' });
        const read = await bridge.readInput(ref.path);
        if (!read.ok) throw new JobError('InputUnreadable', { item: index });
        if (read.size !== ref.size || read.modified !== ref.modified) throw new JobError('InputChanged', { item: index });
        return read.bytes;
      },
      async onFile(_file, leafName) {
        const opened = await bridge.openFile(token, leafName);
        if (!opened.ok) throw mainFailure(opened);
        fileId = opened.fileId;
      },
      async onChunk(_file, seq, bytes) {
        if (fileId === null) throw new JobError('Internal', { detail: 'chunk before file' });
        const written = await bridge.append(token, fileId, seq, bytes);
        if (!written.ok) throw mainFailure(written);
      },
      async onFileEnd(_file, byteLength) {
        if (fileId === null) throw new JobError('Internal', { detail: 'fileEnd before file' });
        const closed = await bridge.closeFile(token, fileId, byteLength);
        if (!closed.ok) throw mainFailure(closed);
      },
    });
    params.onStart?.(run.cancel);
    // A Cancel pressed before onStart had a function to call reaches the worker now.
    if (params.isCancelled?.()) run.cancel();
    let finished: { files: number; pages: number; notes: JobNote[] };
    try {
      finished = await run.promise;
    } catch (error) {
      // A failure on the page side (main refused a write, an input changed) stops the worker, which would otherwise wait.
      if (error instanceof JobError && error.kind !== 'Cancelled' && error.kind !== 'Stopped') run.cancel();
      throw error;
    }
    // Cancel pressed while the last piece was being written: nothing is committed.
    stop();
    const committedResult = await bridge.commit(token);
    if (!committedResult.ok) throw mainFailure(committedResult);
    committed = true;
    const file = committedResult.results[0];
    if (!file) throw new JobError('Internal', { detail: 'no result' });
    return { status: 'done', file, pages: finished.pages };
  } catch (error) {
    if (error instanceof JobError && error.kind === 'Cancelled') return { status: 'cancelled' };
    return { status: 'failed', error: error instanceof JobError ? error : new JobError('Internal', { detail: String(error) }), notStarted: false };
  } finally {
    if (!committed) await bridge.abort(token).catch(() => undefined);
    // The job is over, whatever the ending: the worker goes, and its WASM heap with it.
    worker.terminate();
  }
}
