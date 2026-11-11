// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeMupdf, openMupdfMock, registry, bridge, watchOptions } = vi.hoisted(() => {
  class FakeMupdf {
    version = 0;
    save = vi.fn(async (_same: boolean, _unchanged: boolean, _drop?: boolean) => ({ bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] }));
    applyEdits = vi.fn(async () => ({ version: 1, history: {}, changed: true, uidSeed: 0 }));
    onProgress = vi.fn(() => () => undefined);
    undo = vi.fn(async () => ({}));
    extract = vi.fn(async (_uids: string[], _options?: unknown) => new ArrayBuffer(4));
    fingerprints = vi.fn(async () => [1]);
    destroy = vi.fn(async () => undefined);
  }
  const fresh = new FakeMupdf();
  const entries = new Map<string, { docId: string; doc: FakeMupdf; pageCount: number }>();
  return {
    FakeMupdf,
    openMupdfMock: vi.fn(async () => ({ document: () => fresh, discard: () => undefined, xfa: {}, bytes: new ArrayBuffer(0) })),
    registry: {
      entries,
      get: vi.fn((docId: string) => entries.get(docId)),
      replaceDocument: vi.fn(() => true),
      // Spellings of one path are joined by the real registry; the tests here open one spelling.
      sameFileId: (id: string) => id,
      isSuspended: () => false,
      rekey: vi.fn((oldId: string, newId: string) => {
        const entry = entries.get(oldId);
        if (!entry || entries.has(newId)) return false;
        entries.delete(oldId);
        entries.set(newId, { ...entry, docId: newId });
        return true;
      }),
    },
    bridge: {
      files: {
        stat: vi.fn(async (_path: string) => ({ size: 10, modified: 1 }) as { size: number; modified: number } | null),
        saveDialog: vi.fn(async () => 'C:\\Docs\\me\\new.pdf' as string | null),
        saveAtomic: vi.fn(async (_path: string, _bytes: unknown) => ({ ok: true })),
        read: vi.fn(async () => ({ ok: false, reason: 'missing' })),
      },
      recovery: {
        write: vi.fn(async () => undefined),
        read: vi.fn(async () => null),
        writeStash: vi.fn(async () => undefined),
        readStash: vi.fn(async () => null),
        list: vi.fn(async () => []),
        clear: vi.fn(async () => undefined),
      },
    },
    watchOptions: [] as Array<{ path: string }>,
  };
});

vi.mock('../../app/services', () => ({ documentRegistry: registry, fileService: { noteOpened: vi.fn() } }));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeMupdf, openMupdf: openMupdfMock }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));
vi.mock('./diskWatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diskWatch')>();
  return {
    ...actual,
    startDiskWatch: (options: Parameters<typeof actual.startDiskWatch>[0]) => {
      watchOptions.push(options);
      return actual.startDiskWatch({ ...options, target: new EventTarget() });
    },
  };
});

import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { addedBytesOf, noteAdded, resetAdded } from './addedBytes';
import { applyPageEdits, attachSourceLogged, redoPageEdit, undoPageEdit } from './editOps';
import { saveWithFeedback } from './closeFlow';
import { extractPages, keepMyVersion, rememberFileStamp, resetSaveState, saveDocument, watchDocumentFile } from './saveDocument';

const OLD = 'C:\\old.pdf';
const DOC = `path:${OLD}`;
const NEW = 'C:\\Docs\\me\\new.pdf';

