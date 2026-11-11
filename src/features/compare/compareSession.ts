import { documentRegistry, fileService } from '../../app/services';
import { useCompareStore, sessionOf, type CompareSession } from '../../core/stores/compareStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSheetStore, type LengthUnit } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { bitmapCache } from '../../engine/bitmapCache';
import { ERROR_MESSAGES, isPdfOpenError, plainMessage, readFailureMessage } from '../../engine/errors';
import { MupdfDocument } from '../../engine/mupdf/mupdfDocument';
import type { PageEdit, XfaFacts } from '../../engine/mupdf/protocol';
import { precheckBytes } from '../../engine/precheck';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import type { FileStat, ReadResult } from '../../platform/desktop/contract';
import { attachSourceLogged } from '../documents/editOps';
import { addBlocked } from '../documents/sourceCheck';
import { askSourcePassword } from '../organizer/sourcePassword';
import { compareHooks } from './compareHooks';
import { activePane, currentUid, orderOf, runEdits, selectedUids } from '../organizer/actions';
import { defaultUnitFor } from '../organizer/units';
import {
  COMPARE_GONE,
  addProblem,
  addedText,
  compareTargets,
  modeOf,
  OVERLAY_KEY_MARK,
  openingText,
  viewKeyOf,
  xfaText,
  type CompareInputs,
} from './compareMath';

/**
 * "Overlay to Compare" (1.3.4), the page side. The overlay file is attached to the base document's worker as a source (the
 * same read path "Insert from PDF" uses), drawn into the page bitmaps by the engine, and dropped on leaving. After a save the
 * document is a new worker with no sources, so the file is read again and attached again. Nothing here writes a file.
 *
 * Which file is the overlay is the session's `file` and `sourceDocId`: choosing another file replaces them (and detaches the
 * old one), and Apply reads the file the session names now, never one kept from earlier.
 */

/** What the session needs from the app, so it can be tested without a window. */
export interface ComparePorts {
  /** The PDF the user picks (the native Open dialog). Null when they cancel. */
  pick(): Promise<{ path: string | null; name: string; bytes?: ArrayBuffer } | null>;
  read(path: string): Promise<ReadResult>;
  stat(path: string): Promise<FileStat | null>;
  /** The engine document of a docId. */
  documentOf(docId: string): MupdfDocument | undefined;
  askPassword(name: string, error: string | null): Promise<string | null>;
  toast(message: string): void;
  /** Attaches the overlay file for the edit, so recovery can store it (see editOps.attachSourceLogged). */
  attachLogged(docId: string, bytes: ArrayBuffer, password?: string): Promise<{ sourceDocId: string; pages: number }>;
  /**
   * Why an overlay file of this size may not be added to the document (it is over the edit limit, or the document and it together
   * would be), or null when it may. Asked before the file is read (see features/documents/sourceCheck.ts).
   */
  addBlocked(docId: string, sourceBytes: number): Promise<string | null>;
  /** The live inputs of the scope rules: the page list, the selection and the current page of the document. */
  inputs(docId: string): CompareInputs;
  /** Runs the edit with its feedback (a toast with Undo). True when it went through. */
  runEdit(docId: string, edits: PageEdit[], done: string): Promise<boolean>;
  /** The locale's default unit. */
  unit(): LengthUnit;
}

function defaultDocumentOf(docId: string): MupdfDocument | undefined {
  const doc = documentRegistry.get(docId)?.doc;
  return doc instanceof MupdfDocument ? doc : undefined;
}

