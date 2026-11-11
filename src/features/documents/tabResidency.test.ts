// @vitest-environment node
// Background tabs release memory (1.5.4): which documents the sweep lets go, and what a reopen does (page and zoom kept, the
// file's stamp checked, "changed on disk" shown instead of taking the new file over silently).
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handle = { doc: { isEncrypted: boolean; pageCount: number }; pageCount: number };

const fake = vi.hoisted(() => {
  const suspended = new Set<string>();
  const live = new Map<string, { doc: { isEncrypted: boolean; pageCount: number }; pageCount: number }>();
  return {
    suspended,
    live,
    registry: {
      get: vi.fn((id: string) => (suspended.has(id) ? undefined : live.get(id))),
      suspend: vi.fn((id: string) => {
        if (!live.has(id) || suspended.has(id)) return false;
        suspended.add(id);
        return true;
      }),
      isSuspended: vi.fn((id: string) => suspended.has(id)),
      resume: vi.fn(async (id: string, _source?: unknown, _options?: unknown): Promise<unknown> => {
        suspended.delete(id);
        return live.get(id)!;
      }),
    },
    stamps: new Map<string, { size: number; modified: number; sample?: string }>(),
    acknowledged: new Map<string, { size: number; modified: number; sample?: string }>(),
    recorded: [] as Array<[string, unknown]>,
    now: { value: null as { size: number; modified: number; sample?: string } | null },
    busy: new Set<string>(),
    logged: new Set<string>(),
    password: new Map<string, string>(),
  };
});

vi.mock('../../app/services', () => ({ documentRegistry: fake.registry, fileService: {} }));
vi.mock('./saveDocument', () => ({
  currentIdOf: (id: string) => id,
  fileStampOf: (path: string) => fake.stamps.get(path),
  seenStampOf: (path: string) => fake.acknowledged.get(path) ?? fake.stamps.get(path),
  recordFileStamp: (path: string, stamp: unknown) => {
    fake.recorded.push([path, stamp]);
  },
  savePathOf: (id: string) => (id.startsWith('path:') ? id.slice(5) : null),
  statFile: vi.fn(async () => fake.now.value),
  watchDocumentFile: vi.fn(),
}));
vi.mock('./editOps', () => ({ isEditBusy: (id: string) => fake.busy.has(id), hasEditLog: (id: string) => fake.logged.has(id) }));
vi.mock('./sessionPasswords', () => ({ sessionPasswordOf: (id: string) => fake.password.get(id) }));

import { pageIdForUid } from '../../core/model/pageList';
import { useCompareStore } from '../../core/stores/compareStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useJobStore } from '../../core/stores/jobStore';
import { useUiStore } from '../../core/stores/uiStore';
import { ERROR_MESSAGES, PdfOpenError } from '../../engine/errors';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { bitmapCache } from '../../engine/bitmapCache';
import { useSearchStore } from '../search/searchStore';
import { statFile, watchDocumentFile } from './saveDocument';
import { BACKGROUND_IDLE_MS } from './residencyRule';
import { CHANGED_NOTICE, REOPEN_TIMEOUT_MS, STAT_TIMEOUT_MS, residencyOf, resetResidency, startTabResidency, sweepBackground, useResidencyStore, wakeDocument } from './tabResidency';

const A = 'path:C:\\docs\\a.pdf';
const B = 'path:C:\\docs\\b.pdf';
const STAMP = { size: 1000, modified: 5 };
const T0 = 1_000_000;
const LATER = T0 + BACKGROUND_IDLE_MS + 1;

function view(docId: string, uid: string, zoom = 1) {
  return { pageId: pageIdForUid(docId, uid), zoom, fit: 'none' as const, offset: 0.25, rotation: 0 as const };
}

function tab(id: string, docIds: string[], views: Record<string, ReturnType<typeof view>> = {}) {
  return {
    id,
    title: `${id}.pdf`,
    origin: { kind: 'path' as const, path: docIds[0]!.slice(5) },
    status: { kind: 'ready' as const },
    panes: docIds.map((docId, i) => ({ id: `${id}-p${i}`, docId, view: views[docId] ?? view(docId, '0') })),
    split: docIds.length > 1 ? { orientation: 'vertical' as const, ratio: 0.5, syncScroll: false } : null,
  };
}

