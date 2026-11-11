// @vitest-environment node
// Data-loss paths (1.5.8 review, V3 and V4) against the REAL registry, stores, close prompt and open flow: a split pane or
// Close others giving up a document with unsaved edits asks first, and a restored split's second document is opened like a
// tab's. Only the engine (a fake document), the desktop bridge (a fake disk) and the disk watch timer are stand-ins.
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
      read: vi.fn(async (_key: string) => null as string | null),
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
vi.mock('../documents/diskWatch', () => ({ startDiskWatch: vi.fn(() => () => undefined) }));
vi.mock('../../platform/recovery/snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/recovery/snapshot')>()),
  loadSnapshot: vi.fn(async () => null),
  saveSnapshot: vi.fn(async () => undefined),
}));
vi.mock('../../app/services', async () => {
  const { DocumentRegistry, defaultHasher } = await vi.importActual<typeof import('../../engine/documentRegistry')>('../../engine/documentRegistry');
  const { useEditStore } = await import('../../core/stores/editStore');
  const { residencyHooks } = await import('../documents/residencyHooks');
  const { mirrorPageEvent } = await import('../documents/pageSync');
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
import { startDiskWatch } from '../documents/diskWatch';
import { answerClosePrompt, closeTabWithPrompt, promptDocIds } from '../documents/closeFlow';
import { openSource } from '../documents/documentService';
import { fileStampOf, pathDocId, rekeyDocument, resetSaveState } from '../documents/saveDocument';
import { resetResidency } from '../documents/tabResidency';
import { loadSnapshot } from '../../platform/recovery/snapshot';
import { recoveryKeysFor } from '../recovery/recoveryKey';
import { restoreSession } from '../recovery/recoveryService';
import { closeOtherTabs, closeTabsToRight } from '../tabs/tabActions';
import { closeSplit, openInSplit, switchPaneDocument } from './splitActions';

const PATH_A = 'C:\\docs\\a.pdf';
const PATH_B = 'C:\\docs\\b.pdf';
const PATH_C = 'C:\\docs\\c.pdf';
const A = pathDocId(PATH_A);
const B = pathDocId(PATH_B);
const C = pathDocId(PATH_C);
const PATH_D = 'C:\docs\d.pdf';
const PATH_E = 'C:\docs\e.pdf';
const PATH_F = 'C:\docs\f.pdf';
const PATH_G = 'C:\docs\g.pdf';
const D = pathDocId(PATH_D);
const E = pathDocId(PATH_E);
const F = pathDocId(PATH_F);
const G = pathDocId(PATH_G);
const src = (path: string) => ({ kind: 'path' as const, path, name: path.split('\\').pop()! });
const view = { pageId: null, zoom: 1, fit: 'page' as const, offset: 0, rotation: 0 as const };

function markDirty(docId: string): void {
  const pages = useEditStore.getState().byDoc[docId]!;
  useEditStore.getState().setPages(docId, { ...pages, history: { ...pages.history, dirty: true } });
}

const tabs = () => useWorkspaceStore.getState().tabs;
const isOpen = (docId: string) => useDocumentsStore.getState().docs[docId] !== undefined;
const promptOpen = () => useUiStore.getState().closePrompt;

async function openAB(): Promise<{ t1: string; t2: string }> {
  const t1 = await openSource(src(PATH_A));
  const t2 = await openSource(src(PATH_B));
  await vi.waitFor(() => {
    for (const id of [A, B]) expect(useDocumentsStore.getState().docs[id]?.sizes.every((s) => s !== undefined)).toBe(true);
  });
  return { t1, t2 };
}

beforeEach(() => {
  resetResidency();
  resetSaveState();
  h.FakeMupdf.opened = 0;
  h.FakeMupdf.pages = 3;
  h.disk.clear();
  h.disk.set(PATH_A, { size: 1000, modified: 5, sample: 'a' });
  h.disk.set(PATH_B, { size: 500, modified: 1, sample: 'b' });
  h.disk.set(PATH_C, { size: 700, modified: 2, sample: 'c' });
  h.disk.set(PATH_D, { size: 800, modified: 3, sample: 'd' });
  h.disk.set(PATH_E, { size: 900, modified: 4, sample: 'e' });
  h.disk.set(PATH_F, { size: 910, modified: 4, sample: 'f' });
  h.disk.set(PATH_G, { size: 920, modified: 4, sample: 'g' });
  for (const id of [A, B, C, D, E, F, G]) while (documentRegistry.refCount(id) > 0) documentRegistry.release(id);
  useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null });
  useDocumentsStore.setState({ docs: {} });
  useEditStore.setState({ byDoc: {}, changedOnDisk: {}, saving: {}, progress: {}, selected: {} });
  useUiStore.setState({ toasts: [] });
  h.bridge.recovery.read.mockClear();
  vi.mocked(startDiskWatch).mockClear();
});

