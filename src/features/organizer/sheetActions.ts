import { create } from 'zustand';
import { documentRegistry } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import {
  useSheetStore,
  type CropDraft,
  type CutDraft,
  type FromDraft,
  type InsertDraft,
  type ReplaceDraft,
  type RotateDraft,
  type SizeDraft,
  type SheetDraft,
} from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { MAX_INSERT_COUNT, type PageEdit, type PageDims } from '../../engine/mupdf/protocol';
import { cropBoxFor, cropScopeUids, insertAnchor, pageUidFromId } from './pageMath';
import { parsePageRange } from './pageRange';
import { MupdfDocument } from '../../engine/mupdf/mupdfDocument';
import { BUSY_MESSAGE, cutTargetsFor, deletePages, discardLastEdit, lastEditOutcome, orderOf, resetEditOutcome, runEdits } from './actions';
import { useEditStore } from '../../core/stores/editStore';
import { cancelOperation, settleEdits } from '../documents/editOps';
import { CUT_MEASURING_MESSAGE, CUT_NO_MATCH_MESSAGE, CUT_PERCENT_MESSAGE, cutDoneText, cutShare, parseCutPercent } from './cutMath';
import { sizeInPoints } from './units';
import { applyCompare, leaveCompare } from '../compare/compareSession';

/**
 * Apply and Cancel of the organizer's side sheets. Each Apply turns the draft into page edits (one undo step) and closes
 * the sheet, or keeps it open and says why when the draft is not valid.
 */

export { MAX_INSERT_COUNT };

/** The two insert-limit messages (1.5.5 C7), built from the one constant the engine uses. */
const INSERT_LIMIT_TEXT = MAX_INSERT_COUNT.toLocaleString('en-US');
export const INSERT_COUNT_MESSAGE = `Enter a number of pages from 1 to ${INSERT_LIMIT_TEXT}.`;
export const INSERT_RANGE_MESSAGE = `You can insert up to ${INSERT_LIMIT_TEXT} pages at a time. Choose a shorter page range.`;

const MAX_CUSTOM_PT = 14400;

function fail(message: string): false {
  useUiStore.getState().pushToast(message);
  return false;
}

/** The version and instance generation of a document's page list, or undefined when it is not an open MuPDF document. */
function versionOf(docId: string): { version: number; generation: number } | undefined {
  const doc = documentRegistry.get(docId)?.doc;
  return doc instanceof MupdfDocument ? { version: doc.version, generation: doc.generation } : undefined;
}

/**
 * Whether the open sheet's Apply is running (its fields are read-only and Apply is off), and whether the sheet's own Cancel
 * (or x, or Esc) was pressed meanwhile, so the sheet closes once the running change has been rolled back (1.5.5 C5).
 */
interface ApplyState {
  /** The document the running Apply belongs to (null when none runs), so another document's sheet is not affected. */
  docId: string | null;
  applying: boolean;
  closeRequested: boolean;
  /** The last Apply ended because the status-bar Cancel stopped it: the sheet stays and focus goes to Apply. */
  focusApply: boolean;
}

export const useApplyStore = create<ApplyState>()(() => ({ docId: null, applying: false, closeRequested: false, focusApply: false }));

const IDLE = { docId: null, applying: false, closeRequested: false } as const;

/** Resolves when no save runs on the document (a save refuses every edit and undo, so the preview undo waits for it). */
function whenNotSaving(docId: string): Promise<void> {
  if (useEditStore.getState().saving[docId] !== true) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useEditStore.subscribe((state) => {
      if (state.saving[docId] !== true) {
        stop();
        resolve();
      }
    });
  });
}

/**
 * Closes the sheet, undoing an Auto-crop that the sheet applied and the user cancelled. The undo happens only while the
 * document is still at the version the preview produced: if anything else was done since, the top step is not the
 * crop, and undoing it would revert the wrong edit.
 *
 * While the sheet's Apply is running, Cancel stops the change instead and the sheet closes once the roll-back is confirmed
 * (see applySheet). If a change, undo, redo or save is running when an Auto-crop preview is cancelled, the sheet closes at
 * once and the undo of the preview waits for the running one to finish, then checks again (1.5.5 C6).
 */
export function cancelSheet(): void {
  const sheet = useSheetStore.getState().sheet;
  // The x, Esc and Cancel of the Overlay sheet leave the compare (the sheet's own [>>] only hides it).
  if (sheet?.kind === 'compare') {
    leaveCompare(sheet.docId);
    return;
  }
  if (sheet && useApplyStore.getState().applying && useApplyStore.getState().docId === sheet.docId) {
    if (!useApplyStore.getState().closeRequested) {
      useApplyStore.setState({ closeRequested: true });
      cancelOperation(sheet.docId);
    }
    return;
  }
  if (sheet?.kind === 'crop' && sheet.autoApplied && sheet.autoVersion !== undefined) {
    const { docId, autoVersion, autoGeneration } = sheet;
    void (async () => {
      try {
        await whenNotSaving(docId);
        await settleEdits(docId);
      } catch {
        // The wait only orders the undo after the running change; a failed change is reported where it ran.
      }
      const now = versionOf(docId);
      if (now?.version === autoVersion && now.generation === autoGeneration) await discardLastEdit(docId);
    })();
  }
  useSheetStore.getState().close();
}

