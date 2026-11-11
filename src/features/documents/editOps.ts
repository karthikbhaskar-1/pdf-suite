import { documentRegistry } from '../../app/services';
import { useEditStore } from '../../core/stores/editStore';
import { currentOrder, remapAfterReplace } from './replacedDocument';
import { diag, diagEnabled } from '../../engine/diag';
import { DOCUMENT_GONE } from '../../engine/errors';
import { labelFor } from '../../engine/mupdf/editCore';
import { MupdfDocument, openMupdf } from '../../engine/mupdf/mupdfDocument';
import type { PageEdit } from '../../engine/mupdf/protocol';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import type { PdfSuiteApi } from '../../platform/desktop/contract';
import { EditLog, isLegacyLog, parseEditLog, replayAllowed, replayLog, sourceOf, type LogFailure, type LogPort } from '../recovery/editLog';
import { canonicalRecoveryKey, recoveryKeysFor } from '../recovery/recoveryKey';
import { RECOVERY_OFF_MESSAGE } from '../recovery/recoveryMessages';
import { watchUnresponsive } from './unresponsive';
import { remeasurePages } from './pageSync';
import { currentIdOf, fileStampOf, recordFileStamp, rewatchDocumentFile, savePathOf, statFile } from './saveDocument';
import { sessionPasswordOf } from './sessionPasswords';
import { refuseViewOnly, isViewOnly } from './viewOnly';
import { noteAdded, rekeyAdded, resetAdded } from './addedBytes';
import { TOO_LARGE_TO_OPEN } from '../../core/fileLimits';

/**
 * Page edits of an open document, with three things on top of the engine calls: each edit is logged for recovery (see
 * features/recovery/editLog.ts), a long edit reports its progress and can be cancelled, and the unsaved edits of an
 * earlier session can be restored when the file opens.
 */

/** Live recovery logs, by document. A log exists once a document with a file on disk has an edit or a source. */
const logs = new Map<string, EditLog>();
/** A log being made (its stamp and key are read first), so two callers at once get the same log. */
const creating = new Map<string, Promise<EditLog | null>>();
/**
 * Documents whose recording stopped until their next save: an edit used a password-protected source (its copy cannot be
 * kept), or a recovery write failed. The log already on disk is kept as it was; later edits are not recorded, and a bar
 * (useEditStore.recoveryNotice) says so until the save.
 */
const stopped = new Set<string>();
/**
 * Documents whose restore was refused or failed, with the key their old log is still under. The old log is not replayed and
 * must not be overwritten by the fresh log the next edit starts: createLog moves it aside as the previous copy first. The
 * previous copy is removed only by a save or an explicit Discard.
 */
const refusedKeys = new Map<string, string>();
/** Source ids (per document) attached with a password. An edit that uses one stops crash recovery for the document. */
const protectedSources = new Map<string, Set<string>>();

export { RECOVERY_OFF_MESSAGE };
/** The running edit of each document, so cancelOperation can stop it. */
const operations = new Map<string, AbortController>();
/** The running edit, undo or redo of each document, so a save can wait for it before it takes the bytes. */
const running = new Map<string, Promise<unknown>>();
/**
 * The restore of each document's earlier session (restoreEditLog), while it runs. It is the document's running operation:
 * edit, undo and redo are refused with WAIT_MESSAGE, a save waits for it, and the recovery log is not made until it ends.
 */
const restoring = new Map<string, Promise<void>>();

/** The words for a request that arrives while an edit is running (also used by runEdits in features/organizer/actions). */
export const WAIT_MESSAGE = 'Wait for the current change to finish.';

/** The reason edits are refused while a save runs. */
export const SAVING_MESSAGE = 'Wait for the save to finish.';

function refuseWhileSaving(docId: string): void {
  // A view-only document (file over the edit limit) takes no edit, undo, redo or source, whatever the caller.
  refuseViewOnly(docId);
  if (useEditStore.getState().saving[docId]) throw new Error(SAVING_MESSAGE);
  // Edits made while the earlier session's edits are being put back would land in the middle of the replay.
  if (restoring.has(docId)) throw new Error(WAIT_MESSAGE);
}

/**
 * The checks of the Undo and Redo commands, for every caller (the toast's Undo button included): not while a save runs,
 * not while another change is running, and only when there is a step to undo or redo.
 */
