import { useEffect, useRef, useState } from 'react';
import { documentRegistry } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { bitmapBytes } from '../../engine/bitmapCache';
import { thumbnailCache, thumbnailKey } from '../../engine/thumbnailCache';
import { renderScheduler, type Priority } from '../../engine/renderScheduler';

export interface ThumbnailRequest {
  docId: string;
  srcIndex: number;
  /** Extra rotation of the page in the page list. */
  rotation: number;
  /** Width of the thumbnail in CSS pixels. */
  widthPx: number;
  priority: Priority;
  /** The page's "uid@rev" (see PageRef.content). A thumbnail for other content is never returned. */
  content?: string;
}

const DEFAULT_WIDTH_PT = 612;
const DEFAULT_HEIGHT_PT = 792;

/**
 * A small rendered image of one page, `widthPx` wide. Rendered through the shared scheduler at the priority the caller
 * gives (Priority.Thumbnail in the page list), kept in the page bitmap cache under its own key prefix (thumbnailCache.ts:
 * thumbnails share the pages' byte budget and have no count limit of their own), and cancelled when the component leaves.
 * Thumbnails are never recolored.
 *
 * Ownership matches usePageBitmap: the cache owns the bitmap and only its eviction closes it. A
 * closed bitmap is never returned; the thumbnail is rendered again instead.
 */
export function useThumbnail({ docId, srcIndex, rotation, widthPx, priority, content = '' }: ThumbnailRequest): ImageBitmap | null {
  const sizes = useDocumentsStore((s) => s.docs[docId]?.sizes);
  const size = sizes?.[srcIndex];
  // PageSize already includes the page's own rotation, so only the page list rotation can turn it again.
  const turned = rotation % 180 !== 0;
  const pageWidth = size ? (turned ? size.height : size.width) : turned ? DEFAULT_HEIGHT_PT : DEFAULT_WIDTH_PT;
  const dpr = window.devicePixelRatio || 1;
  const scale = (widthPx * dpr) / Math.max(1, pageWidth);
  const key = thumbnailKey(docId, srcIndex, rotation, widthPx, scale, content);
  const [shown, setShown] = useState<ImageBitmap | null>(() => thumbnailCache.get(key) ?? null);
  const [shownFor, setShownFor] = useState(content);
  const [attempt, setAttempt] = useState(0);
  // The latest request values, read by the render effect, so the effect is keyed by `key` and `attempt` only.
  const latest = useRef({ docId, srcIndex, rotation, scale, priority, content });
  latest.current = { docId, srcIndex, rotation, scale, priority, content };

  useEffect(() => {
    const cached = thumbnailCache.get(key);
    if (cached && cached.width > 0) {
      setShown(cached);
      setShownFor(latest.current.content);
      return;
    }
    const request = latest.current;
    const handle = documentRegistry.get(request.docId);
    if (!handle) return;
    let alive = true;
    const job = renderScheduler.schedule(key, request.priority, (signal) =>
      handle.doc.renderBitmap(request.srcIndex, { scale: request.scale, rotation: request.rotation, signal }),
    );
    job.promise.then(
      (bitmap) => {
        thumbnailCache.set(key, bitmap, bitmapBytes(bitmap));
        if (alive) {
          setShown(bitmap);
          setShownFor(request.content);
        }
      },
      () => {
        // Cancelled or failed. The thumbnail stays blank.
      },
    );
    return () => {
      alive = false;
      job.cancel();
    };
  }, [key, attempt]);

  // The cache closed this bitmap (it was evicted), so it cannot be drawn. Drop it and render again.
  const stale = shown !== null && shown.width === 0;
  useEffect(() => {
    if (stale) {
      setShown(null);
      setAttempt((n) => n + 1);
    }
  }, [stale]);

  return shown !== null && !stale && shownFor === content ? shown : null;
}
