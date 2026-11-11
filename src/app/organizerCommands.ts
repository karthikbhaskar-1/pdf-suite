import { commands } from '../core/commands/registry';
import { useDocumentsStore } from '../core/stores/documentsStore';
import { useUiStore } from '../core/stores/uiStore';
import { useEditStore } from '../core/stores/editStore';
import { MupdfDocument } from '../engine/mupdf/mupdfDocument';
import { documentRegistry } from './services';
import { VIEW_ONLY_REASON } from '../core/fileLimits';
import { isViewOnly } from '../features/documents/viewOnly';
import { saveWithFeedback } from '../features/documents/closeFlow';
import {
  BUSY_MESSAGE,
  activeDocId,
  activePane,
  autoCropTargets,
  LAST_PAGE_MESSAGE,
  deletesEveryPage,
  duplicateTargets,
  extractTargets,
  movePages,
  moveTargets,
  openCropSheet,
  openCutSheet,
  openFromSheet,
  openInsertSheet,
  openReplaceSheet,
  openRotateSheet,
  openSizeSheet,
  orderOf,
  requestDelete,
  redoEdit,
  reverseTargets,
  rotateTargets,
  targetUids,
  undoEdit,
} from '../features/organizer/actions';
import { keyboardMove, type KeyboardMoveAction } from '../features/organizer/pageMath';
import { sessionOf } from '../core/stores/compareStore';
import { leaveCompare, startCompare, toggleShow } from '../features/compare/compareSession';

/** The message a read-only form shows in every disabled organizer control. */
export const EDIT_LOCKED_MESSAGE = 'This form can be viewed but not edited yet.';

/** A document the organizer can change: a MuPDF document that is not a read-only (XFA) form. */
function docEditable(docId: string): boolean {
  const doc = documentRegistry.get(docId)?.doc;
  return doc instanceof MupdfDocument && doc.capabilities.canEdit && !doc.capabilities.htmlLayer;
}

/** A read-only form: an XFA document, however it was opened. */
function isLockedForm(docId: string): boolean {
  const doc = documentRegistry.get(docId)?.doc;
  return doc !== undefined && (doc.capabilities.canEdit === false || doc.capabilities.htmlLayer === true);
}

/** The reason edits are off while the focused document is being saved. */
export const SAVING_REASON = 'Wait for the save to finish.';

/** True while the focused document is being saved: edits, undo and redo are refused until the saved file is reopened. */
function savingActive(): boolean {
  const docId = activeDocId();
  return docId !== undefined && useEditStore.getState().saving[docId] === true;
}

/** The focused document can be changed: it is editable, it is not busy with a long edit or a save, and it is open. */
function canEditActive(): boolean {
  const docId = activeDocId();
  if (!docId) return false;
  return (
    docEditable(docId) &&
    useEditStore.getState().progress[docId] === undefined &&
    useEditStore.getState().saving[docId] !== true &&
    useDocumentsStore.getState().docs[docId] !== undefined
  );
}

/** A page command can run: the document can be edited and has pages. */
function pageEditable(): boolean {
  const docId = activeDocId();
  return canEditActive() && docId !== undefined && orderOf(docId).length > 0;
}

/** True while an edit of the focused document is running (its progress is set from the first moment of the edit). */
function editRunning(): boolean {
  const docId = activeDocId();
  return docId !== undefined && useEditStore.getState().progress[docId] !== undefined;
}

/**
 * The reason an edit command is off: a read-only form, a save in progress, or another edit still running. Nothing
 * otherwise. It is the tooltip, and the toast a blocked shortcut shows (see blockedKey).
 */
function lockReason(): string | undefined {
  const docId = activeDocId();
  // A file over the edit limit is view-only: it comes before the form reason (a view-only document is not a form).
  if (docId && isViewOnly(docId)) return VIEW_ONLY_REASON;
  if (docId && isLockedForm(docId)) return EDIT_LOCKED_MESSAGE;
  if (savingActive()) return SAVING_REASON;
  return editRunning() ? BUSY_MESSAGE : undefined;
}

/**
 * Why Undo is off: the usual reasons (see lockReason), or that the changes so far went into a save that did not reach the
 * disk and can no longer be undone. It is the Undo command's tooltip in the menu, toolbar and palette, and the toast of Ctrl+Z.
 */
