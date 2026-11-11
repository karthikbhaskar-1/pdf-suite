// @vitest-environment node
// A saved document replaces the open one with fresh uids (0, 1, 2 ...). The selection and each pane's current page follow
// their pages by position, so they still name the same pages. A reload of a changed file clears the selection.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ fileService: {} }));

import { pageIdForUid } from '../../core/model/pageList';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useSheetStore, type SheetDraft } from '../../core/stores/sheetStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { registerViewer, resetViewerBus } from '../../ui/viewer/viewerBus';
import { currentOrder, remapAfterReplace, remapCurrentUid, remapSelectedUids } from './replacedDocument';

const DOC = 'path:C:\work\A.pdf';
// Six pages, then page 1 duplicated: the uids no longer equal the positions.
const OLD = ['0', 'n1', '1', '2', '3', '4', '5'];
const FRESH = ['0', '1', '2', '3', '4', '5', '6'];

describe('position mapping', () => {
  it('after duplicate-then-save, pages 3-4 stay pages 3-4', () => {
    // Old uids of pages 3 and 4 are "1" and "2"; the fresh uids of positions 3 and 4 are "2" and "3".
    expect(remapSelectedUids(OLD, FRESH, ['1', '2'], true)).toEqual(['2', '3']);
    expect(remapCurrentUid(OLD, FRESH, '1')).toBe('2');
  });

  it('clears the selection when the page count differs or the pages are not the same', () => {
    expect(remapSelectedUids(OLD, FRESH.slice(0, 6), ['1'], true)).toEqual([]);
    expect(remapSelectedUids(OLD, FRESH, ['1'], false)).toEqual([]);
  });

  it('clamps the current page to the last page, and never keeps an old uid with no pages', () => {
    expect(remapCurrentUid(OLD, ['0', '1', '2'], '5')).toBe('2');
    expect(remapCurrentUid(OLD, [], '5')).toBeNull();
  });
});

function setUp(panes: string[]) {
  useWorkspaceStore.setState({
    tabs: [{
      id: 't', title: 'A.pdf', origin: { kind: 'path', path: 'A' }, status: { kind: 'ready' }, split: null,
      panes: panes.map((uid, i) => ({ id: `p${i}`, docId: DOC, view: { pageId: pageIdForUid(DOC, uid), zoom: 1, fit: 'width', offset: 0, rotation: 0 } })),
    }],
    activeTabId: 't', activePaneId: 'p0',
  } as never);
  useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: OLD, revs: OLD.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } } as never);
  useSelectionStore.setState({ pageIds: [pageIdForUid(DOC, '1'), pageIdForUid(DOC, '2')], anchorId: pageIdForUid(DOC, '1'), selection: { type: 'page', docId: DOC, pageId: pageIdForUid(DOC, '1') } });
}
const replaceWithFresh = (uids: string[]) => useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } } as never);
const viewIds = () => useWorkspaceStore.getState().tabs[0]!.panes.map((p) => p.view.pageId);

describe('remapAfterReplace', () => {
  beforeEach(() => setUp(['1', '3']));

  it('save: moves the selection, the anchor, Properties and every pane (both panes of a split) by position', () => {
    const before = currentOrder(DOC);
    replaceWithFresh(FRESH);
    remapAfterReplace(DOC, before, true);
    const sel = useSelectionStore.getState();
    expect(sel.pageIds).toEqual([pageIdForUid(DOC, '2'), pageIdForUid(DOC, '3')]);
    expect(sel.anchorId).toBe(pageIdForUid(DOC, '2'));
    expect(sel.selection?.pageId).toBe(pageIdForUid(DOC, '2'));
    expect(viewIds()).toEqual([pageIdForUid(DOC, '2'), pageIdForUid(DOC, '4')]);
  });

  it('reload of a changed file: clears the selection and clamps the current page', () => {
    const before = currentOrder(DOC);
    replaceWithFresh(['0', '1', '2']);
    remapAfterReplace(DOC, before, false);
    const sel = useSelectionStore.getState();
    expect(sel.pageIds).toEqual([]);
    expect(sel.anchorId).toBeNull();
    expect(sel.selection).toBeNull();
    expect(viewIds()).toEqual([pageIdForUid(DOC, '2'), pageIdForUid(DOC, '2')]);
  });

  it('a save whose page count differs clears the selection too', () => {
    const before = currentOrder(DOC);
    replaceWithFresh(['0', '1', '2']);
    remapAfterReplace(DOC, before, true);
    expect(useSelectionStore.getState().pageIds).toEqual([]);
  });
});

