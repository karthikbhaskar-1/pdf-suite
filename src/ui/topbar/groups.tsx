import { useEffect, useState } from 'react';
import { fileService } from '../../app/services';
import { commands } from '../../core/commands/registry';
import type { MenuEntry, ToolbarItem } from '../../core/layout/topBarRegistry';
import { useEditStore } from '../../core/stores/editStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import type { RecentFile } from '../../platform/fileService';
import { openRecent } from '../../features/recovery/recoveryService';
import { requestViewer } from '../viewer/viewerBus';
import { ChevronDownIcon, ChevronUpIcon, ClockIcon, FolderIcon, RedoIcon, SaveIcon, SearchIcon, ThemeIcon, UndoIcon } from '../icons';
import { ICON_PX, MenuButton, ToolbarButton, useRecentStore } from './toolbarControls';
import { useSelectOnFocus } from './selectOnFocus';
import { useActivePage } from './usePageState';

/**
 * The File, Navigation and Theme groups of the top bar, as items (ticket 1.2.2). Open, Save, Undo, Redo, the page controls
 * and Theme never collapse into the "…" menu; Recent is a high item.
 */

/** The label of the next undo or redo step ("Delete 3 pages"), or an empty string. Primitive, so it changes only with the step. */
function useHistoryLabel(which: 'undoLabel' | 'redoLabel'): string {
  return useEditStore((s) => {
    const state = useWorkspaceStore.getState();
    const docId = selectPane(state, state.activePaneId)?.docId;
    return (docId ? s.byDoc[docId]?.history[which] : undefined) ?? '';
  });
}

function UndoButton({ labels }: { labels: boolean }) {
  const step = useHistoryLabel('undoLabel');
  return <ToolbarButton commandId="edit.undo" label="Undo" name={step ? `Undo ${step}` : 'Undo'} icon={<UndoIcon size={ICON_PX} />} showLabel={labels} />;
}

function RedoButton({ labels }: { labels: boolean }) {
  const step = useHistoryLabel('redoLabel');
  return <ToolbarButton commandId="edit.redo" label="Redo" name={step ? `Redo ${step}` : 'Redo'} icon={<RedoIcon size={ICON_PX} />} showLabel={labels} />;
}

/** The rows of the Recent menu: the ten newest files, or a note when there are none. */
function recentRows(): MenuEntry[] {
  const files = useRecentStore.getState().files;
  if (files.length === 0) return [{ kind: 'note', label: 'No recent files' }];
  return files.map((file) => ({ kind: 'run', label: file.name, run: () => void openRecent(file) }));
}

export const fileItems: ToolbarItem[] = [
  {
    id: 'file.open',
    priority: 'critical',
    label: 'Open',
    render: ({ labels }) => <ToolbarButton commandId="file.open" label="Open" icon={<FolderIcon size={ICON_PX} />} showLabel={labels} />,
    menu: () => [{ kind: 'command', command: 'file.open', label: 'Open…' }],
  },
  {
    id: 'file.save',
    priority: 'critical',
    label: 'Save',
    render: ({ labels }) => <ToolbarButton commandId="file.save" label="Save" icon={<SaveIcon size={ICON_PX} />} showLabel={labels} />,
    menu: () => [{ kind: 'command', command: 'file.save', label: 'Save' }],
  },
  {
    id: 'edit.undo',
    priority: 'critical',
    label: 'Undo',
    render: ({ labels }) => <UndoButton labels={labels} />,
    menu: () => [{ kind: 'command', command: 'edit.undo', label: commands.labelOf('edit.undo') ?? 'Undo' }],
  },
  {
    id: 'edit.redo',
    priority: 'critical',
    label: 'Redo',
    render: ({ labels }) => <RedoButton labels={labels} />,
    menu: () => [{ kind: 'command', command: 'edit.redo', label: commands.labelOf('edit.redo') ?? 'Redo' }],
  },
  {
    id: 'file.recent',
    priority: 'high',
    label: 'Recent',
    render: ({ labels }) => (
      <MenuButton
        label="Recent"
        name="Recent files"
        icon={<ClockIcon size={ICON_PX} />}
        showLabel={labels}
        entries={recentRows}
        onOpen={() => useRecentStore.getState().refresh()}
        tip="Recent files"
      />
    ),
    menu: () => [{ kind: 'heading', label: 'Recent files' }, ...recentRows()],
  },
];

/** Previous page, the page box with "of N", and next page. The page number is editable: Enter goes to that page. */
function NavControls() {
  const { paneId, index, total } = useActivePage();
  const current = index >= 0 ? String(index + 1) : '';
  const [draft, setDraft] = useState<string | null>(null);
  const select = useSelectOnFocus();

  const go = (value: string) => {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number) || total === 0) return;
    requestViewer(paneId, { kind: 'goto', index: Math.min(Math.max(number, 1), total) - 1 });
  };

  return (
    <div className="tb-nav" role="group" aria-label="Page navigation">
      <ToolbarButton commandId="nav.prev" label="Previous page" icon={<ChevronUpIcon size={ICON_PX} />} />
      <input
        id="page-box"
        className="tb-page-box"
        type="text"
        inputMode="numeric"
        aria-label="Page number"
        disabled={total === 0}
        value={draft ?? current}
        onFocus={(e) => {
          setDraft(current);
          select.onFocus(e);
        }}
        onMouseUp={select.onMouseUp}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          select.onBlur();
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            go(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.currentTarget.blur();
          }
        }}
      />
      <span className="tb-muted tb-of">of {total}</span>
      <ToolbarButton commandId="nav.next" label="Next page" icon={<ChevronDownIcon size={ICON_PX} />} />
    </div>
  );
}

export const navItems: ToolbarItem[] = [
  {
    id: 'nav',
    priority: 'critical',
    label: 'Page navigation',
    render: () => <NavControls />,
    menu: () => [],
  },
];

export const themeItems: ToolbarItem[] = [
  {
    id: 'theme.toggle',
    priority: 'critical',
    label: 'Theme',
    render: ({ labels }) => <ToolbarButton commandId="theme.toggle" label="Theme" name="Light or dark" icon={<ThemeIcon size={ICON_PX} />} showLabel={labels} />,
    menu: () => [{ kind: 'command', command: 'theme.toggle', label: 'Light or dark' }],
  },
];

export const searchItems: ToolbarItem[] = [
  {
    id: 'search.open',
    priority: 'critical',
    label: 'Find',
    render: ({ labels }) => <ToolbarButton commandId="search.open" label="Find" icon={<SearchIcon size={ICON_PX} />} showLabel={labels} />,
    menu: () => [{ kind: 'command', command: 'search.open', label: 'Find' }],
  },
];

/** Recently used files, loaded once per mount. Used by the empty state. */
export function useRecentFiles(limit: number): RecentFile[] {
  const [files, setFiles] = useState<RecentFile[]>([]);
  useEffect(() => {
    let alive = true;
    void fileService.listRecent(limit).then((list) => {
      if (alive) setFiles(list);
    });
    return () => {
      alive = false;
    };
  }, [limit]);
  return files;
}
