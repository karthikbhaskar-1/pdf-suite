/**
 * The page side of one MuPDF worker. It sends requests, matches replies to them by id, forwards events, and
 * turns a cancelled request into an AbortError. A worker belongs to one document, so the client is shut
 * down with that document.
 */
import { PdfOpenError, type PdfErrorKind } from '../errors';
import { abortError } from '../renderScheduler';
import { diag, diagEnabled } from '../diag';
import {
  Priority,
  isReply,
  nextRequestId,
  type ErrorKind,
  type FromWorker,
  type Request,
  type RequestBody,
  type WorkerEvent,
} from './protocol';

/** Kinds that the open path reports as the typed open errors the rest of the app already handles. */
const OPEN_KINDS = new Set<ErrorKind>(['PasswordNeeded', 'WrongPassword', 'Corrupt', 'NotPdf', 'Empty']);

/** Turns a worker error into the error the page throws. Typed open errors stay PdfOpenError. */
export function toError(kind: ErrorKind, message: string): Error {
  if (kind === 'Cancelled') return abortError();
  if (OPEN_KINDS.has(kind)) return new PdfOpenError(kind as PdfErrorKind);
  const error = new Error(message);
  error.name = kind;
  return error;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Removes the abort listener this request added. Called once, when the request settles. */
  detach: () => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Buffers moved to the worker instead of copied. */
  transfer?: Transferable[];
  /**
   * On abort, tell the worker but keep waiting for its reply instead of rejecting at once. For an edit, whose outcome
   * the page must know: the worker answers Cancelled (rolled back) or success (it had already finished, so the edit
   * stands). Without it a late Cancel could leave a step in the worker that the page thinks never happened.
   */
  settleOnAbort?: boolean;
}

/**
 * How long a worker may be silent while requests wait for it before the page is told (see WorkerClient.watchSilence).
 * Kept at 30 s by probe P6 (the longest real worker job was 6.4 s: 10,755 pages, 1 GB). Any message from the worker
 * (a reply, or a progress or page event) starts the time again, so a long job that reports progress is never "silent".
 */
export const DEFAULT_SILENCE_MS = 30_000;

/** DIAGNOSTICS ONLY: the workers that are not terminated yet (documents plus the warm spare). */
export const liveWorkerClients = new Set<object>();

