import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { documentRegistry } from '../../app/services';
import { bitmapBytes, bitmapCache, bitmapKey, dropLargeHigherScales, dropLowerScales } from '../../engine/bitmapCache';
import { renderScheduler, type Priority } from '../../engine/renderScheduler';
import { useFastScrolling } from './scrollVelocity';
import { overlayCacheId, type OverlayView } from '../../features/compare/compareMath';

export interface BitmapRequest {
  docId: string;
  srcIndex: number;
  rotation: number;
  /** Render scale: zoom times device pixel ratio. */
  scale: number;
  /** Scale used while the viewer scrolls fast (see progressiveScale.ts). */
  lowScale?: number;
  /**
   * False for a page that does not intersect the viewport and is large at full resolution (see progressiveScale.ts
   * pageScales): it renders at `lowScale` only, and releases its larger bitmaps once the lower one shows. Default true.
   */
  wantsFull?: boolean;
  priority: Priority;
  /** The page's "uid@rev" (see PageRef.content). A bitmap for other content is never returned. */
  content?: string;
  /**
   * True while pages must not be requested (a scrollbar drag is in progress). A bitmap already cached still shows.
   */
  paused?: boolean;
  /**
   * Compare view (1.3.4): the overlay laid over this page in the same bitmap. Its bitmaps are cached under a pseudo document id
   * (`${docId}#ov:${hash}`), never under the plain id and never in `content`, so the plain page, the thumbnails and the text
   * are untouched, and a look that is gone cannot be drawn for the one on screen.
   */
  overlay?: OverlayView;
}

/**
 * Returns the rendered bitmap for a page at a scale. Renders through the scheduler and the LRU cache,
 * and cancels the render when the page unmounts. While a new scale renders, the previous bitmap stays
 * visible so the page does not flash.
 *
 * Ownership: the cache owns every bitmap. A consumer never closes one, so two panes that show the
 * same page can share it. Only the cache's eviction closes a bitmap. A bitmap that has been closed is
 * never returned: the hook asks for the page again instead.
 */
export function usePageBitmap({ docId, srcIndex, rotation, scale, lowScale = scale, wantsFull = true, priority, paused = false, content = '', overlay }: BitmapRequest): ImageBitmap | null {
  // While scrolling fast, a page renders at lowScale. Each scale has its own cache key, so the two never mix.
  // A page that already has its full-resolution bitmap keeps it: downgrading would blur a page that is ready.
  const fast = useFastScrolling();
  // The id the cache knows this picture by: the document, or its overlay view (see BitmapRequest.overlay).
  const cacheId = overlay ? overlayCacheId(docId, overlay.hash) : docId;
  const fullReady = fast && wantsFull && (bitmapCache.get(bitmapKey(cacheId, srcIndex, scale, rotation, content))?.width ?? 0) > 0;
  // A neighbour of a large page (not wantsFull) always renders at the lower scale.
  const effectiveScale = !wantsFull || (fast && !fullReady) ? lowScale : scale;
  const key = bitmapKey(cacheId, srcIndex, effectiveScale, rotation, content);
  const [shown, setShown] = useState<ImageBitmap | null>(() => bitmapCache.get(key) ?? null);
  /** The content the shown bitmap was drawn from. After an edit the old bitmap is not shown for the new content. */
  const [shownFor, setShownFor] = useState(content);
  const [attempt, setAttempt] = useState(0);
  // The latest request values. The render effect reads them here, so it is keyed by `key` and `attempt` only.
  const latest = useRef({ docId, cacheId, srcIndex, rotation, scale: effectiveScale, priority, content, overlay });
  latest.current = { docId, cacheId, srcIndex, rotation, scale: effectiveScale, priority, content, overlay };
  const lowScaleRef = useRef(lowScale);
  lowScaleRef.current = lowScale;

  useEffect(() => {
    const cached = bitmapCache.get(key);
    if (cached && cached.width > 0) {
      setShown(cached);
      setShownFor(latest.current.content);
      releaseAbove(latest.current);
      return;
    }
    if (paused) return;
    const request = latest.current;
    const handle = documentRegistry.get(request.docId);
    if (!handle) return;

    let alive = true;
    const job = renderScheduler.schedule(key, request.priority, (signal) =>
      handle.doc.renderBitmap(request.srcIndex, { scale: request.scale, rotation: request.rotation, signal, overlay: request.overlay?.args }),
    );
    job.promise.then(
      (bitmap) => {
        // The cache keeps the bitmap even if this page has gone, so another consumer can use it.
        bitmapCache.set(key, bitmap, bitmapBytes(bitmap));
        // A full-resolution page releases the lower-resolution bitmaps of the same page: they are no longer needed.
        dropLowerScales(request.cacheId, request.srcIndex, request.rotation, request.scale, request.content);
        if (alive) {
          setShown(bitmap);
          setShownFor(request.content);
          // The page now shows this scale: larger bitmaps of it (left from the viewport or a higher zoom) are released.
          releaseAbove(request);
        }
      },
      () => {
        // Cancelled (page scrolled away) or failed. The page stays blank.
      },
    );
    return () => {
      alive = false;
      job.cancel();
    };
  }, [key, attempt, paused]);

  useEffect(() => {
    renderScheduler.reprioritize(key, priority);
  }, [key, priority]);

  // The page leaves the screen (it scrolled out of the overscan, or its tab closed): its large bitmaps go with it.
  useEffect(
    () => () => {
      const r = latest.current;
      dropLargeHigherScales(r.cacheId, r.srcIndex, r.rotation, lowScaleRef.current, r.content);
    },
    [],
  );

  // A shown bitmap is pinned, so the cache cannot evict it while the page is on screen. A blank page with a closed
  // bitmap is the failure this prevents. The pin is released when the page shows another bitmap or unmounts.
  // The pin is taken in a layout effect and released in a passive one, on purpose: a bitmap taken from the cache at mount (the
  // state initializer) is pinned in the commit, before any passive cleanup runs. Another pane's unmount (split view) lets go of
  // its pin and may release a large bitmap in that same commit; without this order it would close the bitmap this pane has just
  // taken. (A layout cleanup would not do: it runs in the mutation phase, before this pane's layout effect.)
  const pinnedRef = useRef<ImageBitmap | null>(null);
  useLayoutEffect(() => {
    pinnedRef.current = null;
    if (!shown || shown.width === 0) return;
    bitmapCache.pin(shown);
    pinnedRef.current = shown;
  }, [shown]);
  useEffect(() => {
    const mine = pinnedRef.current;
    return () => {
      if (mine) bitmapCache.unpin(mine);
    };
  }, [shown]);

  // The cache closed this bitmap (it was evicted), so it cannot be drawn. Drop it and render the page again.
  const stale = shown !== null && shown.width === 0;
  useEffect(() => {
    if (stale) {
      setShown(null);
      setAttempt((n) => n + 1);
    }
  }, [stale]);

  return shown !== null && !stale && shownFor === content ? shown : null;
}

/** Closes the large bitmaps of the page at scales above the one it now shows (see dropLargeHigherScales). */
function releaseAbove(request: { cacheId: string; srcIndex: number; rotation: number; scale: number; content: string }): void {
  dropLargeHigherScales(request.cacheId, request.srcIndex, request.rotation, request.scale, request.content);
}
