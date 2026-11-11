import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../app/services', () => ({ documentRegistry: { get: vi.fn() } }));

// The fast-scrolling flag is set per test.
const scroll = vi.hoisted(() => ({ fast: false }));
vi.mock('./scrollVelocity', () => ({ useFastScrolling: () => scroll.fast }));

import { documentRegistry } from '../../app/services';
import { BITMAP_CACHE_BYTES, bitmapCache, bitmapKey } from '../../engine/bitmapCache';
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

const DOC = 'doc-ownership-test';
const request = { docId: DOC, srcIndex: 0, rotation: 0, scale: 1, priority: Priority.Visible };
const KEY = bitmapKey(DOC, 0, 1, 0);
const LOW_KEY = bitmapKey(DOC, 0, 0.5, 0);

afterEach(() => {
  bitmapCache.delete(KEY);
  bitmapCache.delete(LOW_KEY);
  bitmapCache.delete('evictor');
  scroll.fast = false;
  vi.clearAllMocks();
});

describe('page bitmaps: the cache owns them', () => {
  it('two panes on the same page share one bitmap, and unmounting one does not close it', async () => {
    const first = fakeBitmap(100, 100);
    const renderBitmap = vi.fn(async () => first as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);

    const paneA = renderHook(() => usePageBitmap(request));
    const paneB = renderHook(() => usePageBitmap(request));
    await waitFor(() => expect(paneB.result.current).toBe(first as unknown as ImageBitmap));
    expect(paneA.result.current).toBe(first as unknown as ImageBitmap);
    expect(renderBitmap).toHaveBeenCalledTimes(1);

    paneA.unmount();
    expect(first.close).not.toHaveBeenCalled();
    expect(paneB.result.current).toBe(first as unknown as ImageBitmap);
    paneB.unmount();
    expect(first.close).not.toHaveBeenCalled();
  });

  it('a bitmap on screen is pinned: eviction does not close it', async () => {
    const first = fakeBitmap(100, 100);
    const renderBitmap = vi.fn(async () => first as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);

    const pane = renderHook(() => usePageBitmap(request));
    await waitFor(() => expect(pane.result.current).toBe(first as unknown as ImageBitmap));

    // Another page fills the cache. The page is still on screen, so its bitmap stays open and keeps being drawn.
    bitmapCache.set('evictor', fakeBitmap(1, 1) as unknown as ImageBitmap, BITMAP_CACHE_BYTES);
    expect(first.close).not.toHaveBeenCalled();
    expect(pane.result.current).toBe(first as unknown as ImageBitmap);
    pane.unmount();
  });

  it('after the page lets go, eviction closes the bitmap and the page renders again', async () => {
    const first = fakeBitmap(100, 100);
    const second = fakeBitmap(100, 100);
    const renders = [first, second];
    const renderBitmap = vi.fn(async () => (renders.shift() ?? second) as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);

    const pane = renderHook(() => usePageBitmap(request));
    await waitFor(() => expect(pane.result.current).toBe(first as unknown as ImageBitmap));
    // Scrolling to another scale shows a different bitmap, so the first is no longer pinned by this page.
    pane.rerender();
    bitmapCache.unpin(first as unknown as ImageBitmap);
    bitmapCache.set('evictor', fakeBitmap(1, 1) as unknown as ImageBitmap, BITMAP_CACHE_BYTES);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(pane.result.current).toBe(first as unknown as ImageBitmap);
    pane.unmount();
    expect(second.close).not.toHaveBeenCalled();
  });
});

