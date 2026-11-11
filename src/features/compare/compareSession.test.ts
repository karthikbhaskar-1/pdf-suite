// @vitest-environment node
// 1.3.4 Overlay to Compare, the page side, on the real stores with a fake engine document. The two families of fault that get
// past reviews are tests of their own here: "which pages does it act on" (selection against the current page, another open
// document with its own selection, after Save, after Save As, a split view) and "which file is the overlay" (the right file after
// the user changes it in the sheet, after a save swaps the worker, after Save As, when the file changes on disk).
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

import { noteAdded, resetAdded } from '../documents/addedBytes';
import { pageIdForUid } from '../../core/model/pageList';
import { sessionOf, useCompareStore } from '../../core/stores/compareStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { bitmapCache, bitmapKey, evictStaleOverlayBitmaps } from '../../engine/bitmapCache';
import { ERROR_MESSAGES, PdfOpenError } from '../../engine/errors';
import type { PageEdit } from '../../engine/mupdf/protocol';
import { currentOrder, remapAfterReplace } from '../documents/replacedDocument';
import { cancelSheet } from '../organizer/sheetActions';
import { COMPARE_GONE, COMPARE_NO_MATCH, COMPARE_DIFFERENCES_VIEW_ONLY, overlayViewFor, xfaText } from './compareMath';
import {
  applyCompare,
  changeCompare,
  chooseOpenFile,
  chooseOverlayFile,
  compareDocumentClosed,
  compareDocumentRekeyed,
  compareDocumentReplaced,
  hideSettings,
  leaveCompare,
  openFilesFor,
  pruneOverlayBitmaps,
  setComparePorts,
  showSettings,
  startCompare,
  toggleShow,
} from './compareSession';

const A = 'path:C:\\work\\A.pdf';
const B = 'path:C:\\work\\B.pdf';
const P1 = 'C:\\plans\\plan1.pdf';
const P2 = 'C:\\plans\\plan2.pdf';

interface FakeFile {
  name: string;
  pages: number;
  xfa?: boolean;
  password?: string;
  stat: { size: number; modified: number };
  /** The bytes, which name the file so the fake engine can tell which one it was given. */
  bytes: ArrayBuffer;
}

const files = new Map<string, FakeFile>();
function putFile(path: string, extra: Partial<FakeFile> = {}): FakeFile {
  const name = path.split('\\').pop()!;
  const file: FakeFile = { name, pages: 4, stat: { size: 100, modified: 1 }, bytes: new TextEncoder().encode(`%PDF-1.7 ${path}`).buffer as ArrayBuffer, ...extra };
  files.set(path, file);
  return file;
}
const pathOfBytes = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes).replace('%PDF-1.7 ', '');

/** The engine document of the fake: attach, detach and size, with a record of each call. */
class FakeDoc {
  seq = 0;
  attached: Array<{ id: string; path: string; password?: string }> = [];
  detached: string[] = [];
  gate: Promise<void> | null = null;
  attachSource = vi.fn(async (bytes: ArrayBuffer, password?: string) => {
    if (this.gate) await this.gate;
    const path = pathOfBytes(bytes);
    const file = files.get(path)!;
    if (file.password !== undefined) {
      if (password === undefined) throw new PdfOpenError('PasswordNeeded');
      if (password !== file.password) throw new PdfOpenError('WrongPassword');
    }
    this.seq += 1;
    const id = `src${this.seq}`;
    this.attached.push({ id, path, password });
    return { sourceDocId: id, pages: file.pages, xfa: { needsRendering: false, xfaPresent: file.xfa === true, fieldCount: 0 } };
  });
  detachSource = vi.fn(async (id: string) => {
    this.detached.push(id);
    return {};
  });
  sourceSize = vi.fn(async () => ({ width: 600, height: 800 }));
}

