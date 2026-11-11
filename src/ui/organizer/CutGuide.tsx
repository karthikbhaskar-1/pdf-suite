import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useSheetStore, type CutDraft } from '../../core/stores/sheetStore';
import { cutFromPointer, formatCutPercent, guideShape, snapCutPercent } from '../../features/organizer/cutMath';
import { pageUidFromId } from '../../features/organizer/pageMath';
import type { PageLayerProps } from '../viewer/pageLayers';
import { useCutState } from '../sheet/useCutState';

/**
 * The guide of the Cut Pages in Half sheet, drawn on every page it would cut: a dashed line at the cut position, the number 1
 * on the half that comes first and 2 on the other. Dragging the line sets the cut position in the sheet. Nothing changes in the
 * document until Apply. The layer costs one store read per page while no Cut sheet is open.
 */
export function CutGuide(props: PageLayerProps) {
  const open = useSheetStore((s) => s.sheet?.kind === 'cut' && s.sheet.docId === props.docId);
  if (!open) return null;
  return <CutGuideLines {...props} />;
}

function CutGuideLines({ docId, pageId, rotation }: PageLayerProps) {
  const sheet = useSheetStore((s) => s.sheet) as CutDraft;
  const state = useCutState(sheet);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const uid = pageUidFromId(docId, pageId);
  const affected = useMemo(() => uid !== null && state.targets.uids.includes(uid), [uid, state.targets]);
  if (!affected) return null;

  const shape = guideShape(sheet.direction, state.shownAt, sheet.first, rotation);
  const [a, b] = shape.line;
  const lineIsVertical = Math.abs(a.x - b.x) < 1e-9;
  const pct = (v: number) => `${v * 100}%`;

  const setFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const shown = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    const percent = snapCutPercent(cutFromPointer(sheet.direction, shown, rotation) * 100);
    useSheetStore.getState().update({ percentText: formatCutPercent(percent) } as Partial<CutDraft>);
  };
  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = true;
    setFromPointer(event);
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) setFromPointer(event);
  };
  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div ref={box} className="cut-guide" data-cut-guide={pageId} aria-hidden="true">
      <svg className="cut-guide-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="cut-guide-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <div
        className={lineIsVertical ? 'cut-guide-grab cut-guide-grab-v' : 'cut-guide-grab cut-guide-grab-h'}
        data-cut-line="true"
        style={lineIsVertical ? { left: pct(a.x) } : { top: pct(a.y) }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <span className="cut-guide-mark" data-cut-mark="1" style={{ left: pct(shape.first.x), top: pct(shape.first.y) }}>
        1
      </span>
      <span className="cut-guide-mark" data-cut-mark="2" style={{ left: pct(shape.second.x), top: pct(shape.second.y) }}>
        2
      </span>
    </div>
  );
}
