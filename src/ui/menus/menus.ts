import { commands } from '../../core/commands/registry';
import { closeTabWithPrompt } from '../../features/documents/closeFlow';
import { duplicateTab } from '../../features/documents/documentService';
import { openInSplit } from '../../features/split/splitActions';
import { closeOtherTabs, closeTabsToRight } from '../../features/tabs/tabActions';
import { ZOOM_PRESETS } from '../../features/viewer/layout';
import { RECOLOR_MODES } from '../../features/recolor/recolorFilter';
import { copyOrReport } from '../../platform/clipboard';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { requestViewer } from '../viewer/viewerBus';
import type { MenuItem } from '../../core/stores/overlayStore';
import { pagesMenuItems } from './pageMenuItems';

const recolorCommandFor: Record<string, string> = {
  off: 'view.recolor.off',
  invert: 'view.recolor.invert',
  sepia: 'view.recolor.sepia',
  night: 'view.recolor.night',
  contrast: 'view.recolor.contrast',
  custom: 'view.recolor.custom',
};

function recolorItems(idPrefix: string): MenuItem[] {
  return RECOLOR_MODES.map(({ mode, label }) => ({
    id: `${idPrefix}.${mode}`,
    label,
    onSelect: () => void commands.run(recolorCommandFor[mode] ?? 'view.recolor.off'),
  }));
}

/**
 * Right-click menu on a page, per the UI spec. Makes the clicked pane active first, so the
 * commands in the menu act on it.
 */
export function buildPageMenu(paneId: string, pageIndex: number): MenuItem[] {
  useWorkspaceStore.getState().setActivePane(paneId);
  return [
    { id: 'copy', label: 'Copy', onSelect: () => void commands.run('page.copy') },
    { id: 'selectAll', label: 'Select all', onSelect: () => void commands.run('page.selectAll') },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'zoom',
      label: 'Zoom',
      items: ZOOM_PRESETS.map((zoom) => ({
        id: `zoom-${zoom}`,
        label: `${Math.round(zoom * 100)}%`,
        onSelect: () => requestViewer(paneId, { kind: 'setZoom', zoom }),
      })),
    },
    { id: 'fitWidth', label: 'Fit width', onSelect: () => void commands.run('view.fitWidth') },
    { id: 'rotate', label: 'Rotate view', onSelect: () => void commands.run('page.rotateView') },
    {
      id: 'splitHere',
      label: 'Split here',
      onSelect: () => {
        const tab = useWorkspaceStore.getState().tabs.find((t) => t.panes.some((p) => p.id === paneId));
        if (!tab) return;
        const pageId = useDocumentsStore.getState().docs[tab.panes[0]?.docId ?? '']?.pages[pageIndex]?.id ?? null;
        openInSplit(tab.id);
        const second = useWorkspaceStore.getState().tabs.find((t) => t.id === tab.id)?.panes[1];
        if (second && pageId) useWorkspaceStore.getState().setView(second.id, { pageId, offset: 0 });
      },
    },
    { id: 'pages', label: 'Pages', items: pagesMenuItems('page') },
    { id: 'recolor', label: 'Page colors', items: recolorItems('recolor') },
    { id: 'sep2', label: '', separator: true },
    {
      id: 'properties',
      label: 'Properties',
      onSelect: () => {
        // The right-clicked page is selected first, so the panel describes it.
        const docId = useWorkspaceStore.getState().tabs.flatMap((t) => t.panes).find((p) => p.id === paneId)?.docId;
        const pageId = docId ? useDocumentsStore.getState().docs[docId]?.pages[pageIndex]?.id : undefined;
        if (docId && pageId) useSelectionStore.getState().selectPage(docId, pageId);
        void commands.run('page.properties');
      },
    },
  ];
}

/** Right-click menu on a tab, per the UI spec. Acts on the tab that was clicked. */
export function buildTabMenu(tabId: string): MenuItem[] {
  const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
  const path = tab?.origin.kind === 'path' ? tab.origin.path : null;
  return [
    { id: 'close', label: 'Close tab', onSelect: () => void closeTabWithPrompt(tabId) },
    { id: 'closeOthers', label: 'Close other tabs', onSelect: () => void closeOtherTabs(tabId) },
    { id: 'closeRight', label: 'Close tabs to the right', onSelect: () => void closeTabsToRight(tabId) },
    { id: 'duplicate', label: 'Duplicate', onSelect: () => duplicateTab(tabId) },
    { id: 'openSplit', label: 'Open in split', onSelect: () => openInSplit(tabId) },
    {
      id: 'copyPath',
      label: 'Copy path',
      disabled: path === null,
      onSelect: () => {
        if (path !== null) void copyOrReport(path, 'The path could not be copied.');
        else useUiStore.getState().pushToast('This file has no path to copy.');
      },
    },
  ];
}
