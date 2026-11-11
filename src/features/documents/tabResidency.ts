import { create } from 'zustand';
import type { FileStamp } from '../recovery/editLog';
import { documentRegistry } from '../../app/services';
import { useCompareStore } from '../../core/stores/compareStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useJobStore } from '../../core/stores/jobStore';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useSplitStore } from '../../core/stores/splitStore';
import { selectActiveTab, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useUiStore } from '../../core/stores/uiStore';
import type { Tab } from '../../core/model/types';
import type { DocInfo } from '../../core/stores/documentsStore';
import type { DocHandle } from '../../engine/documentRegistry';
import { ERROR_MESSAGES, isPdfOpenError, PdfOpenError } from '../../engine/errors';
import { releaseBitmapsOf } from '../../engine/bitmapCache';
import { diag } from '../../engine/diag';
import { renderScheduler } from '../../engine/renderScheduler';
import type { DocumentSource } from '../../engine/types';
import { useSearchStore } from '../search/searchStore';
import { hasEditLog, isEditBusy } from './editOps';
import { currentOrder, remapAfterReplace } from './replacedDocument';
import { BACKGROUND_IDLE_MS, residencyFor, type Residency, type ResidencyFacts } from './residencyRule';
import { currentIdOf, fileStampOf, recordFileStamp, savePathOf, seenStampOf, statFile, watchDocumentFile } from './saveDocument';
import { changedSinceSeen } from './saveCheck';
import { sessionPasswordOf } from './sessionPasswords';
import { remeasurePages } from './pageSync';
import { residencyHooks } from './residencyHooks';
import { watchUnresponsive } from './unresponsive';

/**
 * Background tabs release memory (1.5.4). See residencyRule.ts for the rule.
 *
 * A document that ended its engine ("released") keeps its tab, its panes with their page, zoom and fit, its page list and
 * sizes, and its place in the registry (so the main process still counts the file as open: its write right and its place in the
 * last-session record stay). The next time a pane of the active tab shows it, it is opened again from the saved file under the
 * same id, and the pane draws as before. If the file changed on disk meanwhile, the document is opened from the file as it is
 * now and the existing "This file changed on disk" bar is shown: the new file is never taken over silently.
 */

export type ResidencyState = 'released' | 'waking';

interface ResidencyStore {
  /** Documents that have no engine now, or are being reopened. Drawn as "Reopening" by the workspace body. */
  state: Record<string, ResidencyState>;
  set: (docId: string, state: ResidencyState | null) => void;
}

export const useResidencyStore = create<ResidencyStore>()((set) => ({
  state: {},
  set: (docId, state) =>
    set((s) => {
      if (state === null) {
        if (!(docId in s.state)) return s;
        const { [docId]: _gone, ...rest } = s.state;
        return { state: rest };
      }
      return s.state[docId] === state ? s : { state: { ...s.state, [docId]: state } };
    }),
}));

/** How often the sweep looks at the background documents. */
export const SWEEP_INTERVAL_MS = 10_000;

let idleMs = BACKGROUND_IDLE_MS;
/** When each document was last shown in a pane. */
const lastShown = new Map<string, number>();
/** What each released document's page order was, so a reopen from a changed file can follow its pages by position. */
const orderAtRelease = new Map<string, string[]>();
/** The reopens that run now. */
const waking = new Map<string, Promise<void>>();
/** The organizer selection of each released document (a reopen clears it with the rest of the document's state). */
const selectedAtRelease = new Map<string, string[]>();
let sweeping = false;
/** The latest reopen, for the end-to-end runs. */
let lastResume: { docId: string; ms: number; changed: boolean } | null = null;

/** The documents shown in a pane of the active tab (both panes of a split). */
export function visibleDocIds(): Set<string> {
  const tab = selectActiveTab(useWorkspaceStore.getState());
  return new Set(tab?.panes.map((p) => p.docId) ?? []);
}

/** Every document that has a pane in some tab. */
function openDocIds(): Set<string> {
  const ids = new Set<string>();
  for (const tab of useWorkspaceStore.getState().tabs) for (const pane of tab.panes) ids.add(pane.docId);
  return ids;
}

/** The documents that were shown at the last look. A document that has just been hidden was shown until now, not until the look before. */
let previouslyVisible = new Set<string>();

function markVisible(now: number): void {
  for (const docId of previouslyVisible) lastShown.set(docId, now);
  previouslyVisible = visibleDocIds();
  for (const docId of previouslyVisible) lastShown.set(docId, now);
}