let docs: Record<string, FakeDoc>;
const logged: Array<{ docId: string; path: string; password?: string }> = [];
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const WIDE = { width: 800, height: 600, rotation: 0 };
function pane(id: string, docId: string, uid: string) {
  return { id, docId, view: { pageId: pageIdForUid(docId, uid), zoom: 1, fit: 'width' as const, offset: 0, rotation: 0 as const } };
}
function setUids(docId: string, uids: string[]) {
  useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: { version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } }) as never);
}
function setSizes(docId: string, count: number) {
  useDocumentsStore.setState((s) => ({ docs: { ...s.docs, [docId]: { docId, name: docId.split('\\').pop(), pageCount: count, pages: [], sizes: Array.from({ length: count }, () => WIDE) } } }) as never);
}
const select = (docId: string, uids: string[]) =>
  useSelectionStore.getState().setSelection(uids.map((u) => pageIdForUid(docId, u)), uids[0] === undefined ? null : pageIdForUid(docId, uids[0]));
const lastEdit = () => applied.calls.at(-1)![0] as Extract<PageEdit, { op: 'overlay' }>;

beforeEach(() => {
  applied.calls.length = 0;
  applied.result = true;
  logged.length = 0;
  files.clear();
  putFile(P1);
  putFile(P2, { pages: 2 });
  docs = { [A]: new FakeDoc(), [B]: new FakeDoc() };
  useUiStore.setState({ toasts: [] } as never);
  useSheetStore.getState().close();
  useCompareStore.getState().end();
  setComparePorts(null);
  setComparePorts({
    pick: async () => ({ path: P1, name: 'plan1.pdf' }),
    read: async (path) => (files.has(path) ? { ok: true, bytes: files.get(path)!.bytes.slice(0) } : { ok: false, reason: 'missing' }),
    stat: async (path) => files.get(path)?.stat ?? null,
    documentOf: (docId) => docs[docId] as never,
    askPassword: async () => null,
    attachLogged: async (docId, bytes, password) => {
      logged.push({ docId, path: pathOfBytes(bytes), password });
      return { sourceDocId: `logged${logged.length}`, pages: 4 };
    },
    unit: () => 'mm',
  });
  useWorkspaceStore.setState({
    tabs: [
      { id: 'ta', title: 'A.pdf', origin: { kind: 'path', path: 'C:\\work\\A.pdf' }, status: { kind: 'ready' }, panes: [pane('pa', A, '3')], split: null },
      { id: 'tb', title: 'B.pdf', origin: { kind: 'path', path: 'C:\\work\\B.pdf' }, status: { kind: 'ready' }, panes: [pane('pb', B, '1')], split: null },
    ],
    activeTabId: 'ta',
    activePaneId: 'pa',
  } as never);
  const six = ['0', '1', '2', '3', '4', '5'];
  setUids(A, six);
  setUids(B, six);
  setSizes(A, 6);
  setSizes(B, 6);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
});

/** A compare on A with plan1.pdf (4 pages) attached. */
async function compareA(): Promise<void> {
  startCompare(A);
  expect(await chooseOverlayFile(A)).toBe(true);
}

