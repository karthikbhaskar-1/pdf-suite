/**
 * The rule for a document that is not shown (1.5.4, from the L7 tab-memory measurement: every open tab keeps its own worker,
 * about 35 to 43 MB a tab, and the Tab + GPU limit is crossed at about 10 tabs).
 *
 * A document that is not shown in any pane (the active tab's one or two panes) for longer than BACKGROUND_IDLE_MS, and that
 * has no running operation, gives back what it can:
 *  - 'bitmaps': its rendered page bitmaps and thumbnails are released (they are made again when it is shown);
 *  - 'worker':  the same, and its engine (the MuPDF worker) is ended too. Only a document that can be reopened as it is:
 *    no unsaved edits (a worker with edits holds the edit journal and the undo history: it is never ended), a file on disk
 *    to reopen from, and nothing else that lives in the engine (see ResidencyFacts.reopenable).
 * 'keep' means leave it alone: it is shown, was shown a moment ago, or is working.
 */

/** How long a document must be out of every pane before it is released. */
export const BACKGROUND_IDLE_MS = 60_000;

export type Residency = 'keep' | 'bitmaps' | 'worker';

export interface ResidencyFacts {
  /** Shown in a pane of the active tab now (either pane of a split). */
  visible: boolean;
  /** Milliseconds since the document was last shown in a pane. */
  idleMs: number;
  /** An edit, undo, redo, save, restore, search, job, long operation, Compare or open side sheet is working on it. */
  runningOperation: boolean;
  /** Unsaved edits, or undo or redo steps, or an edit journal: the engine holds state the file does not. */
  unsavedEdits: boolean;
  /**
   * The document can be opened again exactly as it is from its file: it has a path, its page sizes are all known, an
   * encrypted file's password is still in memory, and no bar (changed on disk, recovered edits, recovery off, stopped
   * responding) describes its engine.
   */
  reopenable: boolean;
}

export function residencyFor(facts: ResidencyFacts, idleMs: number = BACKGROUND_IDLE_MS): Residency {
  if (facts.visible) return 'keep';
  if (facts.idleMs <= idleMs) return 'keep';
  if (facts.runningOperation) return 'keep';
  if (facts.unsavedEdits || !facts.reopenable) return 'bitmaps';
  return 'worker';
}
