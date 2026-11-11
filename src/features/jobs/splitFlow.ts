/**
 * Split into Files, from the command to the result notice (UI spec section 2; blueprint sections 1, 3, 6).
 *
 * What it acts on, always: the document that was in front when the command ran (not another open document, not a selection)
 * and that document's SAVED file on disk, read through the main process. A document with unsaved changes is not split: the
 * sheet asks to save first. The output goes to a folder the user chose in the folder dialog; the page only ever holds the token.
 */
import { documentRegistry } from '../../app/services';
import { jobIsRunning, useJobStore } from '../../core/stores/jobStore';
import { useEditStore } from '../../core/stores/editStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useSplitStore, type SplitSheet } from '../../core/stores/splitStore';
import { compileMuPdf } from '../../engine/mupdf/pool';
import { MupdfDocument } from '../../engine/mupdf/mupdfDocument';
import { MAX_TOTAL_INPUT_BYTES } from '../../engine/mupdf/jobProtocol';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import { saveWithFeedback } from '../documents/closeFlow';
import { savePathOf } from '../documents/saveDocument';
import { sessionPasswordOf } from '../documents/sessionPasswords';
import { askSourcePassword } from '../organizer/sourcePassword';
import { ERROR_MESSAGES } from '../../engine/errors';
import { defaultBaseName } from './nameRules';
import {
  CANNOT_KEEP_PASSWORD_MESSAGE,
  JOB_BUSY_REASON,
  INTERNAL_MESSAGE,
  STOPPED_RESPONDING_MESSAGE,
  jobErrorMessage,
  mainFailureMessage,
  splitDoneMessage,
} from './jobMessages';
import { deriveSheet, type SplitSettings } from './splitSheetModel';
import { JobError, JobWorkerClient, runSplit, type JobBridge, type WorkerLike } from './jobRunner';

// ---- What the command acts on ------------------------------------------------------------------------------------------------

export type SplitTarget =
  | { kind: 'ok'; docId: string; path: string; name: string }
  /** The document has changes that are not saved: Split works from the saved file. */
  | { kind: 'unsaved'; docId: string; path: string; name: string }
  /** The document is not a file on disk (a web file) or is not open. */
  | { kind: 'none' };

/** The document and file a Split of `docId` would use now: its saved path (after Save As, the new one) and its name. */
export function resolveSplitTarget(docId: string | undefined): SplitTarget {
  if (!docId) return { kind: 'none' };
  const doc = useDocumentsStore.getState().docs[docId];
  const path = savePathOf(docId);
  if (!doc || !path) return { kind: 'none' };
  const dirty = useEditStore.getState().byDoc[docId]?.history.dirty === true;
  const name = path.split(/[\\/]/).pop() ?? doc.name;
  return { kind: dirty ? 'unsaved' : 'ok', docId, path, name };
}

/** Whether the Split command can run for the focused document, and why not. */
export function splitAvailability(docId: string | undefined): { enabled: boolean; reason?: string } {
  if (jobIsRunning()) return { enabled: false, reason: JOB_BUSY_REASON };
  if (!docId) return { enabled: false };
  const handle = documentRegistry.get(docId)?.doc;
  if (!(handle instanceof MupdfDocument) || !handle.capabilities.canEdit) return { enabled: false };
  if (resolveSplitTarget(docId).kind === 'none') return { enabled: false };
  return { enabled: true };
}

// ---- Seams for tests -----------------------------------------------------------------------------------------------------------

type WorkerFactory = () => Promise<WorkerLike>;
let workerFactory: WorkerFactory | null = null;
/** Test hook: the job worker is made by this instead of a real Worker. Pass null to restore. */
export function setJobWorkerFactory(factory: WorkerFactory | null): void {
  workerFactory = factory;
}

export async function makeClient(): Promise<JobWorkerClient> {
  if (workerFactory) {
    const client = new JobWorkerClient(await workerFactory());
    client.markReady();
    return client;
  }
  const worker = new Worker(new URL('../../engine/mupdf/jobWorker.ts', import.meta.url), { type: 'module' });
  const client = new JobWorkerClient(worker as unknown as WorkerLike);
  try {
    await client.init(await compileMuPdf());
  } catch (error) {
    client.terminate();
    throw error;
  }
  return client;
}

export function bridge(): JobBridge | null {
  const api = getDesktopBridge();
  return api ? { ...api.jobs, stat: (path) => api.files.stat(path) } : null;
}

// ---- The sheet ------------------------------------------------------------------------------------------------------------------