describe('which file is the overlay', () => {
  it('starts with no file: the sheet opens, nothing is attached, the pages are plain', () => {
    startCompare(A);
    expect(sessionOf(A)).toMatchObject({ phase: 'none', file: null, sourceDocId: null, look: 'both', opacity: 50, match: 'sequential', startPage: 1, dx: 0, dy: 0, size: 100, addTo: 'current', show: true });
    expect(useSheetStore.getState().sheet).toEqual({ kind: 'compare', docId: A });
    expect(overlayViewFor(sessionOf(A), 0)).toBeUndefined();
  });

  it('a chosen file is read, attached to the document, and named in the session', async () => {
    await compareA();
    expect(sessionOf(A)).toMatchObject({ phase: 'ready', file: { path: P1, name: 'plan1.pdf', pages: 4 }, sourceDocId: 'src1', attach: 1 });
    expect(docs[A]!.attached).toEqual([{ id: 'src1', path: P1, password: undefined }]);
    expect(overlayViewFor(sessionOf(A), 0)!.args.sourceDocId).toBe('src1');
  });

  it('the right file after the user changes it in the sheet: the first is detached, and Add uses the second', async () => {
    await compareA();
    expect(await chooseOpenFile(A, P2, 'plan2.pdf')).toBe(true);
    expect(sessionOf(A)).toMatchObject({ file: { path: P2, name: 'plan2.pdf', pages: 2 }, sourceDocId: 'src2', attach: 2 });
    expect(docs[A]!.detached).toEqual(['src1']);
  });

  it('Add reads the file the session names now, for the pages that have a partner in it', async () => {
    await compareA();
    await chooseOpenFile(A, P2, 'plan2.pdf');
    useCompareStore.getState().patch({ addTo: 'all' });
    expect(await applyCompare(A)).toBe(true);
    expect(logged.map((l) => l.path)).toEqual([P2]);
    expect(lastEdit().uids).toEqual(['0', '1']);
    expect(lastEdit().sourceUids).toEqual(['0', '1']);
  });

  it('the start page moves every pairing: overlay page 2 on page 1, page 3 on page 2', async () => {
    await compareA();
    useCompareStore.getState().patch({ startPage: 2, addTo: 'all' });
    await applyCompare(A);
    expect(lastEdit().uids).toEqual(['0', '1', '2']);
    expect(lastEdit().sourceUids).toEqual(['1', '2', '3']);
  });

  it('a file that fails to attach leaves the overlay that was there', async () => {
    await compareA();
    files.set(P2, { ...files.get(P2)!, bytes: new TextEncoder().encode('not a pdf at all').buffer as ArrayBuffer });
    expect(await chooseOpenFile(A, P2, 'plan2.pdf')).toBe(false);
    expect(sessionOf(A)).toMatchObject({ file: { path: P1 }, sourceDocId: 'src1', phase: 'ready', note: null });
    expect(toasts()).toContain("This isn't a PDF.");
  });

  it('a file that cannot be read says so and leaves the overlay that was there', async () => {
    await compareA();
    expect(await chooseOpenFile(A, 'C:\\plans\\gone.pdf', 'gone.pdf')).toBe(false);
    expect(sessionOf(A)).toMatchObject({ file: { path: P1 }, phase: 'ready' });
    expect(toasts().length).toBe(1);
  });

  it('an XFA form is refused with the spec text, and the overlay that was there stays', async () => {
    await compareA();
    putFile(P2, { xfa: true });
    expect(await chooseOpenFile(A, P2, 'plan2.pdf')).toBe(false);
    expect(toasts()).toContain(xfaText('plan2.pdf'));
    expect(sessionOf(A)).toMatchObject({ file: { path: P1 }, sourceDocId: 'src1' });
    // The refused attachment is released.
    expect(docs[A]!.detached).toEqual(['src2']);
  });

  it('a protected file asks for its password, says so after a wrong one, and Add uses the right one', async () => {
    putFile(P2, { password: 'sesame' });
    const answers = ['wrong', 'sesame'];
    const asked: Array<string | null> = [];
    setComparePorts({ askPassword: async (_name, error) => (asked.push(error), answers.shift() ?? null) });
    startCompare(A);
    expect(await chooseOpenFile(A, P2, 'plan2.pdf')).toBe(true);
    expect(asked).toEqual([null, ERROR_MESSAGES.WrongPassword]);
    expect(sessionOf(A)!.file!.name).toBe('plan2.pdf');
    useCompareStore.getState().patch({ addTo: 'all' });
    await applyCompare(A);
    expect(logged).toEqual([{ docId: A, path: P2, password: 'sesame' }]);
  });

  it('cancelling the password prompt keeps the overlay that was there', async () => {
    await compareA();
    putFile(P2, { password: 'sesame' });
    expect(await chooseOpenFile(A, P2, 'plan2.pdf')).toBe(false);
    expect(sessionOf(A)).toMatchObject({ file: { path: P1 }, phase: 'ready' });
  });

  it('an answer that arrives after a newer choice is dropped and released', async () => {
    startCompare(A);
    let release!: () => void;
    docs[A]!.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = chooseOpenFile(A, P1, 'plan1.pdf');
    await settle();
    // A second choice while the first still reads: it waits at the same gate, so open it after the first is let go of.
    release();
    docs[A]!.gate = null;
    await slow;
    expect(sessionOf(A)!.file!.path).toBe(P1);
    const first = sessionOf(A)!.sourceDocId;
    // Now the other way round: a first choice is held, a second goes through, and the first one then finishes.
    let release2!: () => void;
    docs[A]!.gate = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const held = chooseOpenFile(A, P1, 'plan1.pdf');
    await settle();
    docs[A]!.gate = null;
    const quick = await chooseOpenFile(A, P2, 'plan2.pdf');
    expect(quick).toBe(true);
    release2();
    expect(await held).toBe(false);
    expect(sessionOf(A)!.file!.path).toBe(P2);
    // The overlay of the dropped choice was released, and so was the one before the newest.
    expect(docs[A]!.detached.length).toBeGreaterThanOrEqual(2);
    expect(docs[A]!.detached).not.toContain(sessionOf(A)!.sourceDocId);
    expect(first).toBe('src1');
  });

  it('the files open in other tabs are offered, other than the document itself, with their unsaved state', () => {
    setUids(B, ['0']);
    useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [B]: { ...s.byDoc[B]!, history: { canUndo: true, canRedo: false, dirty: true } } } }) as never);
    expect(openFilesFor(A)).toEqual([{ docId: B, path: 'C:\\work\\B.pdf', name: 'B.pdf', unsaved: true }]);
    expect(openFilesFor(B).map((f) => f.docId)).toEqual([A]);
  });
});

