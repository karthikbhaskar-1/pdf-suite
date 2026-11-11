import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { panels, RAIL_CAPACITY } from '../../core/layout/panelRegistry';
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, useUiStore, type DockSide } from '../../core/stores/uiStore';

/** Left rail (44px): one icon per panel. Panels beyond the capacity go under "more". */
export function LeftRail() {
  const openPanel = useUiStore((s) => s.openPanel);
  const toggle = useUiStore((s) => s.togglePanel);
  const list = panels.list();
  const direct = list.length > RAIL_CAPACITY ? list.slice(0, RAIL_CAPACITY - 1) : list;
  const overflow = list.length > RAIL_CAPACITY ? list.slice(RAIL_CAPACITY - 1) : [];

  const button = (id: string, title: string, icon: ReactNode) => {
    const pressed = openPanel.left === id || openPanel.right === id;
    return (
      <button
        key={id}
        type="button"
        className="rail-button"
        aria-pressed={pressed}
        aria-label={title}
        title={title}
        onClick={() => toggle(id)}
      >
        {icon}
      </button>
    );
  };

  return (
    <nav className="rail" aria-label="Panels">
      {direct.map((p) => button(p.id, p.title, p.icon))}
      {overflow.length > 0 && (
        <details className="rail-more">
          <summary className="rail-button" aria-label="More panels" title="More panels">…</summary>
          <div className="rail-more-list">{overflow.map((p) => button(p.id, p.title, p.icon))}</div>
        </details>
      )}
    </nav>
  );
}

/** A docked panel with its header (title, move, close) and a resizer on its inner edge. */
export function DockArea({ side }: { side: DockSide }) {
  const panelId = useUiStore((s) => s.openPanel[side]);
  const width = useUiStore((s) => s.dockWidth[side]);
  const def = panelId ? panels.get(panelId) : undefined;
  if (!def) return null;
  const Panel = def.component;
  const other: DockSide = side === 'left' ? 'right' : 'left';

  return (
    <aside className="dock" style={{ width }} aria-label={def.title}>
      <div className="dock-header">
        <span className="dock-title">{def.title}</span>
        <button type="button" className="dock-button" onClick={() => useUiStore.getState().movePanel(def.id, other)}>
          Dock {other}
        </button>
        <button type="button" className="dock-button" aria-label={`Close ${def.title}`} onClick={() => useUiStore.getState().closePanel(side)}>
          ×
        </button>
      </div>
      <div className="dock-body">
        <Panel />
      </div>
      <DockResizer side={side} />
    </aside>
  );
}

function DockResizer({ side }: { side: DockSide }) {
  const width = useUiStore((s) => s.dockWidth[side]);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    startX.current = e.clientX;
    startWidth.current = useUiStore.getState().dockWidth[side];
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const delta = e.clientX - startX.current;
    useUiStore.getState().setDockWidth(side, side === 'left' ? startWidth.current + delta : startWidth.current - delta);
  };
  return (
    <div
      className={`dock-resizer dock-resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      tabIndex={0}
      aria-valuenow={width}
      aria-valuemin={DOCK_MIN_WIDTH}
      aria-valuemax={DOCK_MAX_WIDTH}
      onKeyDown={(e) => {
        const cur = useUiStore.getState().dockWidth[side];
        // The panel grows toward the app on its inner edge: Right widens a left dock, narrows a right one.
        const grow = side === 'left' ? 1 : -1;
        let next: number;
        if (e.key === 'ArrowRight') next = cur + 16 * grow;
        else if (e.key === 'ArrowLeft') next = cur - 16 * grow;
        else if (e.key === 'Home') next = DOCK_MIN_WIDTH;
        else if (e.key === 'End') next = DOCK_MAX_WIDTH;
        else return;
        e.preventDefault();
        useUiStore.getState().setDockWidth(side, next);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    />
  );
}