const appPorts: ComparePorts = {
  async pick() {
    const [source] = await fileService.pickPdfs();
    if (!source) return null;
    if (source.kind === 'bytes') {
      const copy = source.bytes.buffer.slice(source.bytes.byteOffset, source.bytes.byteOffset + source.bytes.byteLength) as ArrayBuffer;
      return { path: null, name: source.name, bytes: copy };
    }
    return { path: source.path, name: source.name };
  },
  read: (path) => {
    const bridge = getDesktopBridge();
    return bridge ? bridge.files.read(path) : Promise.resolve({ ok: false, reason: 'unreadable' } as ReadResult);
  },
  stat: (path) => getDesktopBridge()?.files.stat(path) ?? Promise.resolve(null),
  documentOf: defaultDocumentOf,
  askPassword: (name, error) => askSourcePassword(name, error),
  toast: (message) => useUiStore.getState().pushToast(message),
  attachLogged: (docId, bytes, password) => attachSourceLogged(docId, bytes, password),
  addBlocked: (docId, sourceBytes) => addBlocked(docId, sourceBytes),
  inputs: (docId) => ({ order: orderOf(docId), selected: selectedUids(docId), current: currentUid(docId) }),
  runEdit: (docId, edits, done) => runEdits(docId, edits, done),
  unit: () => defaultUnitFor(typeof navigator !== 'undefined' ? navigator.language : undefined),
};

let ports: ComparePorts = appPorts;

/** Test hook: replaces some of the session's ports (the others stay as they are). Pass null to restore all of them to the app's. */
export function setComparePorts(next: Partial<ComparePorts> | null): void {
  ports = next ? { ...ports, ...next } : appPorts;
}

/** What is known about the overlay file that is attached, beyond what the sheet shows. Kept in memory only. */
interface Held {
  /** The password of a protected overlay. Never stored anywhere else, never written. */
  password?: string;
  /** The file's size and modified time when it was read. A changed file closes the view after a save. */
  stamp: FileStat | null;
}

/**
 * By session (its `key`, not the document id): a Save As gives the document a new id while the file is being attached again,
 * and what is held and what is in flight must follow the compare, not the old id.
 */
const held = new Map<number, Held>();
/** Counts attach cycles per session, so an answer that arrives after a newer cycle began (a save, another file) is dropped. */
const cycles = new Map<number, number>();

function nextCycle(key: number): number {
  const n = (cycles.get(key) ?? 0) + 1;
  cycles.set(key, n);
  return n;
}

function currentCycle(key: number): number {
  return cycles.get(key) ?? 0;
}

/** True while the session `key` is the one that is on, and no newer cycle has begun. */
function stillCycle(key: number, cycle: number): boolean {
  return useCompareStore.getState().session?.key === key && currentCycle(key) === cycle;
}

/** The engine document of the session `key` as the document is known now (a Save As may have given it a new id). */
function liveDocument(key: number): MupdfDocument | undefined {
  const session = useCompareStore.getState().session;
  return session?.key === key ? ports.documentOf(session.docId) : undefined;
}

function closeCompareSheet(docId: string): void {
  const sheet = useSheetStore.getState().sheet;
  if (sheet?.kind === 'compare' && sheet.docId === docId) useSheetStore.getState().close();
}

// ---- Start, show settings, leave ----------------------------------------------------------------------------------------

/** Starts a compare on a document and opens its sheet. A compare on another document ends first. */
export function startCompare(docId: string): void {
  const existing = useCompareStore.getState().session;
  if (existing && existing.docId === docId) {
    showSettings(docId);
    return;
  }
  if (existing) leaveCompare(existing.docId);
  useCompareStore.getState().begin(docId, ports.unit());
  showSettings(docId);
}

/** Brings the sheet back (the bar's "Show settings"). */
export function showSettings(docId: string): void {
  useSheetStore.getState().open({ kind: 'compare', docId });
}

/** Hides the sheet and keeps comparing ([»]). */
export function hideSettings(): void {
  const sheet = useSheetStore.getState().sheet;
  if (sheet?.kind === 'compare') useSheetStore.getState().close();
}

/**
 * Leaves the compare of a document: the overlay is detached from its worker, the view is plain again, the sheet closes. The
 * document is not changed. Safe to call when there is no compare.
 */
