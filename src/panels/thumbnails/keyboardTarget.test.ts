// @vitest-environment node
// A selection made with the thumbnail list's keys is the same selection a click makes, so a command that follows it (Delete)
// acts on exactly those pages: not after a Save (which gives the document fresh page uids), and never on the pages of
// another document or on ids that are no longer in the list.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ fileService: {} }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../../features/documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(),
  attachSourceLogged: vi.fn(),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../../features/documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { pageIdForUid } from '../../core/model/pageList';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { selectedUids, targetUids } from '../../features/organizer/actions';
import { currentOrder, remapAfterReplace } from '../../features/documents/replacedDocument';
import { applyListKey, type ListKeyState } from './selection';

const A = 'path:C:\\Docs\\example\\work\\A.pdf';
const B = 'path:C:\\Docs\\example\\work\\B.pdf';
const none = { ctrl: false, shift: false, alt: false, meta: false };

const editState = (uids: string[]) => ({ version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } });

function openDocs(aUids: string[], bUids: string[], activePane: 'pa' | 'pb' = 'pa') {
  const pane = (id: string, docId: string, uid: string) => ({
    id,
    docId,
    view: { pageId: pageIdForUid(docId, uid), zoom: 1, fit: 'width' as const, offset: 0, rotation: 0 as const },
  });
  useWorkspaceStore.setState({
    tabs: [
      { id: 'ta', title: 'A.pdf', origin: { kind: 'path', path: A }, status: { kind: 'ready' }, panes: [pane('pa', A, aUids[0]!)], split: null },
      { id: 'tb', title: 'B.pdf', origin: { kind: 'path', path: B }, status: { kind: 'ready' }, panes: [pane('pb', B, bUids[0]!)], split: null },
    ],
    activeTabId: activePane === 'pa' ? 'ta' : 'tb',
    activePaneId: activePane,
  } as never);
  useEditStore.setState({ byDoc: { [A]: editState(aUids), [B]: editState(bUids) } } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
}

/** One key press on the list, applied the way the panel applies it (the selection, and the page Properties describes). */
function press(docId: string, key: string, mods: Partial<typeof none>, active: { id: string | null }) {
  const order = (useEditStore.getState().byDoc[docId]?.uids ?? []).map((uid) => pageIdForUid(docId, uid));
  const store = useSelectionStore.getState();
  const state: ListKeyState = { order, selected: store.pageIds, anchorId: store.anchorId, activeId: active.id, currentId: order[0] ?? null, pageRows: 3 };
  const result = applyListKey(state, key, { ...none, ...mods });
  active.id = result.activeId;
  if (result.selectionChanged) {
    store.setSelection(result.pageIds, result.anchorId);
    if (result.activeId) store.selectPage(docId, result.activeId);
  }
}

beforeEach(() => openDocs(['0', '1', '2', '3', '4', '5'], ['0', '1', '2', '3', '4', '5']));

describe('keyboard selection, then Delete', () => {
  it('targets the pages the keys selected', () => {
    const active = { id: pageIdForUid(A, '0') };
    press(A, 'ArrowDown', {}, active);
    press(A, 'ArrowDown', {}, active);
    press(A, 'ArrowDown', { shift: true }, active);
    expect(targetUids(A)).toEqual(['2', '3']);
  });

  it('after a Save (fresh uids), still targets the same positions', () => {
    // Page 1 was duplicated, so the uids no longer equal the positions: 0, n1, 1, 2, 3, 4, 5.
    const old = ['0', 'n1', '1', '2', '3', '4', '5'];
    openDocs(old, ['0', '1']);
    const active: { id: string | null } = { id: pageIdForUid(A, '0') };
    for (let i = 0; i < 3; i++) press(A, 'ArrowDown', {}, active); // page 4 (position 3), uid "1"... index 3 is uid '2'
    press(A, 'ArrowDown', { shift: true }, active); // pages at positions 3 and 4
    const before = targetUids(A);
    expect(before).toEqual(['2', '3']);

    // The save replaces the document: a new worker, uids restart at 0.
    const oldOrder = currentOrder(A);
    useEditStore.setState({ byDoc: { [A]: editState(['0', '1', '2', '3', '4', '5', '6']), [B]: editState(['0', '1']) } } as never);
    remapAfterReplace(A, oldOrder, true);

    // Delete now acts on the pages at positions 3 and 4 of the new list, not on the pages that carry the old uids.
    expect(targetUids(A)).toEqual(['3', '4']);

    // The panel forgets its active row when the document is replaced (its ids now name other pages), so the next key starts
    // from the current page. Space then adds that page to the selection, and every target is a page of the new list.
    active.id = null;
    press(A, ' ', {}, active);
    expect(targetUids(A)).toEqual(['0', '3', '4']);
  });

  it('with two documents open, never reaches the other document', () => {
    const active = { id: pageIdForUid(A, '0') };
    press(A, 'ArrowDown', {}, active);
    press(A, 'ArrowDown', { shift: true }, active);
    expect(targetUids(A)).toEqual(['1', '2']);

    // The user moves to document B. The selection is dropped, and Delete acts on B's current page only.
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    expect(selectedUids(B)).toEqual([]);
    expect(targetUids(B)).toEqual(['0']);

    // Keys in B select B's pages, and A's pages are never targets of B.
    const activeB = { id: pageIdForUid(B, '0') };
    press(B, 'End', {}, activeB);
    expect(targetUids(B)).toEqual(['5']);
    expect(selectedUids(A)).toEqual([]);
  });

  it('ignores ids of the other document even when a late write put them in the store', () => {
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    useSelectionStore.getState().setSelection([pageIdForUid(A, '1'), pageIdForUid(A, '2')], pageIdForUid(A, '1'));
    const active = { id: pageIdForUid(B, '2') };
    press(B, ' ', {}, active); // Space adds B's page 3 to the (stale) selection
    expect(useSelectionStore.getState().pageIds).toEqual([pageIdForUid(B, '2')]);
    expect(targetUids(B)).toEqual(['2']);
  });

  it('ignores a stale active row that is no longer in the list', () => {
    const active = { id: pageIdForUid(A, '99') };
    press(A, 'ArrowDown', {}, active);
    expect(targetUids(A)).toEqual(['1']);
  });
});
