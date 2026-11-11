// @vitest-environment node
// Ticket 1.5.1: sequences on ONE document instance, with the real engine core (MuPDF), the real editOps, saveDocument and
// closeFlow, and an in-memory "disk" (files and the recovery folder). Every check reads the result from that disk, the way
// a restart would: the recovery log is replayed onto a fresh copy of the base file and compared with the document that was on
// screen. Nothing here is a mock of the behaviour under test: the stand-ins are only the main process (files, recovery
// folder) and the worker (MupdfCore called directly).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mu from 'mupdf';
import type { PageEdit } from '../../engine/mupdf/protocol';

const OUTLINE = new URL('../../../tests/fixtures/out/outline-6.pdf', import.meta.url);

const hoisted = await vi.hoisted(async () => {
  const mu = await import('mupdf');
  const { MupdfCore } = await import('../../engine/mupdf/core');
  /** What the main process holds: files (bytes and modified time) and the recovery folder. */
  const world = {
    files: new Map<string, { bytes: Uint8Array; modified: number }>(),
    recovery: new Map<string, string>(),
    stashes: new Map<string, ArrayBuffer>(),
    /** The "previous" copies: a log and its stashes moved aside, by key. At most one per key. */
    previous: new Map<string, { log: string; stashes: Map<string, ArrayBuffer> }>(),
    setAsideFails: false,
    readFails: false,
    clock: 1000,
    /** Failure injection for the recovery folder: 'false' makes the main process answer false, 'throw' makes the call reject. */
    writeFails: null as null | 'false' | 'throw',
    stashFails: null as null | 'false' | 'throw',
    /** Failure injection for the file write of a save. */
    saveFails: false,
    saveDialogTarget: 'C:\\docs\\copy.pdf' as string | null,
    log: [] as string[],
    /** Parking places for a restore: a call that reaches a parked name waits until the test lets it go. */
    gates: new Map<string, { reached: () => void; release: Promise<void> }>(),
    park(name: string) {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      const releasePromise = new Promise<void>((resolve) => (release = resolve));
      this.gates.set(name, { reached, release: releasePromise });
      return { reached: reachedPromise, release };
    },
    async hit(name: string) {
      const gate = this.gates.get(name);
      if (!gate) return;
      this.gates.delete(name);
      gate.reached();
      await gate.release;
    },
  };
  const registry = {
    entries: new Map<string, { docId: string; doc: unknown; pageCount: number }>(),
  };
  /** The worker's side, called directly. The page-side surface of MupdfDocument that editOps and saveDocument use. */
  class CoreDoc {
    readonly core = new MupdfCore(mu as never, {});
    version = 0;
    constructor(bytes: Uint8Array) {
      this.core.open(bytes.slice(), undefined);
    }
    onProgress = () => () => undefined;
    async applyEdits(edits: unknown[], _base: number, options: { uidSeed?: number } = {}) {
      if (options.uidSeed !== undefined) await world.hit('apply');
      const result = await this.core.applyEdits(edits as never, undefined, options.uidSeed);
      if (result.changed) this.version += 1;
      return { version: this.version, history: {}, changed: result.changed, uidSeed: result.uidSeed };
    }
    async undo() {
      this.core.undo();
      return {};
    }
    async redo() {
      this.core.redo();
      return {};
    }
    async discardLast() {
      this.core.discardLast();
      return {};
    }
    async attachSource(bytes: ArrayBuffer, password?: string) {
      return this.core.attachSource(new Uint8Array(bytes), password);
    }
    async save(samePath: boolean, diskUnchanged: boolean, dropEncryption?: boolean) {
      return this.core.save(samePath, diskUnchanged, dropEncryption);
    }
    async fingerprints() {
      return this.core.fingerprints();
    }
    async destroy() {
      return undefined;
    }
    /** What is on screen: the page uids and a fingerprint of each page's content, size and rotation. */
    state() {
      return { uids: this.core.editState!.pages().uids, prints: this.core.fingerprints() };
    }
  }
  return { world, registry, CoreDoc };
});
const { world, registry, CoreDoc } = hoisted;
type CoreDoc = InstanceType<typeof CoreDoc>;

vi.mock('../../app/services', () => ({
  documentRegistry: {
    get: (docId: string) => registry.entries.get(docId),
    sameFileId: (id: string) => id,
    isSuspended: () => false,
    replaceDocument: (docId: string, doc: unknown) => {
      const entry = registry.entries.get(docId);
      if (!entry) return false;
      entry.doc = doc;
      return true;
    },
    rekey: (oldId: string, newId: string) => {
      const entry = registry.entries.get(oldId);
      if (!entry || registry.entries.has(newId)) return false;
      registry.entries.delete(oldId);
      registry.entries.set(newId, { ...entry, docId: newId });
      return true;
    },
  },
  fileService: { noteOpened: vi.fn() },
}));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({
  MupdfDocument: hoisted.CoreDoc,
  openMupdf: async (bytes: Uint8Array) => ({ document: () => new hoisted.CoreDoc(bytes) }),
}));
vi.mock('./diskWatch', () => ({ startDiskWatch: () => () => undefined }));
vi.mock('./pageSync', () => ({ remeasurePages: vi.fn() }));
vi.mock('./replacedDocument', () => ({ currentOrder: () => [], remapAfterReplace: vi.fn() }));
vi.mock('./documentService', () => ({ closeTab: vi.fn() }));

/** A cheap content sample: length and a checksum of the first and last 64 KB (the main process makes a SHA-256 of them). */
function sampleOf(bytes: Uint8Array): string {
  let sum = 0;
  for (const b of [...bytes.slice(0, 65536), ...bytes.slice(-65536)]) sum = (sum * 31 + b) >>> 0;
  return `${bytes.length}:${sum}`;
}

/** The disk answers for any spelling of a path, as Windows does. */
function fileAt(path: string) {
  const wanted = canonicalPath(path);
  for (const [name, file] of world.files) if (canonicalPath(name) === wanted) return file;
  return undefined;
}

