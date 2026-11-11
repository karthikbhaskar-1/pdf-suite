import type { MouseEvent, ReactNode } from 'react';
import { commands } from '../../core/commands/registry';
import type { MenuEntry, ToolbarItem } from '../../core/layout/topBarRegistry';
import { CropIcon, CutHalfIcon, FilePlusIcon, LayersIcon, MergeIcon, MoreIcon, PageToPagesIcon, RotateIcon, RulerIcon, TrashIcon } from '../icons';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { pageIdFromUid } from '../../features/organizer/pageMath';
import { selectionChipCount } from '../shell/StatusBar';
import { ICON_PX, MenuButton, SplitButton, ToolbarButton } from './toolbarControls';

const NO_UIDS: readonly string[] = [];

/**
 * The second tooltip line of Delete and Rotate (1.5.5 D5): shown while pages are selected and the selection is not just the
 * current page (the condition of the status bar's chip), "Acts on the 3 selected pages." / "Acts on the selected page (page 2).".
 */
export function targetLineFor(count: number, pageNumber: number): string | null {
  if (count === 0) return null;
  return count === 1 ? `Acts on the selected page (page ${pageNumber}).` : `Acts on the ${count} selected pages.`;
}

function useTargetLine(): string | null {
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const pageId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.view.pageId ?? null);
  const selected = useSelectionStore((s) => s.pageIds);
  const uids = useEditStore((s) => (docId ? s.byDoc[docId]?.uids : undefined)) ?? NO_UIDS;
  if (!docId) return null;
  const count = selectionChipCount(selected, uids, docId, pageId);
  if (count === 0) return null;
  const ids = new Set(selected);
  const first = uids.findIndex((uid) => ids.has(pageIdFromUid(docId, uid)));
  return targetLineFor(count, first + 1);
}

/** A Pages button whose tooltip names the pages it will act on. */
function TargetButton(props: Omit<Parameters<typeof ToolbarButton>[0], 'targetLine'>) {
  return <ToolbarButton {...props} targetLine={useTargetLine()} />;
}

/** Closes the <details> menu a button sits in, once one of its items has been used. */
function closeMenu(event: MouseEvent<HTMLElement>): void {
  event.currentTarget.closest('details')?.removeAttribute('open');
}

/** A menu row that runs a registered command. Disabled rows say why in their tooltip. (Used by the thumbnails panel.) */
function MenuCommand({ commandId, children }: { commandId: string; children: ReactNode }) {
  const enabled = commands.isEnabled(commandId);
  const reason = enabled ? undefined : commands.reasonDisabled(commandId);
  return (
    <button
      type="button"
      role="menuitem"
      className="tb-menu-item"
      disabled={!enabled}
      title={reason}
      onClick={(event) => {
        closeMenu(event);
        void commands.run(commandId);
      }}
    >
      {children}
    </button>
  );
}

const cmd = (command: string, label: string): MenuEntry => ({ kind: 'command', command, label });

const insertRows = (): MenuEntry[] => [
  cmd('pages.insert', 'Blank page…'),
  cmd('pages.insertLined', 'Lined page…'),
  cmd('pages.insertGrid', 'Grid page…'),
  cmd('pages.insertFromPdf', 'From PDF…'),
];
const rotateRows = (): MenuEntry[] => [
  cmd('pages.rotateRight', 'Right 90°'),
  cmd('pages.rotateLeft', 'Left 90°'),
  cmd('pages.rotate180', '180°'),
  cmd('pages.rotateCustom', 'Custom angle…'),
];
const cropRows = (): MenuEntry[] => [cmd('pages.crop', 'Crop pages…'), cmd('pages.autoCrop', 'Auto-crop')];
const moreRows = (): MenuEntry[] => [
  cmd('pages.duplicate', 'Duplicate'),
  cmd('pages.replace', 'Replace…'),
  cmd('pages.reverse', 'Reverse'),
  cmd('pages.extract', 'Extract…'),
];

/**
 * The Pages group, after View: Insert, Delete, Rotate (split: right 90, with left, 180 and custom in its menu), Crop, Page
 * size and More (duplicate, replace, reverse, extract). Every button is a registered command, so the palette has them too.
 * Insert, Delete and Rotate are high items; Crop, Page size and More are normal items and collapse first.
 */
