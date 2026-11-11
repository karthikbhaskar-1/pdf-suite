/**
 * Combine Files, from the command to the result notice (UI spec section 1; blueprint sections 1, 2, 6).
 *
 * The window keeps a list of files. Each file is read once when it is added (the job worker "probes" it: pages, password, forms,
 * layers, attachments) and its first page is previewed; the worker holds ONE input at a time, so everything it is asked goes
 * through one queue, and choosing another row for the preview reads that file again. The files themselves are read again, one
 * at a time, when the run starts. The output goes to ONE path from a Save dialog (`jobs:pickOutputFile`); main refuses a path
 * that is one of the inputs or is open in a tab, before anything starts.
 */
import { jobIsRunning, useJobStore } from '../../core/stores/jobStore';
import { useCombineStore } from '../../core/stores/combineStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { bitmapCache } from '../../engine/bitmapCache';
import { thumbnailCache } from '../../engine/thumbnailCache';
import { ERROR_MESSAGES } from '../../engine/errors';
import type { JobInputInfo } from '../../platform/desktop/contract';
import { getDesktopBridge, pathSource } from '../../platform/desktop/bridge';
import { openPicked } from '../documents/documentService';
import { saveWithFeedback } from '../documents/closeFlow';
import { savePathOf } from '../documents/saveDocument';
import { askSourcePassword } from '../organizer/sourcePassword';
import {
  COMBINE_TARGET_IS_INPUT_MESSAGE,
  COMBINE_TARGET_OPEN_MESSAGE,
  COMBINE_TOO_MANY_MESSAGE,
  STOPPED_RESPONDING_MESSAGE,
  combineDamagedMessage,
  combineEmptyMessage,
  combineDoneMessage,
  combineErrorMessage,
  combineFormValuesMessage,
  combineOfficeMessage,
  combineOtherTypeMessage,
  combinePasswordCancelledMessage,
  combinePictureTooLargeMessage,
  combineTextTooLargeMessage,
  combineUnreadableMessage,
  combineXfaMessage,
  COMBINE_TOTAL_TOO_LARGE_MESSAGE,
  jobErrorMessage,
  mainFailureMessage,
} from './jobMessages';
import {
  DEFAULT_OUTPUT_NAME,
  MAX_COMBINE_ITEMS,
  blockOf,
  buildCombineSpec,
  hasRange,
  imagePageOf,
  leafOf,
  moveBefore,
  moveRows,
  pageDimsOfText,
  pagesOfRow,
  sortByName,
  togglePage,
  type CombineRow,
  type MoveWhere,
} from './combinePlan';
import { JobError, JobWorkerClient, runCombine, type ProbedFacts } from './jobRunner';
import { bridge, makeClient } from './splitFlow';

/** The longer side of a preview thumbnail, in pixels. */
export const THUMB_PX = 160;

// ---- The worker and its queue ----------------------------------------------------------------------------------------------------

let client: JobWorkerClient | null = null;
let queue: Promise<void> = Promise.resolve();
/** The list item the worker holds now (its last probe). */
let heldItem: number | null = null;
/** Bumped when the list is cleared, so work queued for the old list does nothing. */
let generation = 0;
let rowSeq = 0;
const itemNumbers = new Map<string, number>();
let returnFocus: HTMLElement | null = null;

function enqueue(step: () => Promise<void>): Promise<void> {
  const mine = generation;
  const run = queue.then(() => (mine === generation ? step() : undefined)).catch(() => undefined);
  queue = run;
  return run;
}

async function ensureClient(): Promise<JobWorkerClient> {
  if (client && !client.isClosed) return client;
  client = await makeClient();
  heldItem = null;
  return client;
}

function endWorker(): void {
  client?.terminate();
  client = null;
  heldItem = null;
}

const store = () => useCombineStore.getState();
const rowOf = (id: string) => store().rows.find((r) => r.id === id);
const itemOf = (id: string): number => {
  let n = itemNumbers.get(id);
  if (n === undefined) {
    n = ++rowSeq;
    itemNumbers.set(id, n);
  }
  return n;
};