describe('a split pane giving up a document asks about its unsaved edits (finding 1)', () => {
  it('both pickers on B: the second one would close A, so the Save prompt asks; Cancel keeps the pane, Dont save closes A', async () => {
    const { t1 } = await openAB();
    markDirty(A);
    openInSplit(t1, 'vertical');
    const [p1, p2] = tabs().find((t) => t.id === t1)!.panes;

    await switchPaneDocument(t1, p1!.id, B); // A is still shown by pane 2
    expect(isOpen(A)).toBe(true);
    expect(promptOpen()).toBe(false);

    const pending = switchPaneDocument(t1, p2!.id, B); // pane 2 holds A's last reference
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    expect(promptDocIds()).toEqual([A]);
    await answerClosePrompt('cancel');
    await pending;
    expect(tabs().find((t) => t.id === t1)!.panes[1]!.docId).toBe(A);
    expect(isOpen(A)).toBe(true);
    expect(documentRegistry.refCount(A)).toBe(1);
    expect(documentRegistry.refCount(B)).toBe(2); // the tab of B and pane 1: the reference taken for pane 2 went back
    expect(useEditStore.getState().byDoc[A]!.history.dirty).toBe(true);

    const again = switchPaneDocument(t1, p2!.id, B);
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    await answerClosePrompt('discard');
    await again;
    expect(tabs().find((t) => t.id === t1)!.panes.map((p) => p.docId)).toEqual([B, B]);
    expect(isOpen(A)).toBe(false);
    expect(documentRegistry.refCount(A)).toBe(0);
    expect(documentRegistry.refCount(B)).toBe(3);
  });

  it('a clean document is released without a prompt', async () => {
    const { t1 } = await openAB();
    openInSplit(t1, 'vertical');
    const [p1, p2] = tabs().find((t) => t.id === t1)!.panes;
    await switchPaneDocument(t1, p1!.id, B);
    await switchPaneDocument(t1, p2!.id, B);
    expect(promptOpen()).toBe(false);
    expect(isOpen(A)).toBe(false);
  });

  it("close B's own tab, then close the split: B (held only by pane 2) asks first", async () => {
    const { t1, t2 } = await openAB();
    openInSplit(t1, 'vertical');
    const p2 = tabs().find((t) => t.id === t1)!.panes[1]!;
    await switchPaneDocument(t1, p2.id, B);
    markDirty(B);
    await closeTabWithPrompt(t2); // B is still shown by the split: no prompt
    expect(promptOpen()).toBe(false);
    expect(isOpen(B)).toBe(true);

    const pending = closeSplit(t1);
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    expect(promptDocIds()).toEqual([B]);
    await answerClosePrompt('cancel');
    await pending;
    expect(tabs().find((t) => t.id === t1)!.panes).toHaveLength(2);
    expect(isOpen(B)).toBe(true);

    const again = closeSplit(t1);
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    await answerClosePrompt('discard');
    await again;
    expect(tabs().find((t) => t.id === t1)!.panes).toHaveLength(1);
    expect(tabs().find((t) => t.id === t1)!.split).toBeNull();
    expect(isOpen(B)).toBe(false);
    expect(isOpen(A)).toBe(true);
  });
});

describe('a Save As during the prompt renames the document under the pane', () => {
  const RENAMED = pathDocId('C:\docs\b-renamed.pdf');

  it('closeSplit releases the current id of the pane, not the one read before the prompt', async () => {
    const { t1, t2 } = await openAB();
    openInSplit(t1, 'vertical');
    const p2 = tabs().find((t) => t.id === t1)!.panes[1]!;
    await switchPaneDocument(t1, p2.id, B);
    markDirty(B);
    await closeTabWithPrompt(t2); // only pane 2 holds B now

    const pending = closeSplit(t1);
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    expect(rekeyDocument(B, RENAMED)).toBe(true); // what Save As in the prompt does
    expect(tabs().find((t) => t.id === t1)!.panes[1]!.docId).toBe(RENAMED);
    await answerClosePrompt('discard');
    await pending;

    expect(tabs().find((t) => t.id === t1)!.panes).toHaveLength(1);
    expect(documentRegistry.refCount(RENAMED)).toBe(0);
    expect(isOpen(RENAMED)).toBe(false);
    expect(isOpen(B)).toBe(false);
  });

  it('switchPaneDocument does the same for the pane it moves away from the renamed document', async () => {
    const { t1 } = await openAB();
    openInSplit(t1, 'vertical');
    const [p1, p2] = tabs().find((t) => t.id === t1)!.panes;
    await switchPaneDocument(t1, p1!.id, B);
    markDirty(A);
    const pending = switchPaneDocument(t1, p2!.id, B); // pane 2 holds A's last reference
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    const RENAMED_A = pathDocId('C:\docs\a-renamed.pdf');
    expect(rekeyDocument(A, RENAMED_A)).toBe(true);
    await answerClosePrompt('discard');
    await pending;
    expect(tabs().find((t) => t.id === t1)!.panes.map((p) => p.docId)).toEqual([B, B]);
    expect(documentRegistry.refCount(RENAMED_A)).toBe(0);
    expect(isOpen(RENAMED_A)).toBe(false);
  });
});