const bridge = {
  files: {
    stat: async (path: string, withSample?: boolean) => {
      if (withSample) await world.hit('stat');
      const file = fileAt(path);
      if (!file) return null;
      return withSample ? { size: file.bytes.length, modified: file.modified, sample: sampleOf(file.bytes) } : { size: file.bytes.length, modified: file.modified };
    },
    read: async (path: string) => {
      if (world.readFails) return { ok: false, reason: 'unreadable' };
      const file = fileAt(path);
      return file ? { ok: true, bytes: file.bytes.slice().buffer } : { ok: false, reason: 'missing' };
    },
    saveDialog: async () => world.saveDialogTarget,
    saveAtomic: async (path: string, bytes: ArrayBuffer, expected?: { size: number; modified: number }) => {
      if (world.saveFails) return { ok: false, reason: 'write-failed' };
      const now = world.files.get(path);
      if (expected && now && (now.bytes.length !== expected.size || now.modified !== expected.modified)) return { ok: false, reason: 'changed-on-disk' };
      world.files.set(path, { bytes: new Uint8Array(bytes.slice(0)), modified: ++world.clock });
      return { ok: true };
    },
  },
  recovery: {
    write: async (key: string, text: string) => {
      if (world.writeFails === 'throw') throw new Error('disk full');
      if (world.writeFails === 'false') return false;
      world.recovery.set(key, text);
      return true;
    },
    read: async (key: string) => {
      await world.hit('read');
      return world.recovery.get(key) ?? null;
    },
    writeStash: async (key: string, name: string, bytes: ArrayBuffer) => {
      if (world.stashFails === 'throw') throw new Error('locked');
      if (world.stashFails === 'false') return false;
      world.stashes.set(`${key}/${name}`, bytes.slice(0));
      return true;
    },
    readStash: async (key: string, name: string) => {
      await world.hit('stash');
      return world.stashes.get(`${key}/${name}`) ?? null;
    },
    list: async () => [...world.recovery.keys()],
    setAside: async (key: string) => {
      if (world.setAsideFails) return false;
      const log = world.recovery.get(key);
      if (log === undefined) return true;
      const stashes = new Map<string, ArrayBuffer>();
      for (const [name, bytes] of [...world.stashes]) {
        if (name.startsWith(`${key}/`)) {
          stashes.set(name, bytes);
          world.stashes.delete(name);
        }
      }
      world.previous.set(key, { log, stashes });
      world.recovery.delete(key);
      return true;
    },
    clearPrevious: async (key: string) => {
      world.previous.delete(key);
      return true;
    },
    clear: async (key: string) => {
      world.log.push(`clear ${key}`);
      world.recovery.delete(key);
      for (const name of [...world.stashes.keys()]) if (name.startsWith(`${key}/`)) world.stashes.delete(name);
      return true;
    },
  },
};
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));

import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { EditLog, parseEditLog, replayLog } from '../recovery/editLog';
import { canonicalPath, canonicalRecoveryKey, legacyRecoveryKey } from '../recovery/recoveryKey';
import { answerClosePrompt, requestCloseDecision } from './closeFlow';
import {
  applyPageEdits,
  attachSourceLogged,
  discardLastPageEdit,
  discardRecovered,
  dismissNotRestored,
  forgetEditState,
  redoPageEdit,
  restoreEditLog,
  undoPageEdit,
} from './editOps';
import { rememberFileStamp, resetSaveState, saveDocument } from './saveDocument';

const BASE = new Uint8Array(readFileSync(OUTLINE));
const OLD = 'C:\\docs\\report.pdf';
const DOC = `path:${OLD}`;

/** A PDF of `pages` plain pages, used as the source of an insert. */
function sourcePdf(pages: number): ArrayBuffer {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < pages; i++) pdf.insertPage(pdf.countPages(), pdf.addPage([0, 0, 612, 792], 0, {}, `0 g\n${20 + i} 20 100 100 re\nf % S${i}`));
  const out = pdf.saveToBuffer('garbage=compact').asUint8Array().slice().buffer as ArrayBuffer;
  pdf.destroy();
  return out;
}

const live = () => registry.entries.get(DOC)!.doc as CoreDoc;
const uidAt = (i: number) => live().core.editState!.pages().uids[i]!;
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const notice = () => useEditStore.getState().recoveryNotice[DOC];
const notRestored = () => useEditStore.getState().notRestored[DOC];

/** An edit on the page at `index`, by the uid it has now. */
const rotate = (index: number): PageEdit => ({ op: 'rotate', uids: [uidAt(index)], degrees: 90 });
const remove = (index: number): PageEdit => ({ op: 'delete', uids: [uidAt(index)] });
const duplicate = (index: number): PageEdit => ({ op: 'duplicate', uids: [uidAt(index)] });
const blank = (index: number): PageEdit => ({ op: 'insertBlank', afterUid: uidAt(index), size: { width: 612, height: 792 }, template: 'blank' });

/** An edit made in the app: applied, and the document marked as having unsaved changes. */
async function edit(edits: PageEdit[]): Promise<boolean> {
  const changed = await applyPageEdits(DOC, edits);
  useEditStore.setState((state) => ({ byDoc: { ...state.byDoc, [DOC]: { ...state.byDoc[DOC]!, history: { ...state.byDoc[DOC]!.history, dirty: true } } } }) as never);
  return changed;
}

/** The log a restart would find under the canonical key of `path`. */
async function logOnDisk(path = OLD) {
  const text = world.recovery.get(await canonicalRecoveryKey(path));
  return text ? parseEditLog(text) : null;
}

/**
 * THE CRASH: what a restart does with what is on disk. A fresh copy of the base file the log names, the stashes it names,
 * the steps replayed. Returns the state it comes to, or null when there is no log or it is not replayable.
 */