/** The job worker of the open sheet: it holds the probed saved file. Ended when the sheet closes or the run ends. */
let client: JobWorkerClient | null = null;
/** The stamp of the file the worker holds. A different stamp at Split means the file changed: it is read again. */
let probedStamp: { size: number; modified: number } | null = null;
let unsubscribeDirty: (() => void) | null = null;
let checkSeq = 0;

function endWorker(): void {
  client?.terminate();
  client = null;
  probedStamp = null;
}

function initialSheet(target: Extract<SplitTarget, { kind: 'ok' | 'unsaved' }>): SplitSheet {
  return {
    docId: target.docId,
    path: target.path,
    name: target.name,
    stage: target.kind === 'unsaved' ? 'unsaved' : 'checking',
    refusal: null,
    pages: useDocumentsStore.getState().docs[target.docId]?.pageCount ?? 0,
    byteLength: 0,
    facts: null,
    method: 'count',
    perFileText: '10',
    sizeText: '10',
    sizeUnit: 'MB',
    sensitivity: 'normal',
    measures: null,
    looking: null,
    unticked: [],
    blankKeep: 'drop',
    entries: null,
    folder: null,
    baseName: defaultBaseName(target.name),
    keepPassword: true,
    passwordNote: null,
    hidden: false,
  };
}

/** Opens the sheet on the focused document. Does nothing while a job runs or when the document cannot be split. */
export function openSplitSheet(docId: string | undefined): boolean {
  if (!splitAvailability(docId).enabled) return false;
  const target = resolveSplitTarget(docId);
  if (target.kind === 'none') return false;
  closeSplitSheet();
  useSplitStore.getState().open(initialSheet(target));
  watchDirty(target.docId);
  if (target.kind === 'ok') void checkSource();
  return true;
}

/** Closes the sheet and ends its worker. A running job is not touched: it keeps going without the sheet. */
export function closeSplitSheet(): void {
  unsubscribeDirty?.();
  unsubscribeDirty = null;
  checkSeq += 1;
  if (!jobIsRunning()) endWorker();
  useSplitStore.getState().close();
}

/** The sheet follows the document: edits make it ask to save first, and a save or a Save As makes it read the file again. */
function watchDirty(docId: string): void {
  unsubscribeDirty = useEditStore.subscribe((state, previous) => {
    const was = previous.byDoc[docId]?.history.dirty === true;
    const now = state.byDoc[docId]?.history.dirty === true;
    if (was === now) return;
    const sheet = useSplitStore.getState().sheet;
    if (!sheet || sheet.docId !== docId || sheet.hidden) return;
    if (now) {
      checkSeq += 1;
      endWorker();
      useSplitStore.getState().update({ stage: 'unsaved', measures: null, entries: null, looking: null });
    } else {
      useSplitStore.getState().update({ stage: 'checking' });
      void checkSource();
    }
  });
}

/** "Save and continue": saves the document, then reads the saved file. A save that does not finish leaves the sheet as it is. */
export async function saveAndContinue(): Promise<void> {
  const sheet = useSplitStore.getState().sheet;
  if (!sheet) return;
  const result = await saveWithFeedback(sheet.docId);
  if (result !== 'saved') return;
  const target = resolveSplitTarget(sheet.docId);
  if (target.kind !== 'ok') return;
  useSplitStore.getState().update({ path: target.path, name: target.name, stage: 'checking' });
  await checkSource();
}

