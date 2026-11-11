import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useSheetStore, type CropDraft, type Margins } from '../../core/stores/sheetStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import type { PageLayerProps } from '../viewer/pageLayers';
import { moveCropHandle, type CropHandle } from '../../features/organizer/pageMath';

/**
 * The crop box drawn on the page while the Crop sheet is open: a box with eight handles, and the area outside it dimmed.
 * Dragging a handle changes the margins in the sheet. Only the current page of the focused pane shows it.
 */

const HANDLES: Array<{ id: CropHandle; x: number; y: number }> = [
  { id: 'nw', x: 0, y: 0 },
  { id: 'n', x: 0.5, y: 0 },
  { id: 'ne', x: 1, y: 0 },
  { id: 'e', x: 1, y: 0.5 },
  { id: 'se', x: 1, y: 1 },
  { id: 's', x: 0.5, y: 1 },
  { id: 'sw', x: 0, y: 1 },
  { id: 'w', x: 0, y: 0.5 },
];

export function CropOverlay({ docId, pageId, srcIndex, paneId, rotation, width }: PageLayerProps) {
  const sheet = useSheetStore((s) => s.sheet);
  const activePaneId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.id ?? null);
  const size = useDocumentsStore((s) => s.docs[docId]?.sizes[srcIndex]);
  const drag = useRef<{ handle: CropHandle; x: number; y: number; start: Margins } | null>(null);

  const crop = sheet && sheet.kind === 'crop' ? sheet : null;
  if (!crop || crop.docId !== docId || crop.pageId !== pageId || activePaneId !== paneId) return null;
  if (!size || size.width <= 0 || size.height <= 0 || rotation % 180 !== 0 || width <= 0) return null;

  const pageWidth = size.width;
  const pageHeight = size.height;
  const scale = width / pageWidth;
  const m = crop.margins;
  const box = {
    left: m.left * scale,
    top: m.top * scale,
    width: (pageWidth - m.left - m.right) * scale,
    height: (pageHeight - m.top - m.bottom) * scale,
  };

  const onDown = (event: ReactPointerEvent<HTMLDivElement>, handle: CropHandle, current: CropDraft) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, start: current.margins };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (event.clientX - d.x) / scale;
    const dy = (event.clientY - d.y) / scale;
    useSheetStore.getState().update({ margins: moveCropHandle(d.start, d.handle, dx, dy, pageWidth, pageHeight) } as Partial<CropDraft>);
  };
  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div className="crop-overlay" aria-hidden="false">
      <div className="crop-box" role="group" aria-label="Crop area" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
        {HANDLES.map((h) => (
          <div
            key={h.id}
            className={`crop-handle crop-handle-${h.id}`}
            data-handle={h.id}
            style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }}
            onPointerDown={(event) => onDown(event, h.id, crop)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
        ))}
      </div>
    </div>
  );
}
