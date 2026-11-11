import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../app/services', () => ({ documentRegistry: { get: vi.fn() } }));
vi.mock('./scrollVelocity', () => ({ useFastScrolling: () => false }));

import { documentRegistry } from '../../app/services';
import { bitmapCache, bitmapKey, dropLargeHigherScales } from '../../engine/bitmapCache';
import { Priority } from '../../engine/renderScheduler';
import { usePageBitmap } from './usePageBitmap';

/** A stand-in bitmap. Like a real one, close() zeroes its size, so a closed bitmap cannot be drawn. */
function fakeBitmap(width: number, height: number) {
  const bitmap = {
    width,
    height,
    close: vi.fn(() => {
      bitmap.width = 0;
      bitmap.height = 0;
    }),
  };
  return bitmap;
}

const DOC = 'doc-split-view-test';
const request = { docId: DOC, srcIndex: 0, rotation: 0, scale: 1, priority: Priority.Visible };

describe('page bitmaps: two panes on one page (split view, 1.5.12)', () => {
  const BIG_SCALE = 4;
  const BIG_LOW = 2;
  const bigKey = bitmapKey(DOC, 0, BIG_SCALE, 0);
  const bigReq = { ...request, scale: BIG_SCALE, lowScale: BIG_LOW };

  function mockRender() {
    const made = new Map<number, ReturnType<typeof fakeBitmap>>();
    const renderBitmap = vi.fn(async (_index: number, options: { scale: number }) => {
      const bitmap = options.scale === BIG_SCALE ? fakeBitmap(4000, 2000) : fakeBitmap(2000, 1000);
      made.set(options.scale, bitmap);
      return bitmap as unknown as ImageBitmap;
    });
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);
    return { renderBitmap, made };
  }

  /** What a pane would draw: nothing, or a bitmap that is open. A closed bitmap (width 0) must never be handed out. */
  const drawable = (b: ImageBitmap | null) => b === null || b.width > 0;

  afterEach(() => {
    bitmapCache.deleteWhere((key) => key.startsWith(DOC));
  });

  it('one pane leaving the viewport does not close the large bitmap the other pane still shows', async () => {
    const { made } = mockRender();
    const a = renderHook(({ wantsFull }) => usePageBitmap({ ...bigReq, wantsFull }), { initialProps: { wantsFull: true } });
    const b = renderHook(() => usePageBitmap({ ...bigReq, wantsFull: true }));
    await waitFor(() => expect(b.result.current).not.toBeNull());
    const full = made.get(BIG_SCALE) as ReturnType<typeof fakeBitmap>;
    expect(a.result.current).toBe(full as unknown as ImageBitmap);
    expect(b.result.current).toBe(full as unknown as ImageBitmap);

    // Pane A scrolls away: it shows the low bitmap and asks the cache to release the large one.
    a.rerender({ wantsFull: false });
    await waitFor(() => expect(a.result.current).toBe(made.get(BIG_LOW) as unknown as ImageBitmap));
    // Pane B still draws the large bitmap: it is pinned by B, so it is not closed.
    expect(full.close).not.toHaveBeenCalled();
    expect(b.result.current).toBe(full as unknown as ImageBitmap);
    expect(drawable(a.result.current) && drawable(b.result.current)).toBe(true);

    // When B lets go too, the bitmap is released at once.
    b.unmount();
    expect(full.close).toHaveBeenCalledTimes(1);
    expect(bitmapCache.has(bigKey)).toBe(false);
    expect(drawable(a.result.current)).toBe(true);
    a.unmount();
  });

  it('one pane unmounting releases the large bitmap only when the other pane has let go of it', async () => {
    const { made } = mockRender();
    const a = renderHook(() => usePageBitmap({ ...bigReq, wantsFull: true }));
    const b = renderHook(() => usePageBitmap({ ...bigReq, wantsFull: true }));
    await waitFor(() => expect(b.result.current).not.toBeNull());
    const full = made.get(BIG_SCALE) as ReturnType<typeof fakeBitmap>;

    a.unmount();
    expect(full.close).not.toHaveBeenCalled();
    expect(b.result.current).toBe(full as unknown as ImageBitmap);
    expect(drawable(b.result.current)).toBe(true);
    b.unmount();
    expect(full.close).toHaveBeenCalledTimes(1);
  });

  it('a pane that mounts in the same commit as the other pane unmounts gets a bitmap that stays open', async () => {
    const { made } = mockRender();
    const seen: Array<ImageBitmap | null> = [];
    function Pane({ name }: { name: string }) {
      const bitmap = usePageBitmap({ ...bigReq, wantsFull: true });
      if (name === 'B') seen.push(bitmap);
      return null;
    }
    function Panes({ which }: { which: 'A' | 'B' }) {
      return <Pane key={which} name={which} />;
    }
    const view = render(<Panes which="A" />);
    await waitFor(() => expect(made.get(BIG_SCALE)).toBeDefined());
    const full = made.get(BIG_SCALE) as ReturnType<typeof fakeBitmap>;
    await waitFor(() => expect(bitmapCache.isPinned(full as unknown as ImageBitmap)).toBe(true));

    // The cache has been told to release the large bitmap (a release from another pane), and pane A unmounts while pane B mounts.
    dropLargeHigherScales(DOC, 0, 0, BIG_LOW);
    view.rerender(<Panes which="B" />);
    // B took the bitmap from the cache at mount. It is pinned in the same commit, so A's unmount did not close it.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((bitmap) => bitmap === null || bitmap.width > 0)).toBe(true);
    expect(full.close).not.toHaveBeenCalled();
    view.unmount();
  });
});