async function replayFromDisk(path = OLD): Promise<{ uids: string[]; prints: number[] } | null> {
  const key = await canonicalRecoveryKey(path);
  const file = await logOnDisk(path);
  if (!file) return null;
  const fresh = new CoreDoc(world.files.get(path)!.bytes);
  await replayLog(file, async (name) => world.stashes.get(`${key}/${name}`) ?? null, {
    attachSource: async (bytes) => (await fresh.attachSource(bytes)).sourceDocId,
    applyStep: async (edits, seed) => void (await fresh.applyEdits(edits, 0, { uidSeed: seed })),
    undoStep: async () => void (await fresh.undo()),
  });
  return fresh.state();
}

beforeEach(async () => {
  world.files.clear();
  world.recovery.clear();
  world.stashes.clear();
  world.previous.clear();
  world.gates.clear();
  world.setAsideFails = false;
  world.readFails = false;
  world.clock = 1000;
  world.writeFails = null;
  world.stashFails = null;
  world.saveFails = false;
  world.saveDialogTarget = 'C:\\docs\\copy.pdf';
  world.log = [];
  registry.entries.clear();
  resetSaveState();
  forgetEditState(DOC);
  useUiStore.setState({ toasts: [] });
  world.files.set(OLD, { bytes: BASE.slice(), modified: world.clock });
  registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
  useEditStore.setState({
    saving: {},
    progress: {},
    recovered: {},
    recoveryNotice: {},
    notRestored: {},
    byDoc: { [DOC]: { version: 0, uids: [], revs: [], sizes: null, history: { dirty: false, canUndo: true, canRedo: true, undoLabel: null, redoLabel: null } } },
  } as never);
  useWorkspaceStore.setState({
    tabs: [{ id: 'tab1', title: 'report.pdf', origin: { kind: 'path', path: OLD }, status: { kind: 'ready' }, panes: [{ id: 'pane1', docId: DOC, view: { pageId: '0', zoom: 1, fit: 'width', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'report.pdf', pageCount: 6, pages: [], sizes: [], byteSize: BASE.length } } } as never);
  // The app saw the file when it opened it (with its content sample).
  await rememberFileStamp(OLD);
});

describe('crash at every step', () => {
  it('after each of six edits a restart brings back exactly the document that was on screen', async () => {
    const steps: Array<() => PageEdit[]> = [
      () => [rotate(0)],
      () => [remove(2)],
      () => [duplicate(1)],
      () => [blank(3)],
      () => [rotate(4), rotate(5)],
      () => [{ op: 'move', uids: [uidAt(0)], beforeUid: uidAt(4) }],
    ];
    for (let i = 0; i < steps.length; i++) {
      await edit(steps[i]!());
      await settle();
      // The write was made when the edit was reported done: a crash NOW loses nothing.
      expect((await logOnDisk())?.steps.length, `log after edit ${i + 1}`).toBe(i + 1);
      expect(await replayFromDisk(), `restart after edit ${i + 1}`).toEqual(live().state());
    }
  });

  it('an edit followed at once by a crash (no wait at all) is already on disk', async () => {
    await edit([rotate(0)]);
    // No settle: the write was started in the same tick as the record, and the in-memory disk answers in a microtask.
    await Promise.resolve();
    expect((await logOnDisk())?.steps.length).toBe(1);
  });

  it('with a source: an insert from another PDF is replayable after the source file is gone', async () => {
    const attached = await attachSourceLogged(DOC, sourcePdf(3));
    await edit([{ op: 'insertFrom', afterUid: uidAt(1), sourceDocId: attached.sourceDocId, sourceUids: ['0', '2'] }]);
    await edit([rotate(0)]);
    await settle();
    expect(await replayFromDisk()).toEqual(live().state());
  });

  it('undo, redo and a discarded step each leave the disk at the state on screen', async () => {
    await edit([rotate(0)]);
    await edit([remove(3)]);
    await edit([duplicate(0)]);
    await settle();
    await undoPageEdit(DOC);
    await settle();
    expect(await replayFromDisk()).toEqual(live().state());
    await undoPageEdit(DOC);
    await settle();
    expect(await replayFromDisk()).toEqual(live().state());
    await redoPageEdit(DOC);
    await settle();
    expect(await replayFromDisk()).toEqual(live().state());
    await redoPageEdit(DOC);
    await discardLastPageEdit(DOC);
    await settle();
    expect(await replayFromDisk()).toEqual(live().state());
    expect((await logOnDisk())?.steps.length).toBe(2);
    // A new edit after an undo replaces the undone steps.
    await edit([rotate(2)]);
    await settle();
    expect(await replayFromDisk()).toEqual(live().state());
  });
});

describe('save, and save after a failure', () => {
  it('edit, edit, save: the file holds the edits, the log is gone, and a crash afterwards restores nothing', async () => {
    await edit([rotate(0)]);
    await edit([remove(2)]);
    await settle();
    const expected = live().state();
    const outcome = await saveDocument(DOC);
    expect(outcome.status).toBe('saved');
    expect(world.recovery.size).toBe(0);
    // The saved file reopens to what was on screen (positions, not uids: a fresh worker numbers uids again).
    expect(new CoreDoc(world.files.get(OLD)!.bytes).state().prints).toEqual(expected.prints);
    // Restart: nothing to restore.
    forgetEditState(DOC);
    await restoreEditLog(DOC, OLD);
    expect(useEditStore.getState().recovered[DOC]).toBeUndefined();
    expect(notRestored()).toBeUndefined();
  });

  it('save, then more edits: the new log is based on the saved file and replays onto it', async () => {
    await edit([rotate(0)]);
    await saveDocument(DOC);
    await edit([remove(1)]);
    await edit([duplicate(0)]);
    await settle();
    expect((await logOnDisk())?.steps.length).toBe(2);
    expect(await replayFromDisk()).toEqual(live().state());
  });

  it('a save whose write fails keeps the log; the next save writes everything and then clears it', async () => {
    await edit([rotate(0)]);
    await edit([remove(2)]);
    await settle();
    world.saveFails = true;
    await expect(saveDocument(DOC)).rejects.toThrow(/could not be saved/);
    expect((await logOnDisk())?.steps.length).toBe(2);
    expect(await replayFromDisk()).toEqual(live().state());
    // More edits after the failure are logged too.
    await edit([duplicate(0)]);
    await settle();
    expect((await logOnDisk())?.steps.length).toBe(3);
    world.saveFails = false;
    const expected = live().state();
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(world.recovery.size).toBe(0);
    expect(new CoreDoc(world.files.get(OLD)!.bytes).state().prints).toEqual(expected.prints);
  });

  it('a save refused by the main process because the file changed (R9) writes nothing and keeps the log', async () => {
    await edit([rotate(0)]);
    await settle();
    const before = world.files.get(OLD)!.bytes.slice();
    // Another program replaces the file after the app's last look and before the main process's own check.
    const original = bridge.files.stat;
    let calls = 0;
    bridge.files.stat = async (path: string, withSample?: boolean) => {
      calls += 1;
      const answer = await original(path, withSample);
      // The app's two looks see the old stamp; then the file changes.
      if (calls === 2) world.files.set(OLD, { bytes: before, modified: world.clock + 99 });
      return answer;
    };
    try {
      const outcome = await saveDocument(DOC);
      expect(outcome.status).toBe('changed-on-disk');
    } finally {
      bridge.files.stat = original;
    }
    expect(world.files.get(OLD)!.modified).toBe(1099);
    expect((await logOnDisk())?.steps.length).toBe(1);
    expect(useEditStore.getState().changedOnDisk[DOC]).toBe(true);
  });
});

describe('Save As, then save', () => {
  it('logs of both files are cleared; later edits are logged under the new file and replay onto it', async () => {
    await edit([rotate(0)]);
    await edit([remove(2)]);
    await settle();
    const NEW = 'C:\\docs\\copy.pdf';
    const outcome = await saveDocument(DOC, { saveAs: true });
    expect(outcome).toMatchObject({ status: 'saved', path: NEW });
    expect(world.recovery.size).toBe(0);
    const NEW_DOC = `path:${NEW}`;
    expect(registry.entries.has(NEW_DOC)).toBe(true);
    // An edit on the re-keyed document is logged under the NEW path's key, against the file Save As wrote.
    const doc = registry.entries.get(NEW_DOC)!.doc as CoreDoc;
    useEditStore.setState((state) => ({ byDoc: { ...state.byDoc, [NEW_DOC]: state.byDoc[NEW_DOC] ?? state.byDoc[DOC]! } }) as never);
    await applyPageEdits(NEW_DOC, [{ op: 'rotate', uids: [doc.core.editState!.pages().uids[1]!], degrees: 90 }]);
    await settle();
    expect(await logOnDisk(NEW)).not.toBeNull();
    expect(await logOnDisk(OLD)).toBeNull();
    expect(await replayFromDisk(NEW)).toEqual(doc.state());
    // And it saves to the new path.
    expect((await saveDocument(NEW_DOC)).status).toBe('saved');
    expect(world.recovery.size).toBe(0);
    expect(new CoreDoc(world.files.get(NEW)!.bytes).state().prints).toEqual(doc.state().prints);
  });
});

describe('a restore that is refused, then edits (R6)', () => {
  /** Edits made and the app "killed": the log stays on disk, and the file is then changed by another program. */
  async function crashThenChangeFile(): Promise<void> {
    await edit([rotate(0)]);
    await edit([remove(2)]);
    await settle();
    forgetEditState(DOC);
    // Another program rewrites the file: same pages, a new modified time.
    world.files.set(OLD, { bytes: BASE.slice(), modified: world.clock + 500 });
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(world.files.get(OLD)!.bytes), pageCount: 6 });
    resetSaveState();
    await rememberFileStamp(OLD);
    useEditStore.setState({ recoveryNotice: {}, notRestored: {}, recovered: {} });
  }

  it('shows a bar that stays (not a toast), replays nothing, and a new edit starts a fresh log that survives another crash', async () => {
    await crashThenChangeFile();
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('file-changed');
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(useEditStore.getState().recovered[DOC]).toBeUndefined();
    expect(live().state().uids).toHaveLength(6);
    // The next edit is logged (blocked no longer silences logging for the session).
    await edit([duplicate(0)]);
    await settle();
    const file = await logOnDisk();
    expect(file?.steps).toHaveLength(1);
    expect(file?.base.modified).toBe(world.files.get(OLD)!.modified);
    expect(await replayFromDisk()).toEqual(live().state());
  });

  it('the old copy is moved aside, not overwritten: edits, a crash and a relaunch restore the current log, and the previous copy stays until a save', async () => {
    await crashThenChangeFile();
    const key = await canonicalRecoveryKey(OLD);
    const oldLog = world.recovery.get(key)!;
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('file-changed');
    // The first edit after the refusal: the old log is set aside before the fresh one is written.
    await edit([duplicate(0)]);
    await edit([rotate(2)]);
    await settle();
    expect(world.previous.get(key)?.log).toBe(oldLog);
    expect((await logOnDisk())?.steps).toHaveLength(2);
    // Crash and relaunch (the file is as the other program left it): the CURRENT log restores.
    const expected = live().state();
    forgetEditState(DOC);
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(world.files.get(OLD)!.bytes), pageCount: 6 });
    await restoreEditLog(DOC, OLD);
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 2 });
    expect(live().state()).toEqual(expected);
    // The previous copy is still there, and only a save removes it.
    expect(world.previous.get(key)?.log).toBe(oldLog);
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(world.previous.has(key)).toBe(false);
    expect(world.recovery.size).toBe(0);
  });

  it('only one previous copy is ever kept: a newer refused restore replaces it', async () => {
    await crashThenChangeFile();
    const key = await canonicalRecoveryKey(OLD);
    await restoreEditLog(DOC, OLD);
    await edit([duplicate(0)]);
    await settle();
    const firstPrevious = world.previous.get(key)!.log;
    // Crash again, the file changes again, the restore of the second log is refused too.
    const secondLog = world.recovery.get(key)!;
    forgetEditState(DOC);
    world.files.set(OLD, { bytes: BASE.slice(), modified: world.clock + 900 });
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
    resetSaveState();
    await rememberFileStamp(OLD);
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('file-changed');
    await edit([rotate(0)]);
    await settle();
    expect(world.previous.size).toBe(1);
    expect(world.previous.get(key)!.log).toBe(secondLog);
    expect(world.previous.get(key)!.log).not.toBe(firstPrevious);
  });

  it('if the old copy cannot be set aside, the new log is NOT written over it: the usual bar, and the old log is intact', async () => {
    await crashThenChangeFile();
    const key = await canonicalRecoveryKey(OLD);
    const oldLog = world.recovery.get(key)!;
    await restoreEditLog(DOC, OLD);
    world.setAsideFails = true;
    await edit([duplicate(0)]);
    await settle();
    expect(notice()).toEqual({ kind: 'write-failed' });
    expect(world.recovery.get(key)).toBe(oldLog);
    expect(live().state().uids).toHaveLength(7);
  });

  it('"Dont save" on a tab keeps the previous copy; Discard on a recovered bar removes it', async () => {
    await crashThenChangeFile();
    const key = await canonicalRecoveryKey(OLD);
    await restoreEditLog(DOC, OLD);
    await edit([duplicate(0)]);
    await settle();
    expect(world.previous.has(key)).toBe(true);
    const { dropEditLog } = await import('./editOps');
    await dropEditLog(DOC);
    expect(world.previous.has(key)).toBe(true);
    await discardRecovered(DOC);
    expect(world.previous.has(key)).toBe(false);
  });

  it('OK on the bar deletes nothing: the old recovery copy stays until the document is saved or the user chooses Discard (orchestrator ruling)', async () => {
    await crashThenChangeFile();
    await restoreEditLog(DOC, OLD);
    const key = await canonicalRecoveryKey(OLD);
    const logBefore = world.recovery.get(key)!;
    const stashesBefore = world.stashes.size;
    world.log = [];
    dismissNotRestored(DOC);
    await settle();
    expect(notRestored()).toBeUndefined();
    expect(world.log.filter((line) => line.startsWith('clear'))).toEqual([]);
    expect(world.recovery.get(key)).toBe(logBefore);
    expect(world.stashes.size).toBe(stashesBefore);
    // Saving does not bring the bar back, and clears the copy because the file now holds the document.
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(world.recovery.has(key)).toBe(false);
  });

  it('the "not restored" bar is not removed by a save, only by OK or by closing the document', async () => {
    await crashThenChangeFile();
    await restoreEditLog(DOC, OLD);
    await edit([rotate(1)]);
    await saveDocument(DOC);
    expect(notRestored()).toBe('file-changed');
    forgetEditState(DOC);
    expect(notRestored()).toBeUndefined();
  });

  it('Discard on a restored bar is the explicit choice that removes the copy', async () => {
    await edit([rotate(0)]);
    await settle();
    forgetEditState(DOC);
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
    await restoreEditLog(DOC, OLD);
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 1 });
    await discardRecovered(DOC);
    expect(world.recovery.size).toBe(0);
    expect(useEditStore.getState().recovered[DOC]).toBeUndefined();
  });

  it('a content sample that differs (same size, same time, other bytes) is refused too', async () => {
    await edit([rotate(0)]);
    await settle();
    forgetEditState(DOC);
    const swapped = BASE.slice();
    swapped[swapped.length - 5] = (swapped[swapped.length - 5]! + 1) & 255;
    const stamp = world.files.get(OLD)!.modified;
    world.files.set(OLD, { bytes: swapped, modified: stamp });
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('file-changed');
    expect(useEditStore.getState().recovered[DOC]).toBeUndefined();
  });

  it('a log that cannot be replayed (a stash is missing) shows the "could not be restored" bar and a fresh log starts at the next edit', async () => {
    const attached = await attachSourceLogged(DOC, sourcePdf(2));
    await edit([{ op: 'insertFrom', afterUid: uidAt(0), sourceDocId: attached.sourceDocId, sourceUids: ['0'] }]);
    await settle();
    forgetEditState(DOC);
    world.stashes.clear();
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('failed');
    expect(live().state().uids).toHaveLength(6); // nothing half applied
    await edit([rotate(0)]);
    await settle();
    expect(await replayFromDisk()).toEqual(live().state());
  });
});