// ---- Open and close -------------------------------------------------------------------------------------------------------------

export function combineAvailability(): { enabled: boolean; reason?: string } {
  return jobIsRunning() ? { enabled: false, reason: 'PDF Suite is still working on your files. Wait for it to finish, or cancel it.' } : { enabled: true };
}

/** Opens the window (with the list as it was, if it was closed after a failure or Cancel), and adds `paths` to it. */
export function openCombine(paths: readonly string[] = []): boolean {
  if (!combineAvailability().enabled) return false;
  returnFocus = typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  store().set({ open: true, targetMessage: null });
  // Rows that were still being read when the window closed are read again.
  for (const row of store().rows) if (row.status === 'reading') void enqueue(() => probeRow(row.id, {}));
  const focus = store().focusId ? rowOf(store().focusId!) : undefined;
  if (focus) void showPreview(focus.id);
  if (paths.length > 0) void addPaths(paths);
  return true;
}

/** Closes the window and ends its worker. The list stays (it reopens as it was) unless `clear` is set. */
export function closeCombine(options: { clear?: boolean; restoreFocus?: boolean } = {}): void {
  store().set({ open: false, starting: false });
  if (options.clear) clearList();
  if (!jobIsRunning()) endWorker();
  if (options.restoreFocus !== false && returnFocus && returnFocus.isConnected) returnFocus.focus();
}

/** Empties the list and forgets what it knew: the previews, the passwords. */
export function clearList(): void {
  generation += 1;
  itemNumbers.clear();
  bitmapCache.deleteWhere((key) => key.startsWith('thumb|combine|'));
  useJobStore.getState().forgetPasswords();
  store().set({ rows: [], selected: [], focusId: null, messages: [], targetMessage: null, announcement: '' });
}

// ---- Adding files -----------------------------------------------------------------------------------------------------------------

/** The Add files… button: the native picker (multi-select), then the files are typed, granted and listed. */
export async function addFilesFromPicker(): Promise<void> {
  const api = getDesktopBridge();
  if (!api) return;
  addInfos(await api.jobs.pickInputs());
}

/** Dropped files, or open tabs: typed by main, which answers only for paths that already hold a read grant. */
export async function addPaths(paths: readonly string[]): Promise<void> {
  const api = getDesktopBridge();
  if (!api || paths.length === 0) return;
  addInfos(await api.jobs.describeInputs([...paths]));
}