function refuseUnlessReady(docId: string, can: 'canUndo' | 'canRedo', none: string): void {
  if (diagEnabled()) diag('undoRedo.check', { can, saving: useEditStore.getState().saving[docId] === true, operation: operations.has(docId), history: useEditStore.getState().byDoc[docId]?.history });
  refuseWhileSaving(docId);
  // Undo and redo queue behind each other in the worker, so only a running edit (not another undo) is refused.
  if (operations.has(docId)) throw new Error(WAIT_MESSAGE);
  if (useEditStore.getState().byDoc[docId]?.history[can] !== true) throw new Error(none);
}

/** Runs one edit, undo or redo as the document's running operation. */
function track<T>(docId: string, work: () => Promise<T>): Promise<T> {
  const promise = work();
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  running.set(docId, settled);
  void settled.then(() => {
    if (running.get(docId) === settled) running.delete(docId);
  });
  return promise;
}

/** Resolves once the document's running edit, undo or redo (if any) has finished. A save calls this before it starts. */
export async function settleEdits(docId: string): Promise<void> {
  await restoring.get(docId);
  await running.get(docId);
}

/**
 * True while an edit, undo, redo or the restore of an earlier session's edits is running on the document, or its recovery log
 * is being made. A background tab in this state keeps its engine (see tabResidency.ts).
 */
export function isEditBusy(docId: string): boolean {
  return operations.has(docId) || running.has(docId) || restoring.has(docId) || creating.has(docId);
}

/**
 * True when the document has a recovery log, or recording stopped or a refused restore left an old copy under its key: the
 * document holds, or once held, unsaved edits that its worker's journal still knows about. Its engine must not be ended.
 */
export function hasEditLog(docId: string): boolean {
  return logs.has(docId) || stopped.has(docId) || refusedKeys.has(docId);
}

function documentOf(docId: string): MupdfDocument {
  const handle = documentRegistry.get(docId);
  if (!handle || !(handle.doc instanceof MupdfDocument)) throw new Error('This document cannot be edited.');
  return handle.doc;
}

/**
 * Moves a log aside as the "previous" copy, before a fresh log is written under the same key. False when it could not be done
 * (the caller must then NOT write over the old log).
 */
async function setAsidePrevious(bridge: PdfSuiteApi, key: string): Promise<boolean> {
  try {
    return (await bridge.recovery.setAside(key)) === true;
  } catch {
    return false;
  }
}

/** Removes a key's previous copy (the document was saved, or the user chose Discard). A failure is ignored: the next save or Discard retries. */
async function clearPreviousCopy(bridge: PdfSuiteApi, key: string): Promise<void> {
  try {
    await bridge.recovery.clearPrevious(key);
  } catch {
    // Left for the next save or Discard.
  }
}

/** The port the log writes through: the main process, by key. Null outside the desktop app. A refused write says false. */
function logPort(bridge: PdfSuiteApi | null): LogPort | null {
  if (!bridge) return null;
  return {
    write: (key, text) => bridge.recovery.write(key, text),
    writeStash: (key, name, bytes) => bridge.recovery.writeStash(key, name, bytes),
    clear: (key) => bridge.recovery.clear(key),
  };
}

/**
 * The recovery key of a file: the SHA-256 of its canonical path, so two spellings of one path give one key (see
 * recoveryKey.ts). The page computes it; the main process only checks its shape.
 */
export function recoveryKeyFor(path: string): Promise<string> {
  return canonicalRecoveryKey(path);
}

/** Every recovery key the documents' files may have a log under (the canonical key and an earlier version's), for a clean-up. */
export async function recoveryKeysOf(docIds: readonly string[]): Promise<string[]> {
  const keys = new Set<string>();
  for (const docId of docIds) {
    const path = savePathOf(docId);
    if (path) for (const key of await recoveryKeysFor(path)) keys.add(key);
  }
  return [...keys];
}

/** A recovery log that tells this module when it cannot write, so recording stops and the user is told. */
function makeLog(
  key: string,
  path: string,
  base: ConstructorParameters<typeof EditLog>[2],
  port: LogPort,
  resumed?: ConstructorParameters<typeof EditLog>[4],
): EditLog {
  const log: EditLog = new EditLog(key, path, base, port, resumed, { onFailure: (reason) => stopAfterFailure(log, reason) });
  return log;
}

