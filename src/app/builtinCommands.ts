import { commands } from '../core/commands/registry';
import { NO_DOCUMENT_ZOOM_REASON } from '../core/commands/reasons';
import { indexOfPage } from '../core/model/pageList';
import { useDocumentsStore } from '../core/stores/documentsStore';
import { useUiStore } from '../core/stores/uiStore';
import { selectActiveTab, selectPane, useWorkspaceStore } from '../core/stores/workspaceStore';
import { cycleTab, closeOtherTabs, closeTabsToRight } from '../features/tabs/tabActions';
import { duplicateTab, openPicked } from '../features/documents/documentService';
import { closeTabWithPrompt } from '../features/documents/closeFlow';
import { requestViewer, type ViewerRequest } from '../ui/viewer/viewerBus';
import { fileService } from './services';

/** The active pane, or undefined when no document is showing. */
function activePane() {
  const state = useWorkspaceStore.getState();
  return selectPane(state, state.activePaneId);
}

/** Sends a viewer request to the active pane, if one is showing. */
function send(request: ViewerRequest): void {
  requestViewer(activePane()?.id ?? null, request);
}

/** Current page index (in the page list) of the active pane. */
function activePageIndex(): number {
  const pane = activePane();
  if (!pane) return -1;
  const doc = useDocumentsStore.getState().docs[pane.docId];
  if (!doc || !pane.view.pageId) return -1;
  return indexOfPage(doc.pages, pane.view.pageId);
}

const hasPane = () => activePane() !== undefined;
const zoomReason = () => (hasPane() ? undefined : NO_DOCUMENT_ZOOM_REASON);
const hasTab = () => selectActiveTab(useWorkspaceStore.getState()) !== undefined;

/** Registers every built-in command. Call once at startup. */
export function registerBuiltinCommands(): void {
  commands.register({
    id: 'file.open',
    label: 'Open PDF',
    run: async () => {
      await openPicked(await fileService.pickPdfs());
    },
  });

  commands.register({
    id: 'tab.close',
    label: 'Close tab',
    enabled: hasTab,
    run: () => {
      const tab = selectActiveTab(useWorkspaceStore.getState());
      if (tab) void closeTabWithPrompt(tab.id);
    },
  });
  commands.register({
    id: 'tab.closeOthers',
    label: 'Close other tabs',
    enabled: hasTab,
    run: () => {
      const tab = selectActiveTab(useWorkspaceStore.getState());
      if (tab) void closeOtherTabs(tab.id);
    },
  });
  commands.register({
    id: 'tab.closeRight',
    label: 'Close tabs to the right',
    enabled: hasTab,
    run: () => {
      const tab = selectActiveTab(useWorkspaceStore.getState());
      if (tab) void closeTabsToRight(tab.id);
    },
  });
  commands.register({
    id: 'tab.duplicate',
    label: 'Duplicate tab',
    enabled: hasTab,
    run: () => {
      const tab = selectActiveTab(useWorkspaceStore.getState());
      if (tab) duplicateTab(tab.id);
    },
  });
  commands.register({ id: 'tab.next', label: 'Next tab', enabled: hasTab, run: () => cycleTab(1) });
  commands.register({ id: 'tab.prev', label: 'Previous tab', enabled: hasTab, run: () => cycleTab(-1) });

  commands.register({
    id: 'view.fitWidth',
    label: 'Fit width',
    enabled: hasPane,
    disabledReason: zoomReason,
    run: () => send({ kind: 'fit', mode: 'width' }),
  });
  commands.register({
    id: 'view.fitPage',
    label: 'Fit page',
    enabled: hasPane,
    disabledReason: zoomReason,
    run: () => send({ kind: 'fit', mode: 'page' }),
  });
  commands.register({
    id: 'view.zoomIn',
    label: 'Zoom in',
    enabled: hasPane,
    disabledReason: zoomReason,
    run: () => send({ kind: 'zoomStep', direction: 1 }),
  });
  commands.register({
    id: 'view.zoomOut',
    label: 'Zoom out',
    enabled: hasPane,
    disabledReason: zoomReason,
    run: () => send({ kind: 'zoomStep', direction: -1 }),
  });

  commands.register({
    id: 'nav.prev',
    label: 'Previous page',
    enabled: () => activePageIndex() > 0,
    run: () => send({ kind: 'goto', index: activePageIndex() - 1 }),
  });
  commands.register({
    id: 'nav.next',
    label: 'Next page',
    enabled: () => activePageIndex() >= 0 && activePageIndex() < pageCount() - 1,
    run: () => send({ kind: 'goto', index: activePageIndex() + 1 }),
  });
  commands.register({
    id: 'nav.pageUp',
    label: 'Scroll up one screen',
    enabled: hasPane,
    run: () => send({ kind: 'scrollScreen', direction: -1 }),
  });
  commands.register({
    id: 'nav.pageDown',
    label: 'Scroll down one screen',
    enabled: hasPane,
    run: () => send({ kind: 'scrollScreen', direction: 1 }),
  });
  commands.register({
    id: 'nav.goto',
    label: 'Go to page',
    enabled: hasPane,
    run: () => {
      // The page box of the top bar, or the one in the status bar when the toolbar is hidden.
      const box = document.getElementById('page-box') ?? document.getElementById('status-page-box');
      if (box instanceof HTMLInputElement) {
        box.focus();
        box.select();
      }
    },
  });

  commands.register({
    id: 'theme.toggle',
    label: 'Switch light or dark theme',
    run: () => {
      const ui = useUiStore.getState();
      const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      const current = ui.theme === 'system' ? (dark ? 'dark' : 'light') : ui.theme;
      ui.setTheme(current === 'dark' ? 'light' : 'dark');
    },
  });
}

function pageCount(): number {
  const pane = activePane();
  if (!pane) return 0;
  return useDocumentsStore.getState().docs[pane.docId]?.pageCount ?? 0;
}