function docOf(id: string) {
  return registry.entries.get(id)!.doc;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSaveState();
  watchOptions.length = 0;
  registry.entries.clear();
  registry.entries.set(DOC, { docId: DOC, doc: new FakeMupdf() as never, pageCount: 1 });
  useEditStore.setState({ saving: {}, changedOnDisk: {} });
  useWorkspaceStore.setState({
    tabs: [
      {
        id: 'tab1',
        title: 'old.pdf',
        origin: { kind: 'path', path: OLD },
        status: { kind: 'ready' },
        panes: [{ id: 'pane1', docId: DOC, view: { pageId: '0', zoom: 1, fit: 'width', offset: 0, rotation: 0 } }],
        split: null,
      },
    ],
    activeTabId: 'tab1',
  } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'old.pdf', pageCount: 1, pages: [], sizes: [], byteSize: 10 } } } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('edits during a save (ticket 1.2.1 review, item 5)', () => {
  it('refuses edits, undo and redo from the worker save until the saved file replaces the document', async () => {
    await rememberFileStamp(OLD);
    const seen: string[] = [];
    bridge.files.saveAtomic.mockImplementationOnce(async () => {
      expect(useEditStore.getState().saving[DOC]).toBe(true);
      await expect(applyPageEdits(DOC, [{ op: 'rotate', uids: ['0'], degrees: 90 }])).rejects.toThrow('Wait for the save to finish.');
      await expect(undoPageEdit(DOC)).rejects.toThrow('Wait for the save to finish.');
      seen.push('refused');
      return { ok: true };
    });
    await saveDocument(DOC);
    expect(seen).toEqual(['refused']);
    expect(docOf(DOC).applyEdits).not.toHaveBeenCalled();
    // After the save the flag is gone and edits work again.
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();
    await expect(applyPageEdits(DOC, [{ op: 'rotate', uids: ['0'], degrees: 90 }])).resolves.toBe(true);
  });

  it('clears the flag when the save fails', async () => {
    docOf(DOC).save.mockRejectedValueOnce(new Error('boom'));
    await expect(saveDocument(DOC)).rejects.toThrow('boom');
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();
  });

  it('a Save As clears the flag under both ids', async () => {
    await saveDocument(DOC, { saveAs: true });
    expect(useEditStore.getState().saving).toEqual({});
  });

  it('only one save runs at a time: a second plain Save joins the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    docOf(DOC).save.mockImplementationOnce(async () => {
      await gate;
      return { bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] };
    });
    const first = saveDocument(DOC);
    const second = saveDocument(DOC);
    await vi.waitFor(() => expect(docOf(DOC).save).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(docOf(DOC).save).toHaveBeenCalledTimes(1);
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(1);
  });

  it('a Save As asked for during a save waits for it and then runs, never in parallel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let active = 0;
    let most = 0;
    docOf(DOC).save.mockImplementation(async () => {
      active += 1;
      most = Math.max(most, active);
      await gate;
      active -= 1;
      return { bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] };
    });
    const first = saveDocument(DOC);
    await vi.waitFor(() => expect(active).toBe(1));
    const second = saveDocument(DOC, { saveAs: true });
    await Promise.resolve();
    expect(docOf(DOC).save).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(most).toBe(1);
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(2);
  });

  it('a save waits for an edit that is still running, so the edit is in the saved bytes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    docOf(DOC).applyEdits.mockImplementationOnce(async () => {
      await gate;
      order.push('edit done');
      return { version: 1, history: {}, changed: true, uidSeed: 0 };
    });
    docOf(DOC).save.mockImplementationOnce(async () => {
      order.push('save');
      return { bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] };
    });
    const edit = applyPageEdits(DOC, [{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    await vi.waitFor(() => expect(docOf(DOC).applyEdits).toHaveBeenCalled());
    const save = saveDocument(DOC);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([edit, save]);
    expect(order).toEqual(['edit done', 'save']);
  });
});

describe('Save without a password goes to the file the user chose (ticket 1.2.1 review, item 6)', () => {
  it('reports the picked path, and the later choice writes there and never to the encrypted original', async () => {
    await rememberFileStamp(OLD);
    const doc = docOf(DOC);
    doc.save.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NeedsEncryptionChoice' }));
    const first = await saveDocument(DOC, { saveAs: true });
    expect(first).toEqual({ status: 'needs-encryption-choice', target: NEW });
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    bridge.files.saveDialog.mockClear();
    const second = await saveDocument(DOC, { dropEncryption: true, targetPath: NEW });
    expect(second).toMatchObject({ status: 'saved', path: NEW });
    expect(bridge.files.saveDialog).not.toHaveBeenCalled();
    expect(bridge.files.saveAtomic.mock.calls.map((call) => call[0])).toEqual([NEW]);
    expect(doc.save).toHaveBeenLastCalledWith(false, false, true);
  });

  it('a plain Save that needs the choice reports no target, so it stays on the document own path', async () => {
    docOf(DOC).save.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NeedsEncryptionChoice' }));
    expect(await saveDocument(DOC)).toEqual({ status: 'needs-encryption-choice', target: null });
  });
});

