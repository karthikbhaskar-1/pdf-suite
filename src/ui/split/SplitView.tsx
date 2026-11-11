import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Pane, Tab } from '../../core/model/types';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { setSplitRatio, switchPaneDocument, toggleSyncScroll } from '../../features/split/splitActions';
import { splitKeyRatio, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '../../features/split/syncMath';
import { ViewerPane } from '../viewer/ViewerPane';

/**
 * Two panes in one tab. Vertical splits place them side by side (the divider is vertical);
 * horizontal splits stack them. The divider can be dragged, and it carries the sync-scroll toggle.
 */
export function SplitView({ tab }: { tab: Tab }) {
  const split = tab.split;
  const container = useRef<HTMLDivElement>(null);
  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const [first, second] = tab.panes;
  if (!split || !first || !second) return null;

  const vertical = split.orientation === 'vertical';

  const onDividerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDividerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = vertical
      ? (event.clientX - rect.left) / Math.max(1, rect.width)
      : (event.clientY - rect.top) / Math.max(1, rect.height);
    setSplitRatio(tab.id, ratio);
  };

  return (
    <div ref={container} className={`split split-${vertical ? 'vertical' : 'horizontal'}`}>
      <PaneFrame tabId={tab.id} pane={first} active={activePaneId === first.id} style={{ flex: `${split.ratio} 1 0` }} />
      <div className="split-divider">
        <div
          className="split-handle"
          role="separator"
          tabIndex={0}
          aria-orientation={vertical ? 'vertical' : 'horizontal'}
          aria-label="Split divider"
          aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
          aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
          aria-valuenow={Math.round(split.ratio * 100)}
          aria-valuetext={`First pane ${Math.round(split.ratio * 100)}%`}
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          onKeyDown={(e) => {
            const next = splitKeyRatio(split.ratio, e.key, e.shiftKey, split.orientation);
            if (next === null) return;
            e.preventDefault();
            setSplitRatio(tab.id, next);
          }}
        />
        <button
          type="button"
          className="split-sync"
          aria-pressed={split.syncScroll}
          aria-label={split.syncScroll ? 'Sync scroll: on' : 'Sync scroll: off'}
          title="Sync scroll between panes"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleSyncScroll(tab.id)}
        >
          ⇅
        </button>
      </div>
      <PaneFrame tabId={tab.id} pane={second} active={activePaneId === second.id} style={{ flex: `${1 - split.ratio} 1 0` }} />
    </div>
  );
}

interface PaneFrameProps {
  tabId: string;
  pane: Pane;
  active: boolean;
  style: CSSProperties;
}

/** One pane: a document picker over the viewer. Pressing in the pane makes it active. */
function PaneFrame({ tabId, pane, active, style }: PaneFrameProps) {
  const docs = useDocumentsStore((s) => s.docs);
  const list = Object.values(docs);
  return (
    <div
      className={`pane-frame${active ? ' pane-active' : ''}`}
      style={style}
      onPointerDownCapture={() => useWorkspaceStore.getState().setActivePane(pane.id)}
    >
      <div className="pane-header">
        <select
          aria-label="Document in this pane"
          value={pane.docId}
          onChange={(e) => void switchPaneDocument(tabId, pane.id, e.target.value)}
        >
          {list.map((doc) => (
            <option key={doc.docId} value={doc.docId}>
              {doc.name}
            </option>
          ))}
        </select>
      </div>
      <div className="pane-body">
        <ViewerPane key={`${pane.id}:${pane.docId}`} paneId={pane.id} />
      </div>
    </div>
  );
}
