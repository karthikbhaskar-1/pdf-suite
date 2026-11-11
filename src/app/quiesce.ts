import { renderScheduler } from '../engine/renderScheduler';

/** The least wait for animation frames before the page stops waiting for them (a hidden or covered window gets none). */
export const QUIESCE_FRAME_TIMEOUT_MS = 100;

/** Resolves after `count` animation frames, or after `timeoutMs` when frames are not being produced. */
export function afterFrames(
  count: number,
  timeoutMs: number = QUIESCE_FRAME_TIMEOUT_MS,
  raf: ((cb: () => void) => void) | undefined = typeof requestAnimationFrame === 'function'
    ? (cb) => void requestAnimationFrame(() => cb())
    : undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (!raf) return;
    const step = (left: number) => {
      if (left <= 0) return finish();
      raf(() => step(left - 1));
    };
    step(count);
  });
}

/**
 * Brings the page to rest before its window closes: queued and running render jobs are cancelled (no more bitmaps are
 * produced or uploaded), then two animation frames pass so the frame already in flight reaches the GPU. Without this the
 * window is destroyed under a renderer that is still drawing, and Chromium logs "GPU state invalid" while the GPU
 * channel goes away.
 */
export async function quiescePage(
  scheduler: { cancelWhere(predicate: (key: string) => boolean): void } = renderScheduler,
  frames: () => Promise<void> = () => afterFrames(2),
): Promise<void> {
  scheduler.cancelWhere(() => true);
  await frames();
}