describe('which pages does it act on', () => {
  beforeEach(async () => {
    await compareA();
  });

  it('Current page names the page of the page box, whatever is selected', async () => {
    select(A, ['0', '1']);
    await applyCompare(A);
    expect(lastEdit()).toMatchObject({ op: 'overlay', uids: ['3'], sourceUids: ['3'] });
  });

  it('Selected pages names the selection in page order, and not the current page', async () => {
    useCompareStore.getState().patch({ addTo: 'selected' });
    select(A, ['2', '0']);
    await applyCompare(A);
    expect(lastEdit().uids).toEqual(['0', '2']);
    expect(lastEdit().sourceUids).toEqual(['0', '2']);
  });

  it('Selected pages with nothing selected adds nothing, says so, and sends no edit', async () => {
    useCompareStore.getState().patch({ addTo: 'selected' });
    expect(await applyCompare(A)).toBe(false);
    expect(applied.calls).toEqual([]);
    expect(toasts()).toContain(COMPARE_NO_MATCH);
    expect(logged).toEqual([]);
  });

  it('All matched pages names only the pages that have an overlay page (4 pages in the overlay, 6 in the document)', async () => {
    useCompareStore.getState().patch({ addTo: 'all' });
    await applyCompare(A);
    expect(lastEdit().uids).toEqual(['0', '1', '2', '3']);
  });

  it('the pages are read when Add runs, not when the sheet opened: a selection changed in between is the one used', async () => {
    useCompareStore.getState().patch({ addTo: 'selected' });
    select(A, ['0', '1']);
    select(A, ['2', '3']);
    await applyCompare(A);
    expect(lastEdit().uids).toEqual(['2', '3']);
  });

  it('a selection made in another document never reaches this one', async () => {
    useCompareStore.getState().patch({ addTo: 'selected' });
    select(B, ['0', '1', '2']);
    expect(await applyCompare(A)).toBe(false);
    expect(applied.calls).toEqual([]);
  });

  it('while another document is active, this one has no current page: nothing is added to a page the user is not looking at', async () => {
    useWorkspaceStore.setState({ activeTabId: 'tb', activePaneId: 'pb' } as never);
    expect(await applyCompare(A)).toBe(false);
    expect(applied.calls).toEqual([]);
  });

  it('after a save the uids restart at 0: the selection and the current page are the same pages by position', async () => {
    const old = ['0', 'n1', '1', '2', '3', '4', '5'];
    setUids(A, old);
    setSizes(A, 7);
    useWorkspaceStore.setState((state) => ({ tabs: state.tabs.map((tab) => (tab.id === 'ta' ? { ...tab, panes: [pane('pa', A, '1')] } : tab)) }) as never);
    select(A, ['1', '2']);
    const before = currentOrder(A);
    setUids(A, ['0', '1', '2', '3', '4', '5', '6']);
    remapAfterReplace(A, before, true);
    useCompareStore.getState().patch({ addTo: 'selected' });
    await applyCompare(A);
    expect(lastEdit().uids).toEqual(['2', '3']);
    useCompareStore.getState().patch({ addTo: 'current' });
    await applyCompare(A);
    // The first Add ended the compare: start again on the same file.
    expect(applied.calls.length).toBe(1);
  });

  it('after Save As the old id is nothing and the new id carries the compare', async () => {
    const NEW = 'path:C:\\work\\A2.pdf';
    compareDocumentRekeyed(A, NEW);
    expect(sessionOf(A)).toBeNull();
    expect(sessionOf(NEW)).toMatchObject({ file: { path: P1 }, sourceDocId: 'src1' });
    expect(await applyCompare(A)).toBe(false);
  });

  it('split view: Current page is the page of the pane that has the focus, and follows the focus', async () => {
    useWorkspaceStore.setState({
      tabs: [{ id: 'ta', title: 'A.pdf', origin: { kind: 'path', path: 'C:\work\A.pdf' }, status: { kind: 'ready' }, panes: [pane('pa', A, '1'), pane('pa2', A, '2')], split: { orientation: 'vertical', sync: false } }],
      activeTabId: 'ta',
      activePaneId: 'pa2',
    } as never);
    await applyCompare(A);
    expect(lastEdit().uids).toEqual(['2']);
    // Adding ends the compare: start it again, with the focus on the other pane.
    await compareA();
    useWorkspaceStore.setState({ activePaneId: 'pa' } as never);
    await applyCompare(A);
    expect(lastEdit().uids).toEqual(['1']);
  });
});

