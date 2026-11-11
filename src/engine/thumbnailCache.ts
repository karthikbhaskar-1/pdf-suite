import { bitmapCache } from './bitmapCache';

/**
 * Thumbnails share the page bitmaps' byte budget (bitmapCache), under their own key prefix. A thumbnail is
 * counted in bytes, like a page, so the thumbnails cannot grow the renderer's memory without limit.
 */
const PREFIX = 'thumb|';

export const thumbnailCache = {
  get: (key: string): ImageBitmap | undefined => bitmapCache.get(PREFIX + key),
  set: (key: string, bitmap: ImageBitmap, bytes: number): void => bitmapCache.set(PREFIX + key, bitmap, bytes),
  has: (key: string): boolean => bitmapCache.has(PREFIX + key),
  delete: (key: string): void => bitmapCache.delete(PREFIX + key),
};

/** The key of one thumbnail. `content` is the page's "uid@rev", so an edited page never shows its old thumbnail. */
export function thumbnailKey(docId: string, srcIndex: number, rotation: number, widthPx: number, scale: number, content = ''): string {
  return `${docId}|${srcIndex}|${rotation}|${widthPx}|${scale.toFixed(4)}|${content}`;
}
