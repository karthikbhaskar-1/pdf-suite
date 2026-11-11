import { useMemo } from 'react';
import { closeTabWithPrompt } from '../../features/documents/closeFlow';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { buildTabMenu } from '../menus/menus';
import { middleTruncate } from '../common/middleTruncate';

/** The tooltip of the unsaved dot: it names the documents with unsaved changes when the tab shows more than one. */
export function unsavedTitle(dirtyNames: readonly string[], documentCount: number): string {
  return documentCount > 1 && dirtyNames.length > 0 ? `Unsaved changes in ${dirtyNames.join(', ')}` : 'Unsaved changes';
}

/** A dot on a tab when any document shown in its panes has changes that are not saved. */
function UnsavedDot({ docIds }: { docIds: readonly string[] }) {
  // One string, so the tab draws again only when the set of unsaved documents changes.
  const dirtyKey = useEditStore((s) => docIds.filter((id) => s.byDoc[id]?.history.dirty === true).join(NAME_SEP));
  const names = useDocumentsStore((s) => dirtyKey.split(NAME_SEP).filter(Boolean).map((id) => s.docs[id]?.name ?? id).join(NAME_SEP));
  if (dirtyKey === '') return null;
  const title = unsavedTitle(names.split(NAME_SEP).filter(Boolean), docIds.length);
  return (
    <span className="tab-dirty" role="img" aria-label={title} title={title}>
      ●
    </span>
  );
}

interface TabLite {
  id: string;
  title: string;
  progress: number | null;
  docIds: string[];
}

const NAME_SEP = String.fromCharCode(3);

const FIELD = String.fromCharCode(1);
const ROW = String.fromCharCode(2);

/**
 * The fields the strip draws, as one string: the viewer writes the pane's scroll position to the tabs array on every frame,
 * so reading `tabs` itself would draw the strip on every scroll frame. A string that is equal when nothing shown changed
 * draws it only when a title, an id, a progress value or a document changes.
 */
function tabsSignature(tabs: ReturnType<typeof useWorkspaceStore.getState>['tabs']): string {
  return tabs
    .map((t) => [t.id, t.title, t.status.kind === 'loading' ? String(t.status.progress) : '', [...new Set(t.panes.map((p) => p.docId))].join(NAME_SEP)].join(FIELD))
    .join(ROW);
}

function parseTabs(signature: string): TabLite[] {
  if (signature === '') return [];
  return signature.split(ROW).map((row) => {
    const [id = '', title = '', progress = '', docIds = ''] = row.split(FIELD);
    return { id, title, progress: progress === '' ? null : Number(progress), docIds: docIds === '' ? [] : docIds.split(NAME_SEP) };
  });
}

/** Tab strip (36px). Each tab shows its title, a dot when it has unsaved changes, a loading bar while opening, and a close button. */
export function TabStrip() {
  const signature = useWorkspaceStore((s) => tabsSignature(s.tabs));
  const tabs = useMemo(() => parseTabs(signature), [signature]);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const progress = tab.progress;
        return (
          <div
            key={tab.id}
            className={`tab${active ? ' tab-active' : ''}`}
            onContextMenu={(event) => {
              event.preventDefault();
              useOverlayStore.getState().openMenu(event.clientX, event.clientY, buildTabMenu(tab.id));
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab-title"
              title={tab.title}
              aria-label={tab.title}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="tab-title-head">{middleTruncate(tab.title).head}</span>
              <span className="tab-title-end">{middleTruncate(tab.title).end}</span>
            </button>
            {tab.docIds.length > 0 && <UnsavedDot docIds={tab.docIds} />}
            <button type="button" className="tab-close" aria-label={`Close ${tab.title}`} onClick={() => void closeTabWithPrompt(tab.id)}>
              ×
            </button>
            {progress !== null && (
              <div className="tab-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