describe('Add overlay to pages', () => {
  it('sends one edit with the look and placement of the sheet, then the compare ends and both attachments are released', async () => {
    await compareA();
    useCompareStore.getState().patch({ look: 'seethrough', opacity: 30, dx: 11.5, dy: -4, size: 120, addTo: 'all' });
    expect(await applyCompare(A)).toBe(true);
    expect(applied.calls.length).toBe(1);
    expect(applied.calls[0]).toHaveLength(1);
    expect(lastEdit()).toEqual({ op: 'overlay', uids: ['0', '1', '2', '3'], sourceDocId: 'logged1', sourceUids: ['0', '1', '2', '3'], dx: 11.5, dy: -4, scale: 1.2, mode: 'blend', opacity: 0.3 });
    expect(sessionOf(A)).toBeNull();
    expect(useSheetStore.getState().sheet).toBeNull();
    expect(docs[A]!.detached).toContain('src1');
    expect(toasts()).toContain('Added the overlay to 4 pages');
    expect(useUiStore.getState().toasts.at(-1)!.action?.label).toBe('Undo');
  });

  it('Both is Multiply', async () => {
    await compareA();
    await applyCompare(A);
    expect(lastEdit()).toMatchObject({ mode: 'multiply', scale: 1, dx: 0, dy: 0 });
  });

  it('Differences is for viewing only: no file is read, no edit is sent, and the compare stays', async () => {
    await compareA();
    useCompareStore.getState().patch({ look: 'differences' });
    expect(await applyCompare(A)).toBe(false);
    expect(applied.calls).toEqual([]);
    expect(logged).toEqual([]);
    expect(toasts()).toContain(COMPARE_DIFFERENCES_VIEW_ONLY);
    expect(sessionOf(A)).not.toBeNull();
  });

  it('a failed edit leaves the compare and the sheet as they were, and releases the copy made for it', async () => {
    await compareA();
    applied.result = false;
    expect(await applyCompare(A)).toBe(false);
    expect(sessionOf(A)).toMatchObject({ sourceDocId: 'src1' });
    expect(useSheetStore.getState().sheet).not.toBeNull();
    expect(docs[A]!.detached).toContain('logged1');
  });

  it('a file that changed on disk since it was shown closes the compare instead of adding a different file', async () => {
    await compareA();
    files.get(P1)!.stat = { size: 101, modified: 2 };
    expect(await applyCompare(A)).toBe(false);
    expect(applied.calls).toEqual([]);
    expect(logged).toEqual([]);
    expect(toasts()).toContain(COMPARE_GONE);
    expect(sessionOf(A)).toBeNull();
  });

  it('a file that changes while it is being read is not added: the stamp is looked at again after the read', async () => {
    await compareA();
    let stats = 0;
    setComparePorts({ stat: async (path) => (++stats >= 2 ? { size: 999, modified: 7 } : files.get(path)!.stat) });
    expect(await applyCompare(A)).toBe(false);
    expect(stats).toBe(2);
    expect(applied.calls).toEqual([]);
    expect(logged).toEqual([]);
    expect(toasts()).toContain(COMPARE_GONE);
  });

  it('the copy made for the edit is released when the compare ended while the file was being attached', async () => {
    await compareA();
    setComparePorts({
      attachLogged: async (docId, bytes) => {
        logged.push({ docId, path: pathOfBytes(bytes) });
        leaveCompare(A);
        return { sourceDocId: 'logged-late', pages: 4 };
      },
    });
    expect(await applyCompare(A)).toBe(false);
    expect(applied.calls).toEqual([]);
    expect(docs[A]!.detached).toContain('logged-late');
  });

  it('a file that is gone closes the compare with the same words', async () => {
    await compareA();
    files.delete(P1);
    expect(await applyCompare(A)).toBe(false);
    expect(toasts()).toContain(COMPARE_GONE);
    expect(sessionOf(A)).toBeNull();
  });
});

