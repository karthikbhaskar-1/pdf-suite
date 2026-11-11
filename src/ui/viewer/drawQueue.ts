/**
 * Paints bitmaps onto page canvases, at most one per animation frame. A bitmap that arrives while another is
 * waiting for its frame goes behind it, so a burst of new pages cannot upload several large textures in one
 * frame. A newer bitmap for a canvas replaces the older one still waiting.
 *
 * A queued bitmap is pinned in the bitmap cache, so eviction cannot close it while it waits. The pin is released
 * when the bitmap is painted, replaced or dropped. A bitmap that is closed anyway is reported through `onSkipped`,
 * so the page asks for its bitmap again instead of staying blank.
 */
import { bitmapCache } from '../../engine/bitmapCache';

interface Pending {
  canvas: HTMLCanvasElement;
  bitmap: ImageBitmap;
  onSkipped?: () => void;
}

/** Counters for the blank-page probe. Read them as window.__pdfSuiteDrawStats. */
export const drawStats = { queued: 0, painted: 0, replaced: 0, skippedClosed: 0, droppedUnmounted: 0 };

const queue: Pending[] = [];
let frame = 0;

function release(entry: Pending): void {
  bitmapCache.unpin(entry.bitmap);
}

export function queueDraw(canvas: HTMLCanvasElement, bitmap: ImageBitmap, onSkipped?: () => void): void {
  const at = queue.findIndex((entry) => entry.canvas === canvas);
  if (at >= 0) {
    const [replaced] = queue.splice(at, 1);
    if (replaced) {
      release(replaced);
      drawStats.replaced += 1;
    }
  }
  bitmapCache.pin(bitmap);
  queue.push({ canvas, bitmap, onSkipped });
  drawStats.queued += 1;
  if (frame === 0) frame = requestAnimationFrame(drawNext);
}

/** Drops the queued draw of a canvas, if any. Called when the page unmounts. */
export function cancelDraw(canvas: HTMLCanvasElement): void {
  const at = queue.findIndex((entry) => entry.canvas === canvas);
  if (at < 0) return;
  const [dropped] = queue.splice(at, 1);
  if (dropped) release(dropped);
}

function drawNext(): void {
  frame = 0;
  // A page that has unmounted no longer needs its draw. Dropping it here keeps the queue to pages on screen, so a visible
  // page is not held back behind the pages the user scrolled past.
  let next = queue.shift();
  while (next && !next.canvas.isConnected) {
    release(next);
    drawStats.droppedUnmounted += 1;
    next = queue.shift();
  }
  if (next) paint(next);
  if (queue.length > 0) frame = requestAnimationFrame(drawNext);
}

function paint(entry: Pending): void {
  const { canvas, bitmap } = entry;
  release(entry);
  // A bitmap the cache closed while it waited cannot be drawn. Ask for the page again.
  if (bitmap.width === 0) {
    drawStats.skippedClosed += 1;
    entry.onSkipped?.();
    return;
  }
  drawStats.painted += 1;
  // Assigning the size clears and reallocates the canvas, so it happens only when the size changes.
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
  try {
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  } catch {
    // Closed during the draw. The next render replaces it.
    entry.onSkipped?.();
  }
}

if (typeof window !== 'undefined' && window.__pdfSuiteTestMode === true) {
  (window as unknown as { __pdfSuiteDrawStats?: typeof drawStats }).__pdfSuiteDrawStats = drawStats;
}

