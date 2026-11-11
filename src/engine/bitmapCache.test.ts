import { afterEach, describe, expect, it, vi } from 'vitest';
import { BITMAP_BUDGET_BYTES, bitmapCache, bitmapKey, dropLargeHigherScales, dropLowerScales, evictStaleBitmaps } from './bitmapCache';
import { thumbnailCache, thumbnailKey } from './thumbnailCache';

function fakeBitmap(bytes: number) {
  return { width: bytes / 4, height: 1, close: vi.fn() };
}

afterEach(() => {
  bitmapCache.deleteWhere(() => true);
});

describe('one byte budget for page and thumbnail bitmaps', () => {
  it('has a single budget of 48 MB, shared by pages and thumbnails', () => {
    expect(BITMAP_BUDGET_BYTES).toBe(48 * 1024 * 1024);
  });

  it('counts thumbnails in bytes, against the same budget as the pages', () => {
    const thumb = fakeBitmap(1000);
    thumbnailCache.set(thumbnailKey('d', 0, 0, 100, 1), thumb as unknown as ImageBitmap, 1000);
    const page = fakeBitmap(2000);
    bitmapCache.set(bitmapKey('d', 0, 1, 0), page as unknown as ImageBitmap, 2000);
    expect(bitmapCache.bytes).toBe(3000);
    expect(thumbnailCache.get(thumbnailKey('d', 0, 0, 100, 1))).toBe(thumb);
  });

  it('evicts a thumbnail to make room for a page, and closes the evicted bitmap', () => {
    const thumb = fakeBitmap(1000);
    thumbnailCache.set('t', thumb as unknown as ImageBitmap, 1000);
    bitmapCache.set('evictor', fakeBitmap(10) as unknown as ImageBitmap, BITMAP_BUDGET_BYTES);
    expect(thumb.close).toHaveBeenCalledTimes(1);
    expect(thumbnailCache.get('t')).toBeUndefined();
  });
});

describe('releasing lower-resolution bitmaps', () => {
  it('drops the bitmaps of the same page at lower scales, and keeps the full one', () => {
    const low = fakeBitmap(400);
    const full = fakeBitmap(1600);
    bitmapCache.set(bitmapKey('doc', 3, 0.5, 0), low as unknown as ImageBitmap, 400);
    bitmapCache.set(bitmapKey('doc', 3, 2, 0), full as unknown as ImageBitmap, 1600);
    dropLowerScales('doc', 3, 0, 2);
    expect(bitmapCache.has(bitmapKey('doc', 3, 0.5, 0))).toBe(false);
    expect(low.close).toHaveBeenCalledTimes(1);
    expect(bitmapCache.get(bitmapKey('doc', 3, 2, 0))).toBe(full as unknown as ImageBitmap);
    expect(full.close).not.toHaveBeenCalled();
  });

  it('leaves other pages, other rotations, other documents and thumbnails alone', () => {
    const others = [
      bitmapKey('doc', 4, 0.5, 0),
      bitmapKey('doc', 3, 0.5, 90),
      bitmapKey('other', 3, 0.5, 0),
    ];
    for (const key of others) bitmapCache.set(key, fakeBitmap(40) as unknown as ImageBitmap, 40);
    thumbnailCache.set(thumbnailKey('doc', 3, 0, 100, 0.5), fakeBitmap(40) as unknown as ImageBitmap, 40);
    dropLowerScales('doc', 3, 0, 2);
    for (const key of others) expect(bitmapCache.has(key)).toBe(true);
    expect(thumbnailCache.has(thumbnailKey('doc', 3, 0, 100, 0.5))).toBe(true);
  });

  it('treats a document id that contains a separator as one id', () => {
    bitmapCache.set(bitmapKey('a|b', 0, 0.5, 0), fakeBitmap(40) as unknown as ImageBitmap, 40);
    dropLowerScales('a', 0, 0, 2);
    expect(bitmapCache.has(bitmapKey('a|b', 0, 0.5, 0))).toBe(true);
    dropLowerScales('a|b', 0, 0, 2);
    expect(bitmapCache.has(bitmapKey('a|b', 0, 0.5, 0))).toBe(false);
  });
});