describe('the viewer of each pane is told to move the page it holds', () => {
  // With nothing selected, the pane's current page is all there is to move. The viewer keeps its own copy of it (the anchor
  // its layout scrolls back to), so the store alone is not enough: this was the "page 3 becomes page 2 after Save" fault.
  beforeEach(() => {
    resetViewerBus();
    setUp(['1', '3']);
    useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
  });

  it('sends every pane of the document the old and new page ids by position, with nothing selected', () => {
    const seen: Record<string, unknown[]> = { p0: [], p1: [] };
    registerViewer('p0', (r) => (seen.p0!.push(r), true));
    registerViewer('p1', (r) => (seen.p1!.push(r), true));
    const before = currentOrder(DOC);
    replaceWithFresh(FRESH);
    remapAfterReplace(DOC, before, true);
    const expected = { kind: 'remapPages', from: OLD.map((u) => pageIdForUid(DOC, u)), to: FRESH.map((u) => pageIdForUid(DOC, u)) };
    expect(seen.p0).toEqual([expected]);
    expect(seen.p1).toEqual([expected]);
    expect(viewIds()).toEqual([pageIdForUid(DOC, '2'), pageIdForUid(DOC, '4')]);
  });

  it('a pane of another document gets nothing', () => {
    useWorkspaceStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, panes: tab.panes.map((pane, i) => (i === 1 ? { ...pane, docId: 'path:C:\other.pdf' } : pane)) })),
    }));
    const seen: unknown[] = [];
    registerViewer('p1', (r) => (seen.push(r), true));
    const before = currentOrder(DOC);
    replaceWithFresh(FRESH);
    remapAfterReplace(DOC, before, true);
    expect(seen).toEqual([]);
  });
});

