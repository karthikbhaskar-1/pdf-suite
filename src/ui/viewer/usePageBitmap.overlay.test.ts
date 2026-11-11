// 1.3.4 Compare view in the page bitmap hook: an overlay page is cached under a pseudo document id, asked for with the engine's
// overlay arguments, never mixes with the plain page, and a changed look is a new request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../app/services', () => ({ documentRegistry: { get: vi.fn() } }));
vi.mock('./scrollVelocity', () => ({ useFastScrolling: () => false }));

import { documentRegistry } from '../../app/services';
import { bitmapCache, bitmapKey } from '../../engine/bitmapCache';
import { Priority } from '../../engine/renderScheduler';
import { overlayCacheId, type OverlayView } from '../../features/compare/compareMath';
import { usePageBitmap } from './usePageBitmap';

function fakeBitmap(width: number, height: number) {
  const bitmap = {
    width,
    height,
    close: vi.fn(() => {
      bitmap.width = 0;
      bitmap.height = 0;
    }),
  };
  return bitmap as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

const DOC = 'doc-overlay-hook-test';
const request = { docId: DOC, srcIndex: 2, rotation: 0, scale: 1, priority: Priority.Visible, content: '2@0' };
const view = (hash: string, sourcePage = 1): OverlayView => ({
  hash,
  args: { sourceDocId: 'src1', sourcePage, dx: 4, dy: 5, scale: 1.5, mode: 'blend', opacity: 0.4 },
});

afterEach(() => {
  bitmapCache.deleteWhere(() => true);
  vi.clearAllMocks();
});

describe('the overlay in the page bitmap hook', () => {
  it('asks the engine for the overlay, and caches the bitmap under the pseudo document id, not the plain one', async () => {
    const bitmap = fakeBitmap(100, 100);
    const renderBitmap = vi.fn(async () => bitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 3 } as never);
    const pane = renderHook(() => usePageBitmap({ ...request, overlay: view('1.blend.0.400.4.000.5.000.1.500.1') }));
    await waitFor(() => expect(pane.result.current).toBe(bitmap));
    expect(renderBitmap).toHaveBeenCalledWith(2, expect.objectContaining({ scale: 1, rotation: 0, overlay: view('x').args }));
    const pseudo = overlayCacheId(DOC, '1.blend.0.400.4.000.5.000.1.500.1');
    expect(bitmapCache.has(bitmapKey(pseudo, 2, 1, 0, '2@0'))).toBe(true);
    // The plain page was never cached: a plain bitmap cannot be taken for the overlay one, or the other way round.
    expect(bitmapCache.has(bitmapKey(DOC, 2, 1, 0, '2@0'))).toBe(false);
    pane.unmount();
  });

  it('a plain page asks for no overlay', async () => {
    const bitmap = fakeBitmap(100, 100);
    const renderBitmap = vi.fn(async () => bitmap);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 3 } as never);
    const pane = renderHook(() => usePageBitmap(request));
    await waitFor(() => expect(pane.result.current).toBe(bitmap));
    expect(renderBitmap).toHaveBeenCalledWith(2, expect.objectContaining({ overlay: undefined }));
    expect(bitmapCache.has(bitmapKey(DOC, 2, 1, 0, '2@0'))).toBe(true);
    pane.unmount();
  });

  it('a changed look is a new render, and the old look stays cached for when it comes back', async () => {
    const first = fakeBitmap(100, 100);
    const second = fakeBitmap(100, 100);
    const renders = [first, second];
    const renderBitmap = vi.fn(async () => renders.shift() ?? second);
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 3 } as never);
    const pane = renderHook(({ overlay }) => usePageBitmap({ ...request, overlay }), { initialProps: { overlay: view('a') as OverlayView | undefined } });
    await waitFor(() => expect(pane.result.current).toBe(first));
    pane.rerender({ overlay: view('b', 2) });
    await waitFor(() => expect(pane.result.current).toBe(second));
    expect(renderBitmap).toHaveBeenCalledTimes(2);
    // Back to the first look: found in the cache, not rendered again.
    pane.rerender({ overlay: view('a') });
    await waitFor(() => expect(pane.result.current).toBe(first));
    expect(renderBitmap).toHaveBeenCalledTimes(2);
    pane.unmount();
  });

  it('leaving the compare (no overlay) shows the plain page again, from its own cache entry', async () => {
    const plain = fakeBitmap(100, 100);
    const withOverlay = fakeBitmap(100, 100);
    bitmapCache.set(bitmapKey(DOC, 2, 1, 0, '2@0'), plain, 100 * 100 * 4);
    bitmapCache.set(bitmapKey(overlayCacheId(DOC, 'a'), 2, 1, 0, '2@0'), withOverlay, 100 * 100 * 4);
    const renderBitmap = vi.fn(async () => fakeBitmap(1, 1));
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 3 } as never);
    const pane = renderHook(({ overlay }) => usePageBitmap({ ...request, overlay }), { initialProps: { overlay: view('a') as OverlayView | undefined } });
    expect(pane.result.current).toBe(withOverlay);
    pane.rerender({ overlay: undefined });
    await waitFor(() => expect(pane.result.current).toBe(plain));
    expect(renderBitmap).not.toHaveBeenCalled();
    pane.unmount();
  });
});
