/**
 * Page edits for one open MuPDF document, run inside the worker. The worker owns the truth: this class holds the
 * page uids and revs in page order, and the document's journal. One apply is one journal operation. Its undo and
 * redo steps are mirrored here, so the uids and revs come back with the PDF content.
 *
 * Revs come from one counter that never goes back, even on undo. So a uid@rev names one content for the life of the
 * worker: a bitmap cached under an old rev can never be shown for a different content.
 */
import type * as Mu from 'mupdf';
import { MAX_INSERT_COUNT, WorkerFault, type HistoryState, type PageEdit, type PageUid, rotationKind } from './protocol';
import {
  applyOrder,
  autoCropDisplay,
  displayBounds,
  duplicatePageAt,
  fineRotatePage,
  graftPageAt,
  insertBlankPage,
  keepPages,
  moveOrder,
  replacePageFrom,
  resizePage,
  reverseOrder,
  rotatePage,
  setCropBox,
  slicePageAt,
} from './pageOps';
import { insertedNoun } from './insertLabel';
import { overlayPageAt, type OverlayContext } from './overlayOps';
import { PageCarrier } from './annotCarry';

/** The MuPDF functions the edits use that are not methods of a document. Passed in, so this file loads no WASM. */
export type EditMu = Pick<typeof Mu, 'Matrix' | 'Rect' | 'Pixmap' | 'ColorSpace' | 'DrawDevice'>;

/**
 * Called before each page of a long edit, with the pages done so far and the total. It may yield, and it may throw
 * (the worker throws Cancelled here). A throw rolls the whole apply back: the journal operation is abandoned.
 */
export type Tick = (done: number, total: number) => Promise<void>;

/** What an edit needs beyond the document: the MuPDF functions, and the source documents open in the worker. */
export interface EditEnv {
  mu?: EditMu;
  sources?: ReadonlyMap<string, Mu.PDFDocument>;
}

/** The page list: uids and revs, in page order. */
export interface PageState {
  uids: PageUid[];
  revs: number[];
}

interface Step {
  label: string;
  before: PageState;
  after: PageState;
  /** True when the step deleted or replaced pages. A save after such a step is always full. */
  removesPages: boolean;
  /** The uid counter the step started from, so a discard can free the uids it used. */
  seed: number;
}

/** What one apply did. `uidSeed` is the uid counter the step started from, which a replay passes back to apply. */
export interface ApplyResult {
  changed: boolean;
  uidSeed: number;
}

export { MAX_INSERT_COUNT };

/** Why Undo is off for changes that went into a save that did not reach the disk. Plain English, shown to the user. */
export const EARLIER_CHANGES_REASON = 'Changes made before the save that failed are kept, but can no longer be undone.';

export class EditCore {
  private state: PageState;
  private readonly steps: Step[] = [];
  private position = 0;
  /**
   * Steps up to this position went through a save of this document. MuPDF cannot undo what a save has serialized (the
   * journal still lists the step, but the undo changes nothing), so they are not offered for undo again. A save that
   * reaches the disk replaces the document altogether; this matters when the bytes did not reach the disk.
   */
  private undoFloor = 0;
  private uidSeq = 0;
  private revSeq = 0;
  private readonly mu: EditMu | undefined;
  private readonly sources: ReadonlyMap<string, Mu.PDFDocument>;

  constructor(
    private readonly pdf: Mu.PDFDocument,
    pageCount: number,
    private readonly canEdit: boolean,
    env: EditEnv = {},
  ) {
    this.mu = env.mu;
    this.sources = env.sources ?? new Map<string, Mu.PDFDocument>();
    pdf.enableJournal();
    this.state = {
      uids: Array.from({ length: pageCount }, (_unused, i) => String(i)),
      revs: new Array<number>(pageCount).fill(0),
    };
  }

  get editable(): boolean {
    return this.canEdit;
  }

  /** A copy of the page list. */
  pages(): PageState {
    return { uids: [...this.state.uids], revs: [...this.state.revs] };
  }

  get pageCount(): number {
    return this.state.uids.length;
  }

