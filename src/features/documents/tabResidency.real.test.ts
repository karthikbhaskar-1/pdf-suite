// @vitest-environment node
// Background tabs (1.5.4) against the REAL document registry, the REAL save module (stamps, Keep my version, Save As) and the
// REAL open flow. Only the engine (a fake document), the desktop bridge (a fake disk) and the disk watch timer are stand-ins.
// These cover the cases the mock-based tests in tabResidency.test.ts cannot: what the registry hides while a document is
// released, and what the other modules do to it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class FakeMupdf {
    static opened = 0;
    static pages = 3;
    readonly generation = ++FakeMupdf.opened;
    readonly pageCount = FakeMupdf.pages;
    readonly isEncrypted = false;
    readonly capabilities = { canEdit: true, htmlLayer: false };
    destroy = vi.fn(async () => undefined);
    pageSize = vi.fn(async () => ({ width: 612, height: 792, rotation: 0 }));
    save = vi.fn(async () => ({ bytes: new ArrayBuffer(8), mode: 'full' as const, fingerprints: [1] }));
  }
  const disk = new Map<string, { size: number; modified: number; sample?: string } | null>();
  const bridge = {
    files: {
      stat: vi.fn(async (path: string) => {
        const stat = disk.get(path);
        return stat ? { ...stat } : null;
      }),
      read: vi.fn(async (_path: string) => ({ ok: true, bytes: new ArrayBuffer(8) })),
      saveDialog: vi.fn(async () => null as string | null),
      saveAtomic: vi.fn(async () => ({ ok: true })),
      documentOpened: vi.fn(async () => true),
      documentClosed: vi.fn(async () => undefined),
    },
    recovery: {
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => null),
      writeStash: vi.fn(async () => undefined),
      readStash: vi.fn(async () => null),
      list: vi.fn(async () => []),
      clear: vi.fn(async () => undefined),
      setAside: vi.fn(async () => true),
      clearPrevious: vi.fn(async () => undefined),
    },
  };
  return { FakeMupdf, disk, bridge, engineOpen: vi.fn() };
});

vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: h.FakeMupdf, openMupdf: vi.fn() }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => h.bridge }));
vi.mock('../../platform/recovery/fileCache', () => ({ putFile: vi.fn(async () => undefined) }));
vi.mock('./diskWatch', () => ({ startDiskWatch: vi.fn(() => () => undefined) }));
vi.mock('../../app/services', async () => {
  const { DocumentRegistry, defaultHasher } = await vi.importActual<typeof import('../../engine/documentRegistry')>('../../engine/documentRegistry');
  const { useEditStore } = await import('../../core/stores/editStore');
  const { residencyHooks } = await import('./residencyHooks');
  const { mirrorPageEvent } = await import('./pageSync');
  const { PdfOpenError } = await vi.importActual<typeof import('../../engine/errors')>('../../engine/errors');
  const engine = {
    open: async (source: { kind: string; path?: string }) => {
      if (source.kind === 'path') {
        const read = await h.bridge.files.read(source.path!);
        if (!read.ok) throw new PdfOpenError('Missing');
      }
      h.engineOpen();
      return new h.FakeMupdf();
    },
  };
  // The same wiring as app/services.ts, without the engine's page-list listener: the page list of a fake document is 0..n-1.
  const documentRegistry = new DocumentRegistry(
    engine as never,
    defaultHasher,
    (docId, doc) => {
      useEditStore.getState().clear(docId);
      useEditStore.getState().setCanEdit(docId, true);
      const uids = Array.from({ length: doc.pageCount }, (_, i) => String(i));
      useEditStore.getState().setPages(docId, { version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } });
      // The page list reaches the documents store the way the engine's page event does (app/services.ts).
      mirrorPageEvent(docId, { uids, revs: uids.map(() => 0) }, (doc as { generation?: number }).generation);
      residencyHooks.opened(docId);
    },
    undefined,
    (docId) => residencyHooks.closed(docId),
  );
  return { documentRegistry, fileService: { noteOpened: vi.fn() } };
});

import { documentRegistry } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { openSource } from './documentService';
import { BACKGROUND_IDLE_MS } from './residencyRule';
import { fileStampOf, keepMyVersion, pathDocId, resetSaveState, saveDocument } from './saveDocument';
import { CHANGED_NOTICE, resetResidency, sweepBackground, useResidencyStore } from './tabResidency';

const PATH_A = 'C:\\docs\\a.pdf';
const PATH_B = 'C:\\docs\\b.pdf';
const A = pathDocId(PATH_A);
const B = pathDocId(PATH_B);
const S0 = { size: 1000, modified: 5, sample: 'one' };
const S1 = { size: 2000, modified: 9, sample: 'two' };
const T0 = 5_000_000;
const LATER = T0 + BACKGROUND_IDLE_MS + 1;
const src = (path: string) => ({ kind: 'path' as const, path, name: path.split('\\').pop()! });

/** Opens A, then B (B is shown), lets the page sizes finish, and starts the clock. */
async function openBoth(): Promise<void> {
  await openSource(src(PATH_A));
  await openSource(src(PATH_B));
  await vi.waitFor(() => {
    for (const id of [A, B]) expect(useDocumentsStore.getState().docs[id]?.sizes.every((s) => s !== undefined)).toBe(true);
  });
  await sweepBackground(T0);
}

