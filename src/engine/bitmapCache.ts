import { SizedLru } from './lru';
import { knobs } from './testKnobs';

/**
 * One byte budget for every rendered bitmap: pages at each scale and thumbnails, counted in the bytes each
 * bitmap holds. MuPDF bitmaps are GPU-shareable (see core.ts), so drawing one does not upload a second copy. The
 * budget covers the on-screen pages and their overscan, and keeps the renderer's bitmap memory bounded.
 */
export const BITMAP_BUDGET_BYTES = knobs.bitmapBudgetBytes; // test-mode knob; default 48 MB

/** Kept under this name for callers that size against the page cache. */
export const BITMAP_CACHE_BYTES = BITMAP_BUDGET_BYTES;

/** The shared store. Eviction closes the bitmap, so its memory is released at once. */
export const bitmapCache = new SizedLru<ImageBitmap>(BITMAP_BUDGET_BYTES, (_key, bitmap) => {
  bitmap.close();
});

/**
 * The key of one page bitmap. `content` is the page's "uid@rev" (see protocol.ts): a page's content changes its rev, so
 * a bitmap made for old content has a different key and is never drawn for the new content. The engine index alone
 * would name a different page after a move or a delete.
 */
export function bitmapKey(docId: string, srcIndex: number, scale: number, rotation: number, content = ''): string {
  return `${docId}|${srcIndex}|${scale.toFixed(3)}|${rotation}|${content}`;
}

export function bitmapBytes(bitmap: ImageBitmap): number {
  return bitmap.width * bitmap.height * 4;
}

/** The scale, rotation, source index, content and document id of a page bitmap key, or null for a key of another shape. */
function parsePageKey(key: string): { docId: string; srcIndex: string; scale: number; rotation: string; content: string } | null {
  const parts = key.split('|');
  if (parts.length < 5) return null;
  return {
    docId: parts.slice(0, -4).join('|'),
    srcIndex: parts.at(-4) as string,
    scale: Number(parts.at(-3)),
    rotation: parts.at(-2) as string,
    content: parts.at(-1) as string,
  };
}

/**
 * Releases the bitmaps of one page (same content) at lower scales than `scale`, once a bitmap at `scale` is in the
 * cache. Keys are parsed from the end (content, rotation, scale, srcIndex), so the docId may itself contain separators.
 */
export function dropLowerScales(docId: string, srcIndex: number, rotation: number, scale: number, content = ''): void {
  bitmapCache.deleteWhere((key) => {
    const k = parsePageKey(key);
    if (!k || k.rotation !== String(rotation) || k.srcIndex !== String(srcIndex) || k.content !== content || k.docId !== docId) return false;
    return k.scale < scale - 1e-3;
  });
}

/** A page bitmap of at least this size (3 megapixels, 12 MB) is "large": it is released as soon as the page no longer needs it. */
export const LARGE_BITMAP_BYTES = 12_000_000;

/**
 * Releases the large bitmaps (at least `minBytes`) of one page (same content) at higher scales than `scale`. A page that
 * has left the viewport, or whose zoom went back down, no longer needs its full-resolution bitmap, and at high zoom one
 * bitmap is 30 MB or more. Bitmaps still shown are closed when their holder lets go (see SizedLru.deleteWhere).
 */
export function dropLargeHigherScales(docId: string, srcIndex: number, rotation: number, scale: number, content = '', minBytes = LARGE_BITMAP_BYTES): void {
  bitmapCache.deleteWhere((key, size) => {
    if (size < minBytes) return false;
    const k = parsePageKey(key);
    if (!k || k.rotation !== String(rotation) || k.srcIndex !== String(srcIndex) || k.content !== content || k.docId !== docId) return false;
    return k.scale > scale + 1e-3;
  });
}

/**
 * The same as evictStaleBitmaps for the Compare view (1.3.4): its bitmaps are cached under the pseudo document id
 * `${docId}#ov:${hash}`, which evictStaleBitmaps does not match on purpose (it must never find them through the plain id). This
 * closes the ones whose page content is gone. The content is still the last field of the key.
 */
export function evictStaleOverlayBitmaps(docId: string, current: ReadonlySet<string>): void {
  const prefix = `${docId}#ov:`;
  bitmapCache.deleteWhere((key) => {
    if (!key.startsWith(prefix)) return false;
    const content = key.slice(key.lastIndexOf('|') + 1);
    return content !== '' && !current.has(content);
  });
}

/**
 * Closes every bitmap of one document: its pages at any scale, its thumbnails and its Compare overlays. Used when the document
 * has been out of every pane for a while (features/documents/tabResidency.ts). A bitmap that is still pinned (on screen) stays until
 * it is let go. They are drawn again when the document is shown.
 */
export function releaseBitmapsOf(docId: string): void {
  const thumbPrefix = 'thumb|';
  bitmapCache.deleteWhere((key) => {
    const body = key.startsWith(thumbPrefix) ? key.slice(thumbPrefix.length) : key;
    return body.startsWith(`${docId}|`) || body.startsWith(`${docId}#ov:`);
  });
}

/**
 * Closes the bitmaps (pages and thumbnails) of one document whose page content is no longer in its page list. A page
 * that was deleted, or whose content changed (its rev moved on, as after a rotate, resize or replace), has keys nobody
 * can ask for again, so until they were evicted they only held memory. `current` is the document's "uid@rev" set. A
 * bitmap still on screen is pinned and is released when it leaves the screen.
 */
export function evictStaleBitmaps(docId: string, current: ReadonlySet<string>): void {
  const thumbPrefix = 'thumb|';
  bitmapCache.deleteWhere((key) => {
    const body = key.startsWith(thumbPrefix) ? key.slice(thumbPrefix.length) : key;
    if (!body.startsWith(`${docId}|`)) return false;
    // The content is the last field of every key (see bitmapKey and thumbnailKey); "uid@rev" never holds a "|".
    const content = body.slice(body.lastIndexOf('|') + 1);
    return content !== '' && !current.has(content);
  });
}
