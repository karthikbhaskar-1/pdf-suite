import { fileService } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useSheetStore, type InsertTemplate } from '../../core/stores/sheetStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useUiStore } from '../../core/stores/uiStore';
import type { PageEdit } from '../../engine/mupdf/protocol';
import { insertedNoun } from '../../engine/mupdf/insertLabel';
import { diag, diagEnabled } from '../../engine/diag';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import { WAIT_MESSAGE, applyPageEdits, attachSourceLogged, discardLastPageEdit, redoPageEdit, undoPageEdit } from '../documents/editOps';
import { extractWithFeedback } from '../documents/closeFlow';
import { DOCUMENT_GONE, ERROR_MESSAGES, isPdfOpenError, plainMessage, readFailureMessage } from '../../engine/errors';
import { askSourcePassword } from './sourcePassword';
import { precheckBytes } from '../../engine/precheck';
import { addBlocked } from '../documents/sourceCheck';
import { deleteNeedsConfirm, pageIdFromUid, pageUidFromId, reverseScopeOf, wouldEmptyDocument } from './pageMath';
import { defaultUnitFor } from './units';
import { cutScopeUids, defaultCutScope, CUT_DEFAULT_PERCENT, type CutInputs, type CutScope, type CutDirection, type CutTargets } from './cutMath';

/**
 * The page organizer's actions: each one is a page edit with its feedback (a toast with Undo), or opens a sheet. The
 * commands (app/organizerCommands.ts), the top bar, the thumbnail row and the menus all call these.
 */

/** The focused pane, or undefined when no document is showing. */
export function activePane() {
  const state = useWorkspaceStore.getState();
  return selectPane(state, state.activePaneId);
}

/** The document of the focused pane, or undefined. */
export function activeDocId(): string | undefined {
  return activePane()?.docId;
}

/** The page uids of a document, in page order, as the worker last reported them. */
export function orderOf(docId: string): string[] {
  return [...(useEditStore.getState().byDoc[docId]?.uids ?? [])];
}

/** The uid of the focused pane's current page, or null. */
export function currentUid(docId: string): string | null {
  const pane = activePane();
  if (!pane || pane.docId !== docId || !pane.view.pageId) return null;
  return pageUidFromId(docId, pane.view.pageId);
}

/**
 * The selected pages as uids, in page order. Empty when nothing is selected. This is the one place where a stored
 * selection becomes target pages: it walks the page list of `docId` and keeps only the pages whose id is selected, so an
 * id that belongs to another document (a selection made in a tab the user left) is dropped and never reaches the engine.
 */
export function selectedUids(docId: string): string[] {
  const ids = new Set(useSelectionStore.getState().pageIds);
  const picked: string[] = [];
  for (const uid of orderOf(docId)) {
    if (ids.has(pageIdFromUid(docId, uid))) picked.push(uid);
  }
  return picked;
}

/**
 * The pages an action works on: the selection when there is one, else the current page. This is the rule of the thumbnail
 * row and the Pages menus.
 */
export function targetUids(docId: string): string[] {
  const selected = selectedUids(docId);
  if (selected.length > 0) return selected;
  const current = currentUid(docId);
  // The current page must be a page of this document's list, like the selected ones.
  return current === null || !orderOf(docId).includes(current) ? [] : [current];
}

const busy = new Set<string>();

/** What an edit asked for while another edit runs is told. The same words as the Undo and Redo guard (see editOps). */
export const BUSY_MESSAGE = WAIT_MESSAGE;

/**
 * Message for an edit that failed, in plain English (engine error kinds are never shown raw). A cancelled edit says
 * nothing.
 */
export function messageOf(error: unknown, fallback = 'The pages could not be changed.'): string {
  return plainMessage(error, fallback);
}

/** The toast text after an edit, in the past tense: "Deleted 3 pages". */
export function doneText(op: PageEdit['op'], count: number, detail = '', edits: readonly PageEdit[] = []): string {
  const noun = count === 1 ? 'page' : 'pages';
  switch (op) {
    case 'delete':
      return `Deleted ${count} ${noun}`;
    case 'move':
      return `Moved ${count} ${noun}`;
    case 'duplicate':
      return `Duplicated ${count} ${noun}`;
    case 'rotate':
      return `Rotated ${count} ${noun}`;
    case 'reverse':
      return `Reversed ${count} ${noun}`;
    case 'insertBlank':
      return `Inserted ${count} ${edits.length > 0 ? insertedNoun(edits, count) : `blank ${noun}`}`;
    case 'insertFrom':
      return `Inserted ${count} ${noun} from PDF`;
    case 'crop':
      return detail || `Cropped ${count} ${noun}`;
    case 'resize':
      return `Resized ${count} ${noun}`;
    case 'slice':
      return `Cut ${count} ${noun} in half`;
    case 'replace':
      return 'Replaced the page';
  }
  return 'Changed the pages';
}

