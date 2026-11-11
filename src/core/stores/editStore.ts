import { create } from 'zustand';
import type { HistoryState } from '../../engine/mupdf/protocol';

/**
 * The page list of each open document, as the worker last reported it. The worker owns the truth: a `pages` event
 * (open, edit, undo, redo) becomes one setPages, and every pane and thumbnail reads from here. Pages are named by uid,
 * which stays with a page across moves. A rev changes only when the page's content changes.
 */
export interface DocPages {
  version: number;
  uids: string[];
  revs: number[];
  /** Width, height and the page's own rotation per page, three numbers each. Null until the sizes are known. */
  sizes: Float32Array | null;
  /** Undo and redo state. `history.dirty` is true while the document has edits that are not saved. */
  history: HistoryState;
}

/**
 * Why crash recovery is not protecting a document:
 *  - 'protected-source': recovery is off because an edit uses a password-protected PDF (its copy cannot be kept);
 *  - 'write-failed': the recovery copy could not be written (disk full, folder locked or read-only, copy refused).
 */
export type RecoveryNotice = { kind: 'protected-source' } | { kind: 'write-failed' };

/** Why an earlier session's unsaved edits were not restored: the file changed, or the restore failed (or the log was old). */
export type NotRestoredReason = 'file-changed' | 'failed';

/** A long operation in progress (over 100 pages, or 2 s): its label, and the pages done of the total. */
export interface OperationProgress {
  label: string;
  done: number;
  total: number;
}

interface EditState {
  byDoc: Record<string, DocPages>;
  /** The long operation running on each document, if any. Cancel it with cancelOperation (editOps.ts). */
  progress: Record<string, OperationProgress>;
  /**
   * Documents whose unsaved edits were restored from the recovery log when the file was opened. The UI offers Keep (the
   * restored edits stay) or Discard (the file is reloaded from disk). Cleared by either.
   */
  recovered: Record<string, { edits: number; loggingStopped?: boolean }>;
  /**
   * A bar that stays under the tabs while crash recovery is off or has stopped for the document (see RecoveryNotice). It
   * cannot be dismissed; a successful save clears it and turns recovery back on.
   */
  recoveryNotice: Record<string, RecoveryNotice>;
  /**
   * A bar that says unsaved edits of an earlier session were not restored, and why. It stays until the user presses OK or
   * the document closes: a save does not remove it. Dismissing it deletes nothing: the old recovery copy is kept until the
   * document is saved or the user chooses Discard.
   */
  notRestored: Record<string, NotRestoredReason>;
  /**
   * True while a document's engine has not answered for a long time (see WorkerClient's silence timer). The bar offers
   * Wait and Reopen. Nothing is ended without the user's choice.
   */
  unresponsive: Record<string, boolean>;
  /** False when the document cannot be edited (for example an XFA form). Commands are then disabled. */
  canEdit: Record<string, boolean>;
  /** The uids the organizer has selected, per document. */
  selected: Record<string, string[]>;
  /**
   * True while a document's file has changed on disk since it was opened or saved (see features/documents/diskWatch.ts).
   * Incremental save is off while it is set, and the UI offers Reload or Keep my version.
   */
  changedOnDisk: Record<string, boolean>;
  /**
   * True while a document's file is gone from its place (moved, renamed or deleted by another program) and the user has not
   * dealt with it: the bar offers Save, Save As… and Dismiss (1.5.5 D4). Cleared when the file is seen again, when a save
   * succeeds, on Dismiss, and when the tab closes.
   */
  missingOnDisk: Record<string, boolean>;
  /**
   * True while a document is being saved, from the worker's save until the saved file is reopened. Edits, undo and
   * redo are disabled then ("Saving…"): an edit made in that window would be lost when the saved bytes replace the
   * document. Unlike the other entries it survives `clear`, because the reopen itself clears the document's page list.
   */
  saving: Record<string, boolean>;
  /**
   * Replaces a document's page list. Selected uids that no longer exist are dropped. A list from an older version
   * than the one held is ignored, so a late event cannot roll the pages back.
   */
  setPages: (docId: string, pages: DocPages) => void;
  select: (docId: string, uids: string[]) => void;
  setChangedOnDisk: (docId: string, changed: boolean) => void;
  setMissingOnDisk: (docId: string, missing: boolean) => void;
  setSaving: (docId: string, saving: boolean) => void;
  setProgress: (docId: string, progress: OperationProgress | null) => void;
  setRecovered: (docId: string, recovered: { edits: number; loggingStopped?: boolean } | null) => void;
  setRecoveryNotice: (docId: string, notice: RecoveryNotice | null) => void;
  setNotRestored: (docId: string, reason: NotRestoredReason | null) => void;
  setUnresponsive: (docId: string, unresponsive: boolean) => void;
  setCanEdit: (docId: string, canEdit: boolean) => void;
  clear: (docId: string) => void;
  /** Moves every entry of a document to a new docId (Save As). */
  rekey: (oldId: string, newId: string) => void;
}

/** Moves one key of a record to another key. A record without the old key is returned unchanged. */
export function rekeyRecord<T>(record: Record<string, T>, oldId: string, newId: string): Record<string, T> {
  if (oldId === newId || !(oldId in record)) return record;
  const { [oldId]: value, ...rest } = record;
  return { ...rest, [newId]: value as T };
}