function undoReason(): string | undefined {
  const locked = lockReason();
  if (locked) return locked;
  const docId = activeDocId();
  return (docId && useEditStore.getState().byDoc[docId]?.history.undoBlockedReason) || undefined;
}

/**
 * A shortcut pressed while its command is off says why in a toast, so it is never dropped without a word (Ctrl+D pressed
 * again while the first duplicate runs). Nothing to say (no document, no pages) leaves the key alone.
 */
function blockedKey(reason: string | undefined = lockReason()): boolean {
  if (!reason) return false;
  useUiStore.getState().pushToast(reason);
  return true;
}

function hasTargets(): boolean {
  const docId = activeDocId();
  return pageEditable() && docId !== undefined && targetUids(docId).length > 0;
}

/** The focused document's targets are every page of it (a delete would leave none). */
function targetsAreEveryPage(): boolean {
  const docId = activeDocId();
  return docId !== undefined && deletesEveryPage(docId, targetUids(docId));
}

/** Reverse needs two pages. Pages can be picked or, with none picked, all of them are reversed. */
function hasTwoPages(): boolean {
  const docId = activeDocId();
  return pageEditable() && docId !== undefined && orderOf(docId).length >= 2;
}

function hasFocus(): boolean {
  return activePane() !== undefined;
}

function runMove(action: KeyboardMoveAction): void {
  const docId = activeDocId();
  if (!docId) return;
  const targets = moveTargets(docId);
  const move = keyboardMove(orderOf(docId), new Set(targets), action);
  if (move) void movePages(docId, targets, move.beforeUid);
}

/** Save and Save As are off on a view-only document (the file is over the edit limit and is never written). */
function canSaveActive(): boolean {
  return hasFocus() && !isViewOnly(activeDocId());
}

function saveReason(): string | undefined {
  return isViewOnly(activeDocId()) ? VIEW_ONLY_REASON : undefined;
}