/** Every open PDF (its saved file). */
export function openDocumentPaths(): string[] {
  const out: string[] = [];
  for (const docId of Object.keys(useDocumentsStore.getState().docs)) {
    const path = savePathOf(docId);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export async function addOpenFiles(): Promise<void> {
  await addPaths(openDocumentPaths());
}

/** Lists files that were typed. A kind that cannot be combined is said so; the rest are read one after another. */
export function addInfos(infos: readonly JobInputInfo[]): void {
  const s = store();
  const rows = [...s.rows];
  const fresh: CombineRow[] = [];
  let tooMany = false;
  for (const info of infos) {
    if (info.kind === 'office') {
      s.addMessage(combineOfficeMessage(info.name));
      continue;
    }
    if (info.kind === 'unsupported') {
      s.addMessage(combineOtherTypeMessage(info.name));
      continue;
    }
    if (rows.length + fresh.length >= MAX_COMBINE_ITEMS) {
      tooMany = true;
      break;
    }
    const row: CombineRow = {
      id: `row${++rowSeq}`,
      path: info.path,
      name: info.name,
      size: info.size,
      modified: info.modified,
      kind: info.kind,
      status: 'reading',
      pages: 0,
      rangeText: '',
      facts: null,
    };
    itemNumbers.set(row.id, rowSeq);
    fresh.push(row);
  }
  if (tooMany) s.addMessage(COMBINE_TOO_MANY_MESSAGE);
  if (fresh.length === 0) return;
  s.set({ rows: [...rows, ...fresh] });
  if (!store().focusId) selectOnly(fresh[0]!.id);
  for (const row of fresh) void enqueue(() => probeRow(row.id, {}));
}

/** Reads one row: the file, its password if it has one, and the worker's facts; then its first page for the list. */
async function probeRow(id: string, options: { preview?: boolean; keepRange?: boolean }): Promise<void> {
  const api = bridge();
  const row = rowOf(id);
  if (!api || !row) return;
  const remove = (message: string) => {
    removeRows([id], { quiet: true });
    store().addMessage(message);
  };
  let worker: JobWorkerClient;
  try {
    worker = await ensureClient();
  } catch {
    return remove(combineUnreadableMessage(row.name));
  }
  const settings = store();
  const item = itemOf(id);
  let password = useJobStore.getState().passwords[row.path];
  let read = await api.readInput(row.path);
  for (;;) {
    if (!rowOf(id)) return;
    if (!read.ok) {
      // A file that was read before and is gone now stays in the list, marked, so the user decides; one that never could be read is not added.
      if (rowOf(id)?.facts) {
        store().setRow(id, { gone: true, status: 'ready' });
        store().addMessage(jobErrorMessage('InputUnreadable', row.name));
        return;
      }
      return remove(read.reason === 'empty' ? combineEmptyMessage(row.name) : combineUnreadableMessage(row.name));
    }
    let facts: ProbedFacts;
    try {
      facts = await worker.probeInput(row.kind, read.bytes, {
        ...(password !== undefined ? { password } : {}),
        item,
        imagePage: imagePageOf(settings.pictureSize),
        textPage: pageDimsOfText(settings.textSize),
        ...(options.preview ? { preview: true } : {}),
      });
    } catch (error) {
      const kind = error instanceof JobError ? error.kind : 'Internal';
      if (kind === 'Cancelled' || kind === 'Stopped') return;
      heldItem = null;
      if (kind === 'PasswordNeeded' || kind === 'WrongPassword') {
        const answer = await askSourcePassword(row.name, kind === 'WrongPassword' ? ERROR_MESSAGES.WrongPassword : null);
        if (answer === null) return remove(combinePasswordCancelledMessage(row.name));
        password = answer;
        read = await api.readInput(row.path);
        continue;
      }
      if (kind === 'Damaged') return remove(row.kind === 'pdf' ? combineDamagedMessage(row.name) : combineUnreadableMessage(row.name));
      if (kind === 'ImageTooLarge') return remove(combinePictureTooLargeMessage(row.name, error instanceof JobError && error.info.page !== undefined));
      if (kind === 'TextTooLarge') return remove(combineTextTooLargeMessage(row.name));
      if (kind === 'TotalTooLarge') return remove(COMBINE_TOTAL_TOO_LARGE_MESSAGE);
      return remove(combineUnreadableMessage(row.name));
    }
    heldItem = item;
    if (password !== undefined && row.kind === 'pdf' && facts.encrypted) useJobStore.getState().rememberPassword(row.path, password);
    if (!options.preview) {
      if (facts.xfa) return remove(combineXfaMessage(row.name));
      if (!facts.formValuesKept) return remove(combineFormValuesMessage(row.name));
      const current = rowOf(id);
      if (!current) return;
      const keep = options.keepRange === true && current.rangeText !== '';
      const next: CombineRow = { ...current, size: read.size, modified: read.modified, pages: facts.pages };
      const stillValid = keep && pagesOfRow({ ...next, status: 'ready' }).ok;
      store().setRow(id, {
        status: 'ready',
        gone: false,
        size: read.size,
        modified: read.modified,
        pages: facts.pages,
        rangeText: stillValid ? current.rangeText : '',
        facts: { encrypted: facts.encrypted, fields: facts.fields, layers: facts.layers, attachments: facts.attachments, unprintable: facts.unprintable },
      });
      await loadThumb(id, 0);
    }
    return;
  }
}

// ---- Previews ---------------------------------------------------------------------------------------------------------------------

/** The cache key of one preview page. A picture or text row also depends on the page-size options. */
export function thumbKey(row: Pick<CombineRow, 'id' | 'kind'>, page: number): string {
  const s = store();
  const options = row.kind === 'image' ? s.pictureSize : row.kind === 'text' ? s.textSize : '';
  return `combine|${row.id}|${options}|${page}|${THUMB_PX}`;
}

async function loadThumb(id: string, page: number): Promise<void> {
  const row = rowOf(id);
  if (!row || row.status !== 'ready' || page < 0 || page >= row.pages) return;
  const key = thumbKey(row, page);
  if (thumbnailCache.has(key)) return;
  const worker = client;
  if (!worker || worker.isClosed || heldItem !== itemOf(id)) return;
  try {
    const t = await worker.thumb(itemOf(id), page, THUMB_PX);
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(t.pixels), t.width, t.height));
    // The row may have been removed or changed while the picture was made.
    if (!rowOf(id)) {
      bitmap.close();
      return;
    }
    thumbnailCache.set(key, bitmap, t.width * t.height * 4);
    useCombineStore.setState((s) => ({ thumbVersion: s.thumbVersion + 1 }));
  } catch {
    // A preview that cannot be made stays grey.
  }
}