function countOf(edits: readonly PageEdit[]): number {
  return edits.reduce((sum, edit) => {
    if ('uids' in edit) return sum + edit.uids.length;
    if (edit.op === 'insertBlank') return sum + (edit.count ?? 1);
    if (edit.op === 'insertFrom') return sum + edit.sourceUids.length;
    return sum + 1;
  }, 0);
}

/**
 * Runs page edits as one step on a document. On success a toast says what was done, with an Undo button. Returns true
 * when the edit went through, and false when it failed or changed nothing. Edits do not overlap: a second one while the first runs is refused with a message (BUSY_MESSAGE).
 */
export async function runEdits(docId: string, edits: PageEdit[], done?: string): Promise<boolean> {
  return (await runEditsOutcome(docId, edits, done)) === 'done';
}

/** How a page edit ended: it went through, it was cancelled (and rolled back), or it failed / changed nothing / was refused. */
export type EditOutcome = 'done' | 'cancelled' | 'failed';

/** runEdits, saying whether a false result was a cancel (the side sheets treat a cancel differently: 1.5.5 C5). */
export async function runEditsOutcome(docId: string, edits: PageEdit[], done?: string): Promise<EditOutcome> {
  const outcome = await runEditsInner(docId, edits, done);
  lastOutcome = outcome;
  return outcome;
}

let lastOutcome: EditOutcome = 'done';

/** How the latest runEdits ended (the sheet reads it to tell a cancel from a failure). */
export function lastEditOutcome(): EditOutcome {
  return lastOutcome;
}

/** Forgets how the previous edit ended, so a sheet's Apply that never reaches runEdits is not read as a cancel. */
export function resetEditOutcome(): void {
  lastOutcome = 'failed';
}

async function runEditsInner(docId: string, edits: PageEdit[], done?: string): Promise<EditOutcome> {
  if (busy.has(docId) || edits.length === 0) {
    if (diagEnabled()) diag('runEdits.ignored', { busy: busy.has(docId), edits: edits.length });
    // A press that arrives while an edit is running is refused with the same plain message the Undo and Redo guards use,
    // never dropped without a word. (It is not queued: it was aimed at the pages as they were when it was pressed.)
    if (busy.has(docId)) useUiStore.getState().pushToast(BUSY_MESSAGE);
    return 'failed';
  }
  busy.add(docId);
  let changed: boolean;
  try {
    changed = await applyPageEdits(docId, edits);
  } catch (error) {
    // The document was closed or replaced while the edit ran: there is nothing to tell the user about it.
    if ((error as Error)?.name === DOCUMENT_GONE) return 'failed';
    const message = messageOf(error);
    diag('runEdits.error', { name: (error as Error)?.name, raw: (error as Error)?.message, message });
    if (message) useUiStore.getState().pushToast(message);
    // A cancelled page change says so (1.5.5 C5; it said nothing for anything but a cut before).
    else if (['AbortError', 'Cancelled'].includes((error as Error)?.name)) {
      useUiStore.getState().pushToast(CUT_CANCELLED_MESSAGE);
      return 'cancelled';
    }
    return 'failed';
  } finally {
    busy.delete(docId);
  }
  if (!changed) {
    // The edit changed nothing (an auto-crop of blank pages), so there is no step to undo.
    useUiStore.getState().pushToast('Nothing changed');
    return 'failed';
  }
  const first = edits[0]!;
  const text = done ?? doneText(first.op, countOf(edits), '', edits);
  useUiStore.getState().pushToast(text, { label: 'Undo', run: () => void undoEdit(docId) });
  return 'done';
}

/** Undo of the last step. Failure is shown as a toast. */
export async function undoEdit(docId: string): Promise<void> {
  try {
    await undoPageEdit(docId);
  } catch (error) {
    useUiStore.getState().pushToast(messageOf(error) || 'Nothing to undo');
  }
}

/** Takes back the latest step with no redo left (a cancelled preview). Failure is shown as a toast. */
export async function discardLastEdit(docId: string): Promise<void> {
  try {
    await discardLastPageEdit(docId);
  } catch (error) {
    useUiStore.getState().pushToast(messageOf(error) || 'Nothing to undo');
  }
}

/** Redo of the next step. Failure is shown as a toast. */
export async function redoEdit(docId: string): Promise<void> {
  try {
    await redoPageEdit(docId);
  } catch (error) {
    useUiStore.getState().pushToast(messageOf(error) || 'Nothing to redo');
  }
}

