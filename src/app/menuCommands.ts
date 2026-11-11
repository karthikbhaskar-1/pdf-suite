import { commands } from '../core/commands/registry';
import { NO_DOCUMENT_ZOOM_REASON } from '../core/commands/reasons';
import { useUiStore, type ThemeChoice } from '../core/stores/uiStore';
import { selectActiveTab, selectPane, useWorkspaceStore } from '../core/stores/workspaceStore';
import { closeAllTabsWithPrompt } from '../features/documents/closeFlow';
import { openPicked } from '../features/documents/documentService';
import { closeSplit } from '../features/split/splitActions';
import { requestViewer } from '../ui/viewer/viewerBus';
import { getDesktopBridge, pathSource } from '../platform/desktop/bridge';

/**
 * Commands that exist for the menu bar: view, theme, split state, window and help items, and the file items the palette
 * did not need. Each one is a registry entry, so the menu, the palette and any shortcut share it.
 */

const activePane = () => {
  const state = useWorkspaceStore.getState();
  return selectPane(state, state.activePaneId);
};
const activeTab = () => selectActiveTab(useWorkspaceStore.getState());
const hasPane = () => activePane() !== undefined;
const hasTab = () => activeTab() !== undefined;

const THEMES: Array<{ id: string; theme: ThemeChoice; label: string }> = [
  { id: 'theme.system', theme: 'system', label: 'System' },
  { id: 'theme.light', theme: 'light', label: 'Light' },
  { id: 'theme.dark', theme: 'dark', label: 'Dark' },
];

/** Whether the full-screen mode is on, for the View menu. */
function isFullScreen(): boolean {
  return typeof document !== 'undefined' && document.fullscreenElement !== null && document.fullscreenElement !== undefined;
}

export function registerMenuCommands(): void {
  const desktop = getDesktopBridge();

  commands.register({
    id: 'file.openRecent',
    label: 'Open recent file',
    run: (path) => {
      if (desktop && path) void openPicked([pathSource(path)]);
    },
  });
  commands.register({
    id: 'file.clearRecent',
    label: 'Clear recent list',
    run: () => {
      if (desktop) void desktop.recent.clear();
    },
  });
  commands.register({
    id: 'file.closeAll',
    label: 'Close all tabs',
    enabled: hasTab,
    run: () => {
      void closeAllTabsWithPrompt();
    },
  });
  commands.register({
    id: 'file.properties',
    label: 'Document properties',
    enabled: hasPane,
    run: () => useUiStore.getState().showPanel('properties'),
  });
  // Exit: asks the main process to close the window, which runs the same Save / Don't save / Cancel flow as the title-bar
  // button (window.close() from the page would skip it). The menu hides it in the web build.
  commands.register({
    id: 'file.exit',
    label: 'Exit',
    run: () => {
      if (desktop) void desktop.app.requestClose();
      else window.close();
    },
  });

  commands.register({
    id: 'view.actualSize',
    label: 'Actual size',
    enabled: hasPane,
    disabledReason: () => (hasPane() ? undefined : NO_DOCUMENT_ZOOM_REASON),
    run: () => {
      const pane = activePane();
      if (pane) requestViewer(pane.id, { kind: 'setZoom', zoom: 1 });
    },
  });
  commands.register({
    id: 'view.rotateCounter',
    label: 'Rotate view counter-clockwise',
    enabled: hasPane,
    run: () => {
      const pane = activePane();
      if (pane) useWorkspaceStore.getState().setView(pane.id, { rotation: ((pane.view.rotation + 270) % 360) as 0 | 90 | 180 | 270 });
    },
  });
  commands.register({
    id: 'view.toolbar',
    label: 'Toolbar',
    run: () => useUiStore.getState().setToolbarVisible(!useUiStore.getState().toolbarVisible),
    checked: () => useUiStore.getState().toolbarVisible,
  });
  commands.register({
    id: 'view.toolbar.labels',
    label: 'Show labels',
    run: () => useUiStore.getState().setToolbarLabels(!useUiStore.getState().toolbarLabels),
    checked: () => useUiStore.getState().toolbarLabels,
  });
  commands.register({
    id: 'view.fullscreen',
    label: 'Full screen',
    run: async () => {
      try {
        if (isFullScreen()) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        // The browser or the window refused the change; the view stays as it was.
      }
    },
    checked: isFullScreen,
  });

  commands.register({
    id: 'split.none',
    label: 'Turn split off',
    enabled: hasTab,
    run: () => {
      const tab = activeTab();
      if (tab) void closeSplit(tab.id);
    },
    checked: () => (activeTab()?.panes.length ?? 0) < 2,
  });

  for (const { id, theme, label } of THEMES) {
    commands.register({
      id,
      label: `Theme: ${label}`,
      run: () => useUiStore.getState().setTheme(theme),
      checked: () => useUiStore.getState().theme === theme,
    });
  }

  commands.register({
    id: 'window.focusTab',
    label: 'Show tab',
    run: (tabId) => {
      if (tabId) useWorkspaceStore.getState().setActiveTab(tabId);
    },
  });

  commands.register({
    id: 'help.shortcuts',
    label: 'Keyboard shortcuts',
    run: () => useUiStore.getState().setHelpDialog('shortcuts'),
  });
  commands.register({
    id: 'help.about',
    label: 'About PDF Suite',
    run: () => useUiStore.getState().setHelpDialog('about'),
  });
  commands.register({
    id: 'help.logs',
    label: 'Open logs folder',
    run: () => {
      if (desktop) void desktop.app.openLogs();
    },
  });
}
