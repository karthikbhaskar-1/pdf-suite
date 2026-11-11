/**
 * Two small pieces of the document worker (worker.ts), kept here so they can be tested without a worker scope: the end of a
 * turn, and the background job that measures pages. Both exist so the page never waits for something that will not come.
 */
import type { WorkerEvent } from './protocol';

/** The size a page that cannot be measured is given: US Letter, upright. */
export const SIZE_FALLBACK = { width: 612, height: 792 } as const;

/** What a size job needs from the core. */
export interface SizesSource {
  sizesChecked(from: number, count: number): { sizes: Float32Array; failed: number[] };
}

/**
 * Runs one background size job and posts its `sizes` event. The event is always posted: for a page that cannot be measured the
 * core gives the fallback size, and when the whole job throws (or there is no document) every page of the job gets it. The
 * page side then settles every size promise it asked for (search and measuring wait on them).
 */
export function runSizesJob(
  core: SizesSource | null,
  job: { from: number; count: number },
  post: (message: WorkerEvent, transfer: Transferable[]) => void,
): void {
  let sizes: Float32Array;
  let failed: number[];
  try {
    if (!core) throw new Error('No document is open');
    ({ sizes, failed } = core.sizesChecked(job.from, job.count));
  } catch {
    sizes = new Float32Array(job.count * 3);
    for (let i = 0; i < job.count; i++) sizes.set([SIZE_FALLBACK.width, SIZE_FALLBACK.height, 0], i * 3);
    failed = Array.from({ length: job.count }, (_unused, i) => job.from + i);
  }
  post(failed.length > 0 ? { event: 'sizes', from: job.from, sizes, failed } : { event: 'sizes', from: job.from, sizes }, [sizes.buffer]);
}

/**
 * The end of a job's turn: the housekeeping after the job (afterJob), then the next turn. A housekeeping step that throws must
 * not stop the next turn from being posted, or the queue stalls for good.
 */
export function endTurn(afterJob: (() => void) | undefined, next: () => void): void {
  try {
    afterJob?.();
  } catch {
    // Housekeeping only (shrinking caches): the job's own result is already out.
  } finally {
    next();
  }
}