/** Registers the commands of the page organizer and the document state: save, undo and redo, and the Pages group. */
export function registerOrganizerCommands(): void {
  commands.register({
    id: 'file.save',
    label: 'Save',
    enabled: canSaveActive,
    disabledReason: saveReason,
    onBlockedKey: () => blockedKey(saveReason()),
    run: () => {
      const docId = activeDocId();
      if (docId) void saveWithFeedback(docId);
    },
  });
  commands.register({
    id: 'file.saveAs',
    label: 'Save as',
    enabled: canSaveActive,
    disabledReason: saveReason,
    onBlockedKey: () => blockedKey(saveReason()),
    run: () => {
      const docId = activeDocId();
      if (docId) void saveWithFeedback(docId, { saveAs: true });
    },
  });

  commands.register({
    id: 'edit.undo',
    label: 'Undo',
    dynamicLabel: () => {
      const docId = activeDocId();
      const name = docId ? useEditStore.getState().byDoc[docId]?.history.undoLabel : null;
      return name ? `Undo ${name}` : 'Undo';
    },
    enabled: () => {
      const docId = activeDocId();
      return canEditActive() && docId !== undefined && useEditStore.getState().byDoc[docId]?.history.canUndo === true;
    },
    disabledReason: undoReason,
    onBlockedKey: () => blockedKey(undoReason()),
    run: () => {
      const docId = activeDocId();
      if (docId) void undoEdit(docId);
    },
  });
  commands.register({
    id: 'edit.redo',
    label: 'Redo',
    dynamicLabel: () => {
      const docId = activeDocId();
      const name = docId ? useEditStore.getState().byDoc[docId]?.history.redoLabel : null;
      return name ? `Redo ${name}` : 'Redo';
    },
    enabled: () => {
      const docId = activeDocId();
      return canEditActive() && docId !== undefined && useEditStore.getState().byDoc[docId]?.history.canRedo === true;
    },
    disabledReason: lockReason,
    onBlockedKey: blockedKey,
    run: () => {
      const docId = activeDocId();
      if (docId) void redoEdit(docId);
    },
  });

  const page = (
    id: string,
    label: string,
    run: () => unknown,
    enabled: () => boolean = pageEditable,
  ) => commands.register({ id, label, enabled, disabledReason: lockReason, onBlockedKey: blockedKey, run: () => void run() });

  page('pages.insert', 'Pages: Insert blank page…', () => openInsertSheet('blank'));
  page('pages.insertLined', 'Pages: Insert lined page…', () => openInsertSheet('lined'));
  page('pages.insertGrid', 'Pages: Insert grid page…', () => openInsertSheet('grid'));
  page('pages.insertFromPdf', 'Pages: Insert pages from a PDF…', () => openFromSheet());
  // Delete is disabled when the targets are every page: a document keeps at least one page, and the tooltip says so.
  commands.register({
    id: 'pages.delete',
    label: 'Pages: Delete',
    enabled: () => hasTargets() && !targetsAreEveryPage(),
    disabledReason: () => lockReason() ?? (hasTargets() && targetsAreEveryPage() ? LAST_PAGE_MESSAGE : undefined),
    // The Delete key on every page: the command is disabled, so the key says why instead of doing nothing.
    onBlockedKey: () => {
      if (hasTargets() && targetsAreEveryPage()) {
        useUiStore.getState().pushToast(LAST_PAGE_MESSAGE);
        return true;
      }
      return blockedKey();
    },
    run: () => {
      const docId = activeDocId();
      if (docId) requestDelete(docId);
    },
  });
  page('pages.duplicate', 'Pages: Duplicate', () => duplicateTargets(), hasTargets);
  page('pages.rotateRight', 'Pages: Rotate right 90°', () => rotateTargets(90), hasTargets);
  page('pages.rotateLeft', 'Pages: Rotate left 90°', () => rotateTargets(-90), hasTargets);
  page('pages.rotate180', 'Pages: Rotate 180°', () => rotateTargets(180), hasTargets);
  page('pages.rotateCustom', 'Pages: Rotate by a custom angle…', () => openRotateSheet(), hasTargets);
  page('pages.crop', 'Pages: Crop…', () => openCropSheet(), hasTargets);
  page(
    'pages.autoCrop',
    'Pages: Auto-crop white space',
    () => {
      const docId = activeDocId();
      if (docId) return autoCropTargets(docId, targetUids(docId));
      return undefined;
    },
    hasTargets,
  );
  page('pages.size', 'Pages: Set page size…', () => openSizeSheet());
  page('pages.replace', 'Pages: Replace page from a PDF…', () => openReplaceSheet(), pageEditable);
  // Cut Pages in Half (Slice, 1.3.1). No default shortcut, on purpose (V2 brings customizable shortcuts). The palette text is the spec's.
  page('pages.cutHalf', 'Pages: Cut pages in half', () => openCutSheet());
  // Overlay to Compare (1.3.4). Starting it needs an editable document (the result is an edit), like Cut. No default shortcut,
  // on purpose; F8 only shows or hides the overlay while comparing. The palette texts are the spec's.
  page('pages.overlay', 'Pages: Overlay to compare', () => {
    const docId = activeDocId();
    if (docId) startCompare(docId);
  });
  const comparing = (): boolean => sessionOf(activeDocId()) !== null;
  commands.register({
    id: 'pages.overlayLeave',
    label: 'Pages: Leave overlay compare',
    enabled: comparing,
    run: () => {
      const docId = activeDocId();
      if (docId) leaveCompare(docId);
    },
  });
  // F8 anywhere while comparing. Outside a compare the key is left alone (no onBlockedKey).
  commands.register({
    id: 'compare.toggle',
    label: 'Pages: Show or hide the overlay',
    enabled: comparing,
    run: () => {
      const docId = activeDocId();
      if (docId) toggleShow(docId);
    },
  });
  // Reverse: the selected pages, or all pages when none is selected (the toast says so). It needs two pages.
  commands.register({
    id: 'pages.reverse',
    label: 'Pages: Reverse order',
    enabled: hasTwoPages,
    disabledReason: () => lockReason() ?? (pageEditable() && !hasTwoPages() ? 'A PDF needs at least two pages to reverse.' : undefined),
    onBlockedKey: blockedKey,
    run: () => void reverseTargets(),
  });
  commands.register({
    id: 'pages.extract',
    label: 'Pages: Extract to a new PDF…',
    enabled: hasTargets,
    disabledReason: lockReason,
    onBlockedKey: blockedKey,
    run: () => {
      const docId = activeDocId();
      if (docId) void extractTargets(docId);
    },
  });
  page('pages.moveUp', 'Pages: Move up', () => runMove('up'), hasTargets);
  page('pages.moveDown', 'Pages: Move down', () => runMove('down'), hasTargets);
  page('pages.moveStart', 'Pages: Move to the start', () => runMove('start'), hasTargets);
  page('pages.moveEnd', 'Pages: Move to the end', () => runMove('end'), hasTargets);
}
