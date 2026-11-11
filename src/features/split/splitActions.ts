import { documentRegistry } from '../../app/services';
import { newId } from '../../core/ids';
import type { Pane, SplitOrientation, Tab } from '../../core/model/types';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { selectActiveTab, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { mayReleaseDocument } from '../documents/closeFlow';
import { defaultView, releaseDocumentRef } from '../documents/documentService';
import { clampSplitRatio } from './syncMath';

/** The orientation the next split uses. Ctrl+\ reopens the split in the last orientation used. */
let lastOrientation: SplitOrientation = 'vertical';

const findTab = (tabId: string): Tab | undefined => useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);

/**
 * Splits a tab in two. The new pane shows the same document at the same place, with sync-scroll
 * on. A tab that is already split only changes orientation.
 */
export function openInSplit(tabId: string, orientation: SplitOrientation = lastOrientation): void {
  const tab = findTab(tabId);
  const first = tab?.panes[0];
  if (!tab || !first) return;
  lastOrientation = orientation;
  if (tab.panes.length >= 2) {
    setSplitOrientation(tabId, orientation);
    return;
  }
  documentRegistry.retain(first.docId);
  const second: Pane = { id: newId('pane'), docId: first.docId, view: { ...first.view } };
  const ws = useWorkspaceStore.getState();
  ws.patchTab(tabId, {
    panes: [first, second],
    split: { orientation, ratio: 0.5, syncScroll: true },
  });
  // The split tab becomes the active one, so the status bar and the viewer show the same file.
  ws.setActiveTab(tabId);
  ws.setActivePane(second.id);
}

/** Changes the orientation of a split tab. Splits a tab that is not split yet. */
export function setSplitOrientation(tabId: string, orientation: SplitOrientation): void {
  lastOrientation = orientation;
  const tab = findTab(tabId);
  if (!tab) return;
  if (tab.panes.length < 2) {
    openInSplit(tabId, orientation);
    return;
  }
  if (tab.split) useWorkspaceStore.getState().patchTab(tabId, { split: { ...tab.split, orientation } });
}

/**
 * Closes the second pane of a split tab. The first pane keeps its place and becomes active. When the pane holds the last
 * reference of a document with unsaved changes (the document of a tab that was closed meanwhile, or one only the split
 * shows), the Save prompt asks first, and Cancel leaves the split as it was.
 */
export async function closeSplit(tabId: string): Promise<void> {
  const tab = findTab(tabId);
  const [first, second] = tab?.panes ?? [];
  if (!tab || !first || !second) return;
  if (!(await mayReleaseDocument(second.docId))) return;
  // The prompt can take a while: the tab is looked at again afterwards.
  const ws = useWorkspaceStore.getState();
  const now = findTab(tabId);
  const current = now?.panes.find((p) => p.id === second.id);
  if (now && current) {
    // The pane's id is read again: a Save in the prompt can be a Save As, which renames the document under the pane.
    releaseDocumentRef(current.docId);
    ws.patchTab(tabId, { panes: now.panes.filter((p) => p.id !== second.id), split: null });
    if (ws.activePaneId === second.id) ws.setActivePane(first.id);
  }
}

/** Split on or off. Turning it on uses the last orientation. */
export function toggleSplit(tabId: string): void {
  const tab = findTab(tabId);
  if (tab && tab.panes.length >= 2) void closeSplit(tabId);
  else openInSplit(tabId, lastOrientation);
}

export function setSplitRatio(tabId: string, ratio: number): void {
  const tab = findTab(tabId);
  if (tab?.split) useWorkspaceStore.getState().patchTab(tabId, { split: { ...tab.split, ratio: clampSplitRatio(ratio) } });
}

export function toggleSyncScroll(tabId: string): void {
  const tab = findTab(tabId);
  if (tab?.split) useWorkspaceStore.getState().patchTab(tabId, { split: { ...tab.split, syncScroll: !tab.split.syncScroll } });
}

/**
 * Points one pane at another open document. The pane starts at the top of the new document, and
 * the old document loses this pane's reference (it is freed when no other tab or pane uses it; a document with unsaved
 * changes that would be freed is asked about first, and Cancel keeps the pane as it was).
 */
export async function switchPaneDocument(tabId: string, paneId: string, docId: string): Promise<void> {
  const tab = findTab(tabId);
  const pane = tab?.panes.find((p) => p.id === paneId);
  if (!tab || !pane || pane.docId === docId || !useDocumentsStore.getState().docs[docId]) return;
  const oldDocId = pane.docId;
  // The new document is held first, so it cannot go away while the prompt is open.
  documentRegistry.retain(docId);
  const allowed = await mayReleaseDocument(oldDocId);
  const now = findTab(tabId);
  const current = now?.panes.find((p) => p.id === paneId);
  if (!allowed || !now || !current) {
    // Cancelled, or the pane went away while the prompt was open: the reference taken for it goes back.
    releaseDocumentRef(docId);
    return;
  }
  // A Save As in the prompt renames the document under the pane: its current id is the one to release.
  releaseDocumentRef(current.docId);
  const panes = now.panes.map((p) => (p.id === paneId ? { ...p, docId, view: defaultView(docId) } : p));
  useWorkspaceStore.getState().patchTab(tabId, { panes });
}

/** Moves the active pane to the other pane of the active tab (F6). */
export function focusNextPane(): void {
  const ws = useWorkspaceStore.getState();
  const tab = selectActiveTab(ws);
  if (!tab || tab.panes.length < 2) return;
  const index = tab.panes.findIndex((p) => p.id === ws.activePaneId);
  const next = tab.panes[(index + 1) % tab.panes.length];
  if (next) ws.setActivePane(next.id);
}