describe('S8: the overlay survives the worker swap of a save', () => {
  it('the pages are plain while the file is read again, then the overlay is attached again to the new worker', async () => {
    await compareA();
    const before = overlayViewFor(sessionOf(A), 0)!.hash;
    const fresh = new FakeDoc();
    docs[A] = fresh;
    compareDocumentReplaced(A);
    expect(sessionOf(A)).toMatchObject({ phase: 'reattaching', sourceDocId: null });
    expect(overlayViewFor(sessionOf(A), 0)).toBeUndefined();
    await settle();
    await settle();
    expect(sessionOf(A)).toMatchObject({ phase: 'ready', sourceDocId: 'src1', attach: 2, file: { path: P1 } });
    expect(fresh.attached.map((a) => a.path)).toEqual([P1]);
    // The new attachment is a new view: nothing cached for the old worker can be found for it.
    expect(overlayViewFor(sessionOf(A), 0)!.hash).not.toBe(before);
  });

  it('a protected overlay is attached again with the password kept in memory', async () => {
    putFile(P2, { password: 'sesame' });
    setComparePorts({ askPassword: async () => 'sesame' });
    startCompare(A);
    await chooseOpenFile(A, P2, 'plan2.pdf');
    const fresh = new FakeDoc();
    docs[A] = fresh;
    compareDocumentReplaced(A);
    await settle();
    await settle();
    expect(sessionOf(A)!.phase).toBe('ready');
    expect(fresh.attached[0]).toMatchObject({ path: P2, password: 'sesame' });
  });

  it('a file that changed since it was read closes the compare after the save', async () => {
    await compareA();
    files.get(P1)!.stat = { size: 5, modified: 9 };
    docs[A] = new FakeDoc();
    compareDocumentReplaced(A);
    await settle();
    await settle();
    expect(sessionOf(A)).toBeNull();
    expect(toasts()).toContain(COMPARE_GONE);
  });

  it('a file that is gone closes the compare after the save', async () => {
    await compareA();
    files.delete(P1);
    docs[A] = new FakeDoc();
    compareDocumentReplaced(A);
    await settle();
    await settle();
    expect(sessionOf(A)).toBeNull();
    expect(toasts()).toContain(COMPARE_GONE);
  });

  it('Save As: the compare, the password and the file stamp follow the new id, and the overlay is attached to the saved document', async () => {
    putFile(P2, { password: 'sesame' });
    setComparePorts({ askPassword: async () => 'sesame' });
    startCompare(A);
    await chooseOpenFile(A, P2, 'plan2.pdf');
    // Save As: the worker is replaced first, and then the document is re-keyed.
    const NEW = 'path:C:\\work\\A2.pdf';
    const fresh = new FakeDoc();
    docs[A] = fresh;
    docs[NEW] = fresh;
    compareDocumentReplaced(A);
    compareDocumentRekeyed(A, NEW);
    await settle();
    await settle();
    expect(sessionOf(NEW)).toMatchObject({ phase: 'ready', sourceDocId: 'src1', file: { path: P2 } });
    expect(fresh.attached[0]).toMatchObject({ path: P2, password: 'sesame' });
    // The new id can Add, with the same file and password.
    setUids(NEW, ['0', '1', '2']);
    useCompareStore.getState().patch({ addTo: 'all' });
    expect(await applyCompare(NEW)).toBe(true);
    expect(logged).toEqual([{ docId: NEW, path: P2, password: 'sesame' }]);
  });

  it('a change made while the file is read again is dropped: leaving during the read ends it', async () => {
    await compareA();
    const fresh = new FakeDoc();
    docs[A] = fresh;
    compareDocumentReplaced(A);
    leaveCompare(A);
    await settle();
    await settle();
    expect(sessionOf(A)).toBeNull();
    expect(fresh.attached.length === 0 || fresh.detached.length === fresh.attached.length).toBe(true);
  });
});