  get history(): HistoryState {
    const undo = this.position > this.undoFloor ? this.steps[this.position - 1] : undefined;
    const redo = this.position < this.steps.length ? this.steps[this.position] : undefined;
    return {
      dirty: this.position > 0,
      undoBlockedReason: undo === undefined && this.position > 0 && this.position <= this.undoFloor ? EARLIER_CHANGES_REASON : null,
      canUndo: undo !== undefined,
      canRedo: redo !== undefined,
      undoLabel: undo?.label ?? null,
      redoLabel: redo?.label ?? null,
    };
  }

  /**
   * Called when a save has produced bytes from this document. The steps made so far can no longer be undone or redone in
   * MuPDF (see undoFloor), so they stay in the document and keep it unsaved, but only later steps can be taken back.
   */
  markSaved(): void {
    this.undoFloor = this.position;
    this.steps.length = this.position;
  }

  /** The position of the page with this uid, when its rev is still `rev`. -1 when the uid is gone or has changed. */
  locate(uid: PageUid, rev: number): number {
    const at = this.state.uids.indexOf(uid);
    return at >= 0 && this.state.revs[at] === rev ? at : -1;
  }

  /** True when an edit that removes pages is in the history up to the current position. */
  get removesPages(): boolean {
    return this.steps.slice(0, this.position).some((step) => step.removesPages);
  }

  /**
   * Applies the edits in order as one journal operation. Each edit names pages by uid, so an unknown uid
   * (a page deleted since the caller looked) is a Conflict. Nothing is kept if any edit fails.
   */
  async apply(edits: readonly PageEdit[], tick?: Tick, uidSeed?: number): Promise<ApplyResult> {
    this.requireEditable();
    // A replay names the uid counter the step started from, so it allocates the same uids the live session did. The
    // counter only moves up, so a live worker is never made to reuse a uid.
    if (uidSeed !== undefined && Number.isInteger(uidSeed) && uidSeed > this.uidSeq) this.uidSeq = uidSeed;
    const seed = this.uidSeq;
    if (edits.length === 0) return { changed: false, uidSeed: seed };
    const before = this.pages();
    const journalBefore = this.pdf.getJournal().position;
    const working = this.pages();
    const label = labelFor(edits);
    // An overlay grafts a page to bring its content over and deletes it again, as a replace does, so a save after it is full.
    const removesPages = edits.some((edit) => edit.op === 'delete' || edit.op === 'replace' || edit.op === 'overlay');
    this.pdf.beginOperation(label);
    try {
      for (const edit of edits) await this.run(edit, working, tick);
      this.pdf.endOperation();
    } catch (error) {
      this.pdf.abandonOperation();
      this.uidSeq = seed;
      throw error;
    }
    // MuPDF drops an operation that changed nothing (an auto-crop of a blank page). Then there is no journal step, so
    // there must be no undo step here either: the two lists would drift apart and an undo would revert the wrong edit.
    if (this.pdf.getJournal().position === journalBefore) {
      this.uidSeq = seed;
      return { changed: false, uidSeed: seed };
    }
    // A new edit made after an undo drops the steps that could have been redone.
    this.steps.length = this.position;
    this.steps.push({ label, before, after: { uids: [...working.uids], revs: [...working.revs] }, removesPages, seed });
    this.position += 1;
    this.state = working;
    return { changed: true, uidSeed: seed };
  }

  /**
   * Takes back the step just applied, as if it had never been made: it is undone and dropped, so it cannot be redone.
   * The worker calls it when a Cancel arrived for an apply that had already finished. `uidSeed` is the counter the step
   * started from, so the uids it used are free again.
   */
  discardLastStep(uidSeed: number): void {
    if (this.position === 0 || !this.pdf.canUndo()) throw new WorkerFault('Internal', 'No step to discard');
    this.pdf.undo();
    this.position -= 1;
    const step = this.steps[this.position]!;
    this.state = { uids: [...step.before.uids], revs: [...step.before.revs] };
    this.steps.length = this.position;
    this.uidSeq = uidSeed;
  }

  /**
   * Takes back the latest step completely, so it can be neither redone nor seen in the history: for a preview that the
   * user cancelled. Only the latest step of the document can be discarded (nothing may sit above it to redo).
   */
  discardTop(): void {
    this.requireEditable();
    if (this.position === 0 || this.position <= this.undoFloor || this.position !== this.steps.length) {
      throw new WorkerFault('Unsupported', 'Nothing to undo');
    }
    this.discardLastStep(this.steps[this.position - 1]!.seed);
  }