/**
 * A recovery write or stash failed (the main process refused it or it threw). Recording stops for that document, because a
 * log that skips a step cannot be replayed correctly. The log already on disk is the last good one and is kept. The bar says
 * so and offers Save now, and a save turns recovery back on.
 */
function stopAfterFailure(log: EditLog, reason: LogFailure): void {
  for (const [docId, candidate] of logs) {
    if (candidate !== log) continue;
    logs.delete(docId);
    stopped.add(docId);
    diag('recovery.failed', { reason });
    useEditStore.getState().setRecoveryNotice(docId, { kind: 'write-failed' });
    // Mark the last good log "logging stopped here" when the folder lets us, and ignore the log's later changes.
    void log.stopRecording();
  }
}

/** The live log of a document, made when it is first needed. Null when the document has no file, or recording stopped. */
async function logFor(docId: string): Promise<EditLog | null> {
  // The log of a document is made only after its earlier session has been restored (the restore makes it, resumed).
  await restoring.get(docId);
  const existing = logs.get(docId);
  if (existing) return existing;
  if (stopped.has(docId)) return null;
  const inProgress = creating.get(docId);
  if (inProgress) return inProgress;
  const made = createLog(docId).finally(() => creating.delete(docId));
  creating.set(docId, made);
  return made;
}

async function createLog(docId: string): Promise<EditLog | null> {
  const bridge = getDesktopBridge();
  const port = logPort(bridge);
  const path = savePathOf(docId);
  if (!bridge || !port || !path) return null;
  const base = fileStampOf(path) ?? (await bridge.files.stat(path, true));
  if (!base) return null;
  const key = await recoveryKeyFor(path);
  // Recording may have stopped, or the log been made by a restore, while the stamp and key were read.
  if (stopped.has(docId)) return null;
  const existing = logs.get(docId);
  if (existing) return existing;
  // Two documents must never write one log: another live document already holds this key (two spellings of one file that
  // were not joined into one document). The second is refused, with the bar, rather than overwrite the first one's log.
  for (const [other, log] of logs) {
    if (other !== docId && log.logKey === key) {
      stopped.add(docId);
      useEditStore.getState().setRecoveryNotice(docId, { kind: 'write-failed' });
      return null;
    }
  }
  const refusedKey = refusedKeys.get(docId);
  if (refusedKey !== undefined) {
    // The old log of a refused restore is still under this key: keep it as the previous copy before a fresh log replaces it.
    // If it cannot be kept, no fresh log is written over it: recovery stops with the usual bar instead.
    if (!(await setAsidePrevious(bridge, refusedKey))) {
      stopped.add(docId);
      useEditStore.getState().setRecoveryNotice(docId, { kind: 'write-failed' });
      return null;
    }
    refusedKeys.delete(docId);
  }
  const log = makeLog(key, path, base, port);
  logs.set(docId, log);
  return log;
}

/**
 * Applies page edits to a document as one step. A long edit reports its progress (useEditStore.progress), and
 * cancelOperation stops it, with everything it did rolled back. A successful step is recorded in the recovery log.
 * Rejects with an AbortError when cancelled. Resolves with false when the edit changed nothing (no step was made).
 */
export async function applyPageEdits(docId: string, edits: PageEdit[]): Promise<boolean> {
  if (diagEnabled()) diag('apply.request', { saving: useEditStore.getState().saving[docId] === true, running: running.has(docId), operation: operations.has(docId) });
  refuseWhileSaving(docId);
  return track(docId, () => applyPageEditsNow(docId, edits));
}

/** True when an edit takes pages from a source that was attached with a password. */
function usesProtectedSource(docId: string, edits: readonly PageEdit[]): boolean {
  const ids = protectedSources.get(docId);
  if (!ids || ids.size === 0) return false;
  return edits.some((edit) => {
    const id = sourceOf(edit);
    return id !== null && ids.has(id);
  });
}

/**
 * Stops crash recovery for a document, after an edit that uses a protected source has been applied. A copy of that source
 * in the recovery log would need the password to be replayed, and the password is never stored, so the step cannot be
 * recorded. Recording stops, but the log already on disk is KEPT and marked "logging stopped here", so after a crash the user
 * gets back every edit up to that point (through the usual Keep / Discard bar). A bar that stays says recovery is off, and a
 * save turns it back on (clearEditLogAfterSave). Switched off only once the edit has applied: a cancelled or rejected
 * edit leaves recovery on.
 */