describe('leaving, closing, and one compare at a time', () => {
  it('leaving detaches the overlay, ends the session, closes the sheet and leaves the document alone', async () => {
    await compareA();
    leaveCompare(A);
    expect(sessionOf(A)).toBeNull();
    expect(docs[A]!.detached).toEqual(['src1']);
    expect(useSheetStore.getState().sheet).toBeNull();
    expect(applied.calls).toEqual([]);
  });

  it('closing the document ends the compare without touching the worker, which is gone', async () => {
    await compareA();
    compareDocumentClosed(A);
    expect(sessionOf(A)).toBeNull();
    expect(docs[A]!.detached).toEqual([]);
  });

  it('starting a compare on another document ends the first', async () => {
    await compareA();
    startCompare(B);
    expect(sessionOf(A)).toBeNull();
    expect(sessionOf(B)).not.toBeNull();
    expect(docs[A]!.detached).toEqual(['src1']);
  });

  it('starting again on the same document brings the sheet back and keeps the compare', async () => {
    await compareA();
    hideSettings();
    startCompare(A);
    expect(useSheetStore.getState().sheet).toEqual({ kind: 'compare', docId: A });
    expect(sessionOf(A)!.file!.path).toBe(P1);
  });

  it('[»] hides the sheet and keeps comparing, Show settings brings it back, and Cancel (the x and Esc) leaves', async () => {
    await compareA();
    hideSettings();
    expect(useSheetStore.getState().sheet).toBeNull();
    expect(sessionOf(A)).not.toBeNull();
    showSettings(A);
    expect(useSheetStore.getState().sheet?.kind).toBe('compare');
    cancelSheet();
    expect(sessionOf(A)).toBeNull();
    expect(useSheetStore.getState().sheet).toBeNull();
  });

  it('F8 shows and hides the overlay without detaching it', async () => {
    await compareA();
    toggleShow(A);
    expect(sessionOf(A)).toMatchObject({ show: false, sourceDocId: 'src1' });
    expect(overlayViewFor(sessionOf(A), 0)).toBeUndefined();
    toggleShow(A);
    expect(overlayViewFor(sessionOf(A), 0)).toBeDefined();
    expect(docs[A]!.detached).toEqual([]);
  });
});

