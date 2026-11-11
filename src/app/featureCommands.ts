import { commands } from '../core/commands/registry';
import { useFloatingStore } from '../core/stores/floatingStore';
import { useOverlayStore } from '../core/stores/overlayStore';
import { useRecolorStore } from '../core/stores/recolorStore';
import { selectActiveTab, selectPane, useWorkspaceStore } from '../core/stores/workspaceStore';
import { useUiStore } from '../core/stores/uiStore';
import { useSearchStore } from '../features/search/searchStore';
import { closeSplit, focusNextPane, openInSplit, setSplitOrientation, toggleSplit, toggleSyncScroll } from '../features/split/splitActions';
import { copyOrReport } from '../platform/clipboard';
import { nextRotation } from '../features/viewer/rotation';
import type { RecolorMode } from '../features/recolor/recolorFilter';
import { RECOLOR_MODES } from '../features/recolor/recolorFilter';

const activePane = () => {
  const state = useWorkspaceStore.getState();
  return selectPane(state, state.activePaneId);
};
const activeTab = () => selectActiveTab(useWorkspaceStore.getState());
const hasPane = () => activePane() !== undefined;
const hasTab = () => activeTab() !== undefined;
const isSplit = () => (activeTab()?.panes.length ?? 0) >= 2;

/** Registers the commands for search, split view, floating windows, recolor, panels, the palette and page or tab actions. */
export function registerFeatureCommands(): void {
  // Search
  commands.register({
    id: 'search.open',
    label: 'Find in document',
    enabled: hasPane,
    run: () => useSearchStore.getState().setOpen(true),
  });
  commands.register({
    id: 'search.close',
    label: 'Close find bar',
    enabled: () => useSearchStore.getState().open,
    run: () => useSearchStore.getState().setOpen(false),
  });
  commands.register({
    id: 'search.next',
    label: 'Find next',
    enabled: () => useSearchStore.getState().hits.length > 0,
    run: () => useSearchStore.getState().step(1),
  });
  commands.register({
    id: 'search.prev',
    label: 'Find previous',
    enabled: () => useSearchStore.getState().hits.length > 0,
    run: () => useSearchStore.getState().step(-1),
  });
  commands.register({
    id: 'search.toggleCase',
    label: 'Find: match case',
    run: () => {
      const s = useSearchStore.getState();
      s.setMatchCase(!s.matchCase);
    },
  });
  commands.register({
    id: 'search.toggleWholeWord',
    label: 'Find: whole word',
    run: () => {
      const s = useSearchStore.getState();
      s.setWholeWord(!s.wholeWord);
    },
  });

  // Split view
  commands.register({
    id: 'split.toggle',
    label: 'Split view on or off',
    enabled: hasTab,
    run: () => {
      const tab = activeTab();
      if (tab) toggleSplit(tab.id);
    },
  });
  commands.register({
    id: 'split.horizontal',
    label: 'Split horizontal',
    enabled: hasPane,
    run: () => {
      const tab = activeTab();
      if (tab) setSplitOrientation(tab.id, 'horizontal');
    },
  });
  commands.register({
    id: 'split.vertical',
    label: 'Split vertical',
    enabled: hasPane,
    run: () => {
      const tab = activeTab();
      if (tab) setSplitOrientation(tab.id, 'vertical');
    },
  });
  commands.register({
    id: 'split.close',
    label: 'Close split',
    enabled: isSplit,
    run: () => {
      const tab = activeTab();
      if (tab) void closeSplit(tab.id);
    },
  });
  commands.register({
    id: 'split.focusNext',
    label: 'Switch pane',
    enabled: isSplit,
    run: () => focusNextPane(),
  });
  commands.register({
    id: 'split.toggleSync',
    label: 'Sync scroll between panes',
    enabled: isSplit,
    run: () => {
      const tab = activeTab();
      if (tab) toggleSyncScroll(tab.id);
    },
  });

  // Floating windows
  commands.register({
    id: 'view.loupe',
    label: 'Loupe',
    enabled: hasPane,
    run: () => useFloatingStore.getState().toggle('loupe'),
  });
  commands.register({
    id: 'view.panZoom',
    label: 'Pan and zoom',
    enabled: hasPane,
    run: () => useFloatingStore.getState().toggle('panZoom'),
  });

  // Recolor
  for (const { mode, label } of RECOLOR_MODES) {
    commands.register({
      id: `view.recolor.${mode}`,
      label: `Page colors: ${label}`,
      run: () => useRecolorStore.getState().setMode(mode as RecolorMode),
    });
  }

  // Panels (the rail icons do the same)
  for (const [id, label] of [
    ['thumbnails', 'Thumbnails'],
    ['bookmarks', 'Bookmarks'],
    ['properties', 'Properties'],
  ] as const) {
    commands.register({
      id: `panel.${id}`,
      label: `Show ${label} panel`,
      run: () => useUiStore.getState().togglePanel(id),
    });
  }

  commands.register({
    id: 'palette.open',
    label: 'Command palette',
    run: () => {
      const open = useOverlayStore.getState().paletteOpen;
      useOverlayStore.getState().setPaletteOpen(!open);
    },
  });

  // Page actions (context menu and palette)
  commands.register({
    id: 'page.copy',
    label: 'Copy selected text',
    enabled: hasPane,
    run: () => {
      const text = window.getSelection()?.toString() ?? '';
      if (text) void copyOrReport(text, 'The text could not be copied.');
    },
  });
  commands.register({
    id: 'page.selectAll',
    label: 'Select all text',
    enabled: hasPane,
    run: () => {
      const pane = activePane();
      const sheet = pane ? document.querySelector(`[data-pane="${pane.id}"] .sheet`) : null;
      if (sheet) window.getSelection()?.selectAllChildren(sheet);
    },
  });
  commands.register({
    id: 'page.rotateView',
    label: 'Rotate view',
    enabled: hasPane,
    run: () => {
      // View-only: this pane turns 90 degrees clockwise. The document's pages are not changed.
      const pane = activePane();
      if (pane) useWorkspaceStore.getState().setView(pane.id, { rotation: nextRotation(pane.view.rotation) });
    },
  });
  commands.register({
    id: 'page.splitHere',
    label: 'Split here',
    enabled: hasPane,
    run: () => {
      const tab = activeTab();
      if (tab) openInSplit(tab.id);
    },
  });
  commands.register({
    id: 'page.properties',
    label: 'Page properties',
    enabled: hasPane,
    run: () => useUiStore.getState().showPanel('properties'),
  });

  // Tab actions
  commands.register({
    id: 'tab.openSplit',
    label: 'Open tab in split',
    enabled: hasTab,
    run: () => {
      const tab = activeTab();
      if (tab) openInSplit(tab.id);
    },
  });
  commands.register({
    id: 'tab.copyPath',
    label: 'Copy file path',
    enabled: () => activeTab()?.origin.kind === 'path',
    run: () => {
      const tab = activeTab();
      if (tab?.origin.kind === 'path') void copyOrReport(tab.origin.path, 'The path could not be copied.');
    },
  });
}