function addDoc(docId: string, pageCount = 5) {
  const uids = Array.from({ length: pageCount }, (_, i) => String(i));
  fake.live.set(docId, { doc: { isEncrypted: false, pageCount }, pageCount });
  useDocumentsStore.getState().putDoc({
    docId,
    name: docId.split('\\').pop()!,
    pageCount,
    pages: uids.map((uid, i) => ({ id: pageIdForUid(docId, uid), docId, srcIndex: i, rotation: 0, crop: null })),
    sizes: uids.map(() => ({ width: 612, height: 792, rotation: 0 })),
  });
  useEditStore.setState((s) => ({
    byDoc: {
      ...s.byDoc,
      [docId]: { version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } },
    },
  }));
}

function setUp(active: string, tabs: Array<ReturnType<typeof tab>>) {
  useWorkspaceStore.setState({ tabs, activeTabId: active, activePaneId: tabs.find((t) => t.id === active)?.panes[0]?.id ?? null } as never);
}

const bitmap = () => ({ close: vi.fn(), width: 10, height: 10 }) as never;
const pageKey = (docId: string) => `${docId}|0|1.000|0|0@0@1`;
const thumbKey = (docId: string) => `thumb|${docId}|0|0|120|0.2000|0@0@1`;

function markHistory(docId: string, patch: Partial<{ dirty: boolean; canUndo: boolean; canRedo: boolean }>) {
  useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: { ...s.byDoc[docId]!, history: { ...s.byDoc[docId]!.history, ...patch } } } }));
}

beforeEach(() => {
  resetResidency();
  fake.suspended.clear();
  fake.live.clear();
  fake.stamps.clear();
  fake.acknowledged.clear();
  fake.recorded.length = 0;
  fake.stamps.set('C:\\docs\\a.pdf', STAMP);
  fake.stamps.set('C:\\docs\\b.pdf', STAMP);
  fake.now.value = STAMP;
  fake.busy.clear();
  fake.logged.clear();
  fake.password.clear();
  fake.registry.suspend.mockClear();
  fake.registry.resume.mockClear();
  vi.mocked(watchDocumentFile).mockClear();
  vi.mocked(statFile).mockClear();
  useDocumentsStore.setState({ docs: {} });
  useEditStore.setState({ byDoc: {}, saving: {}, progress: {}, changedOnDisk: {}, recovered: {}, notRestored: {}, recoveryNotice: {}, unresponsive: {}, selected: {} });
  useJobStore.setState({ job: null });
  useUiStore.setState({ toasts: [] });
  useCompareStore.setState({ session: null });
  useSheetStore.setState({ sheet: null });
  useSearchStore.setState({ docId: null, running: false });
  bitmapCache.deleteWhere(() => true);
  addDoc(A);
  addDoc(B);
});