describe('a recovery write failure, then edits, then save (R3, R5)', () => {
  it('30 edits, then a refused log write: the last good log replays, the bar is up, later edits apply but are not logged, and a save turns recovery back on', async () => {
    for (let i = 0; i < 30; i++) await edit([rotate(i % 6)]);
    await settle();
    expect((await logOnDisk())?.steps.length).toBe(30);
    const afterThirty = live().state();
    world.writeFails = 'false';
    await edit([remove(0)]); // the edit applies; its log write is refused
    await settle();
    expect(notice()).toEqual({ kind: 'write-failed' });
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(live().state().uids).toHaveLength(5);
    // The disk still holds the 30 steps, and they replay to the state before the refused write.
    expect((await logOnDisk())?.steps.length).toBe(30);
    expect(await replayFromDisk()).toEqual(afterThirty);
    // The disk comes back, but this document stays unlogged until its save (a log that skipped a step cannot be replayed).
    world.writeFails = null;
    await edit([rotate(0)]);
    await edit([duplicate(1)]);
    await settle();
    expect((await logOnDisk())?.steps.length).toBe(30);
    expect(notice()).toEqual({ kind: 'write-failed' });
    // Save now: the file holds all 33 edits, the bar goes, recovery is on again.
    const expected = live().state();
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(notice()).toBeUndefined();
    expect(world.recovery.size).toBe(0);
    expect(new CoreDoc(world.files.get(OLD)!.bytes).state().prints).toEqual(expected.prints);
    await edit([rotate(0)]);
    await settle();
    expect((await logOnDisk())?.steps.length).toBe(1);
    expect(await replayFromDisk()).toEqual(live().state());
  });

  it('a log write that throws is treated the same way, and the failure is shown once', async () => {
    await edit([rotate(0)]);
    await settle();
    world.writeFails = 'throw';
    await edit([rotate(1)]);
    await settle();
    expect(notice()).toEqual({ kind: 'write-failed' });
    await edit([rotate(2)]);
    await settle();
    expect(useUiStore.getState().toasts).toEqual([]);
    expect((await logOnDisk())?.steps.length).toBe(1);
  });

  it('an insert whose stash is refused is told at once; the earlier edits stay recoverable; the insert itself applies', async () => {
    await edit([rotate(0)]);
    await edit([rotate(1)]);
    await settle();
    const before = live().state();
    world.stashFails = 'false';
    const attached = await attachSourceLogged(DOC, sourcePdf(3));
    expect(notice()).toEqual({ kind: 'write-failed' });
    await edit([{ op: 'insertFrom', afterUid: uidAt(0), sourceDocId: attached.sourceDocId, sourceUids: ['0'] }]);
    await settle();
    expect(live().state().uids).toHaveLength(7);
    // The step whose stash failed was never recorded: the log on disk is exactly the two edits and replays.
    const file = await logOnDisk();
    expect(file?.steps).toHaveLength(2);
    expect(file?.stashes).toEqual([]);
    expect(await replayFromDisk()).toEqual(before);
  });

  it('the recovery folder is read-only from the first edit: the bar is up, nothing was logged, the edit applied', async () => {
    world.writeFails = 'throw';
    await edit([rotate(0)]);
    await settle();
    expect(notice()).toEqual({ kind: 'write-failed' });
    expect(world.recovery.size).toBe(0);
    expect(live().state().uids).toHaveLength(6);
  });
});

