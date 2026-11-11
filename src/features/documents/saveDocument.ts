import { documentRegistry, fileService } from '../../app/services';
import { rekeyPageId } from '../../core/model/pageList';
import type { ViewState } from '../../core/model/types';
import { rekeySelection } from '../../core/stores/selectionStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSheetStore } from '../../core/stores/sheetStore';
import { MupdfDocument, openMupdf } from '../../engine/mupdf/mupdfDocument';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import { MAX_EDIT_BYTES } from '../../platform/desktop/contract';
import { SAVE_ENGINE_FAILED, SAVE_OUT_OF_MEMORY, TOO_LARGE_TO_EXTRACT, TOO_LARGE_TO_SAVE } from '../../core/fileLimits';
import { isOutOfMemory } from '../../engine/mupdf/jobProtocol';
import { refuseViewOnly } from './viewOnly';
import { addedBytesOf, resetAdded } from './addedBytes';
import type { FileStamp } from '../recovery/editLog';
import { firstMismatch } from '../../engine/mupdf/pageFingerprint';
import { startDiskWatch } from './diskWatch';
import { changedBeforeSave } from './saveCheck';
import { clearEditLogAfterSave, settleEdits } from './editOps';
import { watchUnresponsive } from './unresponsive';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useSearchStore } from '../search/searchStore';
import { rekeyEditState } from './editOps';
import { currentOrder, remapAfterReplace } from './replacedDocument';
import { moveSessionPassword, sessionPasswordOf } from './sessionPasswords';

/**
 * Save and Save As for a MuPDF document. The worker makes the bytes (see MupdfCore.save), and the main process writes
 * them atomically to a path the user chose. After a save the document is reopened in a fresh worker, so its undo
 * history starts again and it is clean.
 */

/** Size and modified time of a file when it was last opened or saved. A save compares them to the disk. */
const stamps = new Map<string, FileStamp>();
/** The docId of a file on disk. The registry names path sources this way (see defaultHasher). */
export function pathDocId(path: string): string {
  return `path:${path}`;
}

/** Where a document saves to, when Save As picked a path different from the one it was opened from. */
const savedTo = new Map<string, string>();
/** Documents with a save in progress. The disk watch does not report the app's own write. */
const savingDocs = new Set<string>();
/** The watches on open documents' files, by document. A watch removes itself once its document closes. */
const watches = new Map<string, () => void>();
/**
 * The file as it was when the user chose "Keep my version" after an outside change. The watch compares with this, so the
 * same change is not reported again, and the next outside change is. It is separate from `stamps` on purpose: `stamps`
 * decides between an incremental and a full save, and must keep saying the file changed.
 */
const acknowledged = new Map<string, FileStamp>();
/** Ids a document had before Save As re-keyed it, to the id it has now. A save queued under the old id follows it. */
const renamedTo = new Map<string, string>();
/** Added to a failed-save message when the document has changes: a save that did not reach the disk spends their undo. */
export const UNDO_LOST_SENTENCE = ' Your changes are kept and can be saved again, but they can no longer be undone.';

function undoLostSentence(docId: string): string {
  return useEditStore.getState().byDoc[docId]?.history.dirty ? UNDO_LOST_SENTENCE : '';
}

/** The message when a file that has gone from its place cannot be written back (1.5.5 D4). */
export const MISSING_FOLDER_MESSAGE = 'The folder for this file may no longer exist. Use Save As… to choose where to save it.';

/** The message when the write to the disk failed. */
export function failedSaveMessage(docId: string): string {
  return `The file could not be saved. Check that it is not open in another program.${undoLostSentence(docId)}`;
}

/** The message for a save or extract whose file is over the edit limit (the words are in core/fileLimits.ts). */
export { TOO_LARGE_TO_SAVE };

/**
 * What a failed engine save tells the user. The measured cause of every failed save above about 550 MB is the engine running
 * out of memory (docs/milestone-1.5/measurements.md L1), so that is named; any other engine failure says it could not finish.
 * Both say the file on disk is unchanged and the edits are still open (a failed save never writes), and both add the undo sentence.
 */
export function engineSaveFailedMessage(error: unknown, docId: string): string {
  return `${isOutOfMemory(error) ? SAVE_OUT_OF_MEMORY : SAVE_ENGINE_FAILED}${undoLostSentence(docId)}`;
}