export function leaveCompare(docId: string): void {
  const session = sessionOf(docId);
  if (!session) return;
  nextCycle(session.key);
  const sourceDocId = session.sourceDocId;
  useCompareStore.getState().end();
  held.delete(session.key);
  closeCompareSheet(docId);
  dropOverlayBitmaps(docId);
  if (sourceDocId !== null) void ports.documentOf(docId)?.detachSource(sourceDocId).catch(() => undefined);
}

/** Closes the compare with the message "The overlay file has changed or can no longer be read, so comparing has stopped." */
function closeGone(docId: string): void {
  leaveCompare(docId);
  ports.toast(COMPARE_GONE);
}

/** The document was closed (its tab went): its worker is gone with the overlay in it, so there is nothing to detach. */
export function compareDocumentClosed(docId: string): void {
  const session = sessionOf(docId);
  if (!session) return;
  nextCycle(session.key);
  useCompareStore.getState().end();
  held.delete(session.key);
  closeCompareSheet(docId);
  dropOverlayBitmaps(docId);
}

/**
 * The document got a new id (Save As): the session follows it. What is held (the password, the file's stamp) and what is in
 * flight belong to the session, not to the id, so nothing else moves.
 */
export function compareDocumentRekeyed(oldId: string, newId: string): void {
  if (useCompareStore.getState().session?.docId === oldId) {
    dropOverlayBitmaps(oldId);
    useCompareStore.getState().rekey(oldId, newId);
  }
}

/** Drops the bitmaps of this document's overlay views (they are pseudo documents of the bitmap cache). */
function dropOverlayBitmaps(docId: string): void {
  bitmapCache.deleteWhere((key) => key.startsWith(`${docId}${OVERLAY_KEY_MARK}`));
}

// ---- The overlay file ---------------------------------------------------------------------------------------------------

interface Chosen {
  path: string | null;
  name: string;
  bytes?: ArrayBuffer;
}

/** Lets the user pick a PDF and lays it over the document. */
export async function chooseOverlayFile(docId: string): Promise<boolean> {
  const picked = await ports.pick();
  if (!picked) return false;
  return openOverlay(docId, picked);
}

/** Uses a file that is open in another tab (by its path) as the overlay. Its last saved version is read from disk. */
export function chooseOpenFile(docId: string, path: string, name: string): Promise<boolean> {
  return openOverlay(docId, { path, name });
}

/**
 * Reads, checks and attaches a file as the overlay. On any failure the overlay that was there stays, and the user is told. A
 * protected file asks for its password (a wrong one is said so and asked again; Cancel keeps the old overlay).
 */