describe('the two spellings of one path (R10)', () => {
  it('a log written under one spelling is found under another, and an older version\'s key still restores', async () => {
    await edit([rotate(0)]);
    await settle();
    const text = (await logOnDisk())!;
    expect(text.steps).toHaveLength(1);
    forgetEditState(DOC);
    // The same file reached as "c:/DOCS/report.pdf": the canonical key is the same.
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
    await restoreEditLog(DOC, 'c:/DOCS/report.pdf');
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 1 });
  });

  it('a log an earlier version wrote under the path as typed is restored, and cleared with the document\'s other keys on save', async () => {
    await edit([rotate(0)]);
    await settle();
    const canonical = await canonicalRecoveryKey(OLD);
    const legacy = await legacyRecoveryKey(OLD);
    expect(legacy).not.toBe(canonical);
    // Move the log to the old key, as an earlier version would have left it.
    world.recovery.set(legacy, world.recovery.get(canonical)!);
    world.recovery.delete(canonical);
    forgetEditState(DOC);
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
    await restoreEditLog(DOC, OLD);
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 1 });
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(world.recovery.size).toBe(0);
  });
});

describe('a version 2 log written by the code before 1.5.1 still restores (orchestrator condition)', () => {
  it('no sample, no marker: replays on size and modified time', async () => {
    const stat = (await bridge.files.stat(OLD))!;
    const log = JSON.stringify({
      version: 2,
      path: OLD,
      base: { size: stat.size, modified: stat.modified },
      stashes: [],
      steps: [[{ op: 'rotate', uids: ['0'], degrees: 90 }], [{ op: 'delete', uids: ['2'] }]],
      seeds: [0, 0],
    });
    world.recovery.set(await legacyRecoveryKey(OLD), log);
    await restoreEditLog(DOC, OLD);
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 2 });
    expect(notRestored()).toBeUndefined();
    expect(live().state().uids).toHaveLength(5);
  });
});