describe('which documents the sweep lets go', () => {
  it('a document not shown for more than 60 s, with nothing unsaved and nothing running, loses its worker; the shown one keeps it', async () => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    const done = await sweepBackground(LATER);
    expect(done.workers).toEqual([B]);
    expect(fake.registry.suspend).toHaveBeenCalledWith(B);
    expect(fake.registry.suspend).not.toHaveBeenCalledWith(A);
    expect(useResidencyStore.getState().state).toEqual({ [B]: 'released' });
  });

  it('nothing is released before the 60 s have passed', async () => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    const done = await sweepBackground(T0 + BACKGROUND_IDLE_MS);
    expect(done).toEqual({ bitmaps: [], workers: [] });
    expect(fake.registry.suspend).not.toHaveBeenCalled();
  });

  it('a document shown in EITHER pane of the active split tab is never released', async () => {
    setUp('ts', [tab('ts', [A, B])]);
    await sweepBackground(T0);
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: [], workers: [] });
    expect(residencyOf(A, LATER)).toBe('keep');
    expect(residencyOf(B, LATER)).toBe('keep');
  });

  it('a document of a background split tab is released only when BOTH of its documents are idle, each on its own', async () => {
    setUp('ta', [tab('ta', [A]), tab('ts', [B, A])]);
    await sweepBackground(T0);
    const done = await sweepBackground(LATER);
    // A is shown by the active tab; B (in the split tab, not shown) is idle.
    expect(done.workers).toEqual([B]);
  });

  it('a document that a background tab shares with the active tab (a second tab on one file) stays', async () => {
    setUp('ta', [tab('ta', [A]), tab('ta2', [A])]);
    await sweepBackground(T0);
    const done = await sweepBackground(LATER);
    expect(done.workers).toEqual([]);
  });

  it('the time restarts when a document is shown again', async () => {
    setUp('tb', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    useWorkspaceStore.getState().setActiveTab('ta');
    await sweepBackground(T0 + 50_000);
    useWorkspaceStore.getState().setActiveTab('tb');
    const done = await sweepBackground(T0 + 80_000);
    expect(done.workers).toEqual([]);
  });

  it('the 60 s count from the moment the document was hidden, not from the sweep before it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
      const stop = startTabResidency();
      vi.setSystemTime(T0 + 8_000);
      useWorkspaceStore.getState().setActiveTab('tb'); // A is hidden now, 8 s after the last look
      expect((await sweepBackground(T0 + 8_000 + BACKGROUND_IDLE_MS - 1_000)).workers).toEqual([]);
      expect((await sweepBackground(T0 + 8_000 + BACKGROUND_IDLE_MS + 1_000)).workers).toEqual([A]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['an edit is running', () => fake.busy.add(B)],
    ['a save is running', () => useEditStore.setState({ saving: { [B]: true } })],
    ['a long operation shows progress', () => useEditStore.setState({ progress: { [B]: { label: 'Delete', done: 1, total: 9 } } })],
    ['a job (Split or Combine) is running', () => useJobStore.setState({ job: { kind: 'split', phase: 'reading', done: 0, total: 1, unit: 'files', cancelling: false } })],
    ['a search is running on it', () => useSearchStore.setState({ docId: B, running: true })],
    ['a Compare session is on it', () => useCompareStore.getState().begin(B, 'in')],
    ['a side sheet is open on it', () => useSheetStore.setState({ sheet: { kind: 'rotate', docId: B, uids: ['0'] } as never })],
  ])('keeps everything of a document while %s', async (_name, start) => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    bitmapCache.set(pageKey(B), bitmap(), 400);
    start();
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: [], workers: [] });
    expect(residencyOf(B, LATER)).toBe('keep');
    expect(bitmapCache.has(pageKey(B))).toBe(true);
  });

  it.each([
    ['it has unsaved edits', () => markHistory(B, { dirty: true, canUndo: true })],
    ['redo steps are left (undone back to the saved state)', () => markHistory(B, { canRedo: true })],
    ['it has an edit journal', () => fake.logged.add(B)],
  ])('releases only the bitmaps, never the worker, when %s', async (_name, edit) => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    edit();
    bitmapCache.set(pageKey(B), bitmap(), 400);
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: [B], workers: [] });
    expect(fake.registry.suspend).not.toHaveBeenCalled();
    expect(bitmapCache.has(pageKey(B))).toBe(false);
  });

  it("releases the bitmaps and thumbnails of the document it lets go, and no other document's", async () => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    bitmapCache.set(pageKey(B), bitmap(), 400);
    bitmapCache.set(thumbKey(B), bitmap(), 400);
    bitmapCache.set(pageKey(A), bitmap(), 400);
    await sweepBackground(LATER);
    expect(bitmapCache.has(pageKey(B))).toBe(false);
    expect(bitmapCache.has(thumbKey(B))).toBe(false);
    expect(bitmapCache.has(pageKey(A))).toBe(true);
  });

  it.each([
    ['its file is gone', () => (fake.now.value = null)],
    ['its file changed on disk', () => (fake.now.value = { size: 2000, modified: 9 })],
  ])('keeps the worker when %s (the engine may hold the only copy)', async (_name, change) => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    change();
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: [B], workers: [] });
    expect(fake.registry.suspend).not.toHaveBeenCalled();
  });

  it('keeps the worker when the app holds no stamp of the file (nothing to prove it is unchanged)', async () => {
    fake.stamps.delete('C:\\docs\\b.pdf');
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: [B], workers: [] });
  });

  it('keeps the worker after "Keep my version": the stamp the app accepted is not the one the file had when it was opened', async () => {
    fake.acknowledged.set('C:\\docs\\b.pdf', { size: 5555, modified: 77 });
    fake.now.value = { size: 5555, modified: 77 };
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: [B], workers: [] });
  });

  it('keeps the worker when only the content sample of the file differs', async () => {
    fake.stamps.set('C:\\docs\\b.pdf', { ...STAMP, sample: 'aaa' });
    fake.now.value = { ...STAMP, sample: 'bbb' };
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    expect((await sweepBackground(LATER)).workers).toEqual([]);
  });

  it('keeps the worker of a document whose page list is not 0, 1, 2 ... in order', async () => {
    useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [B]: { ...s.byDoc[B]!, uids: ['0', '2', '1', '3', '4'] } } }));
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    expect((await sweepBackground(LATER)).workers).toEqual([]);
  });

  it('a stat that never answers keeps the worker and does not hold the sweep', async () => {
    vi.useFakeTimers();
    try {
      setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
      await sweepBackground(T0);
      vi.mocked(statFile).mockImplementationOnce(() => new Promise(() => undefined));
      const sweeping = sweepBackground(LATER);
      await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS + 1);
      expect(await sweeping).toEqual({ bitmaps: [B], workers: [] });
      // The next sweep runs (the lock was let go) and ends the worker.
      expect((await sweepBackground(LATER + 1)).workers).toEqual([B]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the worker of a document that came from bytes (there is no file to reopen from)', async () => {
    addDoc('hash123');
    setUp('ta', [tab('ta', [A]), tab('tb', ['hash123'])]);
    await sweepBackground(T0);
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: ['hash123'], workers: [] });
  });

  it('keeps the worker of an encrypted file whose password is not in memory; with the password it is released', async () => {
    fake.live.get(B)!.doc.isEncrypted = true;
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    expect((await sweepBackground(LATER)).workers).toEqual([]);
    fake.password.set(B, 'secret');
    expect((await sweepBackground(LATER + 1)).workers).toEqual([B]);
  });

  it.each([
    ['it shows the "changed on disk" bar', () => useEditStore.setState({ changedOnDisk: { [B]: true } })],
    ['recovered edits wait for Keep or Discard', () => useEditStore.setState({ recovered: { [B]: { edits: 2 } } })],
    ['an earlier session\'s edits were not restored', () => useEditStore.setState({ notRestored: { [B]: 'file-changed' } })],
    ['its engine stopped answering', () => useEditStore.setState({ unresponsive: { [B]: true } })],
    [
      'its page sizes are not all measured yet',
      () => {
        const info = useDocumentsStore.getState().docs[B]!;
        useDocumentsStore.getState().putDoc({ ...info, sizes: info.sizes.map((size, i) => (i === 2 ? undefined : size)) });
      },
    ],
  ])('releases only the bitmaps when %s', async (_name, change) => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    change();
    const done = await sweepBackground(LATER);
    expect(done).toEqual({ bitmaps: [B], workers: [] });
    expect(fake.registry.suspend).not.toHaveBeenCalled();
  });

  it('a document that is already released is not looked at again', async () => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    await sweepBackground(LATER);
    fake.registry.suspend.mockClear();
    const done = await sweepBackground(LATER + 20_000);
    expect(done).toEqual({ bitmaps: [], workers: [] });
  });
});