export class WorkerClient {
  private readonly pending = new Map<number, Pending>();
  /** Events that arrive before a handler is set are kept here and delivered when it is. */
  private buffered: WorkerEvent[] = [];
  private handler: ((event: WorkerEvent) => void) | null = null;
  private closed = false;
  /** The silence watchdog, when one was set (see watchSilence). */
  private silence: { ms: number; onSilent: () => void } | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly worker: Worker) {
    liveWorkerClients.add(this);
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    worker.onerror = (event) => {
      diag('worker.onerror', { message: (event as ErrorEvent)?.message ?? null });
      this.failAll(new Error('Something went wrong with this document. If it happens again, Help ▸ Open Logs Folder has the details.'));
    };
  }

  /** Receives events from the worker. Events that came earlier are delivered now, in order. */
  onEvent(handler: (event: WorkerEvent) => void): void {
    this.handler = handler;
    const queued = this.buffered;
    this.buffered = [];
    for (const event of queued) handler(event);
  }

  /**
   * Watches for a worker that has stopped answering. While at least one request is waiting, every message from the worker
   * (a reply or an event) starts the silence time again; when `ms` pass with no message, `onSilent` is called, and the timer
   * runs again, so a worker that stays silent is reported again after another `ms`. With no request waiting the timer is off.
   * The client never ends the worker itself: what to do about a silent one is the user's choice (the "stopped responding"
   * bar: Wait or Reopen), and terminate() is theirs to call.
   */
  watchSilence(onSilent: () => void, ms: number = DEFAULT_SILENCE_MS): void {
    this.silence = { ms, onSilent };
    this.rearmSilence();
  }

  /**
   * A request was sent: the silence time starts only when none is running. Sending must NOT restart it, or a hung worker that
   * keeps being sent render requests would never be reported; only a message FROM the worker restarts it.
   */
  private armSilenceIfIdle(): void {
    if (this.silenceTimer === undefined) this.rearmSilence();
  }

  /** Starts the silence time again, or switches it off when nothing is waiting. */
  private rearmSilence(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    const watch = this.silence;
    if (!watch || this.closed || this.pending.size === 0) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      if (this.closed || this.pending.size === 0) return;
      diag('worker.silent', { pending: this.pending.size, ms: watch.ms });
      watch.onSilent();
      this.rearmSilence();
    }, watch.ms);
  }

  /**
   * Sends one request and resolves with its result. Aborting `signal` cancels the request in the worker, and
   * the promise rejects with an AbortError at once.
   */
  request<T>(body: RequestBody, pri: Priority, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The document is closed.'));
    const { signal, transfer = [] } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    const id = nextRequestId();
    return new Promise<T>((resolve, reject) => {
      // The listener is removed as soon as the request settles, so a long-lived signal does not keep one
      // listener per request it has ever carried.
      const onAbort = () => {
        if (options.settleOnAbort) this.worker.postMessage({ id: 0, pri: Priority.Visible, op: 'cancel', target: id } satisfies Request);
        else this.cancel(id);
      };
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      const message = { id, pri, ...body } as Request;
      // DIAGNOSTICS ONLY: traced when a test probe has turned the trace on (see engine/diag.ts).
      if (diagEnabled() && body.op !== 'render' && body.op !== 'text' && body.op !== 'stats') {
        const sent = performance.now();
        diag('req.send', { id, op: body.op, pending: this.pending.size });
        const entry = this.pending.get(id)!;
        const { resolve: res, reject: rej } = entry;
        entry.resolve = (value) => {
          diag('req.ok', { id, op: body.op, ms: Math.round(performance.now() - sent) });
          res(value);
        };
        entry.reject = (error) => {
          diag('req.fail', { id, op: body.op, ms: Math.round(performance.now() - sent), name: (error as Error)?.name, message: (error as Error)?.message });
          rej(error);
        };
      }
      this.armSilenceIfIdle();
      this.worker.postMessage(message, transfer);
    });
  }

  /** Removes a request from the pending map and detaches its abort listener. Undefined when it is not pending. */
  private take(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.detach();
    // A request leaving (answered, or cancelled by the page) is not a sign of life: only an empty queue stops the watch.
    if (this.pending.size === 0) this.rearmSilence();
    return entry;
  }

  /** Cancels a request. A queued one never runs. A running one finishes, and its result is dropped. */
  cancel(target: number): void {
    const entry = this.take(target);
    if (!entry) return;
    entry.reject(abortError());
    this.worker.postMessage({ id: 0, pri: Priority.Visible, op: 'cancel', target } satisfies Request);
  }

  /**
   * Closes the document in the worker and stops the worker. Requests still waiting are cancelled. The close
   * waits at most 200 ms for a running job, then the worker is terminated anyway.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    for (const id of [...this.pending.keys()]) this.cancel(id);
    const closing = this.request({ op: 'close' }, Priority.Visible).catch(() => undefined);
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 200))]);
    this.terminate();
  }

  /** Stops the worker now. Its WASM memory is released with it. */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    liveWorkerClients.delete(this);
    this.worker.terminate();
    this.failAll(abortError());
  }

  private receive(message: FromWorker): void {
    // Any message shows the worker is alive: the silence time starts again.
    this.rearmSilence();
    if (!isReply(message)) {
      if (this.handler) this.handler(message);
      else this.buffered.push(message);
      return;
    }
    const entry = this.take(message.id);
    if (!entry) {
      // A cancelled render that finished anyway. Its bitmap is released here.
      if (message.ok && typeof ImageBitmap !== 'undefined' && message.result instanceof ImageBitmap) message.result.close();
      return;
    }
    if (message.ok) entry.resolve(message.result);
    else entry.reject(toError(message.error.kind, message.error.message));
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.take(id)?.reject(error);
  }
}
