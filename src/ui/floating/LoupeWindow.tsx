import { useEffect, useRef, useState } from 'react';
import { documentRegistry } from '../../app/services';
import { useViewerStateStore } from '../../core/stores/viewerStateStore';
import { renderScheduler, Priority } from '../../engine/renderScheduler';
import { useRecolorFilterCss } from '../viewer/recolorFilterCss';
import { FloatingWindow } from './FloatingWindow';

/** Magnification of the loupe relative to the viewer's zoom. */
export const LOUPE_MAGNIFICATION = 3;

/**
 * Renders the area under the pointer at 3x. Only the clipped region is rendered, so the cost does
 * not grow with the page size. Recolored with the pages.
 */
export function LoupeWindow() {
  const probe = useViewerStateStore((s) => s.pointer);
  const recolor = useRecolorFilterCss();
  const body = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const target = canvas.current;
    if (!probe || !target || size.width <= 0 || size.height <= 0) return;
    const handle = documentRegistry.get(probe.docId);
    if (!handle) return;

    const dpr = window.devicePixelRatio || 1;
    const magnified = LOUPE_MAGNIFICATION * probe.zoom;
    // The region in points that fills the loupe at the magnified scale.
    const regionWidth = size.width / magnified;
    const regionHeight = size.height / magnified;
    const scale = magnified * dpr;
    const key = `${probe.docId}|loupe|${probe.srcIndex}|${probe.rotation}|${probe.x.toFixed(1)}|${probe.y.toFixed(1)}|${scale.toFixed(3)}|${size.width}x${size.height}`;

    // Only the newest position matters. Drop the render still queued for the previous one.
    renderScheduler.cancelWhere((k) => k.includes('|loupe|'));
    let alive = true;
    const job = renderScheduler.schedule(key, Priority.Visible, (signal) =>
      handle.doc.renderBitmap(probe.srcIndex, {
        scale,
        rotation: probe.rotation,
        signal,
        region: {
          x: probe.x - regionWidth / 2,
          y: probe.y - regionHeight / 2,
          width: regionWidth,
          height: regionHeight,
        },
      }),
    );
    job.promise.then(
      (bitmap) => {
        if (!alive) {
          bitmap.close();
          return;
        }
        target.width = bitmap.width;
        target.height = bitmap.height;
        target.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
      },
      () => {
        // Superseded by a newer position, or the page went away.
      },
    );
    return () => {
      alive = false;
      job.cancel();
    };
  }, [probe, size.width, size.height]);

  return (
    <FloatingWindow id="loupe" title="Loupe">
      <div ref={body} className="loupe-body">
        {probe ? (
          <canvas ref={canvas} className="loupe-canvas" style={{ filter: recolor }} aria-label="Magnified view" />
        ) : (
          <p className="floating-hint">Move the pointer over a page.</p>
        )}
      </div>
    </FloatingWindow>
  );
}