describe('a file with a read grant only asks before the first save (ticket 1.2.1 review, item 7)', () => {
  it('when the main process refuses the write, the Save dialog picks the file and the save goes there', async () => {
    await rememberFileStamp(OLD);
    bridge.files.saveAtomic.mockResolvedValueOnce({ ok: false, reason: 'invalid-argument' } as never);
    bridge.files.saveDialog.mockResolvedValueOnce(OLD);
    const outcome = await saveDocument(DOC);
    expect(outcome).toMatchObject({ status: 'saved', path: OLD });
    expect(bridge.files.saveDialog).toHaveBeenCalledTimes(1);
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(2);
  });

  it('cancelling that dialog saves nothing', async () => {
    bridge.files.saveAtomic.mockResolvedValueOnce({ ok: false, reason: 'invalid-argument' } as never);
    bridge.files.saveDialog.mockResolvedValueOnce(null);
    expect(await saveDocument(DOC)).toEqual({ status: 'cancelled' });
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(1);
  });
});

describe('extract of an encrypted source (ticket 1.2.1 review, item 9)', () => {
  it('asks the encryption choice instead of writing, and then writes unencrypted to the same target', async () => {
    docOf(DOC).extract.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NeedsEncryptionChoice' }));
    const first = await extractPages(DOC, ['0'], 'old.pdf');
    expect(first).toEqual({ status: 'needs-encryption-choice', target: NEW });
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    bridge.files.saveDialog.mockClear();
    const second = await extractPages(DOC, ['0'], 'old.pdf', { targetPath: NEW, dropEncryption: true });
    expect(second).toEqual({ status: 'saved', path: NEW });
    expect(bridge.files.saveDialog).not.toHaveBeenCalled();
    expect(docOf(DOC).extract).toHaveBeenLastCalledWith(['0'], { dropEncryption: true, password: undefined });
  });
});

