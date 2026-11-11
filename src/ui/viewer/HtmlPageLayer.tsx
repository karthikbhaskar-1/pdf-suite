import { useEffect, useRef } from 'react';
import { documentRegistry } from '../../app/services';
import type { PageLayerProps } from './pageLayers';

/**
 * The HTML layer of a page: an XFA page's content as HTML, above the canvas. Built by the engine, read-only
 * (the layer ignores the pointer). While it is shown the canvas underneath is hidden. If the layer cannot be
 * built, nothing is hidden and the canvas (the fallback page) stays visible.
 */
export function HtmlPageLayer({ docId, srcIndex, rotation, zoom }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const handle = documentRegistry.get(docId);
    if (!el || !handle?.doc.capabilities.htmlLayer || !handle.doc.renderHtmlLayer) return;
    const page = el.closest('.page');
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    handle.doc
      .renderHtmlLayer!(srcIndex, el, { scale: zoom, rotation })
      .then((done) => {
        if (!done) return;
        if (cancelled) {
          done();
          return;
        }
        cleanup = done;
        page?.classList.add('has-html-layer');
      })
      .catch(() => {
        // The canvas keeps showing the fallback page.
      });
    return () => {
      cancelled = true;
      cleanup?.();
      page?.classList.remove('has-html-layer');
    };
  }, [docId, srcIndex, rotation, zoom]);

  return <div ref={ref} className="html-layer" />;
}
