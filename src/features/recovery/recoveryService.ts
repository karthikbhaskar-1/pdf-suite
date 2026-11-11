import { newId } from '../../core/ids';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import type { Pane, Tab } from '../../core/model/types';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore, type WorkspaceState } from '../../core/stores/workspaceStore';
import { ERROR_MESSAGES } from '../../engine/errors';
import { getFile } from '../../platform/recovery/fileCache';
import type { RecentFile } from '../../platform/fileService';
import {
  buildSnapshot,
  loadSnapshot,
  saveSnapshot,
  type SnapshotOrigin,
  type SnapshotSplit,
  type SnapshotTab,
} from '../../platform/recovery/snapshot';
import type { DocumentSource } from '../../engine/types';
import { acquireWithTimeout, finishAcquire, openSource, prepareAcquire, releaseDocumentRef } from '../documents/documentService';

/** Page and zoom changes are saved at most this long after they happen. */
export const VIEW_SAVE_DELAY_MS = 500;

/**
 * Asks the main process to open a path it knows (a tab of the last session or a Recent entry) BEFORE the file is read: it
 * accepts each such path once per session, and the document may then be written. A refusal is not an error: the file still opens
 * for reading, and its first Save asks through the Save dialog.
 */
export async function askToOpenKnown(path: string): Promise<string> {
  try {
    return (await getDesktopBridge()?.files.openKnown(path)) ?? path;
  } catch {
    // The file opens read-only, under the spelling the page has.
    return path;
  }
}

/** Turns a saved origin into a source, or null when its bytes are no longer cached. */
async function sourceFromOrigin(origin: SnapshotOrigin, name: string): Promise<DocumentSource | null> {
  if (origin.kind === 'path') {
    return { kind: 'path', path: await askToOpenKnown(origin.path), name };
  }
  const bytes = await getFile(origin.docId);
  return bytes ? { kind: 'bytes', name, bytes } : null;
}

async function sourceFor(saved: SnapshotTab): Promise<DocumentSource | null> {
  return sourceFromOrigin(saved.origin, saved.title);
}

/**
 * Rebuilds a split tab: the second pane reopens its file (or shares the tab's file) at its saved view.
 * If the second file cannot be reopened, the tab comes back as a single pane.
 */
async function restoreSplit(tabId: string, saved: SnapshotSplit): Promise<void> {
  const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
  const first = tab?.panes[0];
  if (!tab || !first || tab.status.kind !== 'ready') return;
  const source = await sourceFromOrigin(saved.second.origin, saved.second.title);
  if (!source) return;
  let handle;
  let stamp;
  try {
    // The same steps as a tab's open, so this document gets its recovery log replayed, its file stamp and watch, and its
    // "stopped responding" watch even when this open is the first one on it (its own tab then finds it open already).
    stamp = await prepareAcquire(source);
    // The open adds a reference, which the second pane owns. It is bounded, so the restore cannot stall.
    handle = await acquireWithTimeout(source, {});
  } catch {
    return;
  }
  if (!useWorkspaceStore.getState().tabs.some((t) => t.id === tabId)) {
    // The tab was closed while the file was opening. Give the reference back.
    releaseDocumentRef(handle.docId);
    return;
  }
  finishAcquire(handle, source, undefined, stamp);
  const second: Pane = { id: newId('pane'), docId: handle.docId, view: saved.second.view };
  useWorkspaceStore.getState().patchTab(tabId, {
    panes: [first, second],
    split: { orientation: saved.orientation, ratio: saved.ratio, syncScroll: saved.syncScroll },
  });
}

/**
 * A saved tab whose bytes are gone from the file cache. It still gets a tab, with an inline message,
 * so it does not disappear without a trace.
 */
function addUnreadableTab(saved: SnapshotTab): string {
  const id = newId('tab');
  useWorkspaceStore.getState().addTab({
    id,
    title: saved.title,
    origin: { kind: 'bytes' },
    status: { kind: 'error', message: ERROR_MESSAGES.Unreadable },
    panes: [],
    split: null,
  } satisfies Tab);
  return id;
}

/**
 * Reopens the tabs from the last session. Every saved tab comes back: a file that was moved or
 * deleted shows "This file was moved, renamed or deleted." in its tab. Shows the "Restored N tabs" toast.
 * Returns how many tabs came back.
 */