/**
 * Applies the open sheet. Resolves with true when the sheet closed. While it runs the sheet is read-only. A change cancelled
 * from the status bar leaves the sheet open with its values; a Cancel of the sheet itself closes it once the change is rolled
 * back (or, if the change had already finished, after the normal success).
 */
export async function applySheet(sheet: SheetDraft): Promise<boolean> {
  if (sheet.kind === 'compare') return applyNow(sheet);
  // One Apply per document: a second press while one runs is refused with the usual plain message, never dropped silently.
  if (useApplyStore.getState().applying && useApplyStore.getState().docId === sheet.docId) return fail(BUSY_MESSAGE);
  useApplyStore.setState({ docId: sheet.docId, applying: true, closeRequested: false, focusApply: false });
  resetEditOutcome();
  let ok = false;
  try {
    ok = await applyNow(sheet);
  } finally {
    const { closeRequested } = useApplyStore.getState();
    useApplyStore.setState({ ...IDLE, focusApply: !ok && !closeRequested && lastEditOutcome() === 'cancelled' });
    if (closeRequested && !ok && useSheetStore.getState().sheet?.kind === sheet.kind) useSheetStore.getState().close();
  }
  return ok;
}

async function applyNow(sheet: SheetDraft): Promise<boolean> {
  switch (sheet.kind) {
    case 'insert':
      return applyInsert(sheet);
    case 'from':
      return applyFrom(sheet);
    case 'replace':
      return applyReplace(sheet);
    case 'rotate':
      return applyRotate(sheet);
    case 'crop':
      return applyCrop(sheet);
    case 'size':
      return applySize(sheet);
    case 'cut':
      return applyCut(sheet);
    case 'compare':
      // "Add overlay to pages": one edit, and then the compare (and its sheet) ends. A failure leaves the sheet as it is.
      return applyCompare(sheet.docId);
    case 'confirmDelete': {
      const ok = await deletePages(sheet.docId, sheet.uids);
      if (ok) useSheetStore.getState().close();
      return ok;
    }
  }
}

function finish(ok: boolean): boolean {
  if (ok) useSheetStore.getState().close();
  return ok;
}

async function applyInsert(sheet: InsertDraft): Promise<boolean> {
  const count = Math.round(sheet.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_INSERT_COUNT) return fail(INSERT_COUNT_MESSAGE);
  const size: PageDims = sizeInPoints(sheet.size, sheet.custom, sheet.unit);
  if (sheet.size === 'custom' && !(size.width >= 1 && size.height >= 1 && size.width <= MAX_CUSTOM_PT && size.height <= MAX_CUSTOM_PT)) {
    return fail('Enter a page size of up to 200 in (5,080 mm) on each side.');
  }
  const order = orderOf(sheet.docId);
  const afterUid = insertAnchor(order, sheet.pageIndex, sheet.position, sheet.at);
  const edit: PageEdit = { op: 'insertBlank', afterUid, size, template: sheet.template, count };
  return finish(await runEdits(sheet.docId, [edit]));
}

async function applyFrom(sheet: FromDraft): Promise<boolean> {
  if (sheet.sourceDocId === null) return fail('Choose a PDF first.');
  const range = parsePageRange(sheet.range, sheet.sourcePages);
  if (!range.ok) return fail(range.message);
  if (range.pages.length > MAX_INSERT_COUNT) return fail(INSERT_RANGE_MESSAGE);
  const order = orderOf(sheet.docId);
  const afterUid = insertAnchor(order, sheet.pageIndex, sheet.position, sheet.at);
  const edit: PageEdit = {
    op: 'insertFrom',
    afterUid,
    sourceDocId: sheet.sourceDocId,
    sourceUids: range.pages.map((page) => String(page - 1)),
  };
  return finish(await runEdits(sheet.docId, [edit]));
}

async function applyReplace(sheet: ReplaceDraft): Promise<boolean> {
  if (sheet.sourceDocId === null) return fail('Choose a PDF first.');
  if (!(sheet.sourcePage >= 1 && sheet.sourcePage <= sheet.sourcePages)) {
    return fail(`Enter a page from 1 to ${sheet.sourcePages}.`);
  }
  const edit: PageEdit = { op: 'replace', uid: sheet.uid, sourceDocId: sheet.sourceDocId, sourceUid: String(sheet.sourcePage - 1) };
  return finish(await runEdits(sheet.docId, [edit], 'Replaced the page'));
}