async function stopForProtectedSource(docId: string): Promise<void> {
  if (stopped.has(docId)) return;
  stopped.add(docId);
  useEditStore.getState().setRecoveryNotice(docId, { kind: 'protected-source' });
  const log = logs.get(docId);
  logs.delete(docId);
  if (log) await log.stopRecording();
}

/** Records one applied step in the document's log. A log that cannot take it stops recording (stopAfterFailure). */
async function recordStep(docId: string, edits: PageEdit[], uidSeed: number): Promise<void> {
  if (usesProtectedSource(docId, edits)) {
    await stopForProtectedSource(docId);
    return;
  }
  const log = await logFor(docId);
  if (!log) return;
  try {
    log.record(edits, uidSeed);
  } catch {
    // A step that names a source with no stash cannot be replayed: stop, and say so, rather than log a broken step.
    stopAfterFailure(log, 'stash');
  }
}

async function applyPageEditsNow(docId: string, edits: PageEdit[]): Promise<boolean> {
  const doc = documentOf(docId);
  const controller = new AbortController();
  operations.set(docId, controller);
  const store = useEditStore.getState();
  store.setProgress(docId, { label: labelFor(edits), done: 0, total: 0 });
  const stop = doc.onProgress((event) => {
    useEditStore.getState().setProgress(docId, { label: event.label, done: event.done, total: event.total });
  });
  try {
    // A Cancel is settled by the worker: it rolls the edit back completely (no step, no redo) or, when it had already
    // finished, the edit stands and is logged below.
    if (diagEnabled()) diag('apply.start', { label: labelFor(edits), baseVersion: doc.version, storeVersion: useEditStore.getState().byDoc[docId]?.version });
    const outcome = await doc.applyEdits(edits, doc.version, { signal: controller.signal }).catch((error: unknown) => {
      diag('apply.fail', { name: (error as Error)?.name, message: (error as Error)?.message });
      // An abort counts as the user's Cancel only when cancelOperation ran. Any other abort (the document was closed, or
      // reopened after a hang, so its engine was destroyed) is not a cancel: nothing may say "the document was not changed".
      if (!controller.signal.aborted && ['AbortError', 'Cancelled'].includes((error as Error)?.name)) {
        throw Object.assign(new Error('The document was closed or replaced.'), { name: DOCUMENT_GONE });
      }
      throw error;
    });
    diag('apply.done', { changed: outcome.changed, version: outcome.version });
    // An edit that changed nothing made no undo step, so it is not logged either.
    if (outcome.changed === false) return false;
    await recordStep(docId, edits, outcome.uidSeed ?? 0);
    return true;
  } finally {
    stop();
    operations.delete(docId);
    useEditStore.getState().setProgress(docId, null);
  }
}

/** Stops the running edit of a document. Its changes are rolled back; nothing is recorded. */
export function cancelOperation(docId: string): void {
  operations.get(docId)?.abort();
}

/**
 * Attaches a PDF as a source for insertFrom or replace, and stores a copy of it in the recovery log, so the edits that use
 * it can be replayed after the source file is gone. Resolves with the source id the edits name and its page count.
 */
export async function attachSourceLogged(docId: string, bytes: ArrayBuffer, password?: string): Promise<{ sourceDocId: string; pages: number }> {
  refuseViewOnly(docId);
  const doc = documentOf(docId);
  const copy = bytes.slice(0);
  const attached = await doc.attachSource(bytes, password);
  // The size check of the next add counts this source until the document is saved or reloaded (addedBytes.ts).
  noteAdded(docId, copy.byteLength);
  if (password !== undefined) {
    // A protected source is not copied into the recovery log (it would need the password to be replayed, and the password
    // is never stored). Recovery stays on until an edit that uses the source has applied (see stopForProtectedSource).
    const ids = protectedSources.get(docId) ?? new Set<string>();
    ids.add(attached.sourceDocId);
    protectedSources.set(docId, ids);
    return attached;
  }
  // A refused or failed stash is reported at once (the log tells stopAfterFailure, which raises the bar): the source is
  // attached and usable, but no step that uses it is recorded.
  await (await logFor(docId))?.addSource(attached.sourceDocId, copy);
  return attached;
}