/** What a cancelled cut tells the user. */
export const CUT_CANCELLED_MESSAGE = 'Cancelled. The document was not changed.';

/** The message when an action would leave a document with no pages. */
export const LAST_PAGE_MESSAGE = 'A PDF needs at least one page.';

/** True when `uids` names every page of the document, so deleting them would leave none. */
export function deletesEveryPage(docId: string, uids: readonly string[]): boolean {
  return wouldEmptyDocument(orderOf(docId), uids);
}

/**
 * Deletes pages. When the current page is deleted it moves to the first deleted place, and the selection is cleared. The last page of a document cannot
 * be deleted: the request is refused before anything changes.
 */
export async function deletePages(docId: string, uids: readonly string[]): Promise<boolean> {
  const order = orderOf(docId);
  const doomed = new Set(uids);
  if (doomed.size === 0) return false;
  if (deletesEveryPage(docId, uids)) {
    useUiStore.getState().pushToast(LAST_PAGE_MESSAGE);
    return false;
  }
  const current = currentUid(docId);
  const ok = await runEdits(docId, [{ op: 'delete', uids: [...doomed] }], `Deleted ${doomed.size} ${doomed.size === 1 ? 'page' : 'pages'}`);
  if (!ok) return false;
  useSelectionStore.getState().setSelection([], null);
  const remaining = order.filter((uid) => !doomed.has(uid));
  const pane = activePane();
  if (pane && pane.docId === docId && current !== null && doomed.has(current) && remaining.length > 0) {
    // The first deleted place: the page that now stands where the first deleted page stood (the thumbnail list's active row
    // goes to the same page, so the next Delete acts on the page the focus ring is on).
    const firstGone = order.findIndex((uid) => doomed.has(uid));
    const next = remaining[Math.min(Math.max(firstGone, 0), remaining.length - 1)];
    if (next !== undefined) useWorkspaceStore.getState().setView(pane.id, { pageId: pageIdFromUid(docId, next), offset: 0 });
  }
  return true;
}

/** Delete from a command, a key or a menu. Removing more than half the pages asks first, inline in the sheet. */
export function requestDelete(docId: string): void {
  const uids = targetUids(docId);
  if (diagEnabled()) {
    const sel = useSelectionStore.getState();
    const total = orderOf(docId).length;
    diag('requestDelete', {
      targets: uids.length,
      first: uids[0],
      last: uids.at(-1),
      total,
      selectionIds: sel.pageIds.length,
      anchor: sel.anchorId,
      current: currentUid(docId),
      everyPage: deletesEveryPage(docId, uids),
      needsConfirm: deleteNeedsConfirm(total, uids.length),
    });
  }
  if (uids.length === 0) return;
  // Refused first, before the confirm sheet: a delete that would leave no page never asks.
  if (deletesEveryPage(docId, uids)) {
    useUiStore.getState().pushToast(LAST_PAGE_MESSAGE);
    return;
  }
  const total = orderOf(docId).length;
  if (deleteNeedsConfirm(total, uids.length)) {
    useSheetStore.getState().open({ kind: 'confirmDelete', docId, uids, total });
    return;
  }
  void deletePages(docId, uids);
}

/** Moves pages before `beforeUid` (null: to the end). */
export function movePages(docId: string, uids: readonly string[], beforeUid: string | null): Promise<boolean> {
  return runEdits(docId, [{ op: 'move', uids: [...uids], beforeUid }], `Moved ${uids.length} ${uids.length === 1 ? 'page' : 'pages'}`);
}

/** Keyboard moves: the targets (the selection, else the current page) go up, down, to the start or to the end. */
export function moveTargets(docId: string): string[] {
  return targetUids(docId);
}

/** Extract: the target pages go to a new file the Save dialog picks, named "<name>-extract.pdf". */
export async function extractTargets(docId: string): Promise<void> {
  const uids = targetUids(docId);
  if (uids.length === 0) return;
  const name = useDocumentsStore.getState().docs[docId]?.name ?? 'document.pdf';
  const ordered = orderOf(docId).filter((uid) => uids.includes(uid));
  await extractWithFeedback(docId, ordered, name);
}

/** Opens the Insert sheet on the focused document. `template` picks the first segment. */
export function openInsertSheet(template: InsertTemplate = 'blank'): boolean {
  const pane = activePane();
  if (!pane) return false;
  const order = orderOf(pane.docId);
  const pageIndex = Math.max(0, order.indexOf(currentUid(pane.docId) ?? ''));
  useSheetStore.getState().open({
    kind: 'insert',
    docId: pane.docId,
    template,
    size: 'letter',
    custom: { width: 8.5, height: 11 },
    unit: defaultUnitFor(typeof navigator !== 'undefined' ? navigator.language : undefined),
    count: 1,
    position: 'after',
    at: pageIndex + 2,
    pageIndex,
  });
  return true;
}

