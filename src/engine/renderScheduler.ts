/**
 * Lower number = more urgent. The order is the one the viewer needs: the pages on screen, then the text of
 * the pages on screen (for selection and search), then pages around the screen, then thumbnails.
 */
import { knobs } from './testKnobs';

export const Priority = {
  Visible: 0,
  Text: 1,
  Prefetch: 2,
  Thumbnail: 3,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export interface ScheduledJob<T> {
  promise: Promise<T>;
  cancel(): void;
}

interface Pending {
  key: string;
  priority: Priority;
  seq: number;
  run: (signal: AbortSignal) => Promise<unknown>;
  controller: AbortController;
  promise: Promise<unknown>;
  settle: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  started: boolean;
}

export function abortError(): Error {
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  return error;
}

/** Runs the callback on the next animation frame, or after FRAME_FALLBACK_MS if frames are not being produced. */
export const FRAME_FALLBACK_MS = 50;
function nextFrame(callback: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    callback();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
  // A window that is hidden or covered gets no frames. Pacing must never stall renders for good.
  setTimeout(once, FRAME_FALLBACK_MS);
}

/**
 * Runs render jobs by priority with a fixed concurrency. Jobs with the same key share one
 * promise. Queued jobs can be cancelled, and running jobs get their signal aborted.
 *
 * Pacing: while `setPaced(true)` is in force (the viewer is scrolling fast), at most one bitmap job starts per
 * animation frame. Each finished bitmap is a GPU upload; hundreds a second queue up in Chromium's GPU thread
 * and then drain as one long frame. Jobs still waiting are cancelled when their page scrolls away, so a page
 * that has left the screen is never rendered late. Text jobs are not bitmaps and are never paced.
 */
export class RenderScheduler {
  private queue: Pending[] = [];
  private readonly byKey = new Map<string, Pending>();
  private active = 0;
  private seq = 0;
  private paced = false;
  /** True from the start of a paced bitmap job until the next animation frame. */
  private frameTaken = false;
  private frameToken = 0;

  constructor(
    private readonly concurrency = knobs.concurrency,
    private readonly frame: (callback: () => void) => void = nextFrame,
  ) {}

  /** Turns pacing on or off. Turning it off starts the queue at full speed again. */
  setPaced(on: boolean): void {
    if (this.paced === on) return;
    this.paced = on;
    if (!on) {
      this.frameTaken = false;
      this.frameToken += 1; // a frame callback still waiting belongs to the old pacing
    }
    this.pump();
  }

  schedule<T>(key: string, priority: Priority, run: (signal: AbortSignal) => Promise<T>): ScheduledJob<T> {
    const existing = this.byKey.get(key);
    if (existing) {
      if (!existing.started) existing.priority = priority;
      return { promise: existing.promise as Promise<T>, cancel: () => this.cancel(key) };
    }

    let settle!: Pending['settle'];
    const promise = new Promise<unknown>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const job: Pending = {
      key,
      priority,
      seq: this.seq++,
      run,
      controller: new AbortController(),
      promise,
      settle,
      started: false,
    };
    this.byKey.set(key, job);
    this.queue.push(job);
    this.pump();
    return { promise: promise as Promise<T>, cancel: () => this.cancel(key) };
  }

  /** True while a job with this key is queued or running. */
  isPending(key: string): boolean {
    return this.byKey.has(key);
  }

  /**
   * Sets the priority of a queued job, up or down: as the viewer scrolls, a page that leaves the screen gives
   * up its place to the pages that arrive. A running job keeps its place.
   */
  reprioritize(key: string, priority: Priority): void {
    const job = this.byKey.get(key);
    if (job && !job.started) job.priority = priority;
  }

  /** Cancels one job by key. Safe to call when the job is already done. */
  cancel(key: string): void {
    const job = this.byKey.get(key);
    if (!job) return;
    this.byKey.delete(key);
    job.controller.abort();
    job.settle.reject(abortError());
    if (!job.started) {
      this.queue = this.queue.filter((q) => q !== job);
    }
  }

  /** Cancels every job whose key matches the predicate. */
  cancelWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.byKey.keys()]) {
      if (predicate(key)) this.cancel(key);
    }
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      // Once this frame's bitmap job has started, only text jobs may start until the next frame.
      const next = this.takeMostUrgent(this.paced && this.frameTaken);
      if (!next) return;
      if (this.paced && next.priority !== Priority.Text) this.takeFrame();
      next.started = true;
      this.active += 1;
      new Promise<unknown>((resolve) => resolve(next.run(next.controller.signal)))
        .then(next.settle.resolve, next.settle.reject)
        .finally(() => {
          this.active -= 1;
          if (this.byKey.get(next.key) === next) this.byKey.delete(next.key);
          this.pump();
        });
    }
  }

  private takeFrame(): void {
    this.frameTaken = true;
    const token = this.frameToken;
    this.frame(() => {
      if (token !== this.frameToken) return;
      this.frameTaken = false;
      this.pump();
    });
  }

  private takeMostUrgent(textOnly: boolean): Pending | undefined {
    let bestIndex = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const candidate = this.queue[i];
      if (!candidate) continue;
      if (textOnly && candidate.priority !== Priority.Text) continue;
      const best = bestIndex >= 0 ? this.queue[bestIndex] : undefined;
      if (
        !best ||
        candidate.priority < best.priority ||
        (candidate.priority === best.priority && candidate.seq < best.seq)
      ) {
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return undefined;
    const [job] = this.queue.splice(bestIndex, 1);
    return job;
  }
}

/** The app-wide scheduler: two concurrent renders. */
export const renderScheduler = new RenderScheduler(knobs.concurrency);