/** The current id of a document, following Save As re-keys. */
export function currentIdOf(docId: string): string {
  let id = docId;
  for (let hops = 0; hops < 20; hops++) {
    const next = renamedTo.get(id);
    if (next === undefined) break;
    id = next;
  }
  return id;
}

/** The save of each document that is running now, so a second Save joins it or waits for it. */
const inflight = new Map<string, Promise<SaveOutcome>>();

/** The stamp the file had when it was last opened or saved, or undefined when it was not recorded. */
export function fileStampOf(path: string): FileStamp | undefined {
  return stamps.get(path);
}

/** The file as the app last saw it: what a save or the disk watch compares with (the stamp, or the one "Keep my version" accepted). */
export function seenStampOf(path: string): FileStamp | undefined {
  return acknowledged.get(path) ?? stamps.get(path);
}

/**
 * Watches a document's file for changes made outside the app (see diskWatch.ts). A change sets the document's
 * changedOnDisk state. One watch per document: a second call for the same document does nothing.
 */
export function watchDocumentFile(docId: string, path: string): void {
  const bridge = getDesktopBridge();
  if (!bridge || watches.has(docId)) return;
  const stop = startDiskWatch({
    path,
    seen: () => acknowledged.get(path) ?? stamps.get(path),
    stat: (target) => bridge.files.stat(target),
    isActive: () => {
      const open = documentRegistry.get(docId) !== undefined;
      if (!open) watches.delete(docId);
      return open;
    },
    isSaving: () => savingDocs.has(docId),
    // The watch stays registered, so the user's choice (Keep my version, Reload) replaces it instead of adding a second one.
    onChanged: () => {
      useEditStore.getState().setChangedOnDisk(docId, true);
    },
    // A file that another program moved or deleted: a bar that stays (DocumentBars) until the file is back, a save works or the
    // user dismisses it. While it shows it takes the place of the "changed on disk" bar (DocumentBars), whose state is kept, so a
    // file that comes back different brings that bar back. Save creates the file again.
    onMissing: () => useEditStore.getState().setMissingOnDisk(docId, true),
    onFound: () => useEditStore.getState().setMissingOnDisk(docId, false),
  });
  watches.set(docId, stop);
}

/**
 * Records a stamp that was taken when the file was read (or null when it could not be). A document opened or reloaded is the
 * bytes that were read, so the stamp must come from a stat taken before that read: a change made during the read is then
 * seen by the next save, instead of being recorded as what the app saw.
 */
export function recordFileStamp(path: string, stat: FileStamp | null): void {
  acknowledged.delete(path);
  if (stat) stamps.set(path, stat);
  else stamps.delete(path);
}

/**
 * The file's stat now, with the content sample the main process makes (it lets a recovery log tell a replaced file from the
 * one its edits were made on), or null when it is gone or cannot be read. Take it before reading the file (see recordFileStamp).
 */
export async function statFile(path: string): Promise<FileStamp | null> {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  return bridge.files.stat(path, true).catch(() => null);
}

/** Records the file's stamp now. Called after each save, which wrote the file itself. */
export async function rememberFileStamp(path: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) return;
  const stat = await bridge.files.stat(path, true).catch(() => null);
  acknowledged.delete(path);
  if (stat) stamps.set(path, stat);
  else stamps.delete(path);
}

/**
 * "Keep my version" after the file changed on disk: the banner goes, the next save writes the document's own pages over
 * the file (a full save, because the stamp still says the file changed), and the disk watch starts again from the file
 * as it is now, so a second outside change is reported too.
 */
export async function keepMyVersion(docId: string): Promise<void> {
  const bridge = getDesktopBridge();
  const path = savePathOf(docId);
  useEditStore.getState().setChangedOnDisk(docId, false);
  if (!bridge || !path) return;
  const now = await bridge.files.stat(path).catch(() => null);
  if (now) acknowledged.set(path, now);
  else acknowledged.delete(path);
  rewatchDocumentFile(docId, path);
}

/**
 * Moves the disk watch of a document to a path. The watch on the old file is stopped first. Used after Save As and
 * after a reload.
 */
export function rewatchDocumentFile(docId: string, path: string): void {
  watches.get(docId)?.();
  watches.delete(docId);
  watchDocumentFile(docId, path);
}