  undo(): void {
    this.requireEditable();
    if (this.position === 0 || !this.pdf.canUndo()) throw new WorkerFault('Unsupported', 'Nothing to undo');
    if (this.position <= this.undoFloor) throw new WorkerFault('Unsupported', EARLIER_CHANGES_REASON);
    this.pdf.undo();
    this.position -= 1;
    const step = this.steps[this.position]!;
    this.state = { uids: [...step.before.uids], revs: [...step.before.revs] };
  }

  redo(): void {
    this.requireEditable();
    if (this.position >= this.steps.length || !this.pdf.canRedo()) throw new WorkerFault('Unsupported', 'Nothing to redo');
    this.pdf.redo();
    const step = this.steps[this.position]!;
    this.position += 1;
    this.state = { uids: [...step.after.uids], revs: [...step.after.revs] };
  }

  private requireEditable(): void {
    if (!this.canEdit) throw new WorkerFault('Unsupported', 'This document cannot be edited.');
  }

  private nextUid(): PageUid {
    this.uidSeq += 1;
    return `n${this.uidSeq}`;
  }

  private nextRev(): number {
    this.revSeq += 1;
    return this.revSeq;
  }

  private indexOf(working: PageState, uid: PageUid): number {
    const at = working.uids.indexOf(uid);
    if (at < 0) throw new WorkerFault('Conflict', `Page ${uid} is no longer in the document`);
    return at;
  }

  private positionsOf(working: PageState, uids: readonly PageUid[]): number[] {
    return [...new Set(uids.map((uid) => this.indexOf(working, uid)))].sort((a, b) => a - b);
  }

  private sourceOf(id: string): Mu.PDFDocument {
    const source = this.sources.get(id);
    if (!source) throw new WorkerFault('Conflict', 'The source document is no longer open');
    return source;
  }

  /** The page index in a source document named by its uid (the index it had when the source was attached). */
  private sourceIndex(source: Mu.PDFDocument, uid: PageUid): number {
    const index = Number(uid);
    if (!Number.isInteger(index) || index < 0 || index >= source.countPages()) {
      throw new WorkerFault('Unsupported', 'The pages changed while this ran. Try again.');
    }
    return index;
  }

  private requireMu(): EditMu {
    if (!this.mu) throw new WorkerFault('Internal', 'This edit needs the MuPDF functions, which are not available');
    return this.mu;
  }