describe('opening a released document again', () => {
  async function release(): Promise<void> {
    setUp('ta', [tab('ta', [A]), tab('tb', [B], { [B]: view(B, '3', 2.5) })]);
    await sweepBackground(T0);
    await sweepBackground(LATER);
    expect(fake.suspended.has(B)).toBe(true);
  }

  it('reopens from the saved file under the same id, and the pane keeps its page, zoom, fit and place in the page', async () => {
    await release();
    useWorkspaceStore.getState().setActiveTab('tb');
    await wakeDocument(B);
    expect(fake.registry.resume).toHaveBeenCalledTimes(1);
    expect(fake.registry.resume.mock.calls[0]![0]).toBe(B);
    expect(fake.registry.resume.mock.calls[0]![1]).toEqual({ kind: 'path', path: 'C:\\docs\\b.pdf', name: 'b.pdf' });
    const pane = useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.panes[0]!;
    expect(pane.view).toEqual(view(B, '3', 2.5));
    expect(useResidencyStore.getState().state).toEqual({});
    expect(useEditStore.getState().changedOnDisk[B]).toBeUndefined();
    expect(vi.mocked(watchDocumentFile)).toHaveBeenCalledWith(B, 'C:\\docs\\b.pdf');
  });

  it("the organizer selection of the document comes back with it (the reopen clears a document's edit state)", async () => {
    setUp('ta', [tab('ta', [A]), tab('tb', [B])]);
    await sweepBackground(T0);
    useEditStore.getState().select(B, ['1', '2']);
    await sweepBackground(LATER);
    useEditStore.getState().clear(B);
    useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [B]: { version: 1, uids: ['0', '1', '2', '3', '4'], revs: [0, 0, 0, 0, 0], sizes: null, history: { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } } } }));
    await wakeDocument(B);
    expect(useEditStore.getState().selected[B]).toEqual(['1', '2']);
  });

  it('the stamp is read before the file is opened, and compared with the one the app last saw', async () => {
    await release();
    const order: string[] = [];
    vi.mocked(statFile).mockImplementationOnce(async () => {
      order.push('stat');
      return fake.now.value;
    });
    fake.registry.resume.mockImplementationOnce(async (id: string) => {
      order.push('open');
      fake.suspended.delete(id);
      return fake.live.get(id)!;
    });
    await wakeDocument(B);
    expect(order).toEqual(['stat', 'open']);
  });

  it('a file that changed on disk while released: it is opened as it is NOW with a plain notice, no Reload / Keep bar; its stamp becomes the recovery base', async () => {
    await release();
    fake.now.value = { size: 4000, modified: 99 };
    await wakeDocument(B);
    expect(fake.registry.resume).toHaveBeenCalledTimes(1);
    expect(useEditStore.getState().changedOnDisk[B]).toBeUndefined();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([CHANGED_NOTICE]);
    expect(CHANGED_NOTICE).toBe('This file changed while the tab was in the background, so it was reopened as it is now.');
    // There is no other version to keep: the stamp the reopen read is what the save, the disk watch and the recovery log compare with.
    expect(fake.recorded).toEqual([['C:\\docs\\b.pdf', { size: 4000, modified: 99 }]]);
    expect(vi.mocked(watchDocumentFile)).toHaveBeenCalled();
  });

  it('a file whose content sample differs although its size and time are the same counts as changed', async () => {
    fake.stamps.set('C:\\docs\\b.pdf', { ...STAMP, sample: 'aaa' });
    fake.now.value = { ...STAMP, sample: 'aaa' };
    await release();
    fake.now.value = { ...STAMP, sample: 'bbb' };
    await wakeDocument(B);
    expect(fake.recorded).toHaveLength(1);
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });

  it('an unchanged file shows no notice and records no stamp', async () => {
    await release();
    await wakeDocument(B);
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(fake.recorded).toEqual([]);
  });

  it('a changed file with fewer pages: the pane moves to the nearest page that exists instead of showing a page that is gone', async () => {
    await release();
    fake.now.value = { size: 4000, modified: 99 };
    fake.registry.resume.mockImplementationOnce(async (id: string) => {
      fake.suspended.delete(id);
      // What the engine reports for the new file: two pages. (In the app the registry's opened hook and the page-list
      // listener set these; here the stores are set by hand.)
      useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [id]: { ...s.byDoc[id]!, uids: ['0', '1'], revs: [0, 0] } } }));
      useDocumentsStore.getState().setPages(id, ['0', '1'].map((uid, i) => ({ id: pageIdForUid(id, uid), docId: id, srcIndex: i, rotation: 0, crop: null })));
      return { doc: { isEncrypted: false, pageCount: 2 }, pageCount: 2 };
    });
    await wakeDocument(B);
    const pane = useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.panes[0]!;
    expect(pane.view.pageId).toBe(pageIdForUid(B, '1'));
    expect(pane.view.zoom).toBe(2.5);
  });

  it('a file that was deleted while released: the tab shows the same message as opening a file that is gone, not a raw error', async () => {
    await release();
    fake.registry.resume.mockRejectedValueOnce(new PdfOpenError('Missing'));
    await expect(wakeDocument(B)).rejects.toThrow();
    expect(useResidencyStore.getState().state).toEqual({});
    expect(useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.status).toEqual({ kind: 'error', message: ERROR_MESSAGES.Missing });
  });

  it('any other failure gives a plain message', async () => {
    await release();
    fake.registry.resume.mockRejectedValueOnce(new Error('worker exploded at 0x1234'));
    await expect(wakeDocument(B)).rejects.toThrow();
    expect(useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.status).toEqual({ kind: 'error', message: 'This file could not be opened.' });
  });

  it('a failed reopen is not tried again on every change of the workspace (no loop), only after another tab was shown; a later success clears the error', async () => {
    await release();
    const stop = startTabResidency();
    try {
      fake.registry.resume.mockRejectedValueOnce(new PdfOpenError('Missing'));
      useWorkspaceStore.getState().setActiveTab('tb'); // wakes it: fails, and patches the tab to the error
      await vi.waitFor(() => expect(useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.status.kind).toBe('error'));
      await Promise.resolve();
      useWorkspaceStore.getState().setView('tb-p0', { zoom: 3 });
      useWorkspaceStore.getState().setView('tb-p0', { zoom: 3.5 });
      await new Promise((r) => setTimeout(r, 10));
      expect(fake.registry.resume).toHaveBeenCalledTimes(1);
      // The file is back; the tab is shown again after another one.
      useWorkspaceStore.getState().setActiveTab('ta');
      useWorkspaceStore.getState().setActiveTab('tb');
      await vi.waitFor(() => expect(useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.status).toEqual({ kind: 'ready' }));
      expect(fake.registry.resume).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('a reopen that takes longer than 60 s gives a plain error, frees the reopen, and the tab is put right if the engine arrives later', async () => {
    await release();
    vi.useFakeTimers();
    try {
      let arrive: () => void = () => undefined;
      fake.registry.resume.mockImplementationOnce(
        (id: string) =>
          new Promise((resolve) => {
            arrive = () => {
              fake.suspended.delete(id);
              resolve(fake.live.get(id)!);
            };
          }),
      );
      const reopening = wakeDocument(B);
      const outcome = expect(reopening).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(REOPEN_TIMEOUT_MS + 1);
      await outcome;
      expect(useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.status).toEqual({ kind: 'error', message: ERROR_MESSAGES.Unreadable });
      expect(useResidencyStore.getState().state).toEqual({});
      arrive();
      await vi.advanceTimersByTimeAsync(0);
      expect(useWorkspaceStore.getState().tabs.find((t) => t.id === 'tb')!.status).toEqual({ kind: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('two callers at once share one reopen, and a document that is not released is left alone', async () => {
    await release();
    await Promise.all([wakeDocument(B), wakeDocument(B)]);
    expect(fake.registry.resume).toHaveBeenCalledTimes(1);
    await wakeDocument(A);
    expect(fake.registry.resume).toHaveBeenCalledTimes(1);
  });

  it('while it is being reopened the document shows as waking, then clears', async () => {
    await release();
    let finish: () => void = () => undefined;
    fake.registry.resume.mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          finish = () => {
            fake.suspended.delete(id);
            resolve(fake.live.get(id)! as Handle);
          };
        }),
    );
    const reopening = wakeDocument(B);
    await vi.waitFor(() => expect(useResidencyStore.getState().state[B]).toBe('waking'));
    finish();
    await reopening;
    expect(useResidencyStore.getState().state[B]).toBeUndefined();
  });
});