/**
 * Save As re-keys the document to the file it wrote: the tab shows the new file's name and path, the shared document
 * record takes the new name, the disk watch follows the new file, and the recent list gets the new file. Saves after
 * this go to the new path (savePathOf).
 */
function retargetDocument(docId: string, path: string): void {
  const name = path.split(/[\\/]/).pop() ?? 'document.pdf';
  rewatchDocumentFile(docId, path);
  useDocumentsStore.setState((state) => (state.docs[docId] ? { docs: { ...state.docs, [docId]: { ...state.docs[docId]!, name } } } : {}));
  const workspace = useWorkspaceStore.getState();
  for (const tab of workspace.tabs) {
    if (tab.panes.some((pane) => pane.docId === docId)) workspace.patchTab(tab.id, { title: name, origin: { kind: 'path', path } });
  }
  void fileService.noteOpened({ kind: 'path', path, name });
}

/**
 * Moves every record of a document from one docId to another. Used after Save As: the document is then the file it
 * was written to, so the old path opens as a fresh document again. The disk watch of the old id is stopped here; the
 * caller starts one for the new id. Returns false when the registry could not move the document.
 */
export function rekeyDocument(oldId: string, newId: string): boolean {
  if (oldId === newId) return true;
  if (!documentRegistry.rekey(oldId, newId)) return false;
  renamedTo.set(oldId, newId);
  const stop = watches.get(oldId);
  watches.delete(oldId);
  stop?.();
  useEditStore.getState().rekey(oldId, newId);
  rekeyEditState(oldId, newId);
  moveSessionPassword(oldId, newId);
  useDocumentsStore.setState((state) => {
    const doc = state.docs[oldId];
    if (!doc) return {};
    const { [oldId]: _moved, ...rest } = state.docs;
    // Page ids start with the document id, so they follow the document to its new id.
    const pages = doc.pages.map((page) => ({ ...page, id: rekeyPageId(oldId, newId, page.id) }));
    return { docs: { ...rest, [newId]: { ...doc, docId: newId, pages } } };
  });
  rekeySelection(oldId, newId);
  // An open sheet of the old id would act on a document that is no longer keyed that way: it closes.
  if (useSheetStore.getState().sheet?.docId === oldId) useSheetStore.getState().close();
  const viewOf = (pane: { docId: string; view: ViewState }) =>
    pane.docId === oldId && pane.view.pageId !== null ? { ...pane.view, pageId: rekeyPageId(oldId, newId, pane.view.pageId) } : pane.view;
  useWorkspaceStore.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.panes.some((pane) => pane.docId === oldId)
        ? { ...tab, panes: tab.panes.map((pane) => (pane.docId === oldId ? { ...pane, docId: newId, view: viewOf(pane) } : pane)) }
        : tab,
    ),
  }));
  const savedPath = savedTo.get(oldId);
  savedTo.delete(oldId);
  if (savedPath !== undefined) savedTo.set(newId, savedPath);
  if (savingDocs.delete(oldId)) savingDocs.add(newId);
  // A search of the old id would show hits for a document that is no longer keyed that way.
  if (useSearchStore.getState().docId === oldId) useSearchStore.getState().setOpen(false);
  return true;
}

/** The path a document saves to: the Save As target, or the path it was opened from. Null for a byte source. */
export function savePathOf(docId: string): string | null {
  return savedTo.get(docId) ?? (docId.startsWith('path:') ? docId.slice('path:'.length) : null);
}

export type SaveOutcome =
  | { status: 'saved'; path: string; mode: 'incremental' | 'full' }
  | { status: 'cancelled' }
  /**
   * The file on disk is not the one the app last saw (another program changed it). Nothing was written. The document's
   * "changed on disk" state is set, so the bar offers Reload or Keep my version, and the user saves again after choosing.
   */
  | { status: 'changed-on-disk' }
  /**
   * The file is encrypted and could not be saved with its encryption. The UI asks the user how to save. `target` is the
   * path the user picked in the Save dialog (null when the save was to the document's own path): the choice must be
   * carried out there, not on the document's current file.
   */
  | { status: 'needs-encryption-choice'; target: string | null }
  /**
   * The estimated size (saved size plus the sources added since) is over the edit limit. Nothing was done, so Undo still works.
   * The estimate can count pages deleted since, so the UI asks (MAY_BE_TOO_LARGE_QUESTION) and saves again with confirmedLarge.
   */
  | { status: 'may-be-too-large' };

