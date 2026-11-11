// @vitest-environment node
// Save checks the file on disk first (ticket 1.2.2, from the 1.2.1 sign-off). A Save pressed right after another program
// changed the file does not write: the "changed on disk" choice (Reload / Keep my version) comes first. The tests run whole
// sequences on one document, because the state a save leaves behind decides what the next save does.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeMupdf, openMupdfMock, registry, bridge, disk, fresh, watchOptions } = vi.hoisted(() => {
  class FakeMupdf {
    save = vi.fn(async (_same: boolean, _unchanged: boolean, _drop?: boolean) => ({ bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] }));
    applyEdits = vi.fn(async () => ({ version: 1, history: {}, changed: true, uidSeed: 0 }));
    onProgress = vi.fn(() => () => undefined);
    fingerprints = vi.fn(async () => [1]);
    destroy = vi.fn(async () => undefined);
    pageSize = vi.fn(async () => ({ width: 612, height: 792 }));
  }
  /** The file as the disk has it now. Null means the file is gone. A test changes it to play "another program". */
  const disk: { stat: { size: number; modified: number } | null } = { stat: { size: 10, modified: 1 } };
  const fresh = new FakeMupdf();
  const entries = new Map<string, { docId: string; doc: FakeMupdf; pageCount: number }>();
  return {
    FakeMupdf,
    fresh,
    disk,
    watchOptions: [] as Array<{ onMissing?: () => void; onFound?: () => void; onChanged: () => void }>,
    openMupdfMock: vi.fn(async () => ({ document: () => fresh, discard: () => undefined, xfa: {}, bytes: new ArrayBuffer(0) })),
    registry: {
      entries,
      get: vi.fn((docId: string) => entries.get(docId)),
      // Opening a path: an open document is shared (nothing is read); otherwise the file is read and a document made.
      acquire: vi.fn(async (source: { path: string }) => {
        const id = `path:${source.path}`;
        const known = entries.get(id);
        if (known) return known;
        await bridge.files.read();
        const made = { docId: id, doc: new FakeMupdf(), pageCount: 1 };
        entries.set(id, made);
        return made;
      }),
      release: vi.fn(),
      retain: vi.fn(),
      refCount: vi.fn(() => 1),
      replaceDocument: vi.fn(() => true),
      // Spellings of one path are joined by the real registry; the tests here open one spelling.
      sameFileId: (id: string) => id,
      isSuspended: () => false,
      rekey: vi.fn(() => true),
    },
    bridge: {
      files: {
        stat: vi.fn(async (_path: string) => (disk.stat ? { ...disk.stat } : null)),
        saveDialog: vi.fn(async () => 'C:\\Docs\\me\\elsewhere.pdf' as string | null),
        saveAtomic: vi.fn(async (_path: string, _bytes: unknown): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
        read: vi.fn(async () => ({ ok: true, bytes: new ArrayBuffer(8) })),
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
  };
});

vi.mock('../../app/services', () => ({ documentRegistry: registry, fileService: { noteOpened: vi.fn() } }));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeMupdf, openMupdf: openMupdfMock }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));
vi.mock('./diskWatch', () => ({
  startDiskWatch: vi.fn((options: { onMissing?: () => void; onFound?: () => void; onChanged: () => void }) => {
    watchOptions.push(options);
    return () => undefined;
  }),
}));

import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { saveWithFeedback, changedOnDiskMessage } from './closeFlow';
import { openPicked } from './documentService';
import { KEEP_TIP, RELOAD_TIP } from '../../ui/documents/DocumentBars';
import { applyPageEdits, discardRecovered } from './editOps';
import { changedBeforeSave } from './saveCheck';
import { failedSaveMessage, fileStampOf, keepMyVersion, rememberFileStamp, resetSaveState, rewatchDocumentFile, saveDocument } from './saveDocument';
import { useUiStore } from '../../core/stores/uiStore';

const PATH = 'C:\\docs\\report.pdf';
const DOC = `path:${PATH}`;

const docOf = () => registry.entries.get(DOC)!.doc;
const changedOnDisk = () => useEditStore.getState().changedOnDisk[DOC] === true;
/** What another program does to the file: a different size and modified time. */
const outsideChange = () => {
  disk.stat = { size: (disk.stat?.size ?? 0) + 5, modified: (disk.stat?.modified ?? 0) + 1000 };
};