/** Makes the worker hold row `id` (reading the file again if another row was probed since) and previews its first page. */
export function showPreview(id: string): Promise<void> {
  return enqueue(async () => {
    const row = rowOf(id);
    if (!row || row.status !== 'ready') return;
    if (heldItem !== itemOf(id)) await probeRow(id, { preview: true });
    if (heldItem === itemOf(id)) await loadThumb(id, 0);
  });
}

/** The preview asks for these pages (0-based) of row `id`, the ones scrolled into view. */
export function requestPreviewPages(id: string, pages: readonly number[]): Promise<void> {
  return enqueue(async () => {
    const row = rowOf(id);
    if (!row || row.status !== 'ready') return;
    if (heldItem !== itemOf(id)) await probeRow(id, { preview: true });
    if (heldItem !== itemOf(id)) return;
    for (const page of pages) {
      if (!rowOf(id)) return;
      await loadThumb(id, page);
    }
  });
}

// ---- Selection, order and ranges -----------------------------------------------------------------------------------------------

export function selectOnly(id: string): void {
  store().set({ selected: [id], focusId: id });
  void showPreview(id);
}

export function setSelection(ids: string[], focusId: string | null): void {
  const previous = store().focusId;
  store().set({ selected: ids, focusId });
  if (focusId && focusId !== previous) void showPreview(focusId);
}

function removeRows(ids: readonly string[], options: { quiet?: boolean } = {}): void {
  const s = store();
  const gone = new Set(ids);
  const index = Math.max(0, s.rows.findIndex((r) => gone.has(r.id)));
  const rows = s.rows.filter((r) => !gone.has(r.id));
  for (const id of ids) {
    bitmapCache.deleteWhere((key) => key.startsWith(`thumb|combine|${id}|`));
    itemNumbers.delete(id);
  }
  const selected = s.selected.filter((id) => !gone.has(id));
  let focusId = s.focusId && !gone.has(s.focusId) ? s.focusId : null;
  if (!focusId && rows.length > 0) {
    focusId = rows[Math.min(index, rows.length - 1)]!.id;
    if (selected.length === 0) selected.push(focusId);
  }
  s.set({ rows, selected, focusId, ...(options.quiet ? {} : { announcement: `Removed ${ids.length} ${ids.length === 1 ? 'file' : 'files'}` }) });
  if (focusId && focusId !== s.focusId) void showPreview(focusId);
}

export function removeSelected(): void {
  const ids = store().selected;
  if (ids.length > 0) removeRows(ids);
}

export function moveSelected(where: MoveWhere): void {
  const s = store();
  const ids = new Set(s.selected);
  if (ids.size === 0) return;
  const moved = moveRows(s.rows, ids, where);
  s.set({ rows: moved.rows, announcement: announceMove(moved.rows, s.focusId, moved.index) });
}