export const pagesItems: ToolbarItem[] = [
  {
    id: 'pages.insert',
    priority: 'high',
    label: 'Insert',
    render: ({ labels }) => <MenuButton label="Insert" name="Insert pages" icon={<FilePlusIcon size={ICON_PX} />} showLabel={labels} entries={insertRows} tip="Insert a page" />,
    menu: () => [{ kind: 'heading', label: 'Insert' }, ...insertRows()],
  },
  {
    id: 'pages.delete',
    priority: 'high',
    label: 'Delete',
    render: ({ labels }) => <TargetButton commandId="pages.delete" label="Delete" name="Delete pages" icon={<TrashIcon size={ICON_PX} />} showLabel={labels} />,
    menu: () => [cmd('pages.delete', 'Delete Pages')],
  },
  {
    id: 'pages.rotate',
    priority: 'high',
    label: 'Rotate',
    render: ({ labels }) => (
      <SplitButton
        main={<TargetButton commandId="pages.rotateRight" label="Rotate" name="Rotate right 90°" icon={<RotateIcon size={ICON_PX} />} showLabel={labels} className="tb-split-main" />}
        caret={<MenuButton label="" name="More rotation options" icon={null} entries={rotateRows} className="tb-split-caret" />}
      />
    ),
    menu: () => [{ kind: 'heading', label: 'Rotate' }, ...rotateRows()],
  },
  {
    id: 'pages.crop',
    priority: 'normal',
    label: 'Crop',
    render: () => <MenuButton label="Crop" name="Crop pages" icon={<CropIcon size={ICON_PX} />} entries={cropRows} />,
    menu: () => [{ kind: 'heading', label: 'Crop' }, ...cropRows()],
  },
  {
    id: 'pages.size',
    priority: 'normal',
    label: 'Page size',
    render: () => <ToolbarButton commandId="pages.size" label="Page size" icon={<RulerIcon size={ICON_PX} />} />,
    menu: () => [cmd('pages.size', 'Page Size…')],
  },
  {
    id: 'pages.more',
    priority: 'normal',
    label: 'More',
    render: () => <MenuButton label="More" name="More page actions" icon={<MoreIcon size={ICON_PX} />} entries={moreRows} />,
    menu: () => [{ kind: 'heading', label: 'More page actions' }, ...moreRows()],
  },
  // The Pages group's new items follow the older ones, after a divider, in the spec's order (section 0): Combine (1.3.3), Split into
  // files (1.3.2), Cut pages in half (1.3.1), Overlay (1.3.4). The divider is part of the first new item's slot, so it is measured
  // with the button and goes away with it when the item collapses.
  {
    id: 'pages.combine',
    priority: 'high',
    label: 'Combine files',
    render: ({ labels }) => (
      <>
        <span className="tb-divider" aria-hidden="true" />
        <ToolbarButton commandId="pages.combine" label="Combine files" icon={<MergeIcon size={ICON_PX} />} showLabel={labels} />
      </>
    ),
    menu: () => [cmd('pages.combine', 'Combine Files…')],
  },
  {
    id: 'pages.splitFiles',
    priority: 'normal',
    label: 'Split into files',
    render: () => <ToolbarButton commandId="pages.splitFiles" label="Split into files" icon={<PageToPagesIcon size={ICON_PX} />} />,
    menu: () => [cmd('pages.splitFiles', 'Split into Files…')],
  },
  {
    id: 'pages.cutHalf',
    priority: 'normal',
    label: 'Cut pages in half',
    render: () => <ToolbarButton commandId="pages.cutHalf" label="Cut pages in half" icon={<CutHalfIcon size={ICON_PX} />} />,
    menu: () => [cmd('pages.cutHalf', 'Cut Pages in Half…')],
  },
  // 1.3.4: Overlay to Compare follows Cut Pages in Half (the Pages group's new items go last, in the spec's order).
  {
    id: 'pages.overlay',
    priority: 'normal',
    label: 'Overlay to compare',
    render: () => <ToolbarButton commandId="pages.overlay" label="Overlay to compare" icon={<LayersIcon size={ICON_PX} />} />,
    menu: () => [cmd('pages.overlay', 'Overlay to Compare…')],
  },
];

export { MenuCommand };
