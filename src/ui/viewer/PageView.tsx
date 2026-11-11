import { memo, useEffect, useReducer, useRef } from 'react';
import type { Priority } from '../../engine/renderScheduler';
import { useRecolorFilterCss } from './recolorFilterCss';
import { pageLayers } from './pageLayers';
import { usePageBitmap } from './usePageBitmap';
import { useTextLayer } from './useTextLayer';
import { cancelDraw, queueDraw } from './drawQueue';
import { NEIGHBOUR_FULL_MAX_PIXELS, pageScales } from './progressiveScale';
import type { OverlayView } from '../../features/compare/compareMath';

export interface PageViewProps {
  paneId: string;
  docId: string;
  pageId: string;
  /** Position in the page list (what the user sees as "Page N"). */
  index: number;
  srcIndex: number;
  /** The page's "uid@rev" (see PageRef.content). Keys the bitmap, so an edited page is drawn again. */
  content?: string;
  rotation: number;
  left: number;
  top: number;
  width: number;
  height: number;
  zoom: number;
  priority: Priority;
  /** True when the page intersects the viewport. A page that does not renders large pages at the lower first-pass resolution. */
  inView: boolean;
  /** Text layer is built only for pages in the viewport. */
  textEnabled: boolean;
  /** True while the viewer is being dragged by its scrollbar: no page is requested until the drag pauses. */
  paused: boolean;
  /** Compare view (1.3.4): the overlay laid over this page, or undefined for the plain page. */
  overlay?: OverlayView;
}

/** One page: the rendered image, the text layer, and the overlay layer stack. */
export const PageView = memo(function PageView(props: PageViewProps) {
  const { paneId, docId, pageId, index, srcIndex, content, rotation, left, top, width, height, zoom, priority, inView, textEnabled, paused, overlay } =
    props;
  const dpr = window.devicePixelRatio || 1;
  const recolor = useRecolorFilterCss();
  const scales = pageScales(zoom * dpr, width, height, dpr, inView);
  const bitmap = usePageBitmap({
    docId,
    srcIndex,
    content,
    rotation,
    scale: scales.scale,
    lowScale: scales.lowScale,
    wantsFull: scales.wantsFull,
    priority,
    paused,
    overlay,
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // A draw that found its bitmap closed asks for a render again: re-rendering this page runs the hook's stale check.
  const [, askAgain] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const canvas = canvasRef.current;
    // A bitmap the cache has closed cannot be drawn. The hook renders the page again.
    if (!canvas || !bitmap || bitmap.width === 0) return;
    queueDraw(canvas, bitmap, askAgain);
    // The page left the screen, or shows another bitmap: its queued draw is no longer wanted.
    return () => cancelDraw(canvas);
  }, [bitmap]);

  // A large canvas is released when its page unmounts, not left to the garbage collector.
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas && canvas.width * canvas.height > NEIGHBOUR_FULL_MAX_PIXELS) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);

  const textRef = useRef<HTMLDivElement>(null);
  useTextLayer(textRef, { docId, srcIndex, rotation, zoom, enabled: textEnabled && !paused, content });

  const layers = pageLayers.list();

  return (
    <div className="page" data-page-index={index} style={{ left, top, width, height }}>
      <canvas
        ref={canvasRef}
        className="page-canvas"
        aria-label={`Page ${index + 1}`}
        style={{ filter: recolor }}
      />
      {!bitmap && <span className="page-placeholder">Page {index + 1}</span>}
      <div ref={textRef} className="textLayer" />
      {layers.map((layer) => (
        <layer.component
          key={layer.id}
          paneId={paneId}
          pageId={pageId}
          docId={docId}
          srcIndex={srcIndex}
          rotation={rotation}
          width={width}
          height={height}
          zoom={zoom}
        />
      ))}
    </div>
  );
});
