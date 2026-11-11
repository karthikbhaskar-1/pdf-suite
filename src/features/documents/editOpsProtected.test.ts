// @vitest-environment node
// Crash recovery and a password-protected source. A copy of the protected file cannot be kept in the recovery log (the
// password is never stored), so once an edit that USES the source has applied, recovery stops for the document: the log
// already on disk is KEPT (marked "logging stopped here", so a crash gives back every edit up to that point), a bar that
// stays tells the user, and a save turns recovery back on. (Ticket 1.5.1 R4, R5: until then the log was deleted and a
// 4-second toast was shown.)
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeDoc, store, bridge, doc, openMupdf, replaceDocument } = vi.hoisted(() => {
  class FakeDoc {
    version = 0;
    onProgress = vi.fn(() => () => undefined);
    applyEdits = vi.fn(async () => ({ version: ++this.version, history: {}, changed: true, uidSeed: this.version }));
    undo = vi.fn(async () => ({}));
    redo = vi.fn(async () => ({}));
    attachSource = vi.fn(async (_bytes: ArrayBuffer, password?: string) => ({ sourceDocId: password === undefined ? 'src-plain' : 'src-locked', pages: 3 }));
  }
  // The recovery folder: what is on disk, by key.
  const store = new Map<string, string>();
  const doc = new FakeDoc();
  const fresh = Object.assign(new FakeDoc(), { pageCount: 0, pageSize: async () => ({ width: 1, height: 1, rotation: 0 }) });
  return {
    FakeDoc,
    doc,
    openMupdf: vi.fn(async () => ({ document: () => fresh })),
    replaceDocument: vi.fn(() => true),
    store,
    bridge: {
      files: { stat: vi.fn(async () => ({ size: 10, modified: 1 })), read: vi.fn(async () => ({ ok: true, bytes: new ArrayBuffer(4) })) },
      recovery: {
        write: vi.fn(async (key: string, text: string) => void store.set(key, text)),
        read: vi.fn(async (key: string) => store.get(key) ?? null),
        writeStash: vi.fn(async () => undefined),
        readStash: vi.fn(async () => null),
        list: vi.fn(async () => [...store.keys()]),
        clear: vi.fn(async (key: string) => void store.delete(key)),
      },
    },
  };
});

vi.mock('../../app/services', () => ({ documentRegistry: { get: () => ({ doc }), replaceDocument } }));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeDoc, openMupdf }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));
vi.mock('./saveDocument', () => ({
  fileStampOf: () => ({ size: 10, modified: 1 }),
  rememberFileStamp: vi.fn(),
  recordFileStamp: vi.fn(),
  statFile: vi.fn(async () => ({ size: 10, modified: 1 })),
  rewatchDocumentFile: vi.fn(),
  currentIdOf: (docId: string) => docId,
  savePathOf: (docId: string) => (docId.startsWith('path:') ? docId.slice(5) : null),
}));

import { useUiStore } from '../../core/stores/uiStore';
import { parseEditLog } from '../recovery/editLog';
import { applyPageEdits, attachSourceLogged, clearEditLogAfterSave, discardRecovered, forgetEditState, RECOVERY_OFF_MESSAGE, restoreEditLog, undoPageEdit } from './editOps';
import { recoveryKeyFor } from './editOps';
import { useEditStore } from '../../core/stores/editStore';
import { addedBytesOf, resetAdded } from './addedBytes';