async function openOverlay(docId: string, chosen: Chosen): Promise<boolean> {
  const session = sessionOf(docId);
  if (!session) return false;
  const key = session.key;
  const cycle = nextCycle(key);
  const before = { phase: session.phase, note: session.note };
  useCompareStore.getState().patch({ phase: session.file ? 'ready' : 'opening', note: openingText(chosen.name) });
  const restore = () => {
    if (!stillCycle(key, cycle)) return;
    useCompareStore.getState().patch({ phase: before.phase === 'opening' ? 'none' : before.phase, note: null });
  };
  try {
    // The file's own size and modified time come first, so a change while it is read is seen by the next check.
    const stamp = chosen.path !== null ? await ports.stat(chosen.path) : null;
    // Too large to add: said before the file is read.
    const sourceSize = chosen.bytes ? chosen.bytes.byteLength : stamp?.size;
    const blocked = sourceSize === undefined ? null : await ports.addBlocked(docId, sourceSize);
    if (blocked) {
      ports.toast(blocked);
      restore();
      return false;
    }
    let bytes: ArrayBuffer;
    if (chosen.bytes) {
      bytes = chosen.bytes;
    } else if (chosen.path !== null) {
      const read = await ports.read(chosen.path);
      if (!read.ok) {
        ports.toast(readFailureMessage(read.reason));
        restore();
        return false;
      }
      bytes = read.bytes;
      // No size from the stat: the bytes that were read decide, as in Insert from PDF.
      const late = sourceSize === undefined ? await ports.addBlocked(docId, bytes.byteLength) : null;
      if (late) {
        ports.toast(late);
        restore();
        return false;
      }
    } else {
      restore();
      return false;
    }
    const notPdf = precheckBytes(new Uint8Array(bytes));
    if (notPdf) {
      ports.toast(ERROR_MESSAGES[notPdf.kind]);
      restore();
      return false;
    }
    const doc = liveDocument(key);
    if (!doc) {
      restore();
      return false;
    }
    let password: string | undefined;
    for (;;) {
      try {
        const attached = await doc.attachSource(bytes.slice(0), password);
        if (!stillCycle(key, cycle)) {
          // Something newer happened while the file was being read (a save, a different file, leaving): this one is not wanted.
          void doc.detachSource(attached.sourceDocId).catch(() => undefined);
          return false;
        }
        if (attached.xfa.xfaPresent || attached.xfa.needsRendering) {
          void doc.detachSource(attached.sourceDocId).catch(() => undefined);
          ports.toast(xfaText(chosen.name));
          restore();
          return false;
        }
        const current = useCompareStore.getState().session!;
        const old = current.sourceDocId;
        held.set(key, { password, stamp });
        useCompareStore.getState().patch({
          phase: 'ready',
          file: { path: chosen.path, name: chosen.name, pages: attached.pages },
          sourceDocId: attached.sourceDocId,
          attach: current.attach + 1,
          startPage: 1,
          fixedPage: 1,
          sizes: {},
          note: null,
        });
        if (old !== null) void doc.detachSource(old).catch(() => undefined);
        return true;
      } catch (error) {
        const kind = isPdfOpenError(error) ? error.kind : null;
        if (kind === 'PasswordNeeded' || kind === 'WrongPassword') {
          const answer = await ports.askPassword(chosen.name, kind === 'WrongPassword' ? ERROR_MESSAGES.WrongPassword : null);
          if (answer === null) {
            restore();
            return false;
          }
          password = answer;
          continue;
        }
        ports.toast(plainMessage(error, 'That PDF could not be used.') || 'That PDF could not be used.');
        restore();
        return false;
      }
    }
  } catch (error) {
    ports.toast(plainMessage(error, 'That PDF could not be used.') || 'That PDF could not be used.');
    restore();
    return false;
  }
}

/**
 * The document's worker was replaced (a save reopened the saved bytes in a new one): the overlay is read again and attached
 * again. While that runs the pages show plain. A file that is missing or has changed since it was read closes the compare.
 */
export function compareDocumentReplaced(docId: string): void {
  const session = sessionOf(docId);
  if (!session) return;
  const cycle = nextCycle(session.key);
  const file = session.file;
  if (!file || session.sourceDocId === null) {
    // Nothing was attached (or an attach was in flight, and went into the old worker): back to choosing.
    if (session.phase === 'opening') useCompareStore.getState().patch({ phase: 'none', note: null, sourceDocId: null });
    return;
  }
  void reattach(session.key, cycle, file.path);
}

async function reattach(key: number, cycle: number, path: string | null): Promise<void> {
  const still = () => stillCycle(key, cycle);
  // The session is found by its key, so a Save As that re-keys the document while the file is read does not lose it.
  const closeThis = () => {
    const now = useCompareStore.getState().session;
    if (now?.key === key) closeGone(now.docId);
  };
  const start = useCompareStore.getState().session;
  if (!start || start.key !== key) return;
  // The old worker is gone with its sources: the pages are plain until the overlay is attached again.
  dropOverlayBitmaps(start.docId);
  useCompareStore.getState().patch({ phase: 'reattaching', sourceDocId: null, sizes: {} });
  const memory = held.get(key);
  try {
    if (path === null || !memory) return closeThis();
    const now = await ports.stat(path);
    if (!still()) return;
    if (!now || (memory.stamp !== null && (now.size !== memory.stamp.size || now.modified !== memory.stamp.modified))) return closeThis();
    const read = await ports.read(path);
    if (!still()) return;
    if (!read.ok) return closeThis();
    const doc = liveDocument(key);
    if (!doc) return;
    const attached = await doc.attachSource(read.bytes, memory.password);
    if (!still()) {
      void doc.detachSource(attached.sourceDocId).catch(() => undefined);
      return;
    }
    const current = useCompareStore.getState().session!;
    useCompareStore.getState().patch({ phase: 'ready', sourceDocId: attached.sourceDocId, attach: current.attach + 1, note: null });
  } catch {
    if (still()) closeThis();
  }
}