describe('a protected source (R4)', () => {
  it('two edits, a protected insert, one more edit, a crash: the two logged edits come back with the "recording stopped" note', async () => {
    await edit([rotate(0)]);
    await edit([remove(2)]);
    await settle();
    const afterTwo = live().state();
    const attached = await attachSourceLogged(DOC, sourcePdf(2), 'secret');
    await edit([{ op: 'insertFrom', afterUid: uidAt(0), sourceDocId: attached.sourceDocId, sourceUids: ['0'] }]);
    await edit([rotate(3)]);
    await settle();
    expect(notice()).toEqual({ kind: 'protected-source' });
    expect(await replayFromDisk()).toEqual(afterTwo);
    const text = world.recovery.get(await canonicalRecoveryKey(OLD))!;
    expect(parseEditLog(text)?.loggingStopped).toBe(true);
  });
});

describe('closing the window with unsaved edits (R8)', () => {
  /** The main process's side: it clears the keys only if the request is still live. */
  async function mainProcessHears(answer: { decision: 'close' | 'cancel'; clearKeys: string[] }, live: boolean): Promise<void> {
    if (live && answer.decision === 'close') for (const key of answer.clearKeys) await bridge.recovery.clear(key);
  }

  it('"Don\'t save" at window close removes nothing itself: it hands the keys to the main process with the answer', async () => {
    await edit([rotate(0)]);
    await settle();
    const pending = requestCloseDecision();
    await answerClosePrompt('discard');
    const answer = await pending;
    expect(answer.decision).toBe('close');
    expect(answer.clearKeys).toEqual(expect.arrayContaining([await canonicalRecoveryKey(OLD), await legacyRecoveryKey(OLD)]));
    // Still on disk until the main process acts on a live request.
    expect((await logOnDisk())?.steps.length).toBe(1);
    await mainProcessHears(answer, true);
    expect(world.recovery.size).toBe(0);
  });

  it('close, unresponsive, "Don\'t save", one more edit, kill: a stale answer changes nothing, and the three edits restore exactly', async () => {
    await edit([rotate(0)]);
    await edit([remove(2)]);
    await settle();
    // The window asked; the page showed the prompt; the main process then ended the request (unresponsive); the user's
    // "Don't save" arrives late.
    const pending = requestCloseDecision();
    await answerClosePrompt('discard');
    const answer = await pending;
    await mainProcessHears(answer, false); // the request is no longer live: nothing is cleared
    expect((await logOnDisk())?.steps.length).toBe(2);
    // The window is still open and the user goes on editing.
    await edit([duplicate(0)]);
    await settle();
    expect((await logOnDisk())?.steps.length).toBe(3);
    // Kill, reopen: the three edits come back, exactly.
    const expected = live().state();
    expect(await replayFromDisk()).toEqual(expected);
    forgetEditState(DOC);
    registry.entries.set(DOC, { docId: DOC, doc: new CoreDoc(BASE), pageCount: 6 });
    await restoreEditLog(DOC, OLD);
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 3 });
    expect(live().state()).toEqual(expected);
  });

  it('closing a tab (the page closes it itself) and choosing Don\'t save removes the logs at once', async () => {
    await edit([rotate(0)]);
    await settle();
    const { askClosePrompt } = await import('./closeFlow');
    const pending = askClosePrompt([DOC]);
    await answerClosePrompt('discard');
    expect(await pending).toBe('close');
    expect(world.recovery.size).toBe(0);
  });

  it('the prompt comes down when the main process says the request ended, and nothing is decided or removed', async () => {
    await edit([rotate(0)]);
    await settle();
    const { watchCloseRequests } = await import('./closeFlow');
    const listeners: Array<(requestId?: number) => void> = [];
    const answers: unknown[] = [];
    const fake = bridge as unknown as { app?: unknown };
    fake.app = {
      onCloseRequested: (listener: (requestId?: number) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      onCloseEnded: (listener: () => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      decideClose: async (...args: unknown[]) => void answers.push(args),
    };
    try {
      const stop = watchCloseRequests();
      listeners[1]!(7); // a close request (id 7) arrives: the prompt is shown
      await settle();
      expect(useUiStore.getState().closePrompt).toBe(true);
      listeners[0]!(); // the main process ended it
      await settle();
      expect(useUiStore.getState().closePrompt).toBe(false);
      // The stale answer names the request it was for, and carries no keys.
      expect(answers).toEqual([['cancel', [], 7]]);
      expect((await logOnDisk())?.steps.length).toBe(1);
      stop();
    } finally {
      delete fake.app;
    }
  });
});

