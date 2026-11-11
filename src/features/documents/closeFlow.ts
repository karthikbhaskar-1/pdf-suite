import { plainMessage } from '../../engine/errors';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { jobIsRunning, useJobStore } from '../../core/stores/jobStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import type { CloseDecision } from '../../platform/desktop/contract';
import { dropEditLog, recoveryKeysOf } from './editOps';
import { extractPages, saveDocument, type ExtractOptions, type SaveOptions } from './saveDocument';
import { documentRegistry } from '../../app/services';
import { closeTab } from './documentService';

/**
 * Closing with unsaved changes: a tab, all tabs, or the window (close or quit). When a document that would be lost has
 * unsaved changes, the prompt (Save / Don't save / Cancel) asks first, and its choice is the answer.
 */

/** What the prompt's choice comes to: the decision, and the recovery keys the main process may clear with it. */
interface CloseAnswer {
  decision: CloseDecision;
  /** Recovery keys of the documents the user chose not to save, sent with a window-close answer (see answerClosePrompt). */
  clearKeys: string[];
}

/**
 * The documents the open prompt is about, and the answer it is waiting to give. `fromWindow` is true when the main process
 * asked (the window is closing or the app is quitting) and false when the page itself is closing a tab.
 */
let pending: { docIds: string[]; fromWindow: boolean; resolve: (answer: CloseAnswer) => void } | null = null;

/** Documents with edits that are not saved. */
export function dirtyDocIds(): string[] {
  return Object.entries(useEditStore.getState().byDoc)
    .filter(([, pages]) => pages.history.dirty)
    .map(([docId]) => docId);
}

/** The documents the open prompt is about (empty when it is closed). */
export function promptDocIds(): string[] {
  return pending?.docIds ?? [];
}

/** The name of a document, for the prompt and messages. */
export function nameOfDoc(docId: string): string {
  return useDocumentsStore.getState().docs[docId]?.name ?? 'this file';
}

function askPrompt(docIds: string[], fromWindow: boolean): Promise<CloseAnswer> {
  const dirty = docIds.filter((id) => dirtyDocIds().includes(id));
  if (dirty.length === 0) return Promise.resolve({ decision: 'close', clearKeys: [] });
  if (pending) return Promise.resolve({ decision: 'cancel', clearKeys: [] });
  return new Promise((resolve) => {
    pending = { docIds: dirty, fromWindow, resolve };
    useUiStore.getState().setClosePrompt(true);
  });
}

/**
 * Closing a tab (or all tabs) from the page. Resolves 'close' at once when none of the documents has unsaved changes.
 * Otherwise opens the prompt for them and resolves with its choice ('close' after a save or a discard, 'cancel' otherwise).
 * A discard removes the recovery logs here, because the page itself closes the tabs.
 */
export async function askClosePrompt(docIds: string[]): Promise<CloseDecision> {
  return (await askPrompt(docIds, false)).decision;
}

/**
 * The main process ended the close request the prompt was answering (it was cancelled: the page was unresponsive or
 * reloaded). The prompt comes down and nothing is decided. A request from the page's own tab close is not affected.
 */
function windowRequestEnded(): void {
  const current = pending;
  if (!current?.fromWindow) return;
  pending = null;
  useUiStore.getState().setClosePrompt(false);
  current.resolve({ decision: 'cancel', clearKeys: [] });
}

/** The answer the quit-while-a-job-runs prompt is waiting to give. */
let jobQuit: ((decision: CloseDecision) => void) | null = null;

/** "PDF Suite is still working on your files. Stop and exit?" Resolves 'close' once the job has stopped, or 'cancel'. */
function askStopAndQuit(): Promise<CloseDecision> {
  if (jobQuit) return Promise.resolve('cancel');
  return new Promise((resolve) => {
    jobQuit = resolve;
    useUiStore.getState().setJobQuitPrompt(true);
  });
}