describe('evictStaleBitmaps (old revisions are released at once)', () => {
  it('closes the page and thumbnail bitmaps whose content is no longer in the document', () => {
    const bitmap = (id: string) => ({ id, width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;
    const keep = bitmap('keep');
    const stale = bitmap('stale');
    const staleThumb = bitmap('stale-thumb');
    const otherDoc = bitmap('other-doc');
    bitmapCache.set(bitmapKey('doc-a', 0, 1, 0, 'u1@1'), keep, 4);
    bitmapCache.set(bitmapKey('doc-a', 1, 1, 0, 'u2@1'), stale, 4);
    thumbnailCache.set(thumbnailKey('doc-a', 2, 0, 160, 0.5, 'u9@3'), staleThumb, 4);
    bitmapCache.set(bitmapKey('doc-b', 0, 1, 0, 'u2@1'), otherDoc, 4);
    evictStaleBitmaps('doc-a', new Set(['u1@1']));
    expect(bitmapCache.has(bitmapKey('doc-a', 0, 1, 0, 'u1@1'))).toBe(true);
    expect(bitmapCache.has(bitmapKey('doc-a', 1, 1, 0, 'u2@1'))).toBe(false);
    expect(thumbnailCache.has(thumbnailKey('doc-a', 2, 0, 160, 0.5, 'u9@3'))).toBe(false);
    expect(bitmapCache.has(bitmapKey('doc-b', 0, 1, 0, 'u2@1'))).toBe(true);
    // The evicted bitmaps are closed, so their memory is released at once.
    expect(stale.close).toHaveBeenCalled();
    expect(staleThumb.close).toHaveBeenCalled();
    expect(keep.close).not.toHaveBeenCalled();
    expect(otherDoc.close).not.toHaveBeenCalled();
  });
});

describe('stale bitmaps after a save or a reload (ticket 1.2.1 review, item 4)', () => {
  const bitmap = (name: string) => ({ name, width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap & { name: string; close: () => void };

  it('a pinned bitmap of a deleted page is released when it is unpinned, and is not found meanwhile by a new worker', () => {
    const D = 'path:C:/docs/a.pdf';
    const page0 = bitmap('original page 0');
    bitmapCache.set(bitmapKey(D, 0, 1, 0, '0@0@1'), page0, 4);
    bitmapCache.pin(page0);
    // Page 0 deleted: the worker reports uids 1 and 2.
    evictStaleBitmaps(D, new Set(['1@0@1', '2@0@1']));
    expect(page0.close).not.toHaveBeenCalled(); // still on screen
    const page1 = bitmap('original page 1');
    bitmapCache.set(bitmapKey(D, 0, 1, 0, '1@0@1'), page1, 4);
    bitmapCache.pin(page1);
    bitmapCache.unpin(page0);
    expect(page0.close).toHaveBeenCalled();
    expect(bitmapCache.has(bitmapKey(D, 0, 1, 0, '0@0@1'))).toBe(false);
    // Save: a fresh worker (generation 2) reports uids 0 and 1 at rev 0. Its key for index 0 is a different key.
    evictStaleBitmaps(D, new Set(['0@0@2', '1@0@2']));
    expect(bitmapCache.get(bitmapKey(D, 0, 1, 0, '0@0@2'))).toBeUndefined();
    bitmapCache.unpin(page1);
    expect(page1.close).toHaveBeenCalled();
    expect(bitmapCache.has(bitmapKey(D, 0, 1, 0, '1@0@1'))).toBe(false);
  });

  it('a pinned stale entry is not drawn for the same uid@rev of a new generation, even before it is unpinned', () => {
    const D = 'doc-gen';
    const old = bitmap('old');
    bitmapCache.set(bitmapKey(D, 0, 1, 0, '0@0@1'), old, 4);
    bitmapCache.pin(old);
    evictStaleBitmaps(D, new Set(['0@0@2']));
    expect(bitmapCache.get(bitmapKey(D, 0, 1, 0, '0@0@2'))).toBeUndefined();
    bitmapCache.unpin(old);
    expect(bitmapCache.has(bitmapKey(D, 0, 1, 0, '0@0@1'))).toBe(false);
  });
});

describe('releasing large higher-resolution bitmaps', () => {
  const LARGE = 30_000_000;
  const big = (bytes = LARGE) => fakeBitmap(bytes);

  it('drops the large bitmaps of the page above the given scale and keeps the lower one', () => {
    const low = big(2_000_000);
    const full = big();
    bitmapCache.set(bitmapKey('doc', 3, 0.5, 0), low as unknown as ImageBitmap, 2_000_000);
    bitmapCache.set(bitmapKey('doc', 3, 4, 0), full as unknown as ImageBitmap, LARGE);
    dropLargeHigherScales('doc', 3, 0, 0.5);
    expect(bitmapCache.has(bitmapKey('doc', 3, 4, 0))).toBe(false);
    expect(full.close).toHaveBeenCalledTimes(1);
    expect(bitmapCache.has(bitmapKey('doc', 3, 0.5, 0))).toBe(true);
    expect(low.close).not.toHaveBeenCalled();
  });

  it('keeps a bitmap under 12 MB at a higher scale (small pages keep their LRU behaviour)', () => {
    const small = big(4_000_000);
    bitmapCache.set(bitmapKey('doc', 3, 2, 0), small as unknown as ImageBitmap, 4_000_000);
    dropLargeHigherScales('doc', 3, 0, 0.5);
    expect(bitmapCache.has(bitmapKey('doc', 3, 2, 0))).toBe(true);
  });

  it('leaves other pages, rotations, content, documents and thumbnails alone', () => {
    const SMALL = 4_000; // sizes are kept small so the entries fit the budget; minBytes is lowered to match
    const others = [bitmapKey('doc', 4, 4, 0), bitmapKey('doc', 3, 4, 90), bitmapKey('other', 3, 4, 0), bitmapKey('doc', 3, 4, 0, 'u2@1')];
    for (const key of others) bitmapCache.set(key, fakeBitmap(SMALL) as unknown as ImageBitmap, SMALL);
    thumbnailCache.set(thumbnailKey('doc', 3, 0, 100, 4), fakeBitmap(SMALL) as unknown as ImageBitmap, SMALL);
    dropLargeHigherScales('doc', 3, 0, 0.5, '', 1_000);
    for (const key of others) expect(bitmapCache.has(key)).toBe(true);
    expect(thumbnailCache.has(thumbnailKey('doc', 3, 0, 100, 4))).toBe(true);
  });

  it('a bitmap still on screen is closed only when its holder lets go', () => {
    const shown = big();
    bitmapCache.set(bitmapKey('doc', 3, 4, 0), shown as unknown as ImageBitmap, LARGE);
    bitmapCache.pin(shown as unknown as ImageBitmap);
    dropLargeHigherScales('doc', 3, 0, 0.5);
    expect(shown.close).not.toHaveBeenCalled();
    bitmapCache.unpin(shown as unknown as ImageBitmap);
    expect(shown.close).toHaveBeenCalledTimes(1);
    expect(bitmapCache.has(bitmapKey('doc', 3, 4, 0))).toBe(false);
  });
});