describe('the disk watch restarts after each decision (ticket 1.2.1 review, item 8)', () => {
  it('Keep my version restarts it, and a second outside change in a row is reported', async () => {
    vi.useFakeTimers();
    await rememberFileStamp(OLD);
    watchDocumentFile(DOC, OLD);
    expect(watchOptions).toHaveLength(1);

    // First outside change.
    bridge.files.stat.mockResolvedValue({ size: 11, modified: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(useEditStore.getState().changedOnDisk[DOC]).toBe(true);

    // Keep my version: the banner goes, the watch restarts. The same change is not reported again.
    await keepMyVersion(DOC);
    expect(useEditStore.getState().changedOnDisk[DOC]).toBe(false);
    expect(watchOptions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useEditStore.getState().changedOnDisk[DOC]).toBe(false);

    // Second outside change.
    bridge.files.stat.mockResolvedValue({ size: 12, modified: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(useEditStore.getState().changedOnDisk[DOC]).toBe(true);
  });

  it('Keep my version does not make the next save incremental over the changed file', async () => {
    await rememberFileStamp(OLD);
    bridge.files.stat.mockResolvedValue({ size: 11, modified: 2 });
    await keepMyVersion(DOC);
    await saveDocument(DOC);
    // The stamp the save compares with is still the old one, so the disk counts as changed.
    expect(docOf(DOC).save).toHaveBeenCalledWith(true, false, false);
  });
});

describe('round 2: undo guard, queued Save As, too-large save', () => {
  const history = (canUndo: boolean, canRedo = false) =>
    ({ version: 1, uids: ['0'], revs: [0], sizes: null, history: { dirty: true, canUndo, canRedo, undoLabel: 'x', redoLabel: null } }) as never;

  it('Undo (the toast button calls the same function) is refused while a save runs and while another change runs, and when there is nothing to undo', async () => {
    useEditStore.setState({ byDoc: { [DOC]: history(true) } });
    useEditStore.getState().setSaving(DOC, true);
    await expect(undoPageEdit(DOC)).rejects.toThrow('Wait for the save to finish.');
    useEditStore.getState().setSaving(DOC, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    docOf(DOC).applyEdits.mockImplementationOnce(async () => {
      await gate;
      return { version: 1, history: {}, changed: true, uidSeed: 0 };
    });
    const edit = applyPageEdits(DOC, [{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    await vi.waitFor(() => expect(docOf(DOC).applyEdits).toHaveBeenCalled());
    await expect(undoPageEdit(DOC)).rejects.toThrow(/current change/);
    release();
    await edit;
    expect(docOf(DOC).undo).not.toHaveBeenCalled();
    useEditStore.setState({ byDoc: { [DOC]: history(false) } });
    await expect(undoPageEdit(DOC)).rejects.toThrow('Nothing to undo');
    useEditStore.setState({ byDoc: { [DOC]: history(true) } });
    await undoPageEdit(DOC);
    expect(docOf(DOC).undo).toHaveBeenCalledTimes(1);
  });

  it('a Save As queued behind another Save As uses the re-keyed document id', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    docOf(DOC).save.mockImplementationOnce(async () => {
      await gate;
      return { bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] };
    });
    bridge.files.saveDialog.mockResolvedValueOnce(NEW).mockResolvedValueOnce('D:/Docs/again.pdf');
    const first = saveDocument(DOC, { saveAs: true });
    const second = saveDocument(DOC, { saveAs: true });
    await vi.waitFor(() => expect(docOf(DOC).save).toHaveBeenCalledTimes(1));
    release();
    await expect(first).resolves.toMatchObject({ status: 'saved', path: NEW });
    await expect(second).resolves.toMatchObject({ status: 'saved', path: 'D:/Docs/again.pdf' });
  });

  it('a save over the size limit says so and does not fall into the Save As retry', async () => {
    await rememberFileStamp(OLD);
    docOf(DOC).save.mockResolvedValueOnce({ bytes: { byteLength: 2 * 1024 * 1024 * 1024 } as ArrayBuffer, mode: 'full' as const, fingerprints: [1] });
    await expect(saveDocument(DOC)).rejects.toThrow(/too large to save/);
    expect(bridge.files.saveDialog).not.toHaveBeenCalled();
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();
  });
});

// 1.5.10 file-size limits.
describe('the save limit is the edit limit (500 MB), by size', () => {
  const MB = 1024 * 1024;
  const saved = (byteLength: number) => ({ bytes: { byteLength } as ArrayBuffer, mode: 'full' as const, fingerprints: [1] });

  it('one byte over 500 MB is refused with the limit, the file unchanged and the edits open; exactly 500 MB is not refused for size', async () => {
    await rememberFileStamp(OLD);
    docOf(DOC).save.mockResolvedValueOnce(saved(500 * MB + 1));
    await expect(saveDocument(DOC)).rejects.toThrow(/too large to save \(the limit is 500 MB\)\. The file on disk is unchanged and your edits are still open/);
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    // At the limit the size check lets it through to the reopen check (which this fake document answers).
    docOf(DOC).save.mockResolvedValueOnce(saved(500 * MB));
    openMupdfMock.mockClear();
    await saveDocument(DOC).catch(() => undefined);
    expect(openMupdfMock).toHaveBeenCalled();
  });

  it('a too-large refusal of a changed document leaves it unsaved and says its changes can no longer be undone (the engine save spent them)', async () => {
    await rememberFileStamp(OLD);
    const history = { dirty: true, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
    useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: ['0'], revs: [0], sizes: null, history } } } as never);
    docOf(DOC).save.mockResolvedValueOnce(saved(500 * MB + 1));
    await expect(saveDocument(DOC)).rejects.toThrow(/Your changes are kept and can be saved again, but they can no longer be undone\./);
    // Nothing is cleared: the store still says dirty, and nothing was written.
    expect(useEditStore.getState().byDoc[DOC]?.history.dirty).toBe(true);
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    useEditStore.setState({ byDoc: {} });
  });

  it('an estimate over the limit (saved size plus the sources added since) asks first: Cancel means no engine save, and Undo still works', async () => {
    bridge.files.stat.mockResolvedValue({ size: 450 * MB, modified: 1 });
    await rememberFileStamp(OLD);
    noteAdded(DOC, 100 * MB);
    const history = { dirty: true, canUndo: true, canRedo: false, undoLabel: 'x', redoLabel: null };
    useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: ['0'], revs: [0], sizes: null, history } } } as never);
    try {
      await expect(saveDocument(DOC)).resolves.toEqual({ status: 'may-be-too-large' });
      expect(docOf(DOC).save).not.toHaveBeenCalled();
      expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
      expect(useEditStore.getState().byDoc[DOC]?.history.canUndo).toBe(true);
      expect(useEditStore.getState().saving[DOC]).toBeUndefined();
      // The feedback layer turns the status into the question, and leaves everything else alone.
      expect(await saveWithFeedback(DOC)).toBe('cancelled');
      expect(useUiStore.getState().largeSave).toEqual({ docId: DOC, options: {} });
      expect(docOf(DOC).save).not.toHaveBeenCalled();
    } finally {
      useUiStore.getState().setLargeSave(null);
      bridge.files.stat.mockResolvedValue({ size: 10, modified: 1 });
      resetAdded(DOC);
      useEditStore.setState({ byDoc: {} });
    }
  });

  it('Save anyway (confirmedLarge) runs the engine save, and the real size check still follows it', async () => {
    bridge.files.stat.mockResolvedValue({ size: 450 * MB, modified: 1 });
    await rememberFileStamp(OLD);
    noteAdded(DOC, 100 * MB);
    docOf(DOC).save.mockResolvedValueOnce(saved(500 * MB + 1));
    try {
      await expect(saveDocument(DOC, { confirmedLarge: true })).rejects.toThrow(/too large to save \(the limit is 500 MB\)/);
      expect(docOf(DOC).save).toHaveBeenCalledTimes(1);
      expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    } finally {
      bridge.files.stat.mockResolvedValue({ size: 10, modified: 1 });
      resetAdded(DOC);
    }
  });

  it('an estimate at the limit is not refused for size', async () => {
    bridge.files.stat.mockResolvedValue({ size: 400 * MB, modified: 1 });
    await rememberFileStamp(OLD);
    noteAdded(DOC, 100 * MB);
    docOf(DOC).save.mockResolvedValueOnce(saved(8));
    try {
      await saveDocument(DOC).catch(() => undefined);
      expect(docOf(DOC).save).toHaveBeenCalled();
    } finally {
      bridge.files.stat.mockResolvedValue({ size: 10, modified: 1 });
      resetAdded(DOC);
    }
  });

  it('an extract over 500 MB is refused and nothing is written', async () => {
    docOf(DOC).extract.mockResolvedValueOnce({ byteLength: 500 * MB + 1 } as ArrayBuffer);
    await expect(extractPages(DOC, ['0'], 'old.pdf', { targetPath: NEW })).rejects.toThrow(/too large to save \(the limit is 500 MB\)\. Nothing was written/);
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
  });
});