/** Opens the From PDF sheet. */
export function openFromSheet(): boolean {
  const pane = activePane();
  if (!pane) return false;
  const order = orderOf(pane.docId);
  const pageIndex = Math.max(0, order.indexOf(currentUid(pane.docId) ?? ''));
  useSheetStore.getState().open({
    kind: 'from',
    docId: pane.docId,
    pageIndex,
    sourceDocId: null,
    sourceName: null,
    sourcePages: 0,
    range: '',
    position: 'after',
    at: pageIndex + 2,
  });
  return true;
}

/** Opens the Replace sheet on the current page (or the page with `uid`). */
export function openReplaceSheet(uid?: string): boolean {
  const pane = activePane();
  if (!pane) return false;
  const target = uid ?? currentUid(pane.docId);
  if (target === null) return false;
  const order = orderOf(pane.docId);
  useSheetStore.getState().open({
    kind: 'replace',
    docId: pane.docId,
    uid: target,
    pageNumber: order.indexOf(target) + 1,
    sourceDocId: null,
    sourceName: null,
    sourcePages: 0,
    sourcePage: 1,
  });
  return true;
}

/** Opens the Rotate sheet on the targets. */
export function openRotateSheet(degrees = 0): boolean {
  const pane = activePane();
  if (!pane) return false;
  const uids = targetUids(pane.docId);
  if (uids.length === 0) return false;
  useSheetStore.getState().open({ kind: 'rotate', docId: pane.docId, uids, degrees });
  return true;
}

/** Rotates the targets by a number of degrees. Multiples of 90 are native rotations; other angles are custom. */
export function rotateTargets(degrees: number): Promise<boolean> {
  const pane = activePane();
  if (!pane) return Promise.resolve(false);
  const uids = targetUids(pane.docId);
  if (uids.length === 0 || degrees === 0) return Promise.resolve(false);
  return runEdits(pane.docId, [{ op: 'rotate', uids, degrees }]);
}

/** Opens the Crop sheet. The scope starts at the selection when there is one, else the current page. */
export function openCropSheet(): boolean {
  const pane = activePane();
  if (!pane || !pane.view.pageId) return false;
  const selected = selectedUids(pane.docId);
  useSheetStore.getState().open({
    kind: 'crop',
    docId: pane.docId,
    uids: selected.length > 0 ? selected : targetUids(pane.docId),
    pageId: pane.view.pageId,
    scope: selected.length > 0 ? 'selected' : 'current',
    unit: defaultUnitFor(typeof navigator !== 'undefined' ? navigator.language : undefined),
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoApplied: false,
  });
  return true;
}

/** Auto-crop: trims the white space of the targets. Applied at once and undoable, from the menu or the Crop sheet. */
export function autoCropTargets(docId: string, uids: readonly string[]): Promise<boolean> {
  if (uids.length === 0) return Promise.resolve(false);
  return runEdits(docId, [{ op: 'crop', uids: [...uids], box: 'auto' }], `Auto-cropped ${uids.length} ${uids.length === 1 ? 'page' : 'pages'}`);
}

/** Opens the Page size sheet. */
export function openSizeSheet(): boolean {
  const pane = activePane();
  if (!pane) return false;
  const selected = selectedUids(pane.docId);
  useSheetStore.getState().open({
    kind: 'size',
    docId: pane.docId,
    uids: selected.length > 0 ? selected : orderOf(pane.docId),
    size: 'a4',
    custom: { width: 8.5, height: 11 },
    unit: defaultUnitFor(typeof navigator !== 'undefined' ? navigator.language : undefined),
    fit: 'scale',
    scope: selected.length > 0 ? 'selected' : 'all',
  });
  return true;
}

/**
 * What the Cut sheet's "Apply to" reads, taken from the stores as they are now: the page list, each page's size by
 * position, the selection and the focused pane's current page. The pure rules are in cutMath.ts.
 */
export function cutInputs(docId: string): CutInputs {
  return {
    order: orderOf(docId),
    sizes: useDocumentsStore.getState().docs[docId]?.sizes ?? [],
    selected: selectedUids(docId),
    current: currentUid(docId),
  };
}

/** The pages a Cut scope names right now. */
export function cutTargetsFor(docId: string, scope: CutScope, direction: CutDirection): CutTargets {
  return cutScopeUids(cutInputs(docId), scope, direction);
}