describe('page bitmaps: fast scrolling', () => {
  it('keeps a full-resolution bitmap that is already cached, and does not downgrade the page to low resolution', async () => {
    const full = fakeBitmap(200, 200);
    bitmapCache.set(KEY, full as unknown as ImageBitmap, 200 * 200 * 4);
    const renderBitmap = vi.fn(async () => fakeBitmap(100, 100) as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);
    scroll.fast = true;

    const pane = renderHook(() => usePageBitmap({ ...request, lowScale: 0.5 }));
    expect(pane.result.current).toBe(full as unknown as ImageBitmap);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderBitmap).not.toHaveBeenCalled();
    expect(pane.result.current).toBe(full as unknown as ImageBitmap);
    pane.unmount();
    expect(full.close).not.toHaveBeenCalled();
  });

  it('renders at low resolution while fast scrolling when no full-resolution bitmap is cached', async () => {
    const low = fakeBitmap(50, 50);
    const renderBitmap = vi.fn(async (_index: number, _options: { scale: number }) => low as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);
    scroll.fast = true;

    const pane = renderHook(() => usePageBitmap({ ...request, lowScale: 0.5 }));
    await waitFor(() => expect(pane.result.current).toBe(low as unknown as ImageBitmap));
    expect(renderBitmap).toHaveBeenCalledTimes(1);
    expect(renderBitmap.mock.calls[0]?.[1]).toMatchObject({ scale: 0.5 });
    expect(bitmapCache.get(LOW_KEY)).toBe(low as unknown as ImageBitmap);
    pane.unmount();
  });
});