/**
 * Moves the edit state of a document to a new docId (Save As): its recovery log, its blocked flag and its running edit.
 * The log file itself is keyed by the path, so it is not touched here.
 */
export function rekeyEditState(oldId: string, newId: string): void {
  const log = logs.get(oldId);
  if (log) {
    logs.delete(oldId);
    logs.set(newId, log);
  }
  const ids = protectedSources.get(oldId);
  if (ids) {
    protectedSources.delete(oldId);
    protectedSources.set(newId, ids);
  }
  if (stopped.delete(oldId)) stopped.add(newId);
  rekeyAdded(oldId, newId);
  const operation = operations.get(oldId);
  if (operation) {
    operations.delete(oldId);
    operations.set(newId, operation);
  }
  const pending = running.get(oldId);
  if (pending) {
    running.delete(oldId);
    running.set(newId, pending);
  }
}

/** Undoes the last step, and moves the recovery log back with it. */
export async function undoPageEdit(docId: string): Promise<void> {
  refuseUnlessReady(docId, 'canUndo', 'Nothing to undo');
  await track(docId, async () => {
    await documentOf(docId).undo();
    logs.get(docId)?.undo();
  });
}

/**
 * Takes back the latest step so completely that it cannot be redone (a cancelled preview, such as Auto-crop on the Crop
 * sheet), and moves the recovery log back with it.
 */
export async function discardLastPageEdit(docId: string): Promise<void> {
  refuseUnlessReady(docId, 'canUndo', 'Nothing to undo');
  await track(docId, async () => {
    await documentOf(docId).discardLast();
    logs.get(docId)?.discard();
  });
}

/** Redoes the next step, and moves the recovery log forward with it. */
export async function redoPageEdit(docId: string): Promise<void> {
  refuseUnlessReady(docId, 'canRedo', 'Nothing to redo');
  await track(docId, async () => {
    await documentOf(docId).redo();
    logs.get(docId)?.redo();
  });
}

/**
 * Called when a document is opened from a file. If the file has a recovery log with edits, and the file is still the one
 * the edits were made on (same size and modified time, and the same content sample when the log has one), the edits are
 * replayed and the document is marked recovered (useEditStore.recovered). Otherwise the edits are not replayed and a bar
 * says so; the next edit starts a fresh log, which replaces the old one. The log is looked for under the canonical key
 * first, then under the key an earlier version used.
 */
export function restoreEditLog(docId: string, path: string): Promise<void> {
  let settled: Promise<void> | undefined;
  const work = restoreNow(docId, path).finally(() => {
    if (restoring.get(docId) === settled) restoring.delete(docId);
  });
  settled = work.then(
    () => undefined,
    () => undefined,
  );
  restoring.set(docId, settled);
  return work;
}

