import { commands } from '../core/commands/registry';
import { attachKeymap } from '../core/keymap/keymapService';
import { flushSnapshot, restoreSession, startSnapshotWriter } from '../features/recovery/recoveryService';
import { startTabResidency } from '../features/documents/tabResidency';
import { startSearchController } from '../features/search/searchController';
import { getDesktopBridge } from '../platform/desktop/bridge';
import { markSessionRestored } from '../platform/recovery/sessionState';
import { useUiStore } from '../core/stores/uiStore';
import { useWorkspaceStore } from '../core/stores/workspaceStore';
import { quiescePage } from './quiesce';
import { registerBuiltins } from './registerBuiltins';
import { keymap } from './services';

let started = false;

/**
 * Makes the session snapshot current before the app goes away. The desktop main process asks for it
 * before quitting and waits for the ack. The page hiding is a best-effort write of its own.
 */
function registerFlushHooks(): void {
  const bridge = getDesktopBridge();
  if (bridge) {
    bridge.session.onFlushRequested(() => {
      // The snapshot is written, then the page comes to rest (no render job running, the last frame sent), so the
      // window is not closed under a renderer that is still drawing.
      void flushSnapshot()
        .finally(() => quiescePage())
        .catch(() => undefined)
        .finally(() => bridge.session.flushed());
    });
  }
  window.addEventListener('pagehide', () => {
    void flushSnapshot();
  });
}

/**
 * The start after two renderer crashes in a minute (the main process loads the page with ?noRestore=1): no tabs come back, and
 * a notice stays until it is closed. The saved session and the recovery logs are NOT touched: the snapshot writer starts only
 * once the user has opened a tab, so quitting with no tabs cannot overwrite the saved session with an empty one, and each
 * file's unsaved edits are offered when it is opened.
 */
function startWithoutRestore(): void {
  useUiStore
    .getState()
    .pushToast('PDF Suite closed unexpectedly twice, so it started without your files. Your unsaved edits are kept and will be offered when you open each file.', undefined, { sticky: true });
  markSessionRestored();
  const begin = (): void => {
    startSnapshotWriter();
  };
  if (useWorkspaceStore.getState().tabs.length > 0) {
    begin();
    return;
  }
  const stop = useWorkspaceStore.subscribe((state) => {
    if (state.tabs.length === 0) return;
    stop();
    begin();
  });
}

/**
 * One-time startup, run before React renders: registers commands, panels and top bar groups,
 * attaches the keyboard, and restores the last session. The snapshot writer starts only
 * after the restore is done. Calling this twice does nothing.
 */
export function bootApp(): void {
  if (started) return;
  started = true;
  registerBuiltins();
  attachKeymap(keymap, commands);
  startSearchController();
  startTabResidency();
  registerFlushHooks();
  if (new URLSearchParams(window.location.search).get('noRestore') === '1') {
    startWithoutRestore();
    return;
  }
  void restoreSession()
    .catch(() => 0)
    .finally(() => {
      markSessionRestored();
      startSnapshotWriter();
    });
}