const PATH = 'C:\\a.pdf';
const DOC = `path:${PATH}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Every change writes the log at once, so a moment is enough for the in-memory store to have it.
const settle = () => wait(5);
const bytes = () => new ArrayBuffer(8);
const rotate = { op: 'rotate' as const, uids: ['0'], degrees: 90 };
const insertFromLocked = { op: 'insertFrom' as const, afterUid: null, sourceDocId: 'src-locked', sourceUids: ['0'] };
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const notice = () => useEditStore.getState().recoveryNotice[DOC];

/** What a restart would find: the steps of the log on disk, or null when there is no log. */
async function onDisk(): Promise<number | null> {
  const text = store.get(await recoveryKeyFor(PATH));
  if (!text) return null;
  return parseEditLog(text)?.steps.length ?? null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  doc.version = 0;
  useUiStore.setState({ toasts: [] });
  useEditStore.setState({ saving: {}, progress: {}, recoveryNotice: {}, recovered: {}, byDoc: { [DOC]: { version: 0, uids: [], revs: [], sizes: null, history: { dirty: true, canUndo: true, canRedo: false, undoLabel: null, redoLabel: null } } } } as never);
  await clearEditLogAfterSave(DOC, [PATH]);
  store.clear();
});

describe('a password-protected source and crash recovery', () => {
  it('after edit, undo and a protected insert, a crash restores nothing (the log on disk is the undone state)', async () => {
    await applyPageEdits(DOC, [rotate]);
    await settle();
    expect(await onDisk()).toBe(1);
    await undoPageEdit(DOC);
    await settle();
    const attached = await attachSourceLogged(DOC, bytes(), 'test123');
    expect(attached.sourceDocId).toBe('src-locked');
    // Browsing for the file switches nothing off: the log is still there.
    expect(await onDisk()).toBe(0);
    expect(notice()).toBeUndefined();
    await applyPageEdits(DOC, [insertFromLocked]);
    await settle();
    // The log is kept, and says recording stopped. It holds no steps (the one edit was undone), so there is nothing to replay.
    expect(await onDisk()).toBe(0);
    expect(parseEditLog(store.get(await recoveryKeyFor(PATH))!)?.loggingStopped).toBe(true);
    // Later undo and redo do not write the log again.
    const writes = bridge.recovery.write.mock.calls.length;
    await undoPageEdit(DOC);
    await settle();
    expect(bridge.recovery.write.mock.calls.length).toBe(writes);
    await restoreEditLog(DOC, PATH);
    expect(useEditStore.getState().recovered[DOC]).toBeUndefined();
    expect(doc.applyEdits).toHaveBeenCalledTimes(2); // only the two live edits, nothing replayed
  });

  it('two edits, then a protected insert: the two edits stay on disk and come back after a crash, with a note that recording stopped', async () => {
    await applyPageEdits(DOC, [rotate]);
    await applyPageEdits(DOC, [{ ...rotate, degrees: 180 }]);
    await attachSourceLogged(DOC, bytes(), 'test123');
    await applyPageEdits(DOC, [insertFromLocked]);
    await applyPageEdits(DOC, [{ ...rotate, degrees: 270 }]); // not recorded: recovery is off
    await settle();
    expect(await onDisk()).toBe(2);
    expect(notice()).toEqual({ kind: 'protected-source' });
    // The restart: the document is opened again (a fresh state), and the log is offered.
    forgetEditState(DOC);
    doc.applyEdits.mockClear();
    await restoreEditLog(DOC, PATH);
    expect(doc.applyEdits).toHaveBeenCalledTimes(2);
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 2, loggingStopped: true });
  });

  it('a protected insert that fails or is cancelled leaves recovery on and the log untouched', async () => {
    await applyPageEdits(DOC, [rotate]);
    await settle();
    const before = store.get(await recoveryKeyFor(PATH));
    await attachSourceLogged(DOC, bytes(), 'test123');
    doc.applyEdits.mockRejectedValueOnce(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    await expect(applyPageEdits(DOC, [insertFromLocked])).rejects.toThrow();
    doc.applyEdits.mockResolvedValueOnce({ version: 99, history: {}, changed: false, uidSeed: 0 } as never);
    await expect(applyPageEdits(DOC, [insertFromLocked])).resolves.toBe(false);
    await settle();
    expect(notice()).toBeUndefined();
    expect(store.get(await recoveryKeyFor(PATH))).toBe(before);
    // Recovery is still on: the next edit is logged.
    await applyPageEdits(DOC, [{ ...rotate, degrees: 180 }]);
    await settle();
    expect(await onDisk()).toBe(2);
  });

  it('tells the user in a bar that stays (not a 4-second toast), once, in plain English', async () => {
    await attachSourceLogged(DOC, bytes(), 'test123');
    expect(notice()).toBeUndefined();
    await applyPageEdits(DOC, [insertFromLocked]);
    await applyPageEdits(DOC, [{ ...insertFromLocked, afterUid: '0' }]);
    expect(notice()).toEqual({ kind: 'protected-source' });
    expect(toasts()).toEqual([]);
    expect(RECOVERY_OFF_MESSAGE).toMatch(/until you save/);
  });

  it('an edit that does not use the protected source keeps recovery on', async () => {
    await attachSourceLogged(DOC, bytes(), 'test123');
    await applyPageEdits(DOC, [rotate]);
    await settle();
    expect(await onDisk()).toBe(1);
    expect(notice()).toBeUndefined();
  });

  it('a plain (unprotected) source is logged as before and does not switch recovery off', async () => {
    await attachSourceLogged(DOC, bytes());
    await applyPageEdits(DOC, [{ ...insertFromLocked, sourceDocId: 'src-plain' }]);
    await settle();
    expect(await onDisk()).toBe(1);
    expect(notice()).toBeUndefined();
  });

  it('recovery works again after a save', async () => {
    await attachSourceLogged(DOC, bytes(), 'test123');
    await applyPageEdits(DOC, [insertFromLocked]);
    await settle();
    expect(await onDisk()).toBeNull();
    expect(notice()).toEqual({ kind: 'protected-source' });
    // The save: the file holds the edits, the document is a fresh one.
    await clearEditLogAfterSave(DOC, [PATH]);
    expect(notice()).toBeUndefined();
    await applyPageEdits(DOC, [rotate]);
    await settle();
    expect(await onDisk()).toBe(1);
    // And a later protected insert is announced again.
    await attachSourceLogged(DOC, bytes(), 'test123');
    await applyPageEdits(DOC, [insertFromLocked]);
    expect(notice()).toEqual({ kind: 'protected-source' });
  });

  it('a protected insert, then Discard or Reload, then a protected insert again: no error, the message shows again', async () => {
    await attachSourceLogged(DOC, bytes(), 'test123');
    await applyPageEdits(DOC, [insertFromLocked]);
    expect(notice()).toEqual({ kind: 'protected-source' });
    // Discard / Reload: the file is read again into a fresh worker.
    await discardRecovered(DOC);
    expect(replaceDocument).toHaveBeenCalledTimes(1);
    expect(notice()).toBeUndefined();
    // The new session attaches the protected file again (a new worker, so a new source) and uses it.
    await attachSourceLogged(DOC, bytes(), 'test123');
    await expect(applyPageEdits(DOC, [insertFromLocked])).resolves.toBe(true);
    expect(notice()).toEqual({ kind: 'protected-source' });
    await settle();
    expect(await onDisk()).toBeNull();
  });

  it('closing the document forgets the protected-source state, so the same file opened again starts clean', async () => {
    await attachSourceLogged(DOC, bytes(), 'test123');
    await applyPageEdits(DOC, [insertFromLocked]);
    forgetEditState(DOC);
    expect(notice()).toBeUndefined();
    await attachSourceLogged(DOC, bytes(), 'test123');
    await expect(applyPageEdits(DOC, [insertFromLocked])).resolves.toBe(true);
    expect(notice()).toEqual({ kind: 'protected-source' });
  });
});

// 1.5.10 file-size limits, review round: the sources attached since the last save count towards the size check of the next add; a
// view-only document takes no replay; a file that grew past the view limit says so on Discard and keeps its logs.
describe('size limits: the running total of attached sources, replay and Discard', () => {
  const setCapabilities = (capabilities: unknown) => Object.defineProperty(doc, 'capabilities', { value: capabilities, configurable: true, writable: true });
  beforeEach(() => {
    setCapabilities(undefined);
    resetAdded(DOC);
  });

  it('every attached source adds its bytes; Discard (a reload from disk) and closing the document start the count again', async () => {
    expect(addedBytesOf(DOC)).toBe(0);
    await attachSourceLogged(DOC, new ArrayBuffer(1000));
    await attachSourceLogged(DOC, new ArrayBuffer(500), 'test123');
    expect(addedBytesOf(DOC)).toBe(1500);
    await discardRecovered(DOC);
    expect(addedBytesOf(DOC)).toBe(0);
    await attachSourceLogged(DOC, new ArrayBuffer(200));
    forgetEditState(DOC);
    expect(addedBytesOf(DOC)).toBe(0);
  });

  it('the sources a replay attaches count too', async () => {
    await attachSourceLogged(DOC, new ArrayBuffer(300));
    await applyPageEdits(DOC, [{ ...insertFromLocked, sourceDocId: 'src-plain' }]);
    await settle();
    forgetEditState(DOC);
    bridge.recovery.readStash.mockImplementation((async () => new ArrayBuffer(300)) as never);
    await restoreEditLog(DOC, PATH);
    expect(addedBytesOf(DOC)).toBe(300);
    bridge.recovery.readStash.mockImplementation(async () => null);
  });

  it('a view-only document takes no replay: the log stays on disk and the bar says the edits were not restored', async () => {
    await applyPageEdits(DOC, [rotate]);
    await settle();
    expect(await onDisk()).toBe(1);
    forgetEditState(DOC);
    doc.applyEdits.mockClear();
    setCapabilities({ canEdit: false, htmlLayer: false, viewOnly: true });
    await restoreEditLog(DOC, PATH);
    expect(doc.applyEdits).not.toHaveBeenCalled();
    expect(useEditStore.getState().notRestored[DOC]).toBe('failed');
    expect(useEditStore.getState().recovered[DOC]).toBeUndefined();
    expect(await onDisk()).toBe(1);
  });

  it('a file that has grown past 1 GB gives the 1 GB message on Discard, and the recovery log is not deleted', async () => {
    await applyPageEdits(DOC, [rotate]);
    await settle();
    bridge.files.read.mockResolvedValueOnce({ ok: false, reason: 'too-large' } as never);
    await expect(discardRecovered(DOC)).rejects.toThrow('This file is too large to open (the limit is 1 GB).');
    expect(await onDisk()).toBe(1);
    expect(replaceDocument).not.toHaveBeenCalled();
  });
});