describe('the log of an edit is on disk before the edit is reported done is not required, but is written in the same tick as the record', () => {
  it('EditLog.record starts its write synchronously', async () => {
    const writes: string[] = [];
    const log = new EditLog('a'.repeat(64), OLD, { size: 1, modified: 1 }, {
      write: async (_key, text) => void writes.push(text),
      writeStash: async () => true,
      clear: async () => true,
    });
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    expect(writes).toHaveLength(1);
  });
});

describe('a restore is the document\'s running operation (1.5.1 review)', () => {
  /** A log with a source (so a stash is read) and two more steps, then "the app is killed". */
  async function leaveLogAndRestart(): Promise<CoreDoc> {
    const attached = await attachSourceLogged(DOC, sourcePdf(2));
    await edit([{ op: 'insertFrom', afterUid: uidAt(1), sourceDocId: attached.sourceDocId, sourceUids: ['0'] }]);
    await edit([rotate(0)]);
    await settle();
    forgetEditState(DOC);
    const fresh = new CoreDoc(world.files.get(OLD)!.bytes);
    registry.entries.set(DOC, { docId: DOC, doc: fresh, pageCount: 6 });
    return fresh;
  }

  it.each(['read', 'stat', 'stash', 'apply'])('an edit, an undo and a redo attempted while the restore waits at "%s" are refused; afterwards editing works and is logged on top', async (step) => {
    await leaveLogAndRestart();
    const parked = world.park(step);
    const restore = restoreEditLog(DOC, OLD);
    await parked.reached;
    for (const attempt of [() => applyPageEdits(DOC, [rotate(2)]), () => undoPageEdit(DOC), () => redoPageEdit(DOC)]) {
      await expect(attempt()).rejects.toThrow('Wait for the current change to finish.');
    }
    // Nothing was applied to the half-restored document, and nothing logged.
    expect(world.recovery.size).toBe(1);
    // A save waits for the restore instead of taking half of it.
    parked.release();
    await restore;
    expect(useEditStore.getState().recovered[DOC]).toEqual({ edits: 2 });
    await edit([duplicate(0)]);
    await settle();
    expect((await logOnDisk())?.steps).toHaveLength(3);
    expect(await replayFromDisk()).toEqual(live().state());
  });

  it('a source attached during the restore waits for it, and its stash goes into the resumed log', async () => {
    await leaveLogAndRestart();
    const parked = world.park('apply');
    const restore = restoreEditLog(DOC, OLD);
    await parked.reached;
    const attaching = attachSourceLogged(DOC, sourcePdf(1));
    await settle();
    parked.release();
    await restore;
    const attached = await attaching;
    await edit([{ op: 'insertFrom', afterUid: uidAt(0), sourceDocId: attached.sourceDocId, sourceUids: ['0'] }]);
    await settle();
    expect((await logOnDisk())?.steps).toHaveLength(3);
    expect(await replayFromDisk()).toEqual(live().state());
  });
});