describe('page bitmaps: paused while the scrollbar is dragged', () => {
  it('requests no page while paused, and renders once the pause lifts', async () => {
    const bitmap = fakeBitmap(100, 100);
    const renderBitmap = vi.fn(async () => bitmap as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);

    const pane = renderHook(({ paused }) => usePageBitmap({ ...request, paused }), { initialProps: { paused: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderBitmap).not.toHaveBeenCalled();
    expect(pane.result.current).toBeNull();

    pane.rerender({ paused: false });
    await waitFor(() => expect(pane.result.current).toBe(bitmap as unknown as ImageBitmap));
    expect(renderBitmap).toHaveBeenCalledTimes(1);
    pane.unmount();
  });

  it('still shows a bitmap that is already cached while paused', () => {
    const cached = fakeBitmap(100, 100);
    bitmapCache.set(KEY, cached as unknown as ImageBitmap, 100 * 100 * 4);
    const renderBitmap = vi.fn(async () => fakeBitmap(1, 1) as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);

    const pane = renderHook(() => usePageBitmap({ ...request, paused: true }));
    expect(pane.result.current).toBe(cached as unknown as ImageBitmap);
    expect(renderBitmap).not.toHaveBeenCalled();
    pane.unmount();
  });
});

describe('page bitmaps: full resolution only for pages in view (1.5.12)', () => {
  // A large page: its full bitmap is 8 MP, its low first pass 2 MP (fake bitmaps are small, but the sizes below are what the
  // cache sees through bitmapBytes: width x height x 4, so the "large" one is 32 MB).
  const BIG_SCALE = 4;
  const BIG_LOW = 2;
  const bigKey = bitmapKey(DOC, 0, BIG_SCALE, 0);
  const lowKey = bitmapKey(DOC, 0, BIG_LOW, 0);
  const bigReq = { ...request, scale: BIG_SCALE, lowScale: BIG_LOW };

  /** A renderer that answers each scale with its own bitmap, so the test can tell which was asked for. */
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

  afterEach(() => {
    bitmapCache.deleteWhere((key) => key.startsWith(DOC));
  });

  it('a page in view renders at full scale', async () => {
    const { renderBitmap } = mockRender();
    const pane = renderHook(() => usePageBitmap({ ...bigReq, wantsFull: true }));
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    expect(renderBitmap).toHaveBeenCalledTimes(1);
    expect(renderBitmap.mock.calls[0]?.[1]).toMatchObject({ scale: BIG_SCALE });
    pane.unmount();
  });

  it('a large neighbour renders at the low first pass and never at full scale', async () => {
    const { renderBitmap } = mockRender();
    const pane = renderHook(() => usePageBitmap({ ...bigReq, wantsFull: false }));
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    expect(renderBitmap).toHaveBeenCalledTimes(1);
    expect(renderBitmap.mock.calls[0]?.[1]).toMatchObject({ scale: BIG_LOW });
    expect(bitmapCache.has(bigKey)).toBe(false);
    pane.unmount();
  });

  it('a neighbour that scrolls into view sharpens to full scale and keeps the low bitmap meanwhile (no blank page)', async () => {
    const { renderBitmap, made } = mockRender();
    const pane = renderHook(({ wantsFull }) => usePageBitmap({ ...bigReq, wantsFull }), { initialProps: { wantsFull: false } });
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    const low = made.get(BIG_LOW) as unknown as ImageBitmap;
    expect(pane.result.current).toBe(low);

    pane.rerender({ wantsFull: true });
    // Never blank: while the full render is under way the page still shows the low bitmap.
    expect(pane.result.current).toBe(low);
    await waitFor(() => expect(pane.result.current).toBe(made.get(BIG_SCALE) as unknown as ImageBitmap));
    expect(renderBitmap).toHaveBeenCalledTimes(2);
    // The full bitmap replaces the low one (existing behaviour).
    expect(bitmapCache.has(lowKey)).toBe(false);
    pane.unmount();
  });

  it('a page that leaves the viewport releases its full-resolution bitmap once the low one shows, and is never blank', async () => {
    const { made } = mockRender();
    const pane = renderHook(({ wantsFull }) => usePageBitmap({ ...bigReq, wantsFull }), { initialProps: { wantsFull: true } });
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    const full = made.get(BIG_SCALE) as ReturnType<typeof fakeBitmap>;
    expect(pane.result.current).toBe(full);

    pane.rerender({ wantsFull: false });
    // While the low bitmap renders the full one is still shown.
    expect(pane.result.current).not.toBeNull();
    await waitFor(() => expect(pane.result.current).toBe(made.get(BIG_LOW) as unknown as ImageBitmap));
    // The full bitmap left the cache and is closed (it was pinned while shown; the pin went when the page switched).
    await waitFor(() => expect(full.close).toHaveBeenCalledTimes(1));
    expect(bitmapCache.has(bigKey)).toBe(false);
    expect(bitmapCache.has(lowKey)).toBe(true);
    pane.unmount();
  });

  it('releases the large bitmap of a higher zoom when the zoom comes back down', async () => {
    const { made } = mockRender();
    const pane = renderHook((props) => usePageBitmap(props), { initialProps: { ...bigReq, wantsFull: true } });
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    const full = made.get(BIG_SCALE) as ReturnType<typeof fakeBitmap>;

    // Back to a small scale (fit): the page shows a small bitmap and the large one is released.
    pane.rerender({ ...request, scale: 0.5, lowScale: 0.25, wantsFull: true });
    await waitFor(() => expect(pane.result.current).not.toBe(full as unknown as ImageBitmap));
    await waitFor(() => expect(full.close).toHaveBeenCalledTimes(1));
    expect(bitmapCache.has(bigKey)).toBe(false);
    pane.unmount();
  });

  it('unmounting a page (scrolled out of the overscan) releases its large bitmap', async () => {
    const { made } = mockRender();
    const pane = renderHook(() => usePageBitmap({ ...bigReq, wantsFull: true }));
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    const full = made.get(BIG_SCALE) as ReturnType<typeof fakeBitmap>;
    pane.unmount();
    expect(bitmapCache.has(bigKey)).toBe(false);
    expect(full.close).toHaveBeenCalledTimes(1);
  });

  it('a small page is not released: its bitmaps keep the normal LRU behaviour', async () => {
    const small = fakeBitmap(800, 1000);
    const renderBitmap = vi.fn(async () => small as unknown as ImageBitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);
    const pane = renderHook(() => usePageBitmap({ ...request, scale: 1, lowScale: 0.5, wantsFull: true }));
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    pane.unmount();
    expect(bitmapCache.has(KEY)).toBe(true);
    expect(small.close).not.toHaveBeenCalled();
  });

  it('a page that keeps wantsFull false holds only the low bitmap in the cache', async () => {
    mockRender();
    const pane = renderHook(() => usePageBitmap({ ...bigReq, wantsFull: false }));
    await waitFor(() => expect(pane.result.current).not.toBeNull());
    expect(bitmapCache.bytes).toBe(2000 * 1000 * 4);
    pane.unmount();
  });
});
