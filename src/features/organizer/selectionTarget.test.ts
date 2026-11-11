// @vitest-environment node
// A page selection belongs to the document it was made in. Commands resolve their target pages through targetUids, and
// a selection made in document A never resolves to pages of document B, even when the two paths share their first 16
// characters (the old page ids did).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ fileService: {} }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(),
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
import { selectedUids, targetUids } from './actions';

const A = 'path:C:\Docs\example\work\A.pdf';
const B = 'path:C:\Docs\example\work\B.pdf';

function openTwo() {
  const pane = (id: string, docId: string) => ({
    id,
    docId,
    view: { pageId: pageIdForUid(docId, '4'), zoom: 1, fit: 'width' as const, offset: 0, rotation: 0 as const },
  });
  useWorkspaceStore.setState({
    tabs: [
      { id: 'ta', title: 'A.pdf', origin: { kind: 'path', path: A }, status: { kind: 'ready' }, panes: [pane('pa', A)], split: null },
      { id: 'tb', title: 'B.pdf', origin: { kind: 'path', path: B }, status: { kind: 'ready' }, panes: [pane('pb', B)], split: null },
    ],
    activeTabId: 'ta',
    activePaneId: 'pa',
  } as never);
  const uids = ['0', '1', '2', '3', '4', '5'];
  useEditStore.setState({ byDoc: { [A]: { uids, revs: uids.map(() => 0) }, [B]: { uids, revs: uids.map(() => 0) } } } as never);
}

beforeEach(() => {
  openTwo();
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
});

describe('a selection never reaches another document', () => {
  it('resolves the selected pages of the document they were made in', () => {
    useSelectionStore.getState().setSelection([pageIdForUid(A, '1'), pageIdForUid(A, '2')], pageIdForUid(A, '1'));
    expect(selectedUids(A)).toEqual(['1', '2']);
    expect(targetUids(A)).toEqual(['1', '2']);
  });

  it('is empty for another document, and the current page is the target there', () => {
    // B is the active document, and a selection of A's pages is stored (as a stale or late write would leave it).
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    useSelectionStore.getState().setSelection([pageIdForUid(A, '1'), pageIdForUid(A, '2')], pageIdForUid(A, '1'));
    expect(selectedUids(B)).toEqual([]);
    expect(targetUids(B)).toEqual(['4']);
  });

  it('drops the selection when another tab becomes the active one', () => {
    useSelectionStore.getState().setSelection([pageIdForUid(A, '1')], pageIdForUid(A, '1'));
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    expect(useSelectionStore.getState().pageIds).toEqual([]);
    expect(targetUids(B)).toEqual(['4']);
  });

  it('drops ids that are not in the page list, and a current page that is not in it', () => {
    useSelectionStore.getState().setSelection([pageIdForUid(A, '99'), 'garbage', pageIdForUid(A, '3')], null);
    expect(targetUids(A)).toEqual(['3']);
    useSelectionStore.getState().clear();
    useEditStore.setState({ byDoc: { [A]: { uids: ['0', '1'], revs: [0, 0] } } } as never);
    expect(targetUids(A)).toEqual([]);
  });
});