function announceMove(rows: readonly CombineRow[], focusId: string | null, index: number): string {
  const row = rows.find((r) => r.id === focusId) ?? rows[index];
  const at = row ? rows.indexOf(row) + 1 : index + 1;
  return row ? `${row.name} moved to ${at} of ${rows.length}` : '';
}

/** Dropping rows (a drag by the handle) before row index `beforeIndex` of the list as it was when the drag started. */
export function dragSelectedTo(ids: readonly string[], beforeIndex: number): void {
  const s = store();
  const rows = moveBefore(s.rows, new Set(ids), beforeIndex);
  const first = rows.find((r) => ids.includes(r.id));
  s.set({ rows, announcement: first ? `${first.name} moved to ${rows.indexOf(first) + 1} of ${rows.length}` : '' });
}

export function sortRowsByName(): void {
  const s = store();
  s.set({ rows: sortByName(s.rows), announcement: 'Sorted by name' });
}

export function setRangeText(id: string, text: string): void {
  store().setRow(id, { rangeText: text });
}

/** A click or Space on a preview page: leaves it out or puts it back. */
export function togglePreviewPage(id: string, page: number): void {
  const row = rowOf(id);
  if (!row || !hasRange(row)) return;
  const next = togglePage(row, page);
  if (next !== null) store().setRow(id, { rangeText: next });
}

/** Picture pages and Text pages: the rows of that kind are read again ("Reading…") and their previews made again. */
export function setPageOption(patch: { pictureSize?: CombineRowOptions['pictureSize']; textSize?: CombineRowOptions['textSize'] }): void {
  const s = store();
  s.set(patch);
  const kind = patch.pictureSize !== undefined ? 'image' : 'text';
  for (const row of s.rows.filter((r) => r.kind === kind)) {
    bitmapCache.deleteWhere((key) => key.startsWith(`thumb|combine|${row.id}|`));
    s.setRow(row.id, { status: 'reading' });
    void enqueue(() => probeRow(row.id, { keepRange: true }));
  }
}

type CombineRowOptions = Pick<ReturnType<typeof store>, 'pictureSize' | 'textSize'>;

/** Save now, for a listed file that is open with unsaved changes: the saved version is then read again. */
export async function saveOpenFile(docId: string): Promise<void> {
  const result = await saveWithFeedback(docId);
  if (result !== 'saved') return;
  const path = savePathOf(docId);
  for (const row of store().rows.filter((r) => r.path === path)) {
    store().setRow(row.id, { status: 'reading' });
    void enqueue(() => probeRow(row.id, { keepRange: true }));
  }
}

/** Listed files that are open in a tab with unsaved changes (for the notice with Save now). */
export function unsavedOpenFiles(): Array<{ docId: string; name: string; path: string }> {
  const dirty = useEditStore.getState().byDoc;
  const out: Array<{ docId: string; name: string; path: string }> = [];
  const listed = new Set(store().rows.map((r) => r.path.toLowerCase()));
  for (const docId of Object.keys(useDocumentsStore.getState().docs)) {
    const path = savePathOf(docId);
    if (path && dirty[docId]?.history.dirty === true && listed.has(path.toLowerCase())) out.push({ docId, name: leafOf(path), path });
  }
  return out;
}

// ---- Running ----------------------------------------------------------------------------------------------------------------------

/** Cancel in the status bar. */
export function cancelCombine(): void {
  const { cancel } = useJobStore.getState();
  if (!cancel) return;
  useJobStore.getState().setCancelling();
  cancel();
}

/**
 * Combine…: the files are checked once more (changed or deleted since they were added), then the Save dialog asks for the name,
 * main checks the target, and the window closes as the job starts.
 */