/** True when an edit, save, restore, search, job, long operation, Compare or side sheet is working on the document. */
export function hasRunningOperation(docId: string): boolean {
  const edit = useEditStore.getState();
  if (edit.saving[docId] || edit.progress[docId] !== undefined || isEditBusy(docId)) return true;
  if (useJobStore.getState().job !== null) return true;
  const search = useSearchStore.getState();
  if (search.docId === docId && search.running) return true;
  if (useCompareStore.getState().session?.docId === docId) return true;
  if (useSheetStore.getState().sheet?.docId === docId) return true;
  if (useSplitStore.getState().sheet?.docId === docId) return true;
  return false;
}

/** True when the engine holds state that the file does not: unsaved edits, undo or redo steps, or an edit journal. */
export function hasUnsavedState(docId: string): boolean {
  const history = useEditStore.getState().byDoc[docId]?.history;
  return history?.dirty === true || history?.canUndo === true || history?.canRedo === true || hasEditLog(docId);
}

/** True when the document can be opened again exactly as it is (see ResidencyFacts.reopenable). */
export function isReopenable(docId: string): boolean {
  if (!docId.startsWith('path:') || savePathOf(docId) === null) return false;
  const handle = documentRegistry.get(docId);
  if (!handle) return false;
  if (handle.doc.isEncrypted && sessionPasswordOf(docId) === undefined) return false;
  const info = useDocumentsStore.getState().docs[docId];
  if (!info || info.sizes.length === 0 || info.sizes.some((size) => size === undefined)) return false;
  // A reopened document names its pages 0, 1, 2 ... in file order, and the panes' pages are named that way: only a document
  // whose page list is exactly that can come back as it is.
  const uids = useEditStore.getState().byDoc[docId]?.uids;
  if (uids && (uids.length !== info.pageCount || uids.some((uid, i) => uid !== String(i)))) return false;
  const edit = useEditStore.getState();
  return (
    edit.changedOnDisk[docId] !== true &&
    edit.recovered[docId] === undefined &&
    edit.notRestored[docId] === undefined &&
    edit.recoveryNotice[docId] === undefined &&
    edit.unresponsive[docId] !== true
  );
}

export function factsFor(docId: string, now: number, visible: ReadonlySet<string> = visibleDocIds()): ResidencyFacts {
  return {
    visible: visible.has(docId),
    idleMs: now - (lastShown.get(docId) ?? now),
    runningOperation: hasRunningOperation(docId),
    unsavedEdits: hasUnsavedState(docId),
    reopenable: isReopenable(docId),
  };
}

/** What the rule says for a document now. */
export function residencyOf(docId: string, now: number = Date.now()): Residency {
  return residencyFor(factsFor(docId, now), idleMs);
}

function releaseBitmaps(docId: string): void {
  renderScheduler.cancelWhere((key) => key.startsWith(`${docId}|`));
  releaseBitmapsOf(docId);
}

/** Longest the file stat of a sweep may take. A stat that does not answer keeps the worker and must not hold the sweep. */
export const STAT_TIMEOUT_MS = 10_000;
/** Longest a reopen may take before the tab shows its plain error (the same limit as opening a file, OPEN_TIMEOUT_MS). */
export const REOPEN_TIMEOUT_MS = 60_000;

/** Rejects with `error()` when `work` has not settled after `ms`. The work itself is not stopped. */
function withTimeout<T>(work: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (failure: unknown) => {
        clearTimeout(timer);
        reject(failure);
      },
    );
  });
}

/**
 * Ends the engine of a document that nobody shows. Checked again right before, after the file is looked at. The worker is kept
 * unless the app holds a stamp of the file, that stamp is the one the file had when it was opened or saved (not one that "Keep my
 * version" accepted: then the user's version is only in the engine), and the file on disk still matches it, content sample
 * included. A file that is gone is never let go: the engine may hold the only copy.
 */
async function releaseWorker(docId: string, now: number): Promise<boolean> {
  const path = savePathOf(docId);
  if (!path) return false;
  const seen = fileStampOf(path);
  if (!seen || seenStampOf(path) !== seen) return false;
  const onDisk = await withTimeout(statFile(path), STAT_TIMEOUT_MS, () => new Error('The file did not answer.')).catch(() => null);
  if (onDisk === null || changedSinceSeen(seen, onDisk)) return false;
  if (residencyOf(docId, now) !== 'worker') return false;
  const order = currentOrder(docId);
  if (!documentRegistry.suspend(docId)) return false;
  orderAtRelease.set(docId, order);
  selectedAtRelease.set(docId, [...(useEditStore.getState().selected[docId] ?? [])]);
  useResidencyStore.getState().set(docId, 'released');
  diag('residency.released', { docId });
  return true;
}