async function applyRotate(sheet: RotateDraft): Promise<boolean> {
  if (sheet.degrees === 0) return finish(true);
  const edit: PageEdit = { op: 'rotate', uids: sheet.uids, degrees: sheet.degrees };
  return finish(await runEdits(sheet.docId, [edit]));
}

/** The display size of the page the crop box is drawn on, in points. */
export function displaySizeOf(docId: string, pageId: string): { width: number; height: number } | null {
  const doc = useDocumentsStore.getState().docs[docId];
  const uid = pageUidFromId(docId, pageId);
  if (!doc || uid === null) return null;
  const index = orderOf(docId).indexOf(uid);
  const size = index >= 0 ? doc.sizes[index] : undefined;
  return size ? { width: size.width, height: size.height } : null;
}

async function applyCrop(sheet: CropDraft): Promise<boolean> {
  if (sheet.autoApplied) return finish(true);
  const page = displaySizeOf(sheet.docId, sheet.pageId);
  if (!page) return fail('The page is still being measured. Try again in a moment.');
  const result = cropBoxFor(sheet.margins, page.width, page.height);
  if (!result.ok) return fail(result.message);
  const uids = cropScopeUids(orderOf(sheet.docId), sheet.scope, pageUidFromId(sheet.docId, sheet.pageId) ?? '', sheet.uids);
  const edit: PageEdit = { op: 'crop', uids, box: result.box };
  return finish(await runEdits(sheet.docId, [edit], result.box === null ? 'Removed the crop' : undefined));
}

/** Auto-crop from the Crop sheet: applied now so the page shows the result, and undone by Cancel. */
export async function autoCropFromSheet(): Promise<void> {
  const sheet = useSheetStore.getState().sheet;
  if (!sheet || sheet.kind !== 'crop') return;
  const uids = cropScopeUids(orderOf(sheet.docId), sheet.scope, pageUidFromId(sheet.docId, sheet.pageId) ?? '', sheet.uids);
  // The sheet's Cancel while Auto-crop runs stops it too (see cancelSheet), like any other Apply.
  if (useApplyStore.getState().applying && useApplyStore.getState().docId === sheet.docId) {
    fail(BUSY_MESSAGE);
    return;
  }
  useApplyStore.setState({ docId: sheet.docId, applying: true, closeRequested: false, focusApply: false });
  resetEditOutcome();
  let ok = false;
  try {
    ok = await runEdits(sheet.docId, [{ op: 'crop', uids, box: 'auto' }], 'Auto-cropped the pages');
    if (ok) useSheetStore.getState().update({ autoApplied: true, autoVersion: versionOf(sheet.docId)?.version, autoGeneration: versionOf(sheet.docId)?.generation });
  } finally {
    const { closeRequested } = useApplyStore.getState();
    useApplyStore.setState({ ...IDLE, focusApply: !ok && !closeRequested && lastEditOutcome() === 'cancelled' });
    // Cancel was pressed meanwhile: the sheet closes now (and takes the finished preview back).
    const open = useSheetStore.getState().sheet;
    if (closeRequested && open?.kind === 'crop' && open.docId === sheet.docId) cancelSheet();
  }
}

async function applySize(sheet: SizeDraft): Promise<boolean> {
  const size = sizeInPoints(sheet.size, sheet.custom, sheet.unit);
  if (!(size.width >= 1 && size.height >= 1 && size.width <= MAX_CUSTOM_PT && size.height <= MAX_CUSTOM_PT)) {
    return fail('Enter a page size of up to 200 in (5,080 mm) on each side.');
  }
  const uids = sheet.scope === 'all' ? orderOf(sheet.docId) : sheet.uids;
  const edit: PageEdit = { op: 'resize', uids, size, fit: sheet.fit };
  return finish(await runEdits(sheet.docId, [edit]));
}

/**
 * Cut Pages in Half. The pages are the ones "Apply to" names right now, read from the live page list, selection and current
 * page (not from when the sheet opened), so what Apply cuts is what the sheet and the guide on the pages showed. One undo step.
 */
async function applyCut(sheet: CutDraft): Promise<boolean> {
  const percent = parseCutPercent(sheet.percentText);
  if (percent === null) return fail(CUT_PERCENT_MESSAGE);
  const targets = cutTargetsFor(sheet.docId, sheet.scope, sheet.direction);
  if (targets.unmeasured) return fail(CUT_MEASURING_MESSAGE);
  if (targets.uids.length === 0) return fail(CUT_NO_MATCH_MESSAGE);
  const edit: PageEdit = {
    op: 'slice',
    uids: targets.uids,
    cut: sheet.direction,
    at: cutShare(percent),
    // A top and bottom cut is always top first, so the page order is not sent for it.
    first: sheet.direction === 'horizontal' ? 'left' : sheet.first,
  };
  return finish(await runEdits(sheet.docId, [edit], cutDoneText(targets.uids.length)));
}
