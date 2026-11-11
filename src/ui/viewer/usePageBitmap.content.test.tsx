import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../app/services', () => ({ documentRegistry: { get: vi.fn() } }));
vi.mock('./scrollVelocity', () => ({ useFastScrolling: () => false }));

import { documentRegistry } from '../../app/services';
import { bitmapBytes, bitmapCache, bitmapKey } from '../../engine/bitmapCache';
import { Priority } from '../../engine/renderScheduler';
import { usePageBitmap, type BitmapRequest } from './usePageBitmap';

function fakeBitmap(width: number, height: number) {
  const bitmap = {
    width,
    height,
    close: vi.fn(() => {
      bitmap.width = 0;
      bitmap.height = 0;
    }),
  };
  return bitmap as unknown as ImageBitmap;
}

const DOC = 'doc-content-key-test';

afterEach(() => {
  bitmapCache.delete(bitmapKey(DOC, 0, 1, 0, '0@0'));
  bitmapCache.delete(bitmapKey(DOC, 0, 1, 0, '0@1'));
  vi.clearAllMocks();
});

describe('a page bitmap follows the content of the page, not its index', () => {
  it('after an edit changed the page under the same index, the old bitmap is not shown', async () => {
    // Each test makes its own bitmaps: deleting a key from the cache closes its bitmap.
    const OLD = fakeBitmap(100, 100);
    const NEW = fakeBitmap(120, 120);
    bitmapCache.set(bitmapKey(DOC, 0, 1, 0, '0@0'), OLD, bitmapBytes(OLD));
    let resolveNew!: (bitmap: ImageBitmap) => void;
    const renderBitmap = vi.fn(() => new Promise<ImageBitmap>((resolve) => (resolveNew = resolve)));
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);

    const base: BitmapRequest = { docId: DOC, srcIndex: 0, rotation: 0, scale: 1, priority: Priority.Visible, content: '0@0' };
    const { result, rerender } = renderHook((props: BitmapRequest) => usePageBitmap(props), { initialProps: base });
    expect(result.current).toBe(OLD);

    // The page at index 0 is now a rotated page with a new rev: the old bitmap is for other content.
    rerender({ ...base, content: '0@1' });
    expect(result.current).toBeNull();
    await waitFor(() => expect(renderBitmap).toHaveBeenCalledTimes(1));

    resolveNew(NEW);
    await waitFor(() => expect(result.current).toBe(NEW));
  });

  it('the same content at the same scale keeps showing its bitmap while nothing changed', () => {
    const OLD = fakeBitmap(100, 100);
    bitmapCache.set(bitmapKey(DOC, 0, 1, 0, '0@0'), OLD, bitmapBytes(OLD));
    const renderBitmap = vi.fn(() => new Promise<ImageBitmap>(() => undefined));
    vi.mocked(documentRegistry.get).mockReturnValue({ docId: DOC, doc: { renderBitmap }, pageCount: 1 } as never);
    const base: BitmapRequest = { docId: DOC, srcIndex: 0, rotation: 0, scale: 1, priority: Priority.Visible, content: '0@0' };
    const { result, rerender } = renderHook((props: BitmapRequest) => usePageBitmap(props), { initialProps: base });
    rerender({ ...base });
    expect(result.current).toBe(OLD);
    expect(renderBitmap).not.toHaveBeenCalled();
  });
});