describe('a failed save says why, that the file is unchanged, that the edits are open, and a next step', () => {
  const failure = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('out of memory (the engine error of every failed save above about 550 MB)', async () => {
    await rememberFileStamp(OLD);
    docOf(DOC).save.mockRejectedValueOnce(failure('Internal', 'realloc (827430261 bytes) failed'));
    await expect(saveDocument(DOC)).rejects.toThrow(
      'The file could not be saved, because PDF Suite did not have enough memory. The file on disk is unchanged and your edits are still open. Close other tabs and try again.',
    );
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();
  });

  it('any other engine failure says something went wrong, with the same assurances', async () => {
    await rememberFileStamp(OLD);
    docOf(DOC).save.mockRejectedValueOnce(failure('Internal', 'something else'));
    await expect(saveDocument(DOC)).rejects.toThrow(
      'The file could not be saved, because something went wrong. The file on disk is unchanged and your edits are still open. If it happens again, Help ▸ Open Logs Folder has the details.',
    );
  });

  it('a failed save of a changed document adds that the changes can no longer be undone', async () => {
    await rememberFileStamp(OLD);
    useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: ['0'], revs: [0], sizes: null, history: { dirty: true, canUndo: true, canRedo: false, undoLabel: null, redoLabel: null } } } } as never);
    docOf(DOC).save.mockRejectedValueOnce(failure('Internal', 'out of memory'));
    await expect(saveDocument(DOC)).rejects.toThrow(/Close other tabs and try again\. Your changes are kept and can be saved again, but they can no longer be undone\./);
    useEditStore.setState({ byDoc: {} });
  });
});

