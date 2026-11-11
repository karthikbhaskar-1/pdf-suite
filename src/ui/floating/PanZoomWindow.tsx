import { engineIndexOf } from '../../engine/pageRef';
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { BitmapCanvas } from '../thumbnails/BitmapCanvas';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useViewerStateStore } from '../../core/stores/viewerStateStore';
import { buildLayout, pageLeftPx, SHEET_MARGIN_PX } from '../../features/viewer/layout';
import { effectiveRotation } from '../../features/viewer/rotation';
import { viewportOnPage, type PageRectFraction } from '../../features/overview/overviewMath';
import { requestViewer } from '../viewer/viewerBus';
import { Priority } from '../../engine/renderScheduler';
import { useThumbnail } from '../thumbnails/useThumbnail';
import { FloatingWindow } from './FloatingWindow';

/** Width of the overview image, in CSS pixels. */
const OVERVIEW_WIDTH_PX = 220;

/**
 * Overview of the current page of the active pane, with a rectangle over the part the viewer shows.
 * Dragging the rectangle scrolls the viewer, and scrolling the viewer moves the rectangle.
 */
export function PanZoomWindow() {
  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const pane = useWorkspaceStore((s) => selectPane(s, activePaneId));
  const doc = useDocumentsStore((s) => (pane ? s.docs[pane.docId] : undefined));
  const geometry = useViewerStateStore((s) => (pane ? s.geometry[pane.id] : undefined));
  const pageIndex = doc && pane?.view.pageId ? doc.pages.findIndex((p) => p.id === pane.view.pageId) : -1;
  const ref = doc && pageIndex >= 0 ? doc.pages[pageIndex] : undefined;

  const bitmap = useThumbnail({
    docId: pane?.docId ?? '',
    srcIndex: ref ? engineIndexOf(ref) : 0,
    content: ref?.content,
    rotation: effectiveRotation(ref?.rotation ?? 0, pane?.view.rotation ?? 0),
    widthPx: OVERVIEW_WIDTH_PX,
    priority: Priority.Visible,
  });

  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ offsetX: number; offsetY: number } | null>(null);

  const viewRotation = pane?.view.rotation ?? 0;
  const layout = doc ? buildLayout(doc.pages, doc.sizes, viewRotation) : null;
  const box = layout && pageIndex >= 0 ? layout.boxes[pageIndex] : undefined;

  if (!pane || !doc || !layout || !box || !ref || !geometry || !bitmap) {
    return (
      <FloatingWindow id="panZoom" title="Pan and zoom">
        <p className="floating-hint">{pane ? 'Loading the overview…' : 'Open a document to see its overview.'}</p>
      </FloatingWindow>
    );
  }

  const zoom = pane.view.zoom;
  // The sheet and its pages, in CSS pixels, exactly as the viewer lays them out.
  const sheetWidth = Math.max(geometry.viewWidth, layout.width * zoom + SHEET_MARGIN_PX * 2);
  const rect: PageRectFraction = viewportOnPage(geometry, {
    left: pageLeftPx(sheetWidth, box.width * zoom),
    top: box.top * zoom,
    width: box.width * zoom,
    height: box.height * zoom,
  });
  const paneId = pane.id;

  const fractionAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height };
  };

  const scrollRectTo = (x: number, y: number) => {
    requestViewer(paneId, {
      kind: 'scrollTo',
      index: pageIndex,
      fx: Math.min(Math.max(0, x), Math.max(0, 1 - rect.w)),
      fy: Math.min(Math.max(0, y), Math.max(0, 1 - rect.h)),
    });
  };

  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = fractionAt(event);
    const inside = p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
    // Grab the rectangle where it is, or centre it on the click.
    const offsetX = inside ? p.x - rect.x : rect.w / 2;
    const offsetY = inside ? p.y - rect.y : rect.h / 2;
    drag.current = { offsetX, offsetY };
    scrollRectTo(p.x - offsetX, p.y - offsetY);
  };

  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const p = fractionAt(event);
    scrollRectTo(p.x - current.offsetX, p.y - current.offsetY);
  };

  const end = () => {
    drag.current = null;
  };

  return (
    <FloatingWindow id="panZoom" title="Pan and zoom">
      <div className="overview-wrap">
        <div
          ref={frame}
          className="overview-frame"
          style={{ aspectRatio: `${box.width} / ${box.height}` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <BitmapCanvas bitmap={bitmap} label={`Page ${pageIndex + 1} overview`} />
          <div
            className="overview-rect"
            aria-label="Visible area"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
          />
        </div>
        <p className="floating-hint">
          Page {pageIndex + 1} of {doc.pages.length}
        </p>
      </div>
    </FloatingWindow>
  );
}
