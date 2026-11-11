// @vitest-environment node
// After a delete, the current page is the page that now stands in the first deleted place, the same page the thumbnail
// list's active row goes to (activeAfterDelete): so a second Delete acts on the page the focus ring is on.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ fileService: {} }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(async (docId: string, edits: Array<{ op: string; uids: string[] }>) => {
    const { useEditStore } = await import('../../core/stores/editStore');
    const gone = new Set(edits.flatMap((edit) => edit.uids));
    const uids = (useEditStore.getState().byDoc[docId]?.uids ?? []).filter((uid) => !gone.has(uid));
    useEditStore.setState({ byDoc: { [docId]: { version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { canUndo: true, canRedo: false } } } } as never);
    return true;
  }),
  attachSourceLogged: vi.fn(),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { pageIdForUid } from '../../core/model/pageList';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { activeAfterDelete, applySelectionClick } from '../../panels/thumbnails/selection';
import { deletePages, orderOf, targetUids } from './actions';

const DOC = 'path:C:\\Docs\\ten.pdf';
const ALL = Array.from({ length: 10 }, (_, i) => String(i));

beforeEach(() => {
  useWorkspaceStore.setState({
    tabs: [
      {
        id: 't',
        title: 'ten.pdf',
        origin: { kind: 'path', path: DOC },
        status: { kind: 'ready' },
        panes: [{ id: 'p', docId: DOC, view: { pageId: pageIdForUid(DOC, '0'), zoom: 1, fit: 'width', offset: 0, rotation: 0 } }],
        split: null,
      },
    ],
    activeTabId: 't',
    activePaneId: 'p',
  } as never);
  useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: ALL, revs: ALL.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
});

const ids = () => orderOf(DOC).map((uid) => pageIdForUid(DOC, uid));
const current = () => useWorkspaceStore.getState().tabs[0]!.panes[0]!.view.pageId;

function click(pageNo: number, shift: boolean) {
  const id = pageIdForUid(DOC, String(pageNo - 1));
  const store = useSelectionStore.getState();
  const result = applySelectionClick(store.pageIds, ids(), store.anchorId, id, { ctrl: false, shift });
  store.setSelection(result.pageIds, result.anchorId);
  store.selectPage(DOC, id);
  if (!shift) useWorkspaceStore.getState().setView('p', { pageId: id, offset: 0 });
}

describe('the current page after a delete', () => {
  it('click 5, Shift+click 3, Delete, Delete again: the second Delete removes the page the ring is on', async () => {
    click(5, false);
    click(3, true);
    expect(targetUids(DOC)).toEqual(['2', '3', '4']);
    const before = ids();
    expect(await deletePages(DOC, targetUids(DOC))).toBe(true);
    // The page now in the first deleted place (page 3, uid 5) is the current page, and the list's active row goes there too.
    const ring = activeAfterDelete(before, ids());
    expect(ring).toBe(pageIdForUid(DOC, '5'));
    expect(current()).toBe(ring);
    expect(targetUids(DOC)).toEqual(['5']);
    expect(await deletePages(DOC, targetUids(DOC))).toBe(true);
    expect(orderOf(DOC)).toEqual(['0', '1', '6', '7', '8', '9']);
  });

  it('deleting the last pages leaves the last page current', async () => {
    useWorkspaceStore.getState().setView('p', { pageId: pageIdForUid(DOC, '9'), offset: 0 });
    await deletePages(DOC, ['8', '9']);
    expect(current()).toBe(pageIdForUid(DOC, '7'));
  });

  it('a current page that was not deleted stays', async () => {
    useWorkspaceStore.getState().setView('p', { pageId: pageIdForUid(DOC, '1'), offset: 0 });
    await deletePages(DOC, ['5']);
    expect(current()).toBe(pageIdForUid(DOC, '1'));
  });
});