describe('a failed replay leaves no partial state (1.5.1 review)', () => {
  it('the document is reloaded from disk before the bar: empty redo, then an edit, a crash and a correct replay', async () => {
    // A log whose second step names a page that is not there: the first step applies, the second fails.
    const stat = (await bridge.files.stat(OLD))!;
    const log = JSON.stringify({
      version: 2,
      path: OLD,
      base: { size: stat.size, modified: stat.modified },
      stashes: [],
      steps: [[{ op: 'rotate', uids: ['0'], degrees: 90 }], [{ op: 'delete', uids: ['no-such-page'] }]],
      seeds: [0, 0],
    });
    world.recovery.set(await canonicalRecoveryKey(OLD), log);
    const before = live();
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('failed');
    const reloaded = live();
    expect(reloaded).not.toBe(before);
    // Nothing is left on the redo stack (the undone first step would have been), nor on the undo stack.
    expect(reloaded.core.editState!.history.canRedo).toBe(false);
    expect(reloaded.core.editState!.history.canUndo).toBe(false);
    expect(() => reloaded.core.redo()).toThrow();
    expect(reloaded.state().prints).toEqual(new CoreDoc(BASE).state().prints);
    // A new edit is logged (the old log is set aside as the previous copy) and a crash restores exactly it.
    await edit([duplicate(0)]);
    await settle();
    expect((await logOnDisk())?.steps).toHaveLength(1);
    expect(await replayFromDisk()).toEqual(live().state());
    expect(world.previous.get(await canonicalRecoveryKey(OLD))?.log).toBe(log);
  });

  it('a log that cannot be read at all (not JSON) shows the "could not be restored" bar, is kept, and is set aside at the next edit', async () => {
    const key = await canonicalRecoveryKey(OLD);
    world.recovery.set(key, '{ this is not a log');
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('failed');
    await edit([rotate(0)]);
    await settle();
    expect(world.previous.get(key)?.log).toBe('{ this is not a log');
    expect((await logOnDisk())?.steps).toHaveLength(1);
  });
});

describe('two documents never write one recovery log (1.5.1 review, defence in depth)', () => {
  it('a second live document with the same recovery key is refused with the bar, and the first one\'s log is untouched', async () => {
    await edit([rotate(0)]);
    await settle();
    const before = world.recovery.get(await canonicalRecoveryKey(OLD));
    const OTHER = 'path:c:/DOCS/report.pdf';
    registry.entries.set(OTHER, { docId: OTHER, doc: new CoreDoc(BASE), pageCount: 6 });
    await applyPageEdits(OTHER, [{ op: 'rotate', uids: [(registry.entries.get(OTHER)!.doc as CoreDoc).core.editState!.pages().uids[0]!], degrees: 90 }]);
    await settle();
    expect(useEditStore.getState().recoveryNotice[OTHER]).toEqual({ kind: 'write-failed' });
    expect(world.recovery.get(await canonicalRecoveryKey(OLD))).toBe(before);
    expect(useEditStore.getState().recoveryNotice[DOC]).toBeUndefined();
  });
});

describe('a stash too large for the recovery folder, and the marker after a failure (1.5.1 review)', () => {
  it('a stash over MAX_RECOVERY_BYTES is treated as refused: the bar is up and the earlier edits stay', async () => {
    await edit([rotate(0)]);
    await settle();
    const { MAX_RECOVERY_BYTES } = await import('../../platform/desktop/contract');
    const huge = { byteLength: MAX_RECOVERY_BYTES + 1, slice: () => huge } as unknown as ArrayBuffer;
    const log = new EditLog('a'.repeat(64), OLD, { size: 1, modified: 1 }, bridge.recovery as never, undefined, { onFailure: () => undefined });
    expect(await log.addSource('x', huge)).toBe(false);
    expect(log.snapshot().stashes).toEqual([]);
  });

  it('the recovery limit is the edit limit (500 MB): a stash of exactly that size is sent to the recovery folder, one byte more is not', async () => {
    const { MAX_RECOVERY_BYTES, MAX_EDIT_BYTES } = await import('../../platform/desktop/contract');
    expect(MAX_RECOVERY_BYTES).toBe(MAX_EDIT_BYTES);
    expect(MAX_RECOVERY_BYTES).toBe(500 * 1024 * 1024);
    const sent: number[] = [];
    const port = { ...(bridge.recovery as object), writeStash: async (_key: string, _name: string, bytes: ArrayBuffer) => (sent.push(bytes.byteLength), true) };
    const big = (length: number) => ({ byteLength: length, slice: () => big(length) }) as unknown as ArrayBuffer;
    const log = new EditLog('b'.repeat(64), OLD, { size: 1, modified: 1 }, port as never, undefined, { onFailure: () => undefined });
    expect(await log.addSource('x', big(MAX_RECOVERY_BYTES))).toBe(true);
    expect(await log.addSource('y', big(MAX_RECOVERY_BYTES + 1))).toBe(false);
    expect(sent).toEqual([MAX_RECOVERY_BYTES]);
  });

  it('a refused stash marks the last good log "logging stopped here"', async () => {
    await edit([rotate(0)]);
    await settle();
    world.stashFails = 'false';
    await attachSourceLogged(DOC, sourcePdf(2));
    await settle();
    expect(notice()).toEqual({ kind: 'write-failed' });
    const file = await logOnDisk();
    expect(file?.steps).toHaveLength(1);
    expect(file?.loggingStopped).toBe(true);
  });
});

describe('a failed replay whose reload also fails (1.5.1 re-check)', () => {
  it('recording stops for the document: the next edit starts no log on a half-replayed document', async () => {
    const stat = (await bridge.files.stat(OLD))!;
    const log = JSON.stringify({
      version: 2,
      path: OLD,
      base: { size: stat.size, modified: stat.modified },
      stashes: [],
      steps: [[{ op: 'rotate', uids: ['0'], degrees: 90 }], [{ op: 'delete', uids: ['no-such-page'] }]],
      seeds: [0, 0],
    });
    const key = await canonicalRecoveryKey(OLD);
    world.recovery.set(key, log);
    world.readFails = true; // the reload after the failed replay cannot read the file
    await restoreEditLog(DOC, OLD);
    expect(notRestored()).toBe('failed');
    expect(notice()).toEqual({ kind: 'write-failed' });
    world.readFails = false;
    await edit([duplicate(0)]);
    await settle();
    // Nothing was logged: the old log is exactly as it was, and none was set aside.
    expect(world.recovery.get(key)).toBe(log);
    expect(world.previous.size).toBe(0);
    // A save turns recovery back on.
    expect((await saveDocument(DOC)).status).toBe('saved');
    expect(notice()).toBeUndefined();
  });
});