/** Reads the saved file into a fresh job worker and learns what it is (pages, password, forms, layers, attachments). */
export async function checkSource(): Promise<void> {
  const seq = ++checkSeq;
  const api = bridge();
  const sheet = useSplitStore.getState().sheet;
  if (!api || !sheet) return;
  const stale = () => seq !== checkSeq || useSplitStore.getState().sheet?.docId !== sheet.docId;
  const refuse = (refusal: NonNullable<SplitSheet['refusal']>) => {
    if (stale()) return;
    endWorker();
    useSplitStore.getState().update({ stage: 'refused', refusal });
  };
  endWorker();
  const target = resolveSplitTarget(sheet.docId);
  if (target.kind !== 'ok') {
    if (!stale()) useSplitStore.getState().update({ stage: target.kind === 'unsaved' ? 'unsaved' : 'refused', refusal: target.kind === 'unsaved' ? null : 'Unreadable' });
    return;
  }
  const read = await api.readInput(target.path);
  if (stale()) return;
  if (!read.ok) return refuse('Unreadable');
  if (read.size > MAX_TOTAL_INPUT_BYTES) return refuse('TotalTooLarge');
  let worker: JobWorkerClient;
  try {
    worker = await makeClient();
  } catch {
    return refuse('Unreadable');
  }
  if (stale()) {
    worker.terminate();
    return;
  }
  client = worker;
  let password = sessionPasswordOf(sheet.docId);
  let bytes = read.bytes;
  for (;;) {
    try {
      const facts = await worker.probe(bytes, password);
      if (stale()) return;
      probedStamp = { size: read.size, modified: read.modified };
      if (facts.xfa) return refuse('Xfa');
      if (!facts.formValuesKept) return refuse('FormValuesLost');
      useSplitStore.getState().update({
        stage: 'ready',
        refusal: null,
        path: target.path,
        name: target.name,
        pages: facts.pages,
        byteLength: facts.byteLength,
        facts: { encrypted: facts.encrypted, fields: facts.fields, layers: facts.layers, attachments: facts.attachments },
        keepPassword: facts.encrypted,
      });
      return;
    } catch (error) {
      if (stale()) return;
      const kind = error instanceof JobError ? error.kind : 'Internal';
      if (kind === 'PasswordNeeded' || kind === 'WrongPassword') {
        // The app no longer holds the password (or it is wrong): the existing prompt asks. The bytes went to the worker, so the file is read again.
        const answer = await askSourcePassword(target.name, kind === 'WrongPassword' ? ERROR_MESSAGES.WrongPassword : null);
        if (stale()) return;
        if (answer === null) return refuse('PasswordNeeded');
        password = answer;
        const again = await api.readInput(target.path);
        if (!again.ok) return refuse('Unreadable');
        bytes = again.bytes;
        continue;
      }
      if (kind === 'Damaged') return refuse('Damaged');
      if (kind === 'TotalTooLarge') return refuse('TotalTooLarge');
      return refuse('Unreadable');
    }
  }
}

/** The settings of the open sheet as the model wants them. */
export function settingsOf(sheet: SplitSheet): SplitSettings {
  return {
    method: sheet.method,
    pages: sheet.pages,
    byteLength: sheet.byteLength,
    perFileText: sheet.perFileText,
    sizeText: sheet.sizeText,
    sizeUnit: sheet.sizeUnit,
    sensitivity: sheet.sensitivity,
    measures: sheet.measures,
    unticked: sheet.unticked,
    blankKeep: sheet.blankKeep,
    entries: sheet.entries,
    baseName: sheet.baseName,
    hasFolder: sheet.folder !== null,
    encrypted: sheet.facts?.encrypted === true,
    keepPassword: sheet.keepPassword,
  };
}

/** Choosing a method starts the work it needs: the blank-page search, or reading the bookmarks. */
export async function chooseMethod(method: SplitSheet['method']): Promise<void> {
  const store = useSplitStore.getState();
  const sheet = store.sheet;
  if (!sheet || sheet.stage !== 'ready' || !client) return;
  store.update({ method });
  if (method === 'blank' && sheet.measures === null && sheet.looking === null) {
    const worker = client;
    const seq = checkSeq;
    store.update({ looking: { done: 0, total: sheet.pages } });
    const search = worker.analyse('blank', (done, total) => {
      if (seq === checkSeq) useSplitStore.getState().update({ looking: { done, total } });
    });
    stopLooking = search.cancel;
    try {
      const result = await search.promise;
      if (seq !== checkSeq) return;
      if (result.what === 'blank') useSplitStore.getState().update({ measures: result.ink.map((ink, i) => ({ ink, mark: result.mark[i] ?? 0 })), looking: null, unticked: [] });
    } catch {
      // Stopped (or the worker ended): back to the first method, nothing was found.
      if (seq === checkSeq) useSplitStore.getState().update({ looking: null, method: 'count' });
    } finally {
      stopLooking = null;
    }
  }
  if (method === 'bookmarks' && sheet.entries === null) {
    const seq = checkSeq;
    try {
      const result = await client.analyse('outline').promise;
      if (seq === checkSeq && result.what === 'outline') useSplitStore.getState().update({ entries: result.entries });
    } catch {
      if (seq === checkSeq) useSplitStore.getState().update({ entries: [] });
    }
  }
}

let stopLooking: (() => void) | null = null;
/** The Stop button of the blank-page search. */
export function stopBlankSearch(): void {
  stopLooking?.();
}

