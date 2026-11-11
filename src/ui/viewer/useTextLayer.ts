import { useEffect, type RefObject } from 'react';
import { documentRegistry } from '../../app/services';

export interface TextLayerRequest {
  docId: string;
  srcIndex: number;
  rotation: number;
  zoom: number;
  /** Only pages in the viewport get a text layer. */
  enabled: boolean;
  /** The page's "uid@rev" (PageRef.content): the layer is built again when an edit (Crop, Page size) changes the page. */
  content?: string;
}

/** Builds the selectable text layer while the page is in the viewport, and removes it when it leaves. */
export function useTextLayer(container: RefObject<HTMLDivElement>, req: TextLayerRequest): void {
  const { docId, srcIndex, rotation, zoom, enabled, content } = req;

  useEffect(() => {
    const el = container.current;
    const handle = documentRegistry.get(docId);
    if (!enabled || !el || !handle) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    handle.doc
      .renderTextLayer(srcIndex, el, { scale: zoom, rotation })
      .then((done) => {
        if (cancelled) done();
        else cleanup = done;
      })
      .catch(() => {
        // No text layer for this page. The image still shows.
      });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [container, docId, srcIndex, rotation, zoom, enabled, content]);
}