/**
 * Saves the document. Without `saveAs` it writes to the path it is saved to. With `saveAs`, or for a document with no
 * path, the Save dialog picks the path. Throws a plain error when the save fails, and leaves the document as it was.
 *
 * One save runs at a time per document. A plain Save asked for while one runs joins it (it gets the same result). A
 * Save As, or a save with a choice, waits for the running one and then runs.
 */
export function saveDocument(docId: string, options: SaveOptions = {}): Promise<SaveOutcome> {
  const running = inflight.get(docId);
  if (running) {
    const plain = !options.saveAs && !options.dropEncryption && !options.targetPath && !options.confirmedLarge;
    if (plain) return running;
    // A Save As that ran meanwhile re-keyed the document, so the queued save goes to its current id.
    return running.then(
      () => saveDocument(currentIdOf(docId), options),
      () => saveDocument(currentIdOf(docId), options),
    );
  }
  const promise = runSave(docId, options);
  inflight.set(docId, promise);
  const release = (): void => {
    for (const [id, p] of inflight) if (p === promise) inflight.delete(id);
  };
  void promise.then(release, release);
  return promise;
}

async function runSave(docId: string, options: SaveOptions): Promise<SaveOutcome> {
  const ids = new Set([docId]);
  try {
    return await saveDocumentNow(docId, options, (id) => ids.add(id));
  } finally {
    // Save As re-keys the document while it is saving, so both ids are cleared.
    for (const id of ids) endSaving(id);
  }
}

function beginSaving(docId: string): void {
  savingDocs.add(docId);
  useEditStore.getState().setSaving(docId, true);
}

function endSaving(docId: string): void {
  savingDocs.delete(docId);
  useEditStore.getState().setSaving(docId, false);
}

/** True while a save of this document is writing. Edits, undo and redo are refused then. */
export function isSaving(docId: string): boolean {
  return savingDocs.has(docId);
}

export interface SaveOptions {
  /** Ask for a path even when the document has one. */
  saveAs?: boolean;
  /** Save to this path without asking: the target the user already picked, carried through an encryption choice. */
  targetPath?: string;
  /** Write the file without its encryption. Used after the user chose to drop the encryption (see NeedsEncryptionChoice). */
  dropEncryption?: boolean;
  /** The user answered "Save anyway" to the question asked when the estimated size is over the edit limit. */
  confirmedLarge?: boolean;
}

/** A save that found the file changed on disk: the bar asks Reload or Keep my version, and nothing is written. */
function refuseSave(docId: string): SaveOutcome {
  useEditStore.getState().setChangedOnDisk(docId, true);
  return { status: 'changed-on-disk' };
}