export async function startCombine(): Promise<void> {
  const api = getDesktopBridge();
  const s = store();
  if (!api || s.starting || jobIsRunning() || blockOf(s.rows) !== null) return;
  s.set({ starting: true, targetMessage: null });
  try {
    // 1. The files on disk are what they were when they were added.
    let problem = false;
    for (const row of s.rows) {
      const now = await api.files.stat(row.path);
      if (!now) {
        store().setRow(row.id, { gone: true });
        store().addMessage(jobErrorMessage('InputUnreadable', row.name));
        problem = true;
      } else if (now.size !== row.size || now.modified !== row.modified) {
        store().setRow(row.id, { status: 'reading' });
        void enqueue(() => probeRow(row.id, { keepRange: true }));
        store().addMessage(jobErrorMessage('InputChanged', row.name));
        problem = true;
      }
    }
    if (problem) return;

    // 2. The output name.
    const rows = store().rows;
    const outputPath = await api.jobs.pickOutputFile(DEFAULT_OUTPUT_NAME, rows[0]!.path);
    if (!outputPath) return;

    // 3. Run. The window closes when main has accepted the target.
    const worker = await ensureClient();
    const state = store();
    const passwords = new Map(Object.entries(useJobStore.getState().passwords));
    const spec = buildCombineSpec(rows, { fileBookmarks: state.fileBookmarks, pictureSize: state.pictureSize, textSize: state.textSize }, leafOf(outputPath), passwords);
    let cancel: () => void = () => undefined;
    const openWhenDone = state.openWhenDone;
    const outcome = await runCombine({
      worker,
      bridge: { ...api.jobs, stat: (path) => api.files.stat(path) },
      outputPath,
      inputs: rows.map((r) => ({ path: r.path, size: r.size, modified: r.modified })),
      spec,
      onProgress: (phase, done, total, unit) => useJobStore.getState().progress(phase, done, total, unit),
      onBegun: () => {
        store().set({ open: false, starting: false });
        useJobStore.getState().start('combine', () => cancel());
      },
      onStart: (fn) => {
        cancel = fn;
      },
      isCancelled: () => useJobStore.getState().job?.cancelling === true,
    });
    if (outcome.status === 'failed' && outcome.notStarted) {
      // Nothing started: the window stays as it is, with the reason under the buttons.
      const reason = outcome.error.info.reason ?? 'invalid';
      store().set({
        targetMessage:
          reason === 'target-is-input' ? COMBINE_TARGET_IS_INPUT_MESSAGE : reason === 'target-open' ? COMBINE_TARGET_OPEN_MESSAGE : mainFailureMessage(reason, outcome.error.info.drive),
      });
      return;
    }
    useJobStore.getState().finish();
    endWorker();
    if (outcome.status === 'done') {
      const done = combineDoneMessage(rows.length, outcome.file.name, outcome.pages);
      clearList();
      closeCombine({ restoreFocus: false });
      useJobStore.getState().setNotice({ message: done, failed: false, resultIds: [outcome.file.resultId], ...(openWhenDone ? {} : { openResultId: outcome.file.resultId }) });
      if (openWhenDone) await openResult(outcome.file.resultId);
      return;
    }
    if (outcome.status === 'cancelled') {
      useJobStore.getState().setNotice({ message: jobErrorMessage('Cancelled'), failed: true, resultIds: [] });
      return;
    }
    const error = outcome.error;
    const named = error.info.item !== undefined ? rows[error.info.item] : undefined;
    const name = named?.name ?? 'The file';
    let message: string;
    if (error.kind === 'Stopped') message = STOPPED_RESPONDING_MESSAGE;
    else if (error.kind === 'MainFailure') message = mainFailureMessage(error.info.reason ?? 'invalid', error.info.drive);
    else message = combineErrorMessage(error.kind, name, named !== undefined && hasRange(named) && named.kind === 'image' && named.pages > 1);
    useJobStore.getState().setNotice({ message, failed: true, resultIds: [] });
  } finally {
    if (store().starting) store().set({ starting: false });
  }
}

/** Open, from the result notice, or automatically after the run. */
export async function openResult(resultId: string): Promise<void> {
  const path = await getDesktopBridge()?.jobs.openResult(resultId);
  if (path) await openPicked([pathSource(path)]);
}