export async function restoreSession(): Promise<number> {
  const snapshot = await loadSnapshot();
  if (!snapshot || snapshot.tabs.length === 0) return 0;

  // Each tab is added to the strip in saved order, then opens on its own. A file that cannot be read
  // ends in an inline message in its tab, and does not hold up the tabs after it.
  const opening: Promise<string>[] = [];
  for (const saved of snapshot.tabs) {
    const source = await sourceFor(saved);
    if (!source) {
      opening.push(Promise.resolve(addUnreadableTab(saved)));
      continue;
    }
    opening.push(
      openSource(source, saved.view, { restored: true }).then(async (id) => {
        if (saved.split) await restoreSplit(id, saved.split);
        return id;
      }),
    );
  }

  const count = opening.length;
  if (count > 0) {
    useUiStore.getState().pushToast(`Restored ${count} ${count === 1 ? 'tab' : 'tabs'}`);
  }
  const restoredIds = await Promise.all(opening);
  const activeIndex = snapshot.activeIndex;
  const activeId = restoredIds[activeIndex] ?? restoredIds[0];
  if (activeId) useWorkspaceStore.getState().setActiveTab(activeId);
  return count;
}

/**
 * What decides whether a change is saved right away: which tabs are open, their file, their panes,
 * their split, and which tab is active. Page and zoom changes are not in here.
 */
export function structureSignature(state: Pick<WorkspaceState, 'tabs' | 'activeTabId'>): string {
  return JSON.stringify([
    state.activeTabId,
    state.tabs.map((t) => [t.id, t.title, t.origin, t.status.kind, t.panes.map((p) => p.docId), t.split?.orientation ?? null]),
  ]);
}

let writerActive = false;
let viewTimer: ReturnType<typeof setTimeout> | undefined;
/** The last save queued. Saves run one after another, so an older write never lands after a newer one. */
let writing: Promise<void> = Promise.resolve();

/** Queues a save of the workspace as it is when the save runs. Never rejects. */
function saveCurrent(): Promise<void> {
  writing = writing.then(() => {
    const { tabs, activeTabId } = useWorkspaceStore.getState();
    return saveSnapshot(buildSnapshot(tabs, activeTabId));
  });
  return writing;
}

function cancelViewTimer(): void {
  clearTimeout(viewTimer);
  viewTimer = undefined;
}

/**
 * Keeps the saved session current. Changes to the tab structure are saved right away. Page and zoom
 * changes are saved within VIEW_SAVE_DELAY_MS. Call only after restoreSession has finished, so an
 * unfinished restore cannot overwrite the saved session. Returns a stop function.
 */
export function startSnapshotWriter(): () => void {
  writerActive = true;
  let last = structureSignature(useWorkspaceStore.getState());
  const unsubscribe = useWorkspaceStore.subscribe((state) => {
    const signature = structureSignature(state);
    if (signature !== last) {
      last = signature;
      cancelViewTimer();
      void saveCurrent();
      return;
    }
    // A timer is started by the first unsaved change, not restarted by each one, so a long scroll
    // still saves within the delay.
    if (viewTimer === undefined) {
      viewTimer = setTimeout(() => {
        viewTimer = undefined;
        void saveCurrent();
      }, VIEW_SAVE_DELAY_MS);
    }
  });
  return () => {
    writerActive = false;
    cancelViewTimer();
    unsubscribe();
  };
}

/**
 * Writes the session now and resolves when the write has finished. Used when the app is quitting.
 * Does nothing before the restore has finished, so a half-restored workspace is never saved.
 */
export function flushSnapshot(): Promise<void> {
  if (!writerActive) return Promise.resolve();
  cancelViewTimer();
  return saveCurrent();
}

/**
 * Reopens a recently used file. Desktop entries open by path, so a file that has moved shows its
 * inline message in the new tab. Web entries reopen from the byte cache.
 */
export async function openRecent(file: RecentFile): Promise<void> {
  if (file.kind === 'path') {
    await openSource({ kind: 'path', path: await askToOpenKnown(file.path), name: file.name });
    return;
  }
  const bytes = await getFile(file.docId);
  if (!bytes) {
    useUiStore.getState().pushToast('PDF Suite no longer has a copy of that file. Open it again.');
    return;
  }
  await openSource({ kind: 'bytes', name: file.name, bytes });
}