/** The folder dialog. It opens at the document's folder, or the one used last. The page keeps only the token and the label. */
export async function chooseFolder(): Promise<void> {
  const api = bridge();
  const sheet = useSplitStore.getState().sheet;
  if (!api || !sheet) return;
  const picked = await api.pickFolder(sheet.path);
  if (picked) useSplitStore.getState().update({ folder: picked });
}

// ---- Running -----------------------------------------------------------------------------------------------------------------------

/** Cancel in the status bar. */
export function cancelJob(): void {
  const { cancel } = useJobStore.getState();
  if (!cancel) return;
  useJobStore.getState().setCancelling();
  cancel();
}

/**
 * Starts the split of the open sheet. The sheet hides (its settings stay), the job shows in the status bar, and the result is a
 * notice that stays until closed. Closing the source tab does not stop it.
 */
export async function startSplit(): Promise<void> {
  const sheet = useSplitStore.getState().sheet;
  const api = getDesktopBridge();
  if (!sheet || !api || sheet.stage !== 'ready' || !client || jobIsRunning()) return;
  const model = deriveSheet(settingsOf(sheet));
  if (!model.spec || !sheet.folder) return;

  // The sheet works on the saved file. If that file changed since it was read (a save, another program), it is read again first.
  const now = await api.files.stat(sheet.path);
  if (!now || !probedStamp || now.size !== probedStamp.size || now.modified !== probedStamp.modified) {
    useSplitStore.getState().update({ stage: 'checking' });
    await checkSource();
    return;
  }
  const worker = client;
  const folder = sheet.folder;
  const source = { path: sheet.path, size: probedStamp.size, modified: probedStamp.modified };
  // The password was given to the worker with the file (probe) and stays there; it is not sent again.
  useSplitStore.getState().update({ hidden: true, passwordNote: null });
  let cancel: () => void = () => undefined;
  useJobStore.getState().start('split', () => cancel());
  const outcome = await runSplit({
    worker,
    bridge: { ...api.jobs, stat: (path) => api.files.stat(path) },
    folderToken: folder.token,
    source,
    spec: model.spec,
    isCancelled: () => useJobStore.getState().job?.cancelling === true,
    onProgress: (phase, done, total, unit) => useJobStore.getState().progress(phase, done, total, unit),
    onStart: (fn) => {
      cancel = fn;
    },
  });
  useJobStore.getState().finish();
  const fileNameOf = (n: number) => (outcome.status === 'done' ? outcome.files[n - 1]?.name : undefined);

  if (outcome.status === 'done') {
    endWorker();
    closeSplitSheet();
    const oversize = outcome.notes.map((note) => ({ page: note.page, limitBytes: note.limitBytes, leafName: fileNameOf(note.file) ?? '' }));
    useJobStore.getState().setNotice({ message: splitDoneMessage(sheet.name, outcome.files.length, oversize), failed: false, resultIds: outcome.files.map((f) => f.resultId) });
    return;
  }
  if (outcome.status === 'cancelled') {
    endWorker();
    closeSplitSheet();
    useJobStore.getState().setNotice({ message: jobErrorMessage('Cancelled'), failed: true, resultIds: [] });
    return;
  }
  const error = outcome.error;
  if (error.kind === 'CannotKeepPassword') {
    // Nothing was made. The sheet comes back with its settings, and the note shows under the box.
    useSplitStore.getState().update({ hidden: false, passwordNote: CANNOT_KEEP_PASSWORD_MESSAGE });
    return;
  }
  endWorker();
  closeSplitSheet();
  let message: string;
  if (error.kind === 'Stopped') message = STOPPED_RESPONDING_MESSAGE;
  else if (error.kind === 'MainFailure') message = mainFailureMessage(error.info.reason ?? 'invalid', error.info.drive);
  else if (error.kind === 'CheckFailed' || error.kind === 'Internal' || error.kind === 'InputChanged' || error.kind === 'Cancelled') message = jobErrorMessage(error.kind, sheet.name);
  else message = jobErrorMessage(error.kind, sheet.name, 'split') || INTERNAL_MESSAGE;
  useJobStore.getState().setNotice({ message, failed: true, resultIds: [] });
}

/** Show in folder, from the result notice. */
export async function revealResult(resultId: string): Promise<void> {
  await getDesktopBridge()?.jobs.reveal(resultId);
}

/** Quit while a job runs: the close prompt asks, and Stop and exit cancels the job. Resolves true when the job has ended. */
export async function stopJobForQuit(): Promise<void> {
  cancelJob();
  for (let i = 0; i < 40 && jobIsRunning(); i++) await new Promise((r) => setTimeout(r, 100));
}