/** Opens the Cut Pages in Half sheet. "Apply to" starts at the selected pages when two or more are selected, else all pages. */
export function openCutSheet(): boolean {
  const pane = activePane();
  if (!pane) return false;
  useSheetStore.getState().open({
    kind: 'cut',
    docId: pane.docId,
    direction: 'vertical',
    percentText: String(CUT_DEFAULT_PERCENT),
    first: 'left',
    scope: defaultCutScope(selectedUids(pane.docId).length),
  });
  return true;
}

/** Duplicates the targets. Each copy goes after its original. */
export function duplicateTargets(): Promise<boolean> {
  const pane = activePane();
  if (!pane) return Promise.resolve(false);
  const uids = targetUids(pane.docId);
  if (uids.length === 0) return Promise.resolve(false);
  return runEdits(pane.docId, [{ op: 'duplicate', uids }]);
}

/**
 * The pages Reverse works on: the selection, or every page when nothing is selected (the toast then says "all"). Choice
 * documented here and in the command's tooltip.
 */
export function reverseScope(docId: string): { uids: string[]; all: boolean } {
  return reverseScopeOf(orderOf(docId), new Set(selectedUids(docId)));
}

/** Reverses the order of the targets. Says so when there is nothing to reverse, instead of doing nothing silently. */
export function reverseTargets(): Promise<boolean> {
  const pane = activePane();
  if (!pane) return Promise.resolve(false);
  const { uids, all } = reverseScope(pane.docId);
  if (uids.length < 2) {
    useUiStore
      .getState()
      .pushToast(all ? 'A PDF needs at least two pages to reverse.' : 'Select two or more pages to reverse, or clear the selection to reverse all pages.');
    return Promise.resolve(false);
  }
  return runEdits(pane.docId, [{ op: 'reverse', uids }], all ? `Reversed all ${uids.length} pages` : undefined);
}

/**
 * Reads a PDF the user picked, for an insert or a replace. The source stays in the document's worker until the document
 * closes. Resolves with its id and page count, or null when the user cancelled or the file could not be read.
 */
export async function attachPickedSource(docId: string): Promise<{ sourceDocId: string; pages: number; name: string } | null> {
  const [source] = await fileService.pickPdfs();
  if (!source) return null;
  let bytes: ArrayBuffer;
  if (source.kind === 'bytes') {
    bytes = toArrayBuffer(source.bytes);
  } else {
    const bridge = getDesktopBridge();
    if (!bridge) return null;
    // The size is checked BEFORE the file is read: a source over the edit limit, or one that would take the document past it,
    // is refused with the reason, and nothing is read or changed (see features/documents/sourceCheck.ts).
    const stat = await Promise.resolve()
      .then(() => bridge.files.stat(source.path))
      .catch(() => null);
    const blocked = stat ? await addBlocked(docId, stat.size) : null;
    if (blocked) {
      useUiStore.getState().pushToast(blocked);
      return null;
    }
    const read = await bridge.files.read(source.path);
    if (!read.ok) {
      // The desktop read says why it refused (not a PDF, empty, missing...), and the engine's text says it.
      useUiStore.getState().pushToast(readFailureMessage(read.reason));
      return null;
    }
    bytes = read.bytes;
  }
  // The bytes' own size, for a source whose stat was not available (and for a byte source): the same rule.
  const tooBig = await addBlocked(docId, bytes.byteLength);
  if (tooBig) {
    useUiStore.getState().pushToast(tooBig);
    return null;
  }
  // The engine's own classification first: a file that is not a PDF is "This isn't a PDF.", whatever the path.
  const notPdf = precheckBytes(new Uint8Array(bytes));
  if (notPdf) {
    useUiStore.getState().pushToast(ERROR_MESSAGES[notPdf.kind]);
    return null;
  }
  // A protected PDF asks for its password. A wrong one is said so in plain English and asked again; Cancel leaves the
  // document alone. The password is used for this call only and is not kept.
  let password: string | undefined;
  for (;;) {
    try {
      const attached = await attachSourceLogged(docId, bytes.slice(0), password);
      return { ...attached, name: source.name };
    } catch (error) {
      const kind = isPdfOpenError(error) ? error.kind : null;
      if (kind === 'PasswordNeeded' || kind === 'WrongPassword') {
        const answer = await askSourcePassword(source.name, kind === 'WrongPassword' ? ERROR_MESSAGES.WrongPassword : null);
        if (answer === null) return null;
        password = answer;
        continue;
      }
      useUiStore.getState().pushToast(messageOf(error, 'That PDF could not be used.'));
      return null;
    }
  }
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
