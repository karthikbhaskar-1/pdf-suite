// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeMupdf, openMupdfMock, registry, noteOpened, bridge, startDiskWatch } = vi.hoisted(() => {
  class FakeMupdf {
    save = vi.fn(async () => ({ bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] }));
    attachSource = vi.fn(async () => ({ sourceDocId: 'src1', pages: 1 }));
    fingerprints = vi.fn(async () => [1]);
    destroy = vi.fn(async () => undefined);
  }
  const fresh = new FakeMupdf();
  // A keyed stand-in for DocumentRegistry: entries by docId, with the same rekey rule (the new id must be free).
  const entries = new Map<string, { docId: string; doc: FakeMupdf; pageCount: number }>();
  return {
    FakeMupdf,
    openMupdfMock: vi.fn(async () => ({ document: () => fresh, discard: () => undefined, xfa: {}, bytes: new ArrayBuffer(0) })),
    registry: {
      fresh,
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
    noteOpened: vi.fn(),
    bridge: {
      files: {
        stat: vi.fn(async () => ({ size: 10, modified: 1 })),
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
    startDiskWatch: vi.fn((_options: { path: string }) => () => undefined),
  };
});

vi.mock('../../app/services', () => ({
  documentRegistry: registry,
  fileService: { noteOpened },
}));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeMupdf, openMupdf: openMupdfMock }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));
vi.mock('./diskWatch', () => ({ startDiskWatch }));

import { recoveryKeysFor } from '../recovery/recoveryKey';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { pathDocId, rememberFileStamp, saveDocument, savePathOf, resetSaveState } from './saveDocument';

const DOC = 'path:C:\\old.pdf';
const OLD = 'C:\\old.pdf';
const NEW = 'C:\\Docs\\me\\new.pdf';
const NEW_DOC = `path:${NEW}`;

beforeEach(() => {
  vi.clearAllMocks();
  resetSaveState();
  registry.entries.clear();
  const doc = new FakeMupdf() as never;
  registry.entries.set(DOC, { docId: DOC, doc, pageCount: 1 });
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

describe('Save As re-keys the document to the new file', () => {
  it('moves the tab, the name, the recent list and the disk watch, and later saves go to the new path', async () => {
    await rememberFileStamp(OLD);
    const outcome = await saveDocument(DOC, { saveAs: true });
    expect(outcome).toEqual({ status: 'saved', path: NEW, mode: 'full' });

    // The tab shows the new file, and its pane is keyed by the new document id.
    const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === 'tab1')!;
    expect(tab.origin).toEqual({ kind: 'path', path: NEW });
    expect(tab.title).toBe('new.pdf');
    expect(tab.panes[0]?.docId).toBe(NEW_DOC);
    // The shared document record moves with it and takes the new name.
    expect(useDocumentsStore.getState().docs[DOC]).toBeUndefined();
    expect(useDocumentsStore.getState().docs[NEW_DOC]?.name).toBe('new.pdf');
    // The recent list gets the new file.
    expect(noteOpened).toHaveBeenCalledWith({ kind: 'path', path: NEW, name: 'new.pdf' });
    // The disk watch is moved: the old one stopped, a new one watches the new file.
    const lastWatch = startDiskWatch.mock.calls.at(-1)?.[0];
    expect(lastWatch?.path).toBe(NEW);
    // The document now saves to the new path.
    expect(savePathOf(NEW_DOC)).toBe(NEW);
  });

  it('closes an open side sheet of the old id (its stored pages and id would be stale)', async () => {
    await rememberFileStamp(OLD);
    useSheetStore.getState().open({ kind: 'confirmDelete', docId: DOC, uids: ['0'], total: 1 });
    await saveDocument(DOC, { saveAs: true });
    expect(useSheetStore.getState().sheet).toBeNull();
  });

  it('a later plain Save writes to the new path without asking for a file', async () => {
    await rememberFileStamp(OLD);
    await saveDocument(DOC, { saveAs: true });
    bridge.files.saveDialog.mockClear();
    bridge.files.saveAtomic.mockClear();
    const outcome = await saveDocument(NEW_DOC);
    expect(outcome).toEqual({ status: 'saved', path: NEW, mode: 'full' });
    expect(bridge.files.saveDialog).not.toHaveBeenCalled();
    expect(bridge.files.saveAtomic.mock.calls[0]?.[0]).toBe(NEW);
  });

  it('a save clears the recovery logs of both files', async () => {
    await rememberFileStamp(OLD);
    await saveDocument(DOC, { saveAs: true });
    // The logs of both files were cleared. Each file is cleared under its canonical key and under the key an earlier version
    // used (the path as typed), so a log written by an older version goes too (1.5.1 R10): two files, four keys.
    const cleared = new Set(bridge.recovery.clear.mock.calls.map((call: unknown[]) => call[0]));
    expect(cleared).toEqual(new Set([...(await recoveryKeysFor(OLD)), ...(await recoveryKeysFor(NEW))]));
  });

  it('frees the old path: it is no longer open, so opening it again loads the old file fresh', async () => {
    await rememberFileStamp(OLD);
    await saveDocument(DOC, { saveAs: true });
    // The saved document lives under the new path only. Nothing is keyed by the old path any more, so a new open of the
    // old file reads it from disk instead of sharing the document that was saved to the new file.
    expect(registry.entries.has(DOC)).toBe(false);
    expect(registry.entries.has(pathDocId(OLD))).toBe(false);
    expect(registry.entries.get(NEW_DOC)?.docId).toBe(NEW_DOC);
  });

  it('refuses to save over a file that another tab has open, and writes nothing', async () => {
    registry.entries.set(NEW_DOC, { docId: NEW_DOC, doc: new FakeMupdf() as never, pageCount: 1 });
    await expect(saveDocument(DOC, { saveAs: true })).rejects.toThrow(/open in another tab/);
    expect(bridge.files.saveAtomic).not.toHaveBeenCalled();
    // The document is unchanged: still open under its own id, still saving to its old path.
    expect(registry.entries.has(DOC)).toBe(true);
  });
});
