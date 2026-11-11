// @vitest-environment node
// "Which pages does Cut Pages in Half act on" (1.3.1). This family of fault got past earlier reviews, so every case that can
// change the answer is a test here: the selection against the current page, another open document with its own selection, a
// save that renumbers the pages (the uids restart at 0), Save As, a split view of one document in both panes, and sizes that
// are not measured yet. The sheet's own count and the guide on the pages read the same state (see ui/sheet/useCutState).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const applied = vi.hoisted(() => ({ calls: [] as unknown[][], result: true }));

vi.mock('../../app/services', () => ({ fileService: {}, documentRegistry: { get: () => undefined } }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(async (_docId: string, edits: unknown[]) => {
    applied.calls.push(edits);
    return applied.result;
  }),
  attachSourceLogged: vi.fn(),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { pageIdForUid } from '../../core/model/pageList';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useSheetStore, type CutDraft } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { currentOrder, remapAfterReplace } from '../documents/replacedDocument';
import { cutTargetsFor, openCutSheet } from './actions';
import { CUT_MEASURING_MESSAGE, CUT_NO_MATCH_MESSAGE, CUT_PERCENT_MESSAGE } from './cutMath';
import { applySheet } from './sheetActions';

const A = 'path:C:\\work\\A.pdf';
const B = 'path:C:\\work\\B.pdf';
const WIDE = { width: 800, height: 600, rotation: 0 };
const TALL = { width: 600, height: 800, rotation: 0 };

function pane(id: string, docId: string, uid: string) {
  return { id, docId, view: { pageId: pageIdForUid(docId, uid), zoom: 1, fit: 'width' as const, offset: 0, rotation: 0 as const } };
}

function setUids(docId: string, uids: string[]) {
  useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: { version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } }) as never);
}

function setSizes(docId: string, sizes: Array<typeof WIDE | undefined>) {
  useDocumentsStore.setState((s) => ({ docs: { ...s.docs, [docId]: { docId, name: 'x.pdf', pageCount: sizes.length, pages: [], sizes } } }) as never);
}

const select = (docId: string, uids: string[]) =>
  useSelectionStore.getState().setSelection(uids.map((u) => pageIdForUid(docId, u)), uids[0] === undefined ? null : pageIdForUid(docId, uids[0]));

const draft = (docId: string, patch: Partial<CutDraft> = {}): CutDraft => ({
  kind: 'cut', docId, direction: 'vertical', percentText: '50', first: 'left', scope: 'all', ...patch,
});

const lastEdit = () => applied.calls.at(-1)![0] as { op: string; uids: string[]; cut: string; at: number; first: string };
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  applied.calls.length = 0;
  applied.result = true;
  useUiStore.setState({ toasts: [] } as never);
  useSheetStore.getState().close();
  useWorkspaceStore.setState({
    tabs: [
      { id: 'ta', title: 'A.pdf', origin: { kind: 'path', path: A }, status: { kind: 'ready' }, panes: [pane('pa', A, '3')], split: null },
      { id: 'tb', title: 'B.pdf', origin: { kind: 'path', path: B }, status: { kind: 'ready' }, panes: [pane('pb', B, '1')], split: null },
    ],
    activeTabId: 'ta',
    activePaneId: 'pa',
  } as never);
  const six = ['0', '1', '2', '3', '4', '5'];
  setUids(A, six);
  setUids(B, six);
  setSizes(A, [WIDE, WIDE, TALL, WIDE, TALL, WIDE]);
  setSizes(B, [WIDE, WIDE, WIDE, WIDE, WIDE, WIDE]);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
});

