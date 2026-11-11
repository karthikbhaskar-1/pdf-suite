// @vitest-environment node
// A save changes nothing in the app until the bytes are known to hold what is on screen AND are on the disk. A write that
// fails, or bytes that do not match the page list, leave the document unsaved, with its recovery log, ready to try again.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeMupdf, openMupdfMock, registry, bridge, fresh } = vi.hoisted(() => {
  class FakeMupdf {
    save = vi.fn(async () => ({ bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [11, 22, 33] }));
    fingerprints = vi.fn(async () => [11, 22, 33]);
    destroy = vi.fn(async () => undefined);
  }
  const fresh = new FakeMupdf();
  const entries = new Map<string, { docId: string; doc: FakeMupdf; pageCount: number }>();
  return {
    FakeMupdf,
    fresh,
    openMupdfMock: vi.fn(async () => ({ document: () => fresh, discard: () => undefined, xfa: {}, bytes: new ArrayBuffer(0) })),
    registry: {
      entries,
      get: vi.fn((docId: string) => entries.get(docId)),
      replaceDocument: vi.fn(() => true),
      // Spellings of one path are joined by the real registry; the tests here open one spelling.
      sameFileId: (id: string) => id,
      isSuspended: () => false,
      rekey: vi.fn(() => true),
    },
    bridge: {
      files: {
        stat: vi.fn(async () => ({ size: 10, modified: 1 })),
        saveDialog: vi.fn(async () => 'C:\Docs\me\other.pdf' as string | null),
        saveAtomic: vi.fn(async (_path: string, _bytes: unknown): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
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
  };
});

vi.mock('../../app/services', () => ({ documentRegistry: registry, fileService: { noteOpened: vi.fn() } }));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeMupdf, openMupdf: openMupdfMock }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));
vi.mock('./diskWatch', () => ({ startDiskWatch: vi.fn(() => () => undefined) }));

import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useEditStore } from '../../core/stores/editStore';
import { rememberFileStamp, resetSaveState, saveDocument, UNDO_LOST_SENTENCE } from './saveDocument';

const PATH = 'C:\old.pdf';
const DOC = `path:${PATH}`;
const FAILED = /could not be saved/;

beforeEach(() => {
  vi.clearAllMocks();
  resetSaveState();
  registry.entries.clear();
  registry.entries.set(DOC, { docId: DOC, doc: new FakeMupdf() as never, pageCount: 3 });
  fresh.fingerprints.mockImplementation(async () => [11, 22, 33]);
  bridge.files.saveAtomic.mockImplementation(async () => ({ ok: true }));
  useWorkspaceStore.setState({
    tabs: [{ id: 'tab1', title: 'old.pdf', origin: { kind: 'path', path: PATH }, status: { kind: 'ready' }, panes: [{ id: 'pane1', docId: DOC, view: { pageId: '0', zoom: 1, fit: 'width', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 'tab1',
  } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'old.pdf', pageCount: 3, pages: [], sizes: [], byteSize: 10 } } } as never);
});

const history = (dirty: boolean) => ({ dirty, canUndo: dirty, canRedo: false, undoLabel: null, redoLabel: null });

describe('the failed-save message', () => {
  it('says the changes can no longer be undone when there are changes', async () => {
    await rememberFileStamp(PATH);
    useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: [], revs: [], sizes: null, history: history(true) } } } as never);
    bridge.files.saveAtomic.mockImplementationOnce(async () => ({ ok: false, reason: 'unreadable' }));
    await expect(saveDocument(DOC)).rejects.toThrow(`Check that it is not open in another program.${UNDO_LOST_SENTENCE}`);
  });

  it('does not say it for a document with no changes', async () => {
    await rememberFileStamp(PATH);
    useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: [], revs: [], sizes: null, history: history(false) } } } as never);
    bridge.files.saveAtomic.mockImplementationOnce(async () => ({ ok: false, reason: 'unreadable' }));
    await expect(saveDocument(DOC)).rejects.toThrow(/^The file could not be saved. Check that it is not open in another program.$/);
  });
});

describe('a save that did not write the edits changes nothing', () => {
  it('writes nothing, and keeps the document and its recovery log, when the reopened pages do not match', async () => {
    await rememberFileStamp(PATH);
    fresh.fingerprints.mockImplementation(async () => [11, 33, 22]);
    await expect(saveDocument(DOC)).rejects.toThrow(/did not match/);
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(registry.replaceDocument).not.toHaveBeenCalled();
    expect(bridge.recovery.clear).not.toHaveBeenCalled();
    expect(fresh.destroy).toHaveBeenCalled();
  });

  it('rejects bytes with a different page count the same way', async () => {
    await rememberFileStamp(PATH);
    fresh.fingerprints.mockImplementation(async () => [11, 22]);
    await expect(saveDocument(DOC)).rejects.toThrow(/did not match/);
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(bridge.recovery.clear).not.toHaveBeenCalled();
  });

  it('a failed write keeps everything, and the next save writes and then clears', async () => {
    await rememberFileStamp(PATH);
    bridge.files.saveAtomic.mockImplementationOnce(async () => ({ ok: false, reason: 'unreadable' }));
    await expect(saveDocument(DOC)).rejects.toThrow(FAILED);
    expect(registry.replaceDocument).not.toHaveBeenCalled();
    expect(bridge.recovery.clear).not.toHaveBeenCalled();
    expect(fresh.destroy).toHaveBeenCalledTimes(1);
    const outcome = await saveDocument(DOC);
    expect(outcome).toMatchObject({ status: 'saved', path: PATH });
    expect(bridge.files.saveAtomic).toHaveBeenCalledTimes(2);
    expect(registry.replaceDocument).toHaveBeenCalledTimes(1);
    expect(bridge.recovery.clear).toHaveBeenCalled();
  });

  it('two failed saves in a row, then a good one', async () => {
    await rememberFileStamp(PATH);
    bridge.files.saveAtomic.mockImplementationOnce(async () => ({ ok: false, reason: 'unreadable' }));
    bridge.files.saveAtomic.mockImplementationOnce(async () => ({ ok: false, reason: 'unreadable' }));
    await expect(saveDocument(DOC)).rejects.toThrow(FAILED);
    await expect(saveDocument(DOC)).rejects.toThrow(FAILED);
    expect(bridge.recovery.clear).not.toHaveBeenCalled();
    await expect(saveDocument(DOC)).resolves.toMatchObject({ status: 'saved' });
  });

  it('a throwing write (not just a refusal) is also a failed save', async () => {
    await rememberFileStamp(PATH);
    bridge.files.saveAtomic.mockImplementationOnce(async () => {
      throw new Error('ipc closed');
    });
    await expect(saveDocument(DOC)).rejects.toThrow(FAILED);
    expect(registry.replaceDocument).not.toHaveBeenCalled();
    expect(bridge.recovery.clear).not.toHaveBeenCalled();
  });

  it('a failed save followed by Save As to another file writes that file', async () => {
    await rememberFileStamp(PATH);
    bridge.files.saveAtomic.mockImplementationOnce(async () => ({ ok: false, reason: 'unreadable' }));
    await expect(saveDocument(DOC)).rejects.toThrow(FAILED);
    const outcome = await saveDocument(DOC, { saveAs: true });
    expect(outcome).toMatchObject({ status: 'saved', path: 'C:\Docs\me\other.pdf' });
  });
});