/** The display size of an overlay page, asked of the worker once and kept in the session (for "different size" and Fit to page). */
export async function ensureOverlaySize(docId: string, page: number): Promise<void> {
  const session = sessionOf(docId);
  if (!session || session.sourceDocId === null || session.sizes[page] !== undefined) return;
  const key = session.key;
  const cycle = currentCycle(key);
  const attach = session.attach;
  try {
    const size = await ports.documentOf(docId)?.sourceSize(session.sourceDocId, page);
    const now = sessionOf(docId);
    if (!size || !now || now.key !== key || currentCycle(key) !== cycle || now.attach !== attach) return;
    useCompareStore.getState().patch({ sizes: { ...now.sizes, [page]: size } });
  } catch {
    // The page's size is only a hint for the sheet; the view does not need it.
  }
}

// ---- Add overlay to pages ----------------------------------------------------------------------------------------------

/**
 * "Add overlay to pages": the pages "Add to" names right now, each with its overlay page, as one edit (one undo step, recorded
 * in the recovery log), and then the compare ends. The overlay file is read again for the edit, so what is added is the file
 * the session names (and a file that changed since it was shown closes the compare instead). Resolves with true when it was added.
 */
export async function applyCompare(docId: string): Promise<boolean> {
  const session = sessionOf(docId);
  if (!session) return false;
  const targets = compareTargets(ports.inputs(docId), session.addTo, session);
  const problem = addProblem(session, targets);
  if (problem) {
    ports.toast(problem);
    return false;
  }
  const file = session.file!;
  const memory = held.get(session.key);
  if (file.path === null || !memory) {
    ports.toast(COMPARE_GONE);
    leaveCompare(docId);
    return false;
  }
  const mode = modeOf(session.look);
  if (mode === 'difference') return false;
  // Overlay Add makes the document bigger by the overlay file: estimated as the document's saved size plus the file's size, and
  // refused before anything is read when that is past the edit limit (the same rule as Insert from PDF).
  if (memory.stamp !== null) {
    const blocked = await ports.addBlocked(docId, memory.stamp.size);
    if (blocked) {
      ports.toast(blocked);
      return false;
    }
  }
  const now = await ports.stat(file.path);
  if (!now || (memory.stamp !== null && (now.size !== memory.stamp.size || now.modified !== memory.stamp.modified))) {
    closeGone(docId);
    return false;
  }
  const read = await ports.read(file.path);
  if (!read.ok) {
    closeGone(docId);
    return false;
  }
  if (memory.stamp === null) {
    const late = await ports.addBlocked(docId, read.bytes.byteLength);
    if (late) {
      ports.toast(late);
      return false;
    }
  }
  // The file can change while it is read: look at it once more, and add nothing that is not the file that was shown.
  const after = await ports.stat(file.path);
  if (!after || (memory.stamp !== null && (after.size !== memory.stamp.size || after.modified !== memory.stamp.modified))) {
    closeGone(docId);
    return false;
  }
  // The edit's own copy of the overlay file, stored for recovery (a protected one is not stored: see editOps).
  let attached: { sourceDocId: string; pages: number };
  try {
    attached = await ports.attachLogged(docId, read.bytes, memory.password);
  } catch (error) {
    ports.toast(plainMessage(error, 'That PDF could not be used.') || 'That PDF could not be used.');
    return false;
  }
  // The pages may have changed while the file was read (an edit, a save): the targets are read again, right before the edit.
  const live = sessionOf(docId);
  if (!live) {
    // The compare ended meanwhile (the tab closed, or the user left): the copy made for the edit is not needed.
    void ports.documentOf(docId)?.detachSource(attached.sourceDocId).catch(() => undefined);
    return false;
  }
  const again = compareTargets(ports.inputs(docId), live.addTo, live);
  const edit: PageEdit = {
    op: 'overlay',
    uids: again.pairs.map((pair) => pair.uid),
    sourceDocId: attached.sourceDocId,
    sourceUids: again.pairs.map((pair) => String(pair.sourceIndex)),
    dx: live.dx,
    dy: live.dy,
    scale: live.size / 100,
    mode,
    opacity: live.opacity / 100,
  };
  const ok = again.pairs.length > 0 && (await ports.runEdit(docId, [edit], addedText(again.pairs.length)));
  // The copy made for the edit is not needed once the step is made (undo and redo work on the document's own objects).
  void ports.documentOf(docId)?.detachSource(attached.sourceDocId).catch(() => undefined);
  if (ok) leaveCompare(docId);
  return ok;
}