describe('selection against the current page', () => {
  it('Current page cuts the page the page box names, with nothing selected', async () => {
    expect(await applySheet(draft(A, { scope: 'current' }))).toBe(true);
    expect(lastEdit()).toMatchObject({ op: 'slice', uids: ['3'], cut: 'vertical', at: 0.5, first: 'left' });
  });

  it('Current page ignores a selection: it is the page box, not the selection', async () => {
    select(A, ['0', '1']);
    await applySheet(draft(A, { scope: 'current' }));
    expect(lastEdit().uids).toEqual(['3']);
  });

  it('Selected pages cuts the selection, in page order, and not the current page', async () => {
    select(A, ['5', '1']);
    await applySheet(draft(A, { scope: 'selected' }));
    expect(lastEdit().uids).toEqual(['1', '5']);
  });

  it('Selected pages with nothing selected cuts nothing, says so, and sends no edit', async () => {
    expect(await applySheet(draft(A, { scope: 'selected' }))).toBe(false);
    expect(applied.calls).toEqual([]);
    expect(toasts()).toContain(CUT_NO_MATCH_MESSAGE);
  });

  it('All pages cuts every page whatever is selected', async () => {
    select(A, ['2']);
    await applySheet(draft(A, { scope: 'all' }));
    expect(lastEdit().uids).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('the sheet opens on Selected pages for two or more selected pages, else on All pages', () => {
    select(A, ['1', '2']);
    expect(openCutSheet()).toBe(true);
    expect((useSheetStore.getState().sheet as CutDraft).scope).toBe('selected');
    select(A, ['1']);
    openCutSheet();
    expect((useSheetStore.getState().sheet as CutDraft).scope).toBe('all');
    useSelectionStore.getState().setSelection([], null);
    openCutSheet();
    expect((useSheetStore.getState().sheet as CutDraft).scope).toBe('all');
  });

  it('the pages are read when Apply runs, not when the sheet opened: a selection changed in between is the one used', async () => {
    select(A, ['1', '2']);
    openCutSheet();
    const sheet = useSheetStore.getState().sheet as CutDraft;
    select(A, ['4', '5']);
    await applySheet(sheet);
    expect(lastEdit().uids).toEqual(['4', '5']);
  });

  it('Wide pages only cuts the wide pages (tall pages for a top and bottom cut) and sends top first for a horizontal cut', async () => {
    await applySheet(draft(A, { scope: 'wide' }));
    expect(lastEdit().uids).toEqual(['0', '1', '3', '5']);
    await applySheet(draft(A, { scope: 'wide', direction: 'horizontal', first: 'right' }));
    expect(lastEdit()).toMatchObject({ cut: 'horizontal', first: 'left', uids: ['2', '4'] });
  });

  it('Right page first and the position are sent as chosen', async () => {
    await applySheet(draft(A, { first: 'right', percentText: '37.5' }));
    expect(lastEdit()).toMatchObject({ first: 'right', at: 0.375 });
  });
});

describe('another document, its own selection and its own current page', () => {
  it('a selection made in A never reaches B, even when B is active and A holds a stored selection', async () => {
    select(A, ['0', '1', '2']);
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    // The tab switch drops A's selection; a late write of A's ids is put back to be sure the lookup itself refuses it.
    select(A, ['0', '1', '2']);
    expect(cutTargetsFor(B, 'selected', 'vertical').uids).toEqual([]);
    expect(await applySheet(draft(B, { scope: 'selected' }))).toBe(false);
    expect(applied.calls).toEqual([]);
  });

  it('each document is cut by its own selection and its own current page', async () => {
    select(B, ['4', '5']);
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    select(B, ['4', '5']);
    await applySheet(draft(B, { scope: 'selected' }));
    expect(lastEdit().uids).toEqual(['4', '5']);
    await applySheet(draft(B, { scope: 'current' }));
    expect(lastEdit().uids).toEqual(['1']);
    // Back on A: its current page is its own.
    useWorkspaceStore.setState({ activeTabId: 'ta', activePaneId: 'pa' } as never);
    await applySheet(draft(A, { scope: 'current' }));
    expect(lastEdit().uids).toEqual(['3']);
  });

  it('the current page is the one of the active pane of that document: a sheet for A names nothing while B is active', () => {
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    expect(cutTargetsFor(A, 'current', 'vertical').uids).toEqual([]);
  });

  it('"Wide pages" uses the sizes of the document the sheet is for', async () => {
    await applySheet(draft(B, { scope: 'wide' }));
    expect(lastEdit().uids).toEqual(['0', '1', '2', '3', '4', '5']);
  });
});

describe('after Save and Save As (the uids restart at 0)', () => {
  // The document had page 1 duplicated: uids 0, n1, 1, 2, 3, 4, 5. After the save they are 0..6, and everything that names
  // a page by uid moves by position (remapAfterReplace).
  const OLD = ['0', 'n1', '1', '2', '3', '4', '5'];
  const FRESH = ['0', '1', '2', '3', '4', '5', '6'];

  beforeEach(() => {
    setUids(A, OLD);
    setSizes(A, [WIDE, WIDE, WIDE, TALL, WIDE, TALL, WIDE]);
    useWorkspaceStore.setState((state) => ({ tabs: state.tabs.map((tab) => (tab.id === 'ta' ? { ...tab, panes: [pane('pa', A, '1')] } : tab)) }) as never);
  });

  it('after a save, the selected pages are still the same pages by position, and so is the current page', async () => {
    select(A, ['1', '2']);
    const before = currentOrder(A);
    setUids(A, FRESH);
    remapAfterReplace(A, before, true);
    await applySheet(draft(A, { scope: 'selected' }));
    expect(lastEdit().uids).toEqual(['2', '3']);
    await applySheet(draft(A, { scope: 'current' }));
    expect(lastEdit().uids).toEqual(['2']);
  });

  it('a sheet opened before the save cuts the pages by the new uids, not by the old ones it was opened with', async () => {
    select(A, ['3', '4']);
    openCutSheet();
    const sheet = useSheetStore.getState().sheet as CutDraft;
    const before = currentOrder(A);
    setUids(A, FRESH);
    remapAfterReplace(A, before, true);
    await applySheet(sheet);
    // Old uids 3 and 4 were pages 5 and 6 (positions 4 and 5); after the save they are uids 4 and 5.
    expect(lastEdit().uids).toEqual(['4', '5']);
  });

  it('after a save with nothing selected, "All pages" and "Wide pages" name the new uids', async () => {
    const before = currentOrder(A);
    setUids(A, FRESH);
    remapAfterReplace(A, before, true);
    await applySheet(draft(A, { scope: 'all' }));
    expect(lastEdit().uids).toEqual(FRESH);
  });

  it('a reload that changes the file clears the selection, so Selected pages names nothing rather than other pages', async () => {
    select(A, ['1', '2']);
    const before = currentOrder(A);
    setUids(A, ['0', '1', '2']);
    remapAfterReplace(A, before, false);
    expect(await applySheet(draft(A, { scope: 'selected' }))).toBe(false);
    expect(applied.calls).toEqual([]);
  });

  it('after Save As the document has a new id: a sheet for the old id names no page and cuts nothing', async () => {
    // The sheet closes when the active document changes (SideSheet); the engine call must not be reachable by the old id either.
    expect(cutTargetsFor('path:C:\\work\\gone.pdf', 'all', 'vertical').uids).toEqual([]);
    expect(await applySheet(draft('path:C:\\work\\gone.pdf', { scope: 'all' }))).toBe(false);
    expect(applied.calls).toEqual([]);
  });
});

describe('split view: one document in both panes', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      tabs: [{ id: 'ta', title: 'A.pdf', origin: { kind: 'path', path: A }, status: { kind: 'ready' }, panes: [pane('pa', A, '1'), pane('pa2', A, '4')], split: { orientation: 'vertical', sync: false } }],
      activeTabId: 'ta',
      activePaneId: 'pa',
    } as never);
  });

  it('Current page is the page of the pane that has the focus, and follows the focus', async () => {
    await applySheet(draft(A, { scope: 'current' }));
    expect(lastEdit().uids).toEqual(['1']);
    useWorkspaceStore.setState({ activePaneId: 'pa2' } as never);
    await applySheet(draft(A, { scope: 'current' }));
    expect(lastEdit().uids).toEqual(['4']);
  });

  it('the selection is one for the document, so both panes give the same selected pages', async () => {
    select(A, ['0', '5']);
    await applySheet(draft(A, { scope: 'selected' }));
    expect(lastEdit().uids).toEqual(['0', '5']);
    useWorkspaceStore.setState({ activePaneId: 'pa2' } as never);
    await applySheet(draft(A, { scope: 'selected' }));
    expect(lastEdit().uids).toEqual(['0', '5']);
  });
});