async function restoreNow(docId: string, path: string): Promise<void> {
  const bridge = getDesktopBridge();
  const port = logPort(bridge);
  if (!bridge || !port) return;
  let key = '';
  let text: string | null = null;
  for (const candidate of await recoveryKeysFor(path)) {
    text = await bridge.recovery.read(candidate);
    if (text) {
      key = candidate;
      break;
    }
  }
  if (!text) return;
  const notRestored = (reason: 'file-changed' | 'failed'): void => {
    useEditStore.getState().setNotRestored(docId, reason);
    // The old log stays where it is; the next edit's fresh log must not overwrite it (see refusedKeys).
    refusedKeys.set(docId, key);
  };
  const file = parseEditLog(text);
  if (!file && isLegacyLog(text)) {
    // A log from an earlier version has no uid seeds, so replaying it could hit the wrong pages. Discard it, and say so.
    await bridge.recovery.clear(key).catch(() => undefined);
    useEditStore.getState().setNotRestored(docId, 'failed');
    return;
  }
  if (!file) {
    // Text that is not a log this version can read: say so, and keep it (the next edit sets it aside, it is never overwritten).
    notRestored('failed');
    return;
  }
  if (file.steps.length === 0) return;
  // A file over the edit limit is view-only: the edits cannot be put back. The log stays where it is (notRestored keeps it).
  if (isViewOnly(docId)) {
    notRestored('failed');
    return;
  }
  const now = await bridge.files.stat(path, true);
  if (!replayAllowed(file, now)) {
    notRestored('file-changed');
    return;
  }
  const doc = documentOf(docId);
  try {
    const { applied, liveByStash } = await replayLog(
      file,
      (name) => bridge.recovery.readStash(key, name),
      {
        attachSource: async (bytes) => {
          const attached = await doc.attachSource(bytes);
          noteAdded(docId, bytes.byteLength);
          return attached.sourceDocId;
        },
        applyStep: (edits, uidSeed) => doc.applyEdits(edits, doc.version, { uidSeed }).then(() => undefined),
        undoStep: () => doc.undo().then(() => undefined),
      },
    );
    logs.set(
      docId,
      makeLog(key, path, file.base, port, { steps: file.steps, seeds: file.seeds, stashes: file.stashes, liveByStash }),
    );
    useEditStore.getState().setRecovered(docId, { edits: applied, ...(file.loggingStopped ? { loggingStopped: true } : {}) });
  } catch {
    // replayLog undoes the steps it applied, but an undone step stays on the redo stack and a failed undo is ignored. The
    // document is therefore reloaded from disk: no partial state, empty undo and redo, before the bar is shown.
    const reloaded = await reloadFromDisk(docId, path).then(
      () => true,
      () => false,
    );
    if (!reloaded) {
      // The document is left half replayed: no fresh log may start on it. Recording stops, with the usual bar.
      stopped.add(docId);
      useEditStore.getState().setRecoveryNotice(docId, { kind: 'write-failed' });
    }
    notRestored('failed');
  }
}

/** Keep: the restored edits stay in the document, and the log goes on recording. */
export function keepRecovered(docId: string): void {
  useEditStore.getState().setRecovered(docId, null);
}

/**
 * OK on the "not restored" bar: the bar goes and NOTHING else changes. The old recovery copy stays on disk until the
 * document is saved or the user chooses Discard: dismissing a message never deletes recovery data.
 */
export function dismissNotRestored(docId: string): void {
  useEditStore.getState().setNotRestored(docId, null);
}

/**
 * Reads the document's file again into a fresh worker that replaces the document's own, under the same document id, as a
 * save does. The selection is cleared and the current page clamped (the file can hold other pages than the edited
 * document). The protected-source and stopped state of the old session go: the fresh worker has none of its sources.
 */
async function reloadFromDisk(docId: string, path: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('This document cannot be reloaded.');
  // The stamp is taken before the read, so a change made during the read is seen by the next save.
  const stampBeforeRead = await statFile(path);
  const read = await bridge.files.read(path);
  // A file that has grown past the view limit since it was opened says so, in the words of the open.
  if (!read.ok) throw new Error(read.reason === 'too-large' ? TOO_LARGE_TO_OPEN : 'The file could not be read again.');
  const session = await openMupdf(new Uint8Array(read.bytes), { password: sessionPasswordOf(docId) });
  const fresh = session.document();
  const orderBefore = currentOrder(docId);
  if (!documentRegistry.replaceDocument(docId, fresh)) {
    await fresh.destroy();
    throw new Error('The document was closed while it was being reloaded.');
  }
  remapAfterReplace(docId, orderBefore, false);
  watchUnresponsive(docId, fresh, currentIdOf);
  protectedSources.delete(docId);
  resetAdded(docId);
  recordFileStamp(path, stampBeforeRead);
  rewatchDocumentFile(docId, path);
  // The file on disk can have other page sizes than the edited document had: measure them again (see remeasurePages).
  remeasurePages(docId, fresh, () => documentRegistry.get(docId)?.doc === fresh);
  useEditStore.getState().setUnresponsive(docId, false);
}

/**
 * Removes the logs (and stashes) under every key the path may have, and the live log of the document. The previous copy of a
 * refused restore goes too: this is only called for a save or an explicit Discard.
 */
async function removeLogs(docId: string, path: string | null): Promise<void> {
  const bridge = getDesktopBridge();
  const log = logs.get(docId);
  logs.delete(docId);
  refusedKeys.delete(docId);
  if (log) await log.clear().catch(() => undefined);
  if (!bridge || !path) return;
  for (const key of await recoveryKeysFor(path)) {
    await bridge.recovery.clear(key).catch(() => undefined);
    await clearPreviousCopy(bridge, key);
  }
}