beforeEach(async () => {
  vi.clearAllMocks();
  watchOptions.length = 0;
  resetSaveState();
  disk.stat = { size: 10, modified: 1 };
  registry.entries.clear();
  registry.entries.set(DOC, { docId: DOC, doc: new FakeMupdf() as never, pageCount: 1 });
  useEditStore.setState({ saving: {}, changedOnDisk: {}, progress: {} });
  useUiStore.setState({ toasts: [] });
  useWorkspaceStore.setState({
    tabs: [
      {
        id: 'tab1',
        title: 'report.pdf',
        origin: { kind: 'path', path: PATH },
        status: { kind: 'ready' },
        panes: [{ id: 'pane1', docId: DOC, view: { pageId: '0', zoom: 1, fit: 'width', offset: 0, rotation: 0 } }],
        split: null,
      },
    ],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'report.pdf', pageCount: 1, pages: [], sizes: [], byteSize: 10 } } } as never);
  // The app saw the file when it opened it.
  await rememberFileStamp(PATH);
});

describe('the check as a function', () => {
  it('refuses only when the file was seen, is still there, and its size or modified time differs', () => {
    const seen = { size: 10, modified: 1 };
    expect(changedBeforeSave(seen, { size: 10, modified: 1 })).toBe(false);
    expect(changedBeforeSave(seen, { size: 11, modified: 1 })).toBe(true);
    expect(changedBeforeSave(seen, { size: 10, modified: 2 })).toBe(true);
    // Nothing seen: nothing to compare. Gone: nothing of anyone else's to overwrite, and the save puts the file back.
    expect(changedBeforeSave(undefined, { size: 99, modified: 9 })).toBe(false);
    expect(changedBeforeSave(seen, null)).toBe(false);
  });
});

describe('the main process checks the stamp again just before it replaces the file (1.5.1 R9)', () => {
  it('sends the stamp the app last saw, and a refusal shows the "changed on disk" choice and clears nothing', async () => {
    bridge.files.saveAtomic.mockResolvedValueOnce({ ok: false, reason: 'changed-on-disk' });
    const outcome = await saveDocument(DOC);
    expect(outcome).toEqual({ status: 'changed-on-disk' });
    expect(bridge.files.saveAtomic).toHaveBeenCalledWith(PATH, expect.anything(), { size: 10, modified: 1 });
    expect(changedOnDisk()).toBe(true);
    // Nothing was written, so the recovery logs are not cleared and the document is not replaced.
    expect(bridge.recovery.clear).not.toHaveBeenCalled();
    expect(registry.replaceDocument).not.toHaveBeenCalled();
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();
  });

  it('a Save As to a path the user picked sends no stamp (the dialog already asked about replacing it)', async () => {
    await saveDocument(DOC, { saveAs: true });
    expect(bridge.files.saveAtomic.mock.calls[0]).toHaveLength(2);
  });
});

describe('the "nothing was saved" message (it must not point to the button that discards the edits)', () => {
  it('names the file and says what Keep my version and Reload do', () => {
    expect(changedOnDiskMessage('report.pdf')).toBe(
      'Another program changed report.pdf, so nothing was saved. Keep my version saves your changes over it; Reload discards your changes.',
    );
    expect(changedOnDiskMessage('report.pdf')).not.toMatch(/Choose Reload/);
  });

  it('the two buttons of the bar say the same in their tooltips', () => {
    expect(KEEP_TIP).toMatch(/Keep my version saves your changes/);
    expect(RELOAD_TIP).toMatch(/Reload discards your changes/);
  });
});

describe('Save with the file unchanged', () => {
  it('writes as before, and the file it wrote is the one the next save compares with', async () => {
    const first = await saveDocument(DOC);
    expect(first.status).toBe('saved');
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(1);
    // The write changed the file (new size and time); the app re-reads it after the save.
    disk.stat = { size: 8, modified: 5 };
    await rememberFileStamp(PATH);
    const second = await saveDocument(DOC);
    expect(second.status).toBe('saved');
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(2);
  });
});