async function saveDocumentNow(docId: string, options: SaveOptions, alsoSaving: (id: string) => void): Promise<SaveOutcome> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('Saving needs the desktop app.');
  const handle = documentRegistry.get(docId);
  if (!handle || !(handle.doc instanceof MupdfDocument)) throw new Error('This document cannot be saved.');
  // A file over the edit limit is open for viewing only: nothing is saved, and nothing is asked (the commands are off too).
  refuseViewOnly(docId);
  const doc = handle.doc;

  const current = savePathOf(docId);
  let target = current;
  let picked: string | null = null;
  if (options.targetPath) {
    target = options.targetPath;
    picked = target;
  } else if (!current || options.saveAs) {
    const suggested = current ? `${current.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document'}.pdf` : 'document.pdf';
    target = await bridge.files.saveDialog(suggested);
    if (!target) return { status: 'cancelled' };
    picked = target;
  }

  // Save As over a file that another tab has open would leave two documents for one file. Refuse it instead.
  // A tab whose engine was ended in the background (released) still has the file open: it counts.
  const targetId = target === null ? null : documentRegistry.sameFileId(pathDocId(target));
  if (target !== current && targetId !== null && (documentRegistry.get(targetId) || documentRegistry.isSuspended(targetId))) {
    throw new Error('That file is open in another tab. Close that tab first, then save over it.');
  }

  // The estimate of 1.5.10 (the size as last saved or opened, plus the sources attached since: addedBytes.ts) counts every added
  // source in full, so it can be higher than the truth (pages deleted since). Over the limit the user is asked BEFORE the engine
  // runs: an engine save empties MuPDF's undo journal, and asking spends nothing, so Cancel keeps Undo.
  const savedSize = (current ? stamps.get(current)?.size : undefined) ?? useDocumentsStore.getState().docs[docId]?.byteSize ?? 0;
  if (!options.confirmedLarge && addedBytesOf(docId) > 0 && savedSize + addedBytesOf(docId) > MAX_EDIT_BYTES) return { status: 'may-be-too-large' };

  // From here to the reopen, edits are refused: one made in this window would be lost when the saved bytes replace the
  // document. An edit still running is waited for first, so its step is in the bytes and in the recovery log.
  beginSaving(docId);
  await settleEdits(docId);

  const samePath = target === current;
  let diskUnchanged = false;
  if (samePath && current) {
    const was = stamps.get(current);
    const now = await bridge.files.stat(current).catch(() => null);
    // Another program changed the file since the app last saw it (opened, saved, or "Keep my version"): never write over
    // it without asking. The watch only looks every few seconds, so this check is what stops a Save pressed right after.
    if (changedBeforeSave(acknowledged.get(current) ?? was, now)) return refuseSave(docId);
    diskUnchanged = !!was && !!now && now.size === was.size && now.modified === was.modified;
  }

  let saved;
  try {
    saved = await doc.save(samePath, diskUnchanged, options.dropEncryption === true);
  } catch (error) {
    if (error instanceof Error && error.name === 'NeedsEncryptionChoice') return { status: 'needs-encryption-choice', target: picked };
    // A save the engine could not make (out of memory, or any engine failure) says why and what is still true.
    if (error instanceof Error && (error.name === 'Internal' || isOutOfMemory(error))) throw new Error(engineSaveFailedMessage(error, docId));
    throw error;
  }

  // The main process refuses a write over its size limit as "invalid-argument", which must not be mistaken for a missing
  // write right (and sent to the Save dialog): say what is wrong instead.
  // The engine has made the bytes, so the steps are spent (see MupdfCore.save): the message says so, as a failed write does.
  if (saved.bytes.byteLength > MAX_EDIT_BYTES) throw new Error(`${TOO_LARGE_TO_SAVE}${undoLostSentence(docId)}`);
  // Reopen the bytes in a fresh worker BEFORE anything is written, and check that they hold what is on screen: the same
  // pages in the same order, with the same rotations, crops and content. Bytes that do not (a save that wrote none of the
  // edits) are never written over the file, and nothing is cleared: the document stays unsaved, with its undo history
  // and its recovery log. An encrypted file needs its password to open again. It is the one the document was opened
  // with (kept in memory only).
  const session = await openMupdf(new Uint8Array(saved.bytes), { password: sessionPasswordOf(docId) });
  const fresh = session.document() as MupdfDocument;
  try {
    const reopened = await fresh.fingerprints();
    const wrongAt = firstMismatch(saved.fingerprints, reopened);
    if (wrongAt >= 0) {
      throw new Error(`The saved copy did not match the document on screen, so nothing was written. Your edits are still open and unsaved.${undoLostSentence(docId)}`);
    }
  } catch (error) {
    await fresh.destroy();
    throw error;
  }
  // The file can change while the bytes are made and checked: look once more right before the write. The main process
  // checks again, just before it replaces the file, against the same stamp (a gap of microseconds is all that is left).
  const expected = samePath && current ? (acknowledged.get(current) ?? stamps.get(current)) : undefined;
  if (samePath && current) {
    const again = await bridge.files.stat(current).catch(() => null);
    if (changedBeforeSave(expected, again)) {
      await fresh.destroy();
      return refuseSave(docId);
    }
  }
  const write = expected
    ? bridge.files.saveAtomic(target!, saved.bytes, { size: expected.size, modified: expected.modified })
    : bridge.files.saveAtomic(target!, saved.bytes);
  const written = await write.catch(() => ({ ok: false as const, reason: 'unreadable' as const }));
  if (!written.ok && written.reason === 'changed-on-disk') {
    // The main process found the file different from the stamp when it was about to replace it: nothing was written.
    await fresh.destroy();
    return refuseSave(docId);
  }
  if (!written.ok && written.reason === 'invalid-argument' && picked === null) {
    // The main process only writes a file the user opened or picked in this session. A Recent or last-session reopen the main
    // process did not accept (files:openKnown allows each such path once per session) has a read grant only, so its first Save
    // asks through the Save dialog, which grants it.
    await fresh.destroy();
    return saveDocumentNow(docId, { ...options, saveAs: true }, alsoSaving);
  }
  if (!written.ok) {
    await fresh.destroy();
    // A file already known to be gone that cannot be written: the folder it was in is the likely cause (the main process only
    // reports "write-failed"). Say so, and point to Save As.
    if (target === current && useEditStore.getState().missingOnDisk[docId] === true && written.reason === 'write-failed') {
      throw new Error(`${MISSING_FOLDER_MESSAGE}${undoLostSentence(docId)}`);
    }
    throw new Error(failedSaveMessage(docId));
  }

  // The saved bytes become the document. It starts clean, with no undo history.
  const orderBefore = currentOrder(docId);
  if (!documentRegistry.replaceDocument(docId, fresh)) {
    await fresh.destroy();
    throw new Error('The document was closed while it was being saved.');
  }
  watchUnresponsive(docId, fresh, currentIdOf);
  // The saved file holds the sources' pages and the new worker has no sources: the size check of an add counts from the saved size again.
  resetAdded(docId);
  // The new document's uids start again at 0: the selection and each pane's current page follow their pages by position.
  remapAfterReplace(docId, orderBefore, true);
  await rememberFileStamp(target!);
  // The file now holds the edits, so the recovery logs of the files it was saved to are no longer needed.
  await clearEditLogAfterSave(docId, [current, target!].filter((p): p is string => p !== null));
  if (target !== current) {
    // Save As: the document is now the file it was written to. Its id follows the path (see rekeyDocument).
    const newId = pathDocId(target!);
    alsoSaving(newId);
    if (!rekeyDocument(docId, newId)) throw new Error('The document was closed while it was being saved.');
    retargetDocument(newId, target!);
  }
  // The file is back in its place: the "moved or deleted" bar (1.5.5 D4) goes, under either id (Save As re-keyed it).
  useEditStore.getState().setMissingOnDisk(docId, false);
  useEditStore.getState().setMissingOnDisk(currentIdOf(docId), false);
  return { status: 'saved', path: target!, mode: saved.mode };
}