describe('a view-only document (the file is over 500 MB) takes no edit, no source and no save', () => {
  const VIEW_ONLY = 'This file is over 500 MB, so it can be viewed but not edited.';
  const edits = [
    { op: 'insertBlank', afterUid: null, size: { width: 612, height: 792 }, template: 'blank' },
    { op: 'insertFrom', afterUid: null, sourceDocId: 's', sourceUids: ['0'] },
    { op: 'delete', uids: ['0'] },
    { op: 'move', uids: ['0'], beforeUid: null },
    { op: 'duplicate', uids: ['0'] },
    { op: 'rotate', uids: ['0'], degrees: 90 },
    { op: 'crop', uids: ['0'], box: 'auto' },
    { op: 'resize', uids: ['0'], size: { width: 612, height: 792 }, fit: 'scale' },
    { op: 'replace', uid: '0', sourceDocId: 's', sourceUid: '0' },
    { op: 'reverse', uids: ['0', '1'] },
    { op: 'slice', uids: ['0'], cut: 'vertical', at: 0.5, first: 'left' },
    { op: 'overlay', uids: ['0'], sourceDocId: 's', sourceUids: ['0'], dx: 0, dy: 0, scale: 1, mode: 'normal', opacity: 1 },
  ] as const;

  beforeEach(() => {
    Object.defineProperty(docOf(DOC), 'capabilities', { value: { canEdit: false, htmlLayer: false, viewOnly: true }, configurable: true });
    useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: ['0'], revs: [0], sizes: null, history: { dirty: false, canUndo: true, canRedo: true, undoLabel: null, redoLabel: null } } } } as never);
  });

  it.each(edits.map((edit) => [edit.op, edit] as const))('the %s edit is refused with the reason, and the engine is not asked', async (_op, edit) => {
    await expect(applyPageEdits(DOC, [edit as never])).rejects.toThrow(VIEW_ONLY);
    expect(docOf(DOC).applyEdits).not.toHaveBeenCalled();
  });

  it('undo and redo are refused', async () => {
    await expect(undoPageEdit(DOC)).rejects.toThrow(VIEW_ONLY);
    await expect(redoPageEdit(DOC)).rejects.toThrow(VIEW_ONLY);
  });

  it('attaching a source (Insert, Replace, Overlay) is refused', async () => {
    const attach = vi.fn();
    (docOf(DOC) as unknown as { attachSource: unknown }).attachSource = attach;
    await expect(attachSourceLogged(DOC, new ArrayBuffer(4))).rejects.toThrow(VIEW_ONLY);
    expect(attach).not.toHaveBeenCalled();
  });

  it('Save and Save As are refused: no bytes are made, no dialog is shown, nothing is written', async () => {
    await expect(saveDocument(DOC)).rejects.toThrow(VIEW_ONLY);
    await expect(saveDocument(DOC, { saveAs: true })).rejects.toThrow(VIEW_ONLY);
    expect(docOf(DOC).save).not.toHaveBeenCalled();
    expect(bridge.files.saveDialog).not.toHaveBeenCalled();
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();
  });
});

describe('the running total of attached sources (size check of the next add)', () => {
  it('attachSourceLogged adds the source bytes; a save that succeeds starts the count again; the next insert counts from zero', async () => {
    await rememberFileStamp(OLD);
    (docOf(DOC) as unknown as { attachSource: unknown }).attachSource = vi.fn(async () => ({ sourceDocId: 's1', pages: 1 }));
    resetAdded(DOC);
    await attachSourceLogged(DOC, new ArrayBuffer(1000));
    await attachSourceLogged(DOC, new ArrayBuffer(250));
    expect(addedBytesOf(DOC)).toBe(1250);
    await saveDocument(DOC);
    expect(addedBytesOf(DOC)).toBe(0);
    await attachSourceLogged(DOC, new ArrayBuffer(100));
    expect(addedBytesOf(DOC)).toBe(100);
  });

  it('a save that fails leaves the count as it was', async () => {
    await rememberFileStamp(OLD);
    (docOf(DOC) as unknown as { attachSource: unknown }).attachSource = vi.fn(async () => ({ sourceDocId: 's1', pages: 1 }));
    resetAdded(DOC);
    await attachSourceLogged(DOC, new ArrayBuffer(1000));
    docOf(DOC).save.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'Internal' }));
    await expect(saveDocument(DOC)).rejects.toThrow();
    expect(addedBytesOf(DOC)).toBe(1000);
    resetAdded(DOC);
  });
});