describe('Save right after another program changed the file', () => {
  it('does not write, and shows the changed-on-disk choice', async () => {
    outsideChange();
    const outcome = await saveDocument(DOC);
    expect(outcome).toEqual({ status: 'changed-on-disk' });
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(changedOnDisk()).toBe(true);
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();
    // The document is untouched.
    expect(registry.replaceDocument).not.toHaveBeenCalled();
  });

  it('the Save command says so in plain words and keeps everything open', async () => {
    outsideChange();
    expect(await saveWithFeedback(DOC)).toBe('cancelled');
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([changedOnDiskMessage('report.pdf')]);
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
  });

  it('asks again on every Save until the user chooses', async () => {
    outsideChange();
    await saveDocument(DOC);
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
  });

  it('Save As to a different path is not affected', async () => {
    outsideChange();
    const outcome = await saveDocument(DOC, { saveAs: true });
    expect(outcome).toMatchObject({ status: 'saved', path: 'C:\\Docs\\me\\elsewhere.pdf' });
    expect(bridge.files.saveAtomic).toHaveBeenCalledWith('C:\\Docs\\me\\elsewhere.pdf', expect.anything());
    expect(changedOnDisk()).toBe(false);
  });

  it('a file that is gone is saved again (nothing of anyone else is overwritten)', async () => {
    disk.stat = null;
    expect((await saveDocument(DOC)).status).toBe('saved');
  });
});

describe('sequences on one document', () => {
  it('outside change, Save, Keep my version, Save: the second Save writes my version as a full save', async () => {
    outsideChange();
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();

    await keepMyVersion(DOC);
    expect(changedOnDisk()).toBe(false);

    const second = await saveDocument(DOC);
    expect(second.status).toBe('saved');
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(1);
    // The stamp still says the file changed, so the worker makes a full save of my pages, never an incremental one on top of
    // the other program's bytes.
    expect(docOf().save).toHaveBeenCalledWith(true, false, false);
  });

  it('Keep my version does not hide the NEXT outside change', async () => {
    outsideChange();
    await saveDocument(DOC);
    await keepMyVersion(DOC);
    outsideChange(); // another change after the user chose
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
  });

  it('outside change, Save, Reload, edit, Save: the file is then the one that was loaded, and the save writes', async () => {
    outsideChange();
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();

    // Reload: the file is read again, and its stamp is the one the next save compares with.
    await discardRecovered(DOC);
    useEditStore.getState().setChangedOnDisk(DOC, false);
    expect(registry.replaceDocument).toHaveBeenCalledTimes(1);

    // An edit on the reloaded document, then Save.
    await expect(applyPageEdits(DOC, [{ op: 'rotate', uids: ['0'], degrees: 90 }])).resolves.toBe(true);
    const outcome = await saveDocument(DOC);
    expect(outcome.status).toBe('saved');
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(1);
    // The reloaded file is the one on disk, so the save may be incremental.
    expect(docOf().save).toHaveBeenCalledWith(true, true, false);
  });

  it('a failed save, then an outside change, then Save: nothing is written over the change, and Keep then saves', async () => {
    bridge.files.saveAtomic.mockResolvedValueOnce({ ok: false, reason: 'unreadable' });
    await expect(saveDocument(DOC)).rejects.toThrow(failedSaveMessage(DOC));
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();

    outsideChange();
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(1); // only the failed attempt

    await keepMyVersion(DOC);
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(2);
  });

  it('an outside change DURING a save is caught just before the write, and the prepared copy is thrown away', async () => {
    // The change lands while the worker is making the bytes: the first look at the file saw nothing, the last one does.
    docOf().save.mockImplementationOnce(async () => {
      outsideChange();
      return { bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] };
    });
    const outcome = await saveDocument(DOC);
    expect(outcome).toEqual({ status: 'changed-on-disk' });
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(fresh.destroy).toHaveBeenCalled();
    expect(changedOnDisk()).toBe(true);
    expect(registry.replaceDocument).not.toHaveBeenCalled();
    expect(useEditStore.getState().saving[DOC]).toBeUndefined();

    await keepMyVersion(DOC);
    expect((await saveDocument(DOC)).status).toBe('saved');
  });

  it('an outside change during a save whose write then fails: the failure is not hidden behind the change', async () => {
    // Write fails with no outside change before it: the error is the failed-save message, as before.
    bridge.files.saveAtomic.mockResolvedValueOnce({ ok: false, reason: 'unreadable' });
    await expect(saveDocument(DOC)).rejects.toThrow(/could not be saved/);
    // The change comes after the failure: the retry sees it.
    outsideChange();
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    expect(changedOnDisk()).toBe(true);
  });
});