/** Show or hide the overlay (F8). */
export function toggleShow(docId: string): void {
  const session = sessionOf(docId);
  if (session) useCompareStore.getState().patch({ show: !session.show });
}

/** Changes a setting, and drops the bitmaps of the looks that are no longer shown (they would only hold the cache's budget). */
export function changeCompare(patch: Partial<CompareSession>): void {
  const session = useCompareStore.getState().session;
  if (!session) return;
  useCompareStore.getState().patch(patch);
  const now = useCompareStore.getState().session;
  if (now) pruneOverlayBitmaps(now);
}

/**
 * Closes the cached bitmaps of this session's looks that are not the one shown now. A bitmap of the look on screen stays (and
 * so does one still pinned by a page that has not switched yet: the cache keeps it until the page lets go). Without this the
 * bitmaps of every look the user tried would stay in the bitmap budget until the cache pushed them out.
 */
export function pruneOverlayBitmaps(session: CompareSession): void {
  const all = `${session.docId}${OVERLAY_KEY_MARK}`;
  const keep = `${all}${viewKeyOf(session)}.`;
  bitmapCache.deleteWhere((key) => key.startsWith(all) && !key.startsWith(keep));
}

/** The open documents that can be used as an overlay: those with a file of their own, other than `docId`. */
export function openFilesFor(docId: string): Array<{ docId: string; path: string; name: string; unsaved: boolean }> {
  const docs = useDocumentsStore.getState().docs;
  const edit = useEditStore.getState().byDoc;
  const out: Array<{ docId: string; path: string; name: string; unsaved: boolean }> = [];
  for (const [id, info] of Object.entries(docs)) {
    if (id === docId || !id.startsWith('path:')) continue;
    out.push({ docId: id, path: id.slice('path:'.length), name: info.name, unsaved: edit[id]?.history.dirty === true });
  }
  return out;
}

/** The active pane's document, for the commands. */
export function activeCompareDocId(): string | undefined {
  return activePane()?.docId;
}

/** True when the document's overlay file is itself a tab with unsaved changes (the sheet then says it shows the saved version). */
export function overlayFileUnsaved(session: CompareSession | null): boolean {
  const path = session?.file?.path;
  if (!path) return false;
  return useEditStore.getState().byDoc[`path:${path}`]?.history.dirty === true;
}

export type { XfaFacts };

// The registry tells these three events to the hooks (see compareHooks.ts); this is where they are listened to.
compareHooks.replaced = compareDocumentReplaced;
compareHooks.rekeyed = compareDocumentRekeyed;
compareHooks.closed = compareDocumentClosed;
