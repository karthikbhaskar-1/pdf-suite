import { afterEach, describe, expect, it } from 'vitest';
import { bitmapCache } from '../../engine/bitmapCache';
import { cancelDraw, drawStats, queueDraw } from './drawQueue';

/** A stand-in bitmap that is still drawable (width above zero). */
function bitmap(width = 20, height = 20) {
  return { width, height, close: () => undefined } as unknown as ImageBitmap;
}

/** Waits for the next animation frame, and a little more, so the queue has been run. */
function frames(count = 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 16 * count + 10));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('draw queue', () => {
  it('drops a queued draw whose canvas has left the page, and releases the bitmap', async () => {
    const detached = document.createElement('canvas');
    const pending = bitmap();
    const dropped = drawStats.droppedUnmounted;
    queueDraw(detached, pending);
    expect(bitmapCache.isPinned(pending)).toBe(true);
    await frames();
    expect(drawStats.droppedUnmounted).toBe(dropped + 1);
    expect(bitmapCache.isPinned(pending)).toBe(false);
  });

  it('paints a queued draw of a canvas on the page, then releases its bitmap', async () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const shown = bitmap(30, 40);
    const painted = drawStats.painted;
    queueDraw(canvas, shown);
    await frames();
    expect(drawStats.painted).toBe(painted + 1);
    expect(canvas.width).toBe(30);
    expect(canvas.height).toBe(40);
    expect(bitmapCache.isPinned(shown)).toBe(false);
  });

  it('cancelDraw removes a waiting draw and releases its bitmap', async () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const waiting = bitmap();
    queueDraw(canvas, waiting);
    cancelDraw(canvas);
    expect(bitmapCache.isPinned(waiting)).toBe(false);
    const painted = drawStats.painted;
    await frames();
    expect(drawStats.painted).toBe(painted);
  });

  it('a newer draw for a canvas replaces the older one still waiting', async () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const older = bitmap(10, 10);
    const newer = bitmap(50, 60);
    queueDraw(canvas, older);
    queueDraw(canvas, newer);
    expect(bitmapCache.isPinned(older)).toBe(false);
    expect(bitmapCache.isPinned(newer)).toBe(true);
    await frames();
    expect(canvas.width).toBe(50);
    expect(bitmapCache.isPinned(newer)).toBe(false);
  });
});
