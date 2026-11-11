import { useEffect, type DragEvent } from 'react';
import { AppShell } from '../ui/shell/AppShell';
import { useUiStore } from '../core/stores/uiStore';
import { selectActiveTab, selectPane, useWorkspaceStore } from '../core/stores/workspaceStore';
import { useEditStore } from '../core/stores/editStore';
import { dirtyDocIds, watchCloseRequests } from '../features/documents/closeFlow';
import { openPicked } from '../features/documents/documentService';
import { routeDroppedSources } from '../features/jobs/dropRouting';
import { windowTitle } from '../core/menus/menuModel';
import { isOpenablePath } from '../platform/desktop/contract';
import { getDesktopBridge, pathSource } from '../platform/desktop/bridge';
import { whenSessionRestored } from '../platform/recovery/sessionState';
import { fileService } from './services';

/** Root component. Applies the theme, accepts dropped PDFs, and on desktop follows the window title and open requests. */
export function App() {
  const theme = useUiStore((s) => s.theme);
  const activeTitle = useWorkspaceStore((s) => selectActiveTab(s)?.title);
  const activeDocId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const dirty = useEditStore((s) => (activeDocId ? s.byDoc[activeDocId]?.history.dirty === true : false));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Desktop: files passed on the command line or sent by a second launch open in new tabs, after the
  // last session has been restored so the requested file ends up in front.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return undefined;
    const open = (paths: string[]) => {
      const sources = paths.filter(isOpenablePath).map(pathSource);
      if (sources.length > 0) void whenSessionRestored().then(() => openPicked(sources));
    };
    const unsubscribe = bridge.files.onOpenRequested(open);
    // Subscribe first, then drain the queue. Startup files are queued until this point.
    void bridge.files.takePending().then(open);
    return unsubscribe;
  }, []);

  // The window title follows the active tab, as "<file name> — PDF Suite", with a bullet while it has unsaved changes.
  // The menu row shows the same text.
  useEffect(() => {
    document.title = windowTitle(activeTitle ?? null, dirty);
  }, [activeTitle, dirty]);

  // Desktop: the window's own title-bar buttons take the app's theme.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
    void bridge.chrome.setDark(dark);
  }, [theme]);

  // Desktop: the main process asks before the window closes, and the prompt answers (see features/documents/closeFlow.ts).
  useEffect(() => watchCloseRequests(), []);

  // Web: the browser's own prompt guards unsaved changes, since the app cannot ask in its own dialog on close.
  useEffect(() => {
    if (getDesktopBridge()) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyDocIds().length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Stop the browser from opening a dropped file in the tab, even outside the app area.
  useEffect(() => {
    const block = (event: Event) => event.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void fileService.fromFileList(event.dataTransfer.files).then(routeDroppedSources);
  };

  return (
    <div className="app-root" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <AppShell />
    </div>
  );
}