  private async run(edit: PageEdit, working: PageState, tick?: Tick): Promise<void> {
    switch (edit.op) {
      case 'insertBlank': {
        const count = edit.count ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > MAX_INSERT_COUNT) {
          throw new WorkerFault('Unsupported', `Enter a number of pages from 1 to ${MAX_INSERT_COUNT.toLocaleString('en-US')}.`);
        }
        const start = edit.afterUid === null ? 0 : this.indexOf(working, edit.afterUid) + 1;
        for (let k = 0; k < count; k++) {
          await tick?.(k, count);
          insertBlankPage(this.pdf, start + k, edit.size, edit.template);
          working.uids.splice(start + k, 0, this.nextUid());
          working.revs.splice(start + k, 0, this.nextRev());
        }
        return;
      }
      case 'delete': {
        if (edit.uids.length === 0) return;
        const gone = new Set(this.positionsOf(working, edit.uids));
        const keep: number[] = [];
        for (let i = 0; i < working.uids.length; i++) if (!gone.has(i)) keep.push(i);
        keepPages(this.pdf, keep);
        working.uids = keep.map((i) => working.uids[i]!);
        working.revs = keep.map((i) => working.revs[i]!);
        return;
      }
      case 'move': {
        if (edit.uids.length === 0) return;
        const moving = this.positionsOf(working, edit.uids);
        const before = edit.beforeUid === null ? null : this.indexOf(working, edit.beforeUid);
        this.reorder(working, moveOrder(working.uids.length, moving, before));
        return;
      }
      case 'reverse': {
        if (edit.uids.length === 0) return;
        this.reorder(working, reverseOrder(working.uids.length, this.positionsOf(working, edit.uids)));
        return;
      }
      case 'duplicate': {
        // From the last page back, so an insert never moves a page that is still to be copied.
        const positions = this.positionsOf(working, edit.uids).reverse();
        for (let k = 0; k < positions.length; k++) {
          const at = positions[k]!;
          await tick?.(k, positions.length);
          duplicatePageAt(this.pdf, at);
          working.uids.splice(at + 1, 0, this.nextUid());
          working.revs.splice(at + 1, 0, this.nextRev());
        }
        return;
      }
      case 'rotate': {
        if (edit.uids.length === 0) return;
        const targets = this.positionsOf(working, edit.uids);
        for (let k = 0; k < targets.length; k++) {
          const at = targets[k]!;
          await tick?.(k, targets.length);
          // A quarter turn sets /Rotate. Any other angle wraps the content (see pageOps.fineRotatePage).
          if (rotationKind(edit.degrees) === 'native') rotatePage(this.pdf, at, edit.degrees);
          else fineRotatePage(this.pdf, at, edit.degrees);
          working.revs[at] = this.nextRev();
        }
        return;
      }
      case 'crop': {
        if (edit.uids.length === 0) return;
        const mu = this.requireMu();
        const targets = this.positionsOf(working, edit.uids);
        for (let k = 0; k < targets.length; k++) {
          const at = targets[k]!;
          await tick?.(k, targets.length);
          if (edit.box === 'auto') {
            const found = autoCropDisplay(mu, this.pdf, at, edit.margin);
            // A blank page has nothing to keep, so it is left as it is.
            if (found === null) continue;
            setCropBox(mu, this.pdf, at, found);
          } else if (edit.box === null) {
            setCropBox(mu, this.pdf, at, null);
          } else {
            const b = displayBounds(this.pdf, at);
            setCropBox(mu, this.pdf, at, [b[0] + edit.box.x, b[1] + edit.box.y, b[0] + edit.box.x + edit.box.width, b[1] + edit.box.y + edit.box.height]);
          }
          working.revs[at] = this.nextRev();
        }
        return;
      }
      case 'resize': {
        if (edit.uids.length === 0) return;
        const targets = this.positionsOf(working, edit.uids);
        for (let k = 0; k < targets.length; k++) {
          const at = targets[k]!;
          await tick?.(k, targets.length);
          resizePage(this.pdf, at, edit.size, edit.fit);
          working.revs[at] = this.nextRev();
        }
        return;
      }
      case 'slice': {
        if (edit.uids.length === 0) return;
        const mu = this.requireMu();
        // From the last page back, so a new page never moves one that is still to be cut.
        const positions = this.positionsOf(working, edit.uids).reverse();
        for (let k = 0; k < positions.length; k++) {
          const at = positions[k]!;
          await tick?.(k, positions.length);
          slicePageAt(mu, this.pdf, at, edit.cut, edit.at, edit.first);
          // The page keeps its uid as the first half, with a new rev; the second half is a new page after it.
          working.revs[at] = this.nextRev();
          working.uids.splice(at + 1, 0, this.nextUid());
          working.revs.splice(at + 1, 0, this.nextRev());
        }
        return;
      }
      case 'overlay': {
        if (edit.uids.length === 0) return;
        if (edit.uids.length !== edit.sourceUids.length) {
          throw new WorkerFault('Unsupported', 'Each page needs its own overlay page.');
        }
        const source = this.sourceOf(edit.sourceDocId);
        // Each pair is named by uid, so a page deleted since the caller looked is a Conflict before anything changes.
        const pairs = edit.uids.map((uid, i) => ({ at: this.indexOf(working, uid), srcIndex: this.sourceIndex(source, edit.sourceUids[i]!) }));
        // One form per overlay page and one graft map for the whole edit (shared fonts and images are copied once), and neither
        // is kept across edits: an undo removes the objects they made.
        const context: OverlayContext = { forms: new Map(), map: this.pdf.newGraftMap() };
        try {
          for (let k = 0; k < pairs.length; k++) {
            const { at, srcIndex } = pairs[k]!;
            await tick?.(k, pairs.length);
            overlayPageAt(this.pdf, at, source, srcIndex, { dx: edit.dx, dy: edit.dy, scale: edit.scale, mode: edit.mode, opacity: edit.opacity }, context);
            working.revs[at] = this.nextRev();
          }
        } finally {
          context.map.destroy();
        }
        return;
      }
      case 'replace': {
        const at = this.indexOf(working, edit.uid);
        const source = this.sourceOf(edit.sourceDocId);
        replacePageFrom(this.pdf, at, source, this.sourceIndex(source, edit.sourceUid));
        working.revs[at] = this.nextRev();
        return;
      }
      case 'insertFrom': {
        if (edit.sourceUids.length === 0) return;
        if (edit.sourceUids.length > MAX_INSERT_COUNT) {
          throw new WorkerFault('Unsupported', `You can insert up to ${MAX_INSERT_COUNT.toLocaleString('en-US')} pages at a time. Choose a shorter page range.`);
        }
        const source = this.sourceOf(edit.sourceDocId);
        const start = edit.afterUid === null ? 0 : this.indexOf(working, edit.afterUid) + 1;
        // One graft map for this edit only, so a font or image the source pages share is copied once. Never kept across
        // edits: an undo removes objects that a kept map would still point at.
        const map = this.pdf.newGraftMap();
        // Comments, form fields and links come along (graftPage leaves them behind); a link to another page of this insert is renumbered.
        const carrier = new PageCarrier(this.pdf, source, map);
        const indices = edit.sourceUids.map((uid) => this.sourceIndex(source, uid));
        const landing = new Map<number, number>();
        indices.forEach((index, k) => {
          if (!landing.has(index)) landing.set(index, start + k);
        });
        try {
          for (let k = 0; k < edit.sourceUids.length; k++) {
            await tick?.(k, edit.sourceUids.length);
            graftPageAt(this.pdf, start + k, source, indices[k]!, map);
            carrier.carry(indices[k]!, start + k);
            working.uids.splice(start + k, 0, this.nextUid());
            working.revs.splice(start + k, 0, this.nextRev());
          }
          // Links last: an internal link names its target page by number, so every inserted page has to be there.
          indices.forEach((index, k) => carrier.carryLinks(index, start + k, (target) => landing.get(target) ?? null));
        } finally {
          map.destroy();
        }
        return;
      }
      default:
        throw new WorkerFault('Unsupported', 'This change is not supported for this file.');
    }
  }

  /** Puts the pages in `order` (old positions, full permutation) in the document and in the working list. */
  private reorder(working: PageState, order: number[]): void {
    applyOrder(this.pdf, order);
    working.uids = order.map((i) => working.uids[i]!);
    working.revs = order.map((i) => working.revs[i]!);
  }
}