describe('an open side sheet follows its pages by position (or closes) when the document is replaced', () => {
  // The Rotate, Crop, Page size, Replace and "Delete pages?" sheets store uids when they open. After a save the uids restart
  // at 0, so a stored old uid would name another page: "duplicate page 1, select 6-11, Delete, Ctrl+S, Apply" deleted the wrong pages.
  const sheets: Array<{ name: string; draft: SheetDraft; expected: SheetDraft }> = [
    {
      name: 'Rotate',
      draft: { kind: 'rotate', docId: DOC, uids: ['1', '2'], degrees: 90 },
      expected: { kind: 'rotate', docId: DOC, uids: ['2', '3'], degrees: 90 },
    },
    {
      name: 'Page size',
      draft: { kind: 'size', docId: DOC, uids: ['3', '4'], size: 'a4', custom: { width: 1, height: 1 }, unit: 'in', fit: 'scale', scope: 'selected' },
      expected: { kind: 'size', docId: DOC, uids: ['4', '5'], size: 'a4', custom: { width: 1, height: 1 }, unit: 'in', fit: 'scale', scope: 'selected' },
    },
    {
      name: 'Delete pages?',
      draft: { kind: 'confirmDelete', docId: DOC, uids: ['2', '3', '4', '5'], total: 7 },
      expected: { kind: 'confirmDelete', docId: DOC, uids: ['3', '4', '5', '6'], total: 7 },
    },
    {
      name: 'Replace',
      draft: { kind: 'replace', docId: DOC, uid: '1', pageNumber: 3, sourceDocId: null, sourceName: null, sourcePages: 0, sourcePage: 1 },
      expected: { kind: 'replace', docId: DOC, uid: '2', pageNumber: 3, sourceDocId: null, sourceName: null, sourcePages: 0, sourcePage: 1 },
    },
    {
      name: 'Crop',
      draft: {
        kind: 'crop', docId: DOC, uids: ['1', '2'], pageId: pageIdForUid(DOC, '1'), scope: 'selected', unit: 'in',
        margins: { top: 1, bottom: 1, left: 1, right: 1 }, autoApplied: false,
      },
      expected: {
        kind: 'crop', docId: DOC, uids: ['2', '3'], pageId: pageIdForUid(DOC, '2'), scope: 'selected', unit: 'in',
        margins: { top: 1, bottom: 1, left: 1, right: 1 }, autoApplied: false,
      },
    },
  ];

  beforeEach(() => {
    setUp(['1', '3']);
    useSheetStore.getState().close();
  });

  for (const { name, draft, expected } of sheets) {
    it(`${name}: after a save the stored pages are the same pages by position`, () => {
      useSheetStore.getState().open(draft);
      const before = currentOrder(DOC);
      replaceWithFresh(FRESH);
      remapAfterReplace(DOC, before, true);
      expect(useSheetStore.getState().sheet).toEqual(expected);
    });

    it(`${name}: a reload or a save with another page count closes the sheet`, () => {
      useSheetStore.getState().open(draft);
      let before = currentOrder(DOC);
      replaceWithFresh(FRESH);
      remapAfterReplace(DOC, before, false);
      expect(useSheetStore.getState().sheet).toBeNull();

      setUp(['1', '3']);
      useSheetStore.getState().open(draft);
      before = currentOrder(DOC);
      replaceWithFresh(['0', '1', '2']);
      remapAfterReplace(DOC, before, true);
      expect(useSheetStore.getState().sheet).toBeNull();
    });
  }

  it('From and Replace forget the PDF they were filled from (its id belonged to the old worker), whatever the replacement', () => {
    const from: SheetDraft = {
      kind: 'from', docId: DOC, pageIndex: 1, sourceDocId: 'src1', sourceName: 'other.pdf', sourcePages: 4, range: '2-3', position: 'after', at: 1,
    };
    for (const samePages of [true, false]) {
      setUp(['1', '3']);
      useSheetStore.getState().open(from);
      const before = currentOrder(DOC);
      replaceWithFresh(FRESH);
      remapAfterReplace(DOC, before, samePages);
      expect(useSheetStore.getState().sheet).toEqual({ ...from, sourceDocId: null, sourceName: null, sourcePages: 0, range: '' });
    }

    setUp(['1', '3']);
    useSheetStore.getState().open({ kind: 'replace', docId: DOC, uid: '1', pageNumber: 3, sourceDocId: 'src1', sourceName: 'other.pdf', sourcePages: 4, sourcePage: 3 });
    const before = currentOrder(DOC);
    replaceWithFresh(FRESH);
    remapAfterReplace(DOC, before, true);
    expect(useSheetStore.getState().sheet).toEqual({
      kind: 'replace', docId: DOC, uid: '2', pageNumber: 3, sourceDocId: null, sourceName: null, sourcePages: 0, sourcePage: 1,
    });
  });

  it('a sheet of another document is left alone, and so are the sheets that name no page by uid', () => {
    const other: SheetDraft = { kind: 'rotate', docId: 'path:C:\other.pdf', uids: ['1'], degrees: 90 };
    useSheetStore.getState().open(other);
    let before = currentOrder(DOC);
    replaceWithFresh(FRESH);
    remapAfterReplace(DOC, before, false);
    expect(useSheetStore.getState().sheet).toEqual(other);

    setUp(['1', '3']);
    const cut: SheetDraft = { kind: 'cut', docId: DOC, direction: 'vertical', percentText: '50', first: 'left', scope: 'all' };
    useSheetStore.getState().open(cut);
    before = currentOrder(DOC);
    replaceWithFresh(FRESH);
    remapAfterReplace(DOC, before, true);
    expect(useSheetStore.getState().sheet).toEqual(cut);
  });
});