describe('the bitmaps of the Compare view stay out of the way', () => {
  const fake = () => ({ width: 10, height: 10, close: vi.fn() }) as unknown as ImageBitmap;
  const put = (id: string, content = '0@0') => {
    const bitmap = fake();
    bitmapCache.set(bitmapKey(id, 0, 1, 0, content), bitmap, 400);
    return bitmap;
  };

  beforeEach(() => {
    bitmapCache.deleteWhere(() => true);
  });

  it('a change of look closes the bitmaps of the looks that are gone, and keeps the plain page and the look on screen', async () => {
    await compareA();
    const view = overlayViewFor(sessionOf(A), 0)!;
    const plain = put(A);
    const current = put(`${A}#ov:${view.hash}`);
    const old = put(`${A}#ov:0.multiply.-.0.000.0.000.1.000.0`);
    pruneOverlayBitmaps(sessionOf(A)!);
    expect(old.close).toHaveBeenCalled();
    expect(plain.close).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    changeCompare({ dx: 5 });
    expect(current.close).toHaveBeenCalled();
    expect(plain.close).not.toHaveBeenCalled();
  });

  it('leaving closes every overlay bitmap of the document and none of another document', async () => {
    await compareA();
    const mine = put(`${A}#ov:1.x`);
    const other = put(`${B}#ov:1.x`);
    const plain = put(A);
    leaveCompare(A);
    expect(mine.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
    expect(plain.close).not.toHaveBeenCalled();
  });

  it('a page whose content is gone loses its overlay bitmaps, and the plain eviction does not touch overlay ones', () => {
    const gone = put(`${A}#ov:1.x`, '5@3');
    const kept = put(`${A}#ov:1.x`, '1@0');
    evictStaleOverlayBitmaps(A, new Set(['1@0']));
    expect(gone.close).toHaveBeenCalled();
    expect(kept.close).not.toHaveBeenCalled();
  });
});

// 1.5.10 file-size limits: an overlay file that would take the document past 500 MB is refused BEFORE it is read, in the choosing and
// again in Add (the estimate is the document's saved size plus the file's size). Nothing is read, attached or changed.
describe('the size limit of an overlay file', () => {
  const MB = 1024 * 1024;
  const sized = (path: string, size: number) => files.set(path, { ...files.get(path)!, stat: { size, modified: 1 } });
  const savedSize = (bytes: number) =>
    useDocumentsStore.setState((s) => ({ docs: { ...s.docs, [A]: { ...s.docs[A]!, byteSize: bytes } } }) as never);

  it('a file over 500 MB is refused when chosen: it is not read or attached, and the overlay that was there stays', async () => {
    await compareA();
    const read = vi.fn(async (path: string) => ({ ok: true as const, bytes: files.get(path)!.bytes.slice(0) }));
    setComparePorts({ read });
    sized(P2, 500 * MB + 1);
    expect(await chooseOpenFile(A, P2, 'plan2.pdf')).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(docs[A]!.attached.map((a) => a.path)).toEqual([P1]);
    expect(toasts().at(-1)).toMatch(/too large to add \(the limit is 500 MB\)/);
    expect(sessionOf(A)).toMatchObject({ file: { path: P1 } });
  });

  it('a file that fits alone but not with the document is refused with both sizes (document 300 MB + file 201 MB)', async () => {
    savedSize(300 * MB);
    startCompare(A);
    sized(P1, 201 * MB);
    expect(await chooseOverlayFile(A)).toBe(false);
    expect(docs[A]!.attached).toEqual([]);
    expect(toasts().at(-1)).toMatch(/over the 500 MB limit \(the document is about 300 MB and the PDF is 201 MB\)\. Nothing was changed\./);
  });

  it('just under: document 300 MB + file 200 MB is chosen, attached, and added', async () => {
    savedSize(300 * MB);
    startCompare(A);
    sized(P1, 200 * MB);
    expect(await chooseOverlayFile(A)).toBe(true);
    expect(docs[A]!.attached).toHaveLength(1);
    expect(await applyCompare(A)).toBe(true);
    expect(logged).toHaveLength(1);
  });

  it('with no size from the stat, the bytes that were read decide (as Insert from PDF does), and nothing is attached', async () => {
    startCompare(A);
    const huge = Object.create(ArrayBuffer.prototype, { byteLength: { value: 500 * MB + 1 } }) as ArrayBuffer;
    setComparePorts({ stat: async () => null, read: async () => ({ ok: true as const, bytes: huge }) });
    expect(await chooseOverlayFile(A)).toBe(false);
    expect(docs[A]!.attached).toEqual([]);
    expect(toasts().at(-1)).toMatch(/too large to add/);
  });

  it('the sources already attached to the document count: 300 MB saved + 150 MB attached + a 100 MB overlay file is refused', async () => {
    savedSize(300 * MB);
    noteAdded(A, 150 * MB);
    try {
      startCompare(A);
      sized(P1, 100 * MB);
      expect(await chooseOverlayFile(A)).toBe(false);
      expect(docs[A]!.attached).toEqual([]);
      expect(toasts().at(-1)).toMatch(/over the 500 MB limit \(the document is about 450 MB and the PDF is 100 MB\)/);
    } finally {
      resetAdded(A);
    }
  });

  it('Add checks the estimate again before it reads the file again (the document grew since the file was chosen)', async () => {
    await compareA();
    const read = vi.fn(async (path: string) => ({ ok: true as const, bytes: files.get(path)!.bytes.slice(0) }));
    setComparePorts({ read });
    savedSize(500 * MB);
    expect(await applyCompare(A)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
    expect(applied.calls).toEqual([]);
    expect(toasts().at(-1)).toMatch(/over the 500 MB limit/);
    expect(sessionOf(A)).not.toBeNull();
  });
});