/** The job prompt's choice. Stop and exit cancels the job and waits (at most 4 s) for it to end; its files are removed. */
export async function answerJobQuitPrompt(stop: boolean): Promise<void> {
  const resolve = jobQuit;
  jobQuit = null;
  useUiStore.getState().setJobQuitPrompt(false);
  if (!resolve) return;
  if (!stop) {
    resolve('cancel');
    return;
  }
  useJobStore.getState().setCancelling();
  useJobStore.getState().cancel?.();
  for (let i = 0; i < 40 && jobIsRunning(); i++) await new Promise((r) => setTimeout(r, 100));
  resolve('close');
}

/**
 * Closing the window or quitting. A running job asks first ("Stop and exit?"); then every document with unsaved changes is
 * asked about. A discard does NOT remove the logs here: it hands their keys back with the answer, and the main process
 * removes them only if the close request is still waiting. A request that ended meanwhile (the page was unresponsive, the
 * window reloaded) must leave the logs alone, or a window that stays open would lose its recovery copy of edits the user
 * still has.
 */
export async function requestCloseDecision(): Promise<CloseAnswer> {
  if (jobIsRunning()) {
    const answer = await askStopAndQuit();
    if (answer === 'cancel') return { decision: 'cancel', clearKeys: [] };
  }
  return askPrompt(dirtyDocIds(), true);
}

/**
 * Shown when a save finds the file changed by another program. It names the file and says what each button of the bar does:
 * Reload throws the user's unsaved changes away, so it must not be what the message points to.
 */
export function changedOnDiskMessage(name: string): string {
  return `Another program changed ${name}, so nothing was saved. Keep my version saves your changes over it; Reload discards your changes.`;
}

/**
 * Saves a document and tells the user the result: a toast for a saved file, the encryption bar when the save needs a
 * choice. Resolves with the outcome.
 */
export async function saveWithFeedback(docId: string, options: SaveOptions = {}): Promise<'saved' | 'cancelled' | 'failed'> {
  try {
    const outcome = await saveDocument(docId, options);
    if (outcome.status === 'saved') {
      const name = outcome.path.split(/[\\/]/).pop() ?? outcome.path;
      useUiStore.getState().pushToast(`Saved ${name}`);
      if (useUiStore.getState().encryptionChoice === docId) useUiStore.getState().setEncryptionChoice(null);
      if (useUiStore.getState().largeSave?.docId === docId) useUiStore.getState().setLargeSave(null);
      return 'saved';
    }
    if (outcome.status === 'needs-encryption-choice') {
      useUiStore.getState().setEncryptionChoice(docId, { target: outcome.target });
      return 'failed';
    }
    if (outcome.status === 'changed-on-disk') {
      useUiStore.getState().pushToast(changedOnDiskMessage(nameOfDoc(docId)));
    }
    if (outcome.status === 'may-be-too-large') {
      // Nothing was done: the bar asks "Save anyway?" and Cancel keeps Undo.
      const { saveAs, targetPath, dropEncryption } = options;
      useUiStore.getState().setLargeSave({ docId, options: { ...(saveAs ? { saveAs } : {}), ...(targetPath ? { targetPath } : {}), ...(dropEncryption ? { dropEncryption } : {}) } });
    }
    return 'cancelled';
  } catch (error) {
    const message = plainMessage(error, 'The file could not be saved.');
    if (message) useUiStore.getState().pushToast(message);
    return 'failed';
  }
}

/**
 * Extracts pages and tells the user the result, like saveWithFeedback: a toast for a written file, the encryption bar
 * when the source is encrypted and the extract could not keep that. Resolves with the outcome.
 */
export async function extractWithFeedback(
  docId: string,
  uids: string[],
  name: string,
  options: ExtractOptions = {},
): Promise<'saved' | 'cancelled' | 'failed'> {
  try {
    const outcome = await extractPages(docId, uids, name, options);
    if (outcome.status === 'saved') {
      useUiStore.getState().pushToast(`Extracted ${uids.length} ${uids.length === 1 ? 'page' : 'pages'}`);
      if (useUiStore.getState().encryptionChoice === docId) useUiStore.getState().setEncryptionChoice(null);
      return 'saved';
    }
    if (outcome.status === 'needs-encryption-choice') {
      useUiStore.getState().setEncryptionChoice(docId, { target: outcome.target, extract: { uids, name } });
      return 'failed';
    }
    return 'cancelled';
  } catch (error) {
    const message = plainMessage(error, 'The pages could not be extracted.');
    if (message) useUiStore.getState().pushToast(message);
    return 'failed';
  }
}