describe('Close others and Close right ask about unsaved edits (V4)', () => {
  async function openThree(): Promise<string[]> {
    return [await openSource(src(PATH_A)), await openSource(src(PATH_B)), await openSource(src(PATH_C))];
  }

  it('two dirty tabs: one prompt lists both, Cancel closes nothing, Dont save closes them', async () => {
    const [ta, tb, tc] = await openThree();
    markDirty(B);
    markDirty(C);
    const pending = closeOtherTabs(ta!);
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    expect(promptDocIds().sort()).toEqual([B, C].sort());
    await answerClosePrompt('cancel');
    await pending;
    expect(tabs().map((t) => t.id)).toEqual([ta, tb, tc]);
    expect(useEditStore.getState().byDoc[B]!.history.dirty).toBe(true);
    expect(useEditStore.getState().byDoc[C]!.history.dirty).toBe(true);

    const again = closeOtherTabs(ta!);
    await vi.waitFor(() => expect(promptOpen()).toBe(true));
    await answerClosePrompt('discard');
    await again;
    expect(tabs().map((t) => t.id)).toEqual([ta]);
    expect(useWorkspaceStore.getState().activeTabId).toBe(ta);
    expect(isOpen(B) || isOpen(C)).toBe(false);
  });

  it('Close right asks only about the tabs to the right; a dirty tab on the left is not part of it', async () => {
    const [ta, tb] = await openThree();
    markDirty(A);
    await closeTabsToRight(tb!);
    expect(promptOpen()).toBe(false);
    expect(tabs().map((t) => t.id)).toEqual([ta, tb]);
  });
});

// Fresh paths: the disk watch of a document id is kept for the whole run, so A and B (watched by the tests above) would hide a missing watch.
describe("the second document of a restored split is opened like a tab's (finding 3)", () => {
  const split = { orientation: 'vertical' as const, ratio: 0.5, syncScroll: true, second: { title: 'b.pdf', origin: { kind: 'path' as const, path: PATH_E }, view } };

  it('its recovery log is looked up, its file stamped and watched, though no tab of its own opened it first', async () => {
    vi.mocked(loadSnapshot).mockResolvedValueOnce({
      version: 1,
      activeIndex: 0,
      tabs: [{ title: 'a.pdf', origin: { kind: 'path', path: PATH_D }, view, split }],
    });
    await restoreSession();
    expect(tabs()[0]!.panes.map((p) => p.docId)).toEqual([D, E]);
    const keys = await recoveryKeysFor(PATH_E);
    await vi.waitFor(() => expect(h.bridge.recovery.read.mock.calls.map((c) => c[0])).toContain(keys[0]));
    expect(fileStampOf(PATH_E)).toBeDefined();
    expect(vi.mocked(startDiskWatch).mock.calls.map((c) => c[0].path)).toContain(PATH_E);
  });

  it("when B's own tab opens as well, the first-open steps run once for the document", async () => {
    vi.mocked(loadSnapshot).mockResolvedValueOnce({
      version: 1,
      activeIndex: 0,
      tabs: [
        { title: 'a.pdf', origin: { kind: 'path', path: PATH_F }, view, split: { ...split, second: { ...split.second, origin: { kind: 'path' as const, path: PATH_G } } } },
        { title: 'b.pdf', origin: { kind: 'path', path: PATH_G }, view },
      ],
    });
    await restoreSession();
    const keys = await recoveryKeysFor(PATH_G);
    await vi.waitFor(() => expect(h.bridge.recovery.read).toHaveBeenCalled());
    expect(h.bridge.recovery.read.mock.calls.filter((c) => c[0] === keys[0])).toHaveLength(1);
    expect(vi.mocked(startDiskWatch).mock.calls.filter((c) => c[0].path === PATH_G)).toHaveLength(1);
    expect(documentRegistry.refCount(G)).toBe(2);
  });
});