beforeEach(() => {
  resetResidency();
  resetSaveState();
  h.FakeMupdf.opened = 0;
  h.FakeMupdf.pages = 3;
  h.engineOpen.mockClear();
  h.disk.clear();
  h.disk.set(PATH_A, S0);
  h.disk.set(PATH_B, { size: 500, modified: 1, sample: 'b' });
  for (const id of [A, B]) while (documentRegistry.refCount(id) > 0) documentRegistry.release(id);
  useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null });
  useDocumentsStore.setState({ docs: {} });
  useEditStore.setState({ byDoc: {}, changedOnDisk: {}, saving: {}, progress: {}, selected: {} });
  useUiStore.setState({ toasts: [] });
});

describe('the worker of a document is ended only when the file is what the app opened or saved', () => {
  it('control: an untouched file is released after 60 s, with the real registry hiding it and keeping its references', async () => {
    await openBoth();
    const done = await sweepBackground(LATER);
    expect(done.workers).toEqual([A]);
    expect(documentRegistry.isSuspended(A)).toBe(true);
    expect(documentRegistry.get(A)).toBeUndefined();
    expect(documentRegistry.refCount(A)).toBe(1);
    expect(h.bridge.files.documentClosed).not.toHaveBeenCalled();
  });

  it('after "Keep my version" the worker is kept: the user\'s version is only in the engine', async () => {
    await openBoth();
    h.disk.set(PATH_A, S1); // another program wrote the file
    await keepMyVersion(A); // acknowledged = the disk's stamp; the document is not dirty
    expect(useEditStore.getState().changedOnDisk[A]).toBe(false);
    const done = await sweepBackground(LATER);
    expect(done.workers).toEqual([]);
    expect(documentRegistry.isSuspended(A)).toBe(false);
  });

  it('with no stamp recorded for the file the worker is kept (changedBeforeSave(undefined, ...) would call it unchanged)', async () => {
    h.disk.set(PATH_A, null); // the stat at open time answers nothing
    await openSource(src(PATH_A));
    h.disk.set(PATH_A, S0);
    await openSource(src(PATH_B));
    await vi.waitFor(() => expect(useDocumentsStore.getState().docs[B]?.sizes.every((s) => s !== undefined)).toBe(true));
    await sweepBackground(T0);
    expect(fileStampOf(PATH_A)).toBeUndefined();
    const done = await sweepBackground(LATER);
    expect(done.workers).toEqual([]);
  });

  it('a file whose content sample changed with the same size and time is kept', async () => {
    await openBoth();
    h.disk.set(PATH_A, { ...S0, sample: 'other' });
    expect((await sweepBackground(LATER)).workers).toEqual([]);
  });
});

describe('Save As over a file that a released tab has open', () => {
  it('is refused, like Save As over a file open in a live tab', async () => {
    await openBoth();
    expect((await sweepBackground(LATER)).workers).toEqual([A]);
    h.bridge.files.saveAtomic.mockClear();
    await expect(saveDocument(B, { targetPath: PATH_A })).rejects.toThrow('That file is open in another tab');
    expect(h.bridge.files.saveAtomic).not.toHaveBeenCalled();
    expect(documentRegistry.isSuspended(A)).toBe(true);
  });
});

describe('opening the same file again while its tab is released', () => {
  it('reopens it first, with the stamp check: a file changed meanwhile gives the notice, a new stamp and fresh pages, and the registry opens it once', async () => {
    await openBoth();
    expect((await sweepBackground(LATER)).workers).toEqual([A]);
    expect(h.engineOpen).toHaveBeenCalledTimes(2);
    h.disk.set(PATH_A, S1);
    h.FakeMupdf.pages = 5; // the file now has five pages

    await openSource(src(PATH_A)); // from Recent, a drop, or Ctrl+O

    expect(h.engineOpen).toHaveBeenCalledTimes(3); // not 4: the second tab shares the reopened document
    expect(documentRegistry.isSuspended(A)).toBe(false);
    expect(documentRegistry.refCount(A)).toBe(2);
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([CHANGED_NOTICE]);
    expect(fileStampOf(PATH_A)).toEqual(S1); // the stamp is the file as it is now: the base of a save and of the recovery log
    expect(useEditStore.getState().changedOnDisk[A]).toBeFalsy();
    expect(useDocumentsStore.getState().docs[A]?.pageCount).toBe(5);
    expect(useResidencyStore.getState().state).toEqual({});
    const tabs = useWorkspaceStore.getState().tabs.filter((t) => t.panes[0]?.docId === A);
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => t.status.kind === 'ready')).toBe(true);
  });

  it('an unchanged file reopens without a notice and keeps its stamp', async () => {
    await openBoth();
    await sweepBackground(LATER);
    await openSource(src(PATH_A));
    expect(h.engineOpen).toHaveBeenCalledTimes(3);
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(fileStampOf(PATH_A)).toEqual(S0);
    expect(documentRegistry.get(A)).toBeDefined();
  });

  it('a file that was deleted meanwhile shows the file-gone message in the new tab, and the document stays released', async () => {
    await openBoth();
    await sweepBackground(LATER);
    h.disk.set(PATH_A, null);
    h.bridge.files.read.mockResolvedValueOnce({ ok: false, reason: 'missing' } as never);
    await openSource(src(PATH_A));
    const tabs = useWorkspaceStore.getState().tabs.filter((t) => t.title === 'a.pdf');
    expect(tabs.every((t) => t.status.kind === 'error')).toBe(true);
    expect(documentRegistry.isSuspended(A)).toBe(true);
  });
});