/** The label an undo or redo shows, such as "Delete 3 pages". One apply gets one label. */
export function labelFor(edits: readonly PageEdit[]): string {
  const ops = new Set(edits.map((edit) => edit.op));
  if (ops.size !== 1) return 'Edit pages';
  const op = edits[0]!.op;
  const count = edits.reduce((sum, edit) => sum + pageCountOf(edit), 0);
  const noun = count === 1 ? 'page' : 'pages';
  switch (op) {
    case 'delete':
      return `Delete ${count} ${noun}`;
    case 'move':
      return `Move ${count} ${noun}`;
    case 'duplicate':
      return `Duplicate ${count} ${noun}`;
    case 'rotate':
      return `Rotate ${count} ${noun}`;
    case 'reverse':
      return `Reverse ${count} ${noun}`;
    case 'insertBlank':
      return `Insert ${count} ${insertedNoun(edits, count)}`;
    case 'insertFrom':
      return `Insert ${count} ${noun} from PDF`;
    case 'crop':
      return `Crop ${count} ${noun}`;
    case 'resize':
      return `Resize ${count} ${noun}`;
    case 'slice':
      return `Cut ${count} ${noun} in half`;
    case 'overlay':
      return `Add overlay to ${count} ${noun}`;
    case 'replace':
      return 'Replace page';
    default:
      return 'Edit pages';
  }
}

function pageCountOf(edit: PageEdit): number {
  switch (edit.op) {
    case 'insertBlank':
      return edit.count ?? 1;
    case 'insertFrom':
      return edit.sourceUids.length;
    case 'replace':
      return 1;
    default:
      return edit.uids.length;
  }
}