/** The uids in `previous` that are not in `next`. */
export function removedUids(previous: readonly string[], next: readonly string[]): string[] {
  const kept = new Set(next);
  return previous.filter((uid) => !kept.has(uid));
}

export const useEditStore = create<EditState>()((set, get) => ({
  byDoc: {},
  progress: {},
  recovered: {},
  recoveryNotice: {},
  notRestored: {},
  unresponsive: {},
  canEdit: {},
  selected: {},
  changedOnDisk: {},
  missingOnDisk: {},
  saving: {},
  setPages: (docId, pages) => {
    const current = get().byDoc[docId];
    if (current && pages.version < current.version) return;
    const gone = new Set(current ? removedUids(current.uids, pages.uids) : []);
    const selectedNow = get().selected[docId];
    set((state) => ({
      byDoc: { ...state.byDoc, [docId]: pages },
      selected: selectedNow
        ? { ...state.selected, [docId]: selectedNow.filter((uid) => !gone.has(uid)) }
        : state.selected,
    }));
  },
  select: (docId, uids) => set((state) => ({ selected: { ...state.selected, [docId]: [...new Set(uids)] } })),
  setChangedOnDisk: (docId, changed) => set((state) => ({ changedOnDisk: { ...state.changedOnDisk, [docId]: changed } })),
  setMissingOnDisk: (docId, missing) =>
    set((state) => {
      if ((state.missingOnDisk[docId] === true) === missing) return {};
      const { [docId]: _gone, ...rest } = state.missingOnDisk;
      return { missingOnDisk: missing ? { ...state.missingOnDisk, [docId]: true } : rest };
    }),
  setSaving: (docId, saving) =>
    set((state) => {
      const { [docId]: _gone, ...rest } = state.saving;
      return { saving: saving ? { ...state.saving, [docId]: true } : rest };
    }),
  setProgress: (docId, progress) =>
    set((state) => {
      const { [docId]: _gone, ...rest } = state.progress;
      return { progress: progress ? { ...state.progress, [docId]: progress } : rest };
    }),
  setRecovered: (docId, recovered) =>
    set((state) => {
      const { [docId]: _gone, ...rest } = state.recovered;
      return { recovered: recovered ? { ...state.recovered, [docId]: recovered } : rest };
    }),
  setRecoveryNotice: (docId, notice) =>
    set((state) => {
      const { [docId]: _gone, ...rest } = state.recoveryNotice;
      return { recoveryNotice: notice ? { ...state.recoveryNotice, [docId]: notice } : rest };
    }),
  setNotRestored: (docId, reason) =>
    set((state) => {
      const { [docId]: _gone, ...rest } = state.notRestored;
      return { notRestored: reason ? { ...state.notRestored, [docId]: reason } : rest };
    }),
  setUnresponsive: (docId, unresponsive) =>
    set((state) => {
      const { [docId]: _gone, ...rest } = state.unresponsive;
      return { unresponsive: unresponsive ? { ...state.unresponsive, [docId]: true } : rest };
    }),
  setCanEdit: (docId, canEdit) => set((state) => ({ canEdit: { ...state.canEdit, [docId]: canEdit } })),
  clear: (docId) =>
    set((state) => {
      const { [docId]: _pages, ...byDoc } = state.byDoc;
      const { [docId]: _selected, ...selected } = state.selected;
      const { [docId]: _changed, ...changedOnDisk } = state.changedOnDisk;
      const { [docId]: _missing, ...missingOnDisk } = state.missingOnDisk;
      const { [docId]: _progress, ...progress } = state.progress;
      const { [docId]: _recovered, ...recovered } = state.recovered;
      const { [docId]: _notice, ...recoveryNotice } = state.recoveryNotice;
      const { [docId]: _notRestored, ...notRestored } = state.notRestored;
      const { [docId]: _unresponsive, ...unresponsive } = state.unresponsive;
      const { [docId]: _canEdit, ...canEdit } = state.canEdit;
      return { byDoc, selected, changedOnDisk, missingOnDisk, progress, recovered, recoveryNotice, notRestored, unresponsive, canEdit };
    }),
  rekey: (oldId, newId) =>
    set((state) => ({
      byDoc: rekeyRecord(state.byDoc, oldId, newId),
      selected: rekeyRecord(state.selected, oldId, newId),
      changedOnDisk: rekeyRecord(state.changedOnDisk, oldId, newId),
      missingOnDisk: rekeyRecord(state.missingOnDisk, oldId, newId),
      progress: rekeyRecord(state.progress, oldId, newId),
      recovered: rekeyRecord(state.recovered, oldId, newId),
      recoveryNotice: rekeyRecord(state.recoveryNotice, oldId, newId),
      notRestored: rekeyRecord(state.notRestored, oldId, newId),
      unresponsive: rekeyRecord(state.unresponsive, oldId, newId),
      canEdit: rekeyRecord(state.canEdit, oldId, newId),
      saving: rekeyRecord(state.saving, oldId, newId),
    })),
}));