/**
 * The prompt's choice. Save saves each document first (a cancelled Save dialog or a failed save keeps everything open).
 * Don't save removes the recovery logs, so the edits are not restored later.
 */
export async function answerClosePrompt(choice: 'save' | 'discard' | 'cancel'): Promise<void> {
  const current = pending;
  pending = null;
  useUiStore.getState().setClosePrompt(false);
  if (!current) return;
  if (choice === 'cancel') {
    current.resolve({ decision: 'cancel', clearKeys: [] });
    return;
  }
  if (choice === 'discard') {
    if (current.fromWindow) {
      current.resolve({ decision: 'close', clearKeys: await recoveryKeysOf(current.docIds) });
      return;
    }
    for (const docId of current.docIds) await dropEditLog(docId);
    current.resolve({ decision: 'close', clearKeys: [] });
    return;
  }
  for (const docId of current.docIds) {
    const result = await saveWithFeedback(docId);
    if (result !== 'saved') {
      current.resolve({ decision: 'cancel', clearKeys: [] });
      return;
    }
  }
  current.resolve({ decision: 'close', clearKeys: [] });
}

/** The documents of the given tabs that no other tab shows, so closing those tabs would lose them. */
function documentsOnlyIn(tabIds: readonly string[]): string[] {
  const tabs = useWorkspaceStore.getState().tabs;
  const closing = new Set(tabIds);
  const docIds = tabs.filter((t) => closing.has(t.id)).flatMap((t) => t.panes.map((pane) => pane.docId));
  return [...new Set(docIds)].filter((docId) => !tabs.some((other) => !closing.has(other.id) && other.panes.some((p) => p.docId === docId)));
}

/**
 * Closes the given tabs together. The documents that would be lost with unsaved changes are asked about once, all in one
 * prompt; Cancel (or a failed save) closes nothing. Resolves true when the tabs were closed.
 */
export async function closeTabsWithPrompt(tabIds: readonly string[]): Promise<boolean> {
  if (tabIds.length === 0) return true;
  const decision = await askClosePrompt(documentsOnlyIn(tabIds));
  if (decision !== 'close') return false;
  for (const tabId of tabIds) closeTab(tabId);
  return true;
}

/** Closes a tab. A document that would be lost with unsaved changes is asked about first. */
export async function closeTabWithPrompt(tabId: string): Promise<void> {
  await closeTabsWithPrompt([tabId]);
}

/**
 * Asks before one reference of a document is given up (a split pane going away). When it is the last one, the document
 * closes, so unsaved changes are asked about first. Resolves true when the reference may go (then call releaseDocumentRef,
 * after looking at the workspace again: the prompt can take a while), false when the user cancelled.
 */
export async function mayReleaseDocument(docId: string): Promise<boolean> {
  if (documentRegistry.refCount(docId) > 1) return true;
  return (await askClosePrompt([docId])) === 'close';
}

/** Closes every tab, asking about the unsaved documents first. */
export async function closeAllTabsWithPrompt(): Promise<void> {
  const tabs = useWorkspaceStore.getState().tabs.map((t) => t.id);
  const docIds = [...new Set(useWorkspaceStore.getState().tabs.flatMap((t) => t.panes.map((p) => p.docId)))];
  const decision = await askClosePrompt(docIds);
  if (decision !== 'close') return;
  for (const tabId of tabs) closeTab(tabId);
}

/** Listens for the main process's close requests and answers them. Returns the unsubscribe function. */
export function watchCloseRequests(): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) return () => undefined;
  const stopEnded = bridge.app.onCloseEnded(windowRequestEnded);
  // The answer names the request it is for, so one that arrives after the main process moved on is ignored there.
  const stop = bridge.app.onCloseRequested((requestId) => {
    void requestCloseDecision().then((answer) => bridge.app.decideClose(answer.decision, answer.clearKeys, requestId));
  });
  return () => {
    stop();
    stopEnded();
  };
}