/**
 * Discard: the log is removed and the file is reloaded from disk, so the document shows what is saved. The new worker
 * replaces the old one under the same document id, as a save does.
 */
export async function discardRecovered(docId: string): Promise<void> {
  const bridge = getDesktopBridge();
  const path = savePathOf(docId);
  if (!bridge || !path) throw new Error('This document cannot be reloaded.');
  // Not while a save runs (it would write the document this replaces), and an edit or the replay of the log that is still
  // running finishes first, so it cannot land on the document that is being replaced.
  if (useEditStore.getState().saving[docId]) throw new Error(SAVING_MESSAGE);
  await settleEdits(docId);
  if (useEditStore.getState().saving[docId]) throw new Error(SAVING_MESSAGE);
  // The file is read first: a read that fails (the file is gone, or has grown past the view limit) leaves the logs where they are.
  await reloadFromDisk(docId, path);
  await removeLogs(docId, path);
  stopped.delete(docId);
  // Recovery is on again (the log was just cleared), exactly as after a save.
  useEditStore.getState().setRecovered(docId, null);
  useEditStore.getState().setRecoveryNotice(docId, null);
  useEditStore.getState().setNotRestored(docId, null);
}

/**
 * Reopen, for a document whose engine stopped answering and that the user chose to reopen: the file is read again into a
 * fresh worker and the recovery log is replayed onto it, so the unsaved edits come back (with the usual Keep / Discard
 * bar). Every change is written to the log at once, so it holds all the edits that were recorded. Edits made after
 * recording stopped (see stopped) are not in it. Never called without the user's choice.
 */
export async function reopenAfterHang(docId: string): Promise<void> {
  const path = savePathOf(docId);
  if (!getDesktopBridge() || !path) throw new Error('This document cannot be reopened.');
  const log = logs.get(docId);
  // The writes already asked for finish first, so the log on disk is the latest.
  await log?.flush();
  logs.delete(docId);
  stopped.delete(docId);
  useEditStore.getState().setRecoveryNotice(docId, null);
  await reloadFromDisk(docId, path);
  await restoreEditLog(docId, path);
}

/**
 * A document that closed: its protected-source and stopped state must not carry over to the next document opened under
 * the same id (the same file opened again).
 */
export function forgetEditState(docId: string): void {
  resetAdded(docId);
  protectedSources.delete(docId);
  stopped.delete(docId);
  logs.delete(docId);
  creating.delete(docId);
  refusedKeys.delete(docId);
  useEditStore.getState().setRecoveryNotice(docId, null);
  useEditStore.getState().setNotRestored(docId, null);
  useEditStore.getState().setUnresponsive(docId, false);
}

/** Closing a document without saving ("Don't save"): its recovery log is removed, so the edits are not restored later. */
export function dropEditLog(docId: string): Promise<void> {
  const path = savePathOf(docId);
  // "Don't save" is not a save or a Discard of the recovery copies: a previous copy of a refused restore is kept.
  return clearEditLogAfterSave(docId, path ? [path] : [], { keepPrevious: true });
}

/**
 * Called after a save has written the file: the log of the document, and any log left for the files it saved to, are no
 * longer needed, because the file now holds the edits. Recovery works as normal again: the "recovery is off" bars go. The
 * "not restored" bar stays until the user presses OK or the document closes.
 */
export async function clearEditLogAfterSave(docId: string, paths: readonly string[], options: { keepPrevious?: boolean } = {}): Promise<void> {
  const bridge = getDesktopBridge();
  const log = logs.get(docId);
  logs.delete(docId);
  if (!options.keepPrevious) refusedKeys.delete(docId);
  stopped.delete(docId);
  // The saved file holds the edits, and the document is a fresh one without its sources.
  protectedSources.delete(docId);
  useEditStore.getState().setRecovered(docId, null);
  useEditStore.getState().setRecoveryNotice(docId, null);
  if (log) await log.clear().catch(() => undefined);
  if (!bridge) return;
  for (const path of new Set(paths)) {
    for (const key of await recoveryKeysFor(path)) {
      await bridge.recovery.clear(key).catch(() => undefined);
      if (!options.keepPrevious) await clearPreviousCopy(bridge, key);
    }
  }
}