/** One look at every document that has a pane. Documents that are not shown give back what the rule allows. */
export async function sweepBackground(now: number = Date.now()): Promise<{ bitmaps: string[]; workers: string[] }> {
  const done = { bitmaps: [] as string[], workers: [] as string[] };
  if (sweeping) return done;
  sweeping = true;
  try {
    markVisible(now);
    const visible = visibleDocIds();
    for (const docId of openDocIds()) {
      if (useResidencyStore.getState().state[docId] !== undefined) continue;
      if (!lastShown.has(docId)) lastShown.set(docId, now);
      const decision = residencyFor(factsFor(docId, now, visible), idleMs);
      if (decision === 'keep') continue;
      releaseBitmaps(docId);
      done.bitmaps.push(docId);
      if (decision === 'worker' && (await releaseWorker(docId, now))) done.workers.push(docId);
    }
  } finally {
    sweeping = false;
  }
  return done;
}

const hasPage = (docId: string, pageId: string | null): boolean =>
  pageId !== null && (useDocumentsStore.getState().docs[docId]?.pages.some((p) => p.id === pageId) ?? false);

/** The views of the panes that show `docId`, moved onto the first page when the page they were on is not in the file any more. */
function clampViews(docId: string): void {
  const first = useDocumentsStore.getState().docs[docId]?.pages[0]?.id ?? null;
  useWorkspaceStore.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.panes.some((pane) => pane.docId === docId && !hasPage(docId, pane.view.pageId))
        ? {
            ...tab,
            panes: tab.panes.map((pane) =>
              pane.docId === docId && !hasPage(docId, pane.view.pageId) ? { ...pane, view: { ...pane.view, pageId: first, offset: 0 } } : pane,
            ),
          }
        : tab,
    ),
  }));
}

/** The documents whose reopen failed for the tab that is active now. They are tried again when another tab has been shown. */
const failedWake = new Set<string>();

export const CHANGED_NOTICE = 'This file changed while the tab was in the background, so it was reopened as it is now.';

/** The tabs that show `docId` get this status (only those on `only`, when it is given). */
function setTabsStatus(docId: string, status: Tab['status'], only?: Tab['status']['kind']): void {
  const workspace = useWorkspaceStore.getState();
  for (const tab of workspace.tabs) {
    if (!tab.panes.some((p) => p.docId === docId)) continue;
    if (only !== undefined && tab.status.kind !== only) continue;
    workspace.patchTab(tab.id, { status });
  }
}

/** What follows the engine's arrival: the watch, the stamp, and, for a file that is not the one that was closed, its pages. */
function finishReopen(docId: string, path: string, handle: DocHandle, info: DocInfo, before: FileStamp | null, changed: boolean, started: number): void {
  watchUnresponsive(docId, handle.doc, currentIdOf);
  if (changed) {
    // There is no other version to keep: the document is the file as it is now. Its stamp is the base of the recovery log and
    // of the disk watch, as for a file opened for the first time.
    recordFileStamp(path, before);
  }
  watchDocumentFile(docId, path);
  if (changed || handle.pageCount !== info.pageCount) {
    // The panes keep their place as far as the file still has it; its pages and sizes are read again.
    const orderBefore = orderAtRelease.get(docId) ?? [];
    remapAfterReplace(docId, orderBefore, false);
    remeasurePages(docId, handle.doc, () => documentRegistry.get(docId)?.doc === handle.doc);
    clampViews(docId);
    residencyHooks.changed(docId);
  }
  if (changed) useUiStore.getState().pushToast(CHANGED_NOTICE, undefined, { sticky: true });
  orderAtRelease.delete(docId);
  const selected = selectedAtRelease.get(docId);
  selectedAtRelease.delete(docId);
  if (selected && selected.length > 0 && !changed) useEditStore.getState().select(docId, selected);
  failedWake.delete(docId);
  // A tab that an earlier failed reopen left on its error shows the document again.
  setTabsStatus(docId, { kind: 'ready' }, 'error');
  const ms = Math.round(performance.now() - started);
  diag('residency.reopened', { docId, ms, changed });
  lastResume = { docId, ms, changed };
}