describe('what is refused before any edit is sent', () => {
  it('a cut position that is not a number from 30 to 70', async () => {
    for (const percentText of ['', 'x', '29', '71', '5e1']) {
      expect(await applySheet(draft(A, { percentText }))).toBe(false);
    }
    expect(applied.calls).toEqual([]);
    expect(toasts()).toContain(CUT_PERCENT_MESSAGE);
  });

  it('"Wide pages" while some pages are not measured yet: it asks to try again, and cuts nothing', async () => {
    setSizes(A, [WIDE, undefined, TALL, WIDE, TALL, WIDE]);
    expect(await applySheet(draft(A, { scope: 'wide' }))).toBe(false);
    expect(applied.calls).toEqual([]);
    expect(toasts()).toContain(CUT_MEASURING_MESSAGE);
  });

  it('no wide pages: "No pages match" and nothing is sent', async () => {
    setSizes(A, [TALL, TALL, TALL, TALL, TALL, TALL]);
    expect(await applySheet(draft(A, { scope: 'wide' }))).toBe(false);
    expect(applied.calls).toEqual([]);
    expect(toasts()).toContain(CUT_NO_MATCH_MESSAGE);
  });

  it('a failed edit leaves the sheet open', async () => {
    applied.result = false;
    useSheetStore.getState().open(draft(A));
    expect(await applySheet(draft(A))).toBe(false);
    expect(useSheetStore.getState().sheet).not.toBeNull();
  });

  it('a successful edit closes the sheet and the toast says how many pages were cut, with Undo', async () => {
    useSheetStore.getState().open(draft(A));
    expect(await applySheet(draft(A))).toBe(true);
    expect(useSheetStore.getState().sheet).toBeNull();
    const toast = useUiStore.getState().toasts.at(-1)!;
    expect(toast.message).toBe('Cut 6 pages in half');
    expect(toast.action?.label).toBe('Undo');
  });
});