export type ExtractOutcome =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  /** The source is encrypted and the extract could not keep its encryption. `target` is the path the user picked. */
  | { status: 'needs-encryption-choice'; target: string };

export interface ExtractOptions {
  /** Write to this path without asking: the target the user already picked, carried through an encryption choice. */
  targetPath?: string;
  /** Write the extract without encryption (the user's choice for an encrypted source). */
  dropEncryption?: boolean;
}

/**
 * Extract: copies the pages with these uids into a new PDF and writes it to a path the Save dialog picks, with the
 * default name "<name>-extract.pdf". The document itself is not changed. An encrypted source gives an encrypted extract
 * with the same password (kept in memory only, see sessionPasswords); when that cannot be done the outcome is
 * needs-encryption-choice, the same choice a save offers, and nothing is written until the user decides.
 */
export async function extractPages(docId: string, uids: string[], sourceName: string, options: ExtractOptions = {}): Promise<ExtractOutcome> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('Extracting needs the desktop app.');
  const handle = documentRegistry.get(docId);
  if (!handle || !(handle.doc instanceof MupdfDocument)) throw new Error('This document cannot be extracted.');
  const target = options.targetPath ?? (await bridge.files.saveDialog(`${sourceName.replace(/\.pdf$/i, '')}-extract.pdf`));
  if (!target) return { status: 'cancelled' };
  let bytes: ArrayBuffer;
  try {
    bytes = await handle.doc.extract(uids, { dropEncryption: options.dropEncryption === true, password: sessionPasswordOf(docId) });
  } catch (error) {
    if (error instanceof Error && error.name === 'NeedsEncryptionChoice') return { status: 'needs-encryption-choice', target };
    throw error;
  }
  if (bytes.byteLength > MAX_EDIT_BYTES) throw new Error(TOO_LARGE_TO_EXTRACT);
  const written = await bridge.files.saveAtomic(target, bytes);
  if (!written.ok) throw new Error('The file could not be saved. Check that it is not open in another program.');
  return { status: 'saved', path: target };
}

/** Test hook: forgets the stamps and save targets. */
export function resetSaveState(): void {
  stamps.clear();
  savedTo.clear();
  acknowledged.clear();
  inflight.clear();
  renamedTo.clear();
}
