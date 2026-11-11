import { create } from 'zustand';
import { rekeyPageId } from '../model/pageList';
import { selectPane, useWorkspaceStore, type WorkspaceState } from './workspaceStore';

/**
 * The page the user last clicked, or chose from a menu. Properties describes it. `docId` says which
 * document the page belongs to, so a selection never reaches another document.
 */
export interface PageSelection {
  type: 'page';
  pageId: string;
  docId: string;
}

/** Selected page ids (for thumbnails and page actions). `anchorId` is where Shift-click ranges start. */
interface SelectionState {
  pageIds: string[];
  anchorId: string | null;
  /** The page the user last picked. Null when nothing is picked. */
  selection: PageSelection | null;
  setPageIds: (ids: string[]) => void;
  setSelection: (pageIds: string[], anchorId: string | null) => void;
  selectPage: (docId: string, pageId: string) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>()((set) => ({
  pageIds: [],
  anchorId: null,
  selection: null,
  setPageIds: (ids) => set({ pageIds: [...new Set(ids)] }),
  setSelection: (pageIds, anchorId) => set({ pageIds: [...new Set(pageIds)], anchorId }),
  selectPage: (docId, pageId) => set({ selection: { type: 'page', pageId, docId } }),
  clear: () => set({ pageIds: [], anchorId: null, selection: null }),
}));

/** The document shown by the focused pane, or null. */
function focusedDoc(state: WorkspaceState): string | null {
  return selectPane(state, state.activePaneId)?.docId ?? null;
}

// A page selection belongs to the tab, pane and document it was made in. Switching any of them clears it,
// so Properties falls back to the current page instead of describing a page the user left behind.
useWorkspaceStore.subscribe((state, previous) => {
  const changed =
    state.activeTabId !== previous.activeTabId ||
    state.activePaneId !== previous.activePaneId ||
    focusedDoc(state) !== focusedDoc(previous);
  if (changed && useSelectionStore.getState().selection !== null) useSelectionStore.setState({ selection: null });
});

// Selected pages belong to the document they were chosen in (a page id starts with its document id). When the focused
// document changes (another tab, another pane, a close), the selected pages of any other document are dropped, so a
// selection cannot come back when the same file is opened again. A Save As re-keys the document and its page ids first
// (see rekeySelection), so its selection stays. Command targets also drop ids that are not in the active document's
// page list (see selectedUids), whatever this store holds.
useWorkspaceStore.subscribe((state, previous) => {
  const doc = focusedDoc(state);
  if (doc === focusedDoc(previous)) return;
  const { pageIds, anchorId } = useSelectionStore.getState();
  const kept = doc === null ? [] : pageIds.filter((id) => id.startsWith(`${doc}:`));
  if (kept.length === pageIds.length) return;
  useSelectionStore.setState({ pageIds: kept, anchorId: anchorId !== null && kept.includes(anchorId) ? anchorId : null });
});

/** Save As re-keys a document: its selected pages (and the anchor) follow it to the new page ids. */
export function rekeySelection(oldDocId: string, newDocId: string): void {
  const { pageIds, anchorId, selection } = useSelectionStore.getState();
  if (selection && selection.docId === oldDocId) {
    useSelectionStore.setState({ selection: { ...selection, docId: newDocId, pageId: rekeyPageId(oldDocId, newDocId, selection.pageId) } });
  }
  if (pageIds.length === 0 && anchorId === null) return;
  useSelectionStore.setState({
    pageIds: pageIds.map((id) => rekeyPageId(oldDocId, newDocId, id)),
    anchorId: anchorId === null ? null : rekeyPageId(oldDocId, newDocId, anchorId),
  });
}