describe('opening a file that is already open (review of 1.2.2)', () => {
  const again = () => openPicked([{ kind: 'path', path: PATH, name: 'report.pdf' }] as never);

  it('does not record the other program version as seen: a Save still refuses', async () => {
    outsideChange();
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    useEditStore.getState().setChangedOnDisk(DOC, false);
    await again();
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.acquire).toHaveBeenCalled();
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
  });

  it('does not undo "Keep my version" either: the next outside change is still caught, and the kept one is not', async () => {
    outsideChange();
    await saveDocument(DOC);
    await keepMyVersion(DOC);
    await again();
    await new Promise((r) => setTimeout(r, 0));
    // Kept: the save goes through (a full save, since the stamp still says the file changed).
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(docOf().save).toHaveBeenCalledWith(true, false, false);
  });

  it('a file opened for the first time is stamped from a stat taken BEFORE the read', async () => {
    registry.entries.clear();
    useDocumentsStore.setState({ docs: {} } as never);
    // Another program changes the file while it is being read.
    bridge.files.read.mockImplementationOnce(async () => {
      outsideChange();
      return { ok: true, bytes: new ArrayBuffer(8) };
    });
    await again();
    await new Promise((r) => setTimeout(r, 0));
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
  });

  it('a file whose stat is refused before the read (the path is not granted yet) is stamped right after the open', async () => {
    registry.entries.clear();
    resetSaveState();
    useDocumentsStore.setState({ docs: {} } as never);
    bridge.files.stat.mockResolvedValueOnce(null);
    await again();
    await vi.waitFor(() => expect(fileStampOf(PATH)).toEqual(disk.stat));
    // So the watch and the save check have something to compare with.
    outsideChange();
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
  });

  it('Reload stamps the file from a stat taken before it reads it', async () => {
    outsideChange();
    bridge.files.read.mockImplementationOnce(async () => {
      outsideChange(); // changed again during the reload's read
      return { ok: true, bytes: new ArrayBuffer(8) };
    });
    await discardRecovered(DOC);
    expect((await saveDocument(DOC)).status).toBe('changed-on-disk');
  });
});

describe('a file deleted or renamed by another program (orchestrator ruling)', () => {
  it('Save creates it again at its path, without asking', async () => {
    disk.stat = null;
    const outcome = await saveDocument(DOC);
    expect(outcome).toMatchObject({ status: 'saved', path: PATH });
    // The stamp the file had when it was last seen goes along (1.5.1 R9); the main process treats a missing file as fine.
    expect(bridge.files.saveAtomic).toHaveBeenCalledWith(PATH, expect.anything(), { size: 10, modified: 1 });
    expect(changedOnDisk()).toBe(false);
  });

  it('Save creates it again even when the "changed on disk" bar was already up', async () => {
    outsideChange();
    await saveDocument(DOC);
    disk.stat = null;
    expect((await saveDocument(DOC)).status).toBe('saved');
  });

  it('the watch raises the "moved or deleted" bar flag (no toast), which replaces the "changed on disk" bar (1.5.5 D4)', () => {
    rewatchDocumentFile(DOC, PATH);
    const options = watchOptions.at(-1)!;
    useEditStore.getState().setChangedOnDisk(DOC, true);
    options.onMissing!();
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(useEditStore.getState().missingOnDisk[DOC]).toBe(true);
    // The "changed on disk" state is kept under the missing bar: a file that returns different brings that bar back.
    expect(changedOnDisk()).toBe(true);
  });

  it('a write that fails for a file known to be gone points to Save As', async () => {
    rewatchDocumentFile(DOC, PATH);
    watchOptions.at(-1)!.onMissing!();
    disk.stat = null;
    bridge.files.saveAtomic.mockResolvedValueOnce({ ok: false, reason: 'write-failed' });
    await expect(saveDocument(DOC)).rejects.toThrow('The folder for this file may no longer exist. Use Save As… to choose where to save it.');
  });

  it('a Save As to another folder that fails gives the normal failed-save message, not the folder one', async () => {
    rewatchDocumentFile(DOC, PATH);
    watchOptions.at(-1)!.onMissing!();
    disk.stat = null;
    bridge.files.saveAtomic.mockResolvedValueOnce({ ok: false, reason: 'write-failed' });
    await expect(saveDocument(DOC, { saveAs: true })).rejects.toThrow(failedSaveMessage(DOC));
  });

  it('the bar flag goes when the file is seen again, and when a save succeeds', async () => {
    rewatchDocumentFile(DOC, PATH);
    const options = watchOptions.at(-1)!;
    options.onMissing!();
    options.onFound!();
    expect(useEditStore.getState().missingOnDisk[DOC]).toBeUndefined();
    options.onMissing!();
    disk.stat = null;
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(useEditStore.getState().missingOnDisk[DOC]).toBeUndefined();
  });
});