async function reopen(docId: string): Promise<void> {
  const path = savePathOf(docId);
  const store = useResidencyStore.getState();
  const info = useDocumentsStore.getState().docs[docId];
  if (!path || !info) {
    store.set(docId, null);
    return;
  }
  store.set(docId, 'waking');
  const started = performance.now();
  let timedOut = false;
  try {
    // The file's stamp is taken BEFORE it is read and compared with the one the app saw (size, time and content sample).
    const before = await statFile(path);
    const changed = changedSinceSeen(seenStampOf(path), before);
    const source: DocumentSource = { kind: 'path', path, name: info.name };
    const resuming = documentRegistry.resume(docId, source, { password: sessionPasswordOf(docId) });
    let handle: DocHandle;
    try {
      handle = await withTimeout(resuming, REOPEN_TIMEOUT_MS, () => {
        timedOut = true;
        return new PdfOpenError('Unreadable');
      });
    } catch (error) {
      // The engine may still arrive after the time was up: the document is then put right, and the tab shows it again.
      if (timedOut) void resuming.then((late) => finishReopen(docId, path, late, info, before, changed, started)).catch(() => undefined);
      throw error;
    }
    finishReopen(docId, path, handle, info, before, changed, started);
    store.set(docId, null);
  } catch (error) {
    store.set(docId, null);
    failedWake.add(docId);
    // The file cannot be read now (moved, deleted, locked, too slow): the tab says so where the pages were, in the words the app
    // uses when it opens a file that is gone ("This file was moved or deleted.").
    const message = isPdfOpenError(error) ? ERROR_MESSAGES[error.kind] : 'This file could not be opened.';
    setTabsStatus(docId, { kind: 'error', message });
    throw error;
  }
}

/** A document got an engine from somewhere else (the same file opened again) or closed: it is not "released" any more. */
function forget(docId: string): void {
  orderAtRelease.delete(docId);
  selectedAtRelease.delete(docId);
  useResidencyStore.getState().set(docId, null);
}

residencyHooks.opened = (docId) => {
  // The reopen this module runs itself finishes its own bookkeeping (the engine arrives before the panes are put right).
  if (useResidencyStore.getState().state[docId] === 'waking') return;
  forget(docId);
};
residencyHooks.closed = forget;

/** Opens a released document again. Several callers at once share one reopen. Rejects when the file cannot be opened. */
export function wakeDocument(docId: string): Promise<void> {
  const running = waking.get(docId);
  if (running) return running;
  if (!documentRegistry.isSuspended(docId)) return Promise.resolve();
  failedWake.delete(docId);
  const work = reopen(docId).finally(() => waking.delete(docId));
  waking.set(docId, work);
  return work;
}

/** Reopens every released document that a pane of the active tab shows. */
function wakeVisible(): void {
  for (const docId of visibleDocIds()) {
    if (documentRegistry.isSuspended(docId) && !failedWake.has(docId)) wakeDocument(docId).catch(() => undefined);
  }
}

/**
 * Starts the sweep and the reopen. Called once at start-up. The sweep looks every SWEEP_INTERVAL_MS; a document shown in the
 * active tab is reopened as soon as it is shown. Returns the function that stops both.
 */
export function startTabResidency(): () => void {
  markVisible(Date.now());
  let activeTab = useWorkspaceStore.getState().activeTabId;
  const unsubscribe = useWorkspaceStore.subscribe((state) => {
    // A reopen that failed is tried again once another tab has been shown, not on every change of the workspace.
    if (state.activeTabId !== activeTab) {
      activeTab = state.activeTabId;
      failedWake.clear();
    }
    markVisible(Date.now());
    wakeVisible();
  });
  const timer = setInterval(() => void sweepBackground(), SWEEP_INTERVAL_MS);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}

/** Test hooks: forget everything, or change the idle time. */
export function resetResidency(): void {
  lastShown.clear();
  previouslyVisible = new Set();
  orderAtRelease.clear();
  selectedAtRelease.clear();
  waking.clear();
  failedWake.clear();
  sweeping = false;
  lastResume = null;
  idleMs = BACKGROUND_IDLE_MS;
  useResidencyStore.setState({ state: {} });
}

export function setBackgroundIdleMs(ms: number): void {
  idleMs = ms;
}

/**
 * Test hook for the end-to-end runs (like __pdfSuiteEngine): which documents are released, and a sweep on demand. The idle time
 * can be shortened so a test does not wait a minute; the app never changes it.
 */
if (typeof window !== 'undefined' && window.__pdfSuiteTestMode === true) {
  (window as unknown as { __pdfSuiteResidency?: unknown }).__pdfSuiteResidency = {
    released: () => Object.keys(useResidencyStore.getState().state),
    setIdleMs: (ms: number) => setBackgroundIdleMs(ms),
    sweep: () => sweepBackground(),
    lastResume: () => lastResume,
    fileStamp: (path: string) => fileStampOf(path) ?? null,
  };
}
