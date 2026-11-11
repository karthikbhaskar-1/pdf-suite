import { documentRegistry } from '../../app/services';
import { newId } from '../../core/ids';
import { createPageList, pageIdFor, pageListFromPages } from '../../core/model/pageList';
import type { Pane, Tab, TabOrigin, ViewState } from '../../core/model/types';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import type { DocHandle } from '../../engine/documentRegistry';
import { ERROR_MESSAGES, isPdfOpenError, PdfOpenError } from '../../engine/errors';
import { renderScheduler } from '../../engine/renderScheduler';
import { measureInBackground, type PageSize } from '../../engine/pageSizes';
import type { DocumentSource } from '../../engine/types';
import { MupdfDocument } from '../../engine/mupdf/mupdfDocument';
import { putFile } from '../../platform/recovery/fileCache';
import { fileService } from '../../app/services';
import { currentIdOf, fileStampOf, pathDocId, recordFileStamp, statFile, watchDocumentFile } from './saveDocument';
import { wakeDocument } from './tabResidency';
import { watchUnresponsive } from './unresponsive';
import { forgetEditState, restoreEditLog } from './editOps';
import { forgetSessionPassword, rememberSessionPassword } from './sessionPasswords';

/** Sources of files waiting for a password, keyed by tab. Passwords are never kept. */
const awaitingPassword = new Map<string, DocumentSource>();

const tabIsOpen = (tabId: string) => useWorkspaceStore.getState().tabs.some((t) => t.id === tabId);
const patchTab = (tabId: string, patch: Partial<Pick<Tab, 'title' | 'status' | 'panes' | 'split'>>) =>
  useWorkspaceStore.getState().patchTab(tabId, patch);

/**
 * The view a new tab starts with: the first page, fit to the whole page. The zoom is worked out from the viewer's size
 * once it is laid out, and kept to that size while the viewer resizes (see useViewerController), so the page shows
 * whole at first. Fit width would leave the bottom of a tall page below the fold.
 */
export function defaultView(docId: string): ViewState {
  return { pageId: pageIdFor(docId, 0), zoom: 1, fit: 'page', offset: 0, rotation: 0 };
}

function originOf(source: DocumentSource): TabOrigin {
  return source.kind === 'path' ? { kind: 'path', path: source.path } : { kind: 'bytes' };
}

/** Opens files the user picked or dropped, one after another. */
export async function openPicked(sources: DocumentSource[]): Promise<void> {
  for (const source of sources) {
    await openSource(source);
  }
}

export interface OpenSourceOptions {
  /** True when the tab is being restored from the last session. Restores do not reorder the recent list. */
  restored?: boolean;
}

/** Opens a source in a new tab and makes it active. Returns the tab id. */
export async function openSource(source: DocumentSource, view?: ViewState, options: OpenSourceOptions = {}): Promise<string> {
  const tabId = newId('tab');
  useWorkspaceStore.getState().addTab({
    id: tabId,
    title: source.name,
    origin: originOf(source),
    status: { kind: 'loading', progress: 0 },
    panes: [],
    split: null,
  });
  await attachDocument(tabId, source, undefined, view, !options.restored);
  return tabId;
}

/**
 * Longest a file may take to open before its tab shows an inline error. A path on an unavailable
 * drive, or a cloud placeholder, can make the read wait far longer, and the tab must not sit on
 * "Opening" forever.
 */
export const OPEN_TIMEOUT_MS = 60_000;

/**
 * Acquires a document, or rejects with an 'Unreadable' error once `timeoutMs` has passed. If the
 * open finishes after the timeout, its reference is given back, so nothing is leaked.
 */
export function acquireWithTimeout(
  source: DocumentSource,
  options: Parameters<typeof documentRegistry.acquire>[1],
  timeoutMs = OPEN_TIMEOUT_MS,
): Promise<DocHandle> {
  return new Promise<DocHandle>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new PdfOpenError('Unreadable'));
    }, timeoutMs);
    documentRegistry.acquire(source, options).then(
      (handle) => {
        clearTimeout(timer);
        if (settled) {
          documentRegistry.release(handle.docId);
          return;
        }
        settled = true;
        resolve(handle);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

type Stamp = Awaited<ReturnType<typeof statFile>>;

/**
 * What an open does BEFORE it acquires the document (a tab, or the second pane of a restored split).
 * The same file may be open in a tab whose engine was ended in the background (see tabResidency.ts). It is reopened first, with
 * the stamp check and the page bookkeeping of a return to that tab, and this open then shares it: the registry never resumes
 * a released document for an acquire.
 * The file's stamp is taken BEFORE the file is read, and kept only when this open really reads it. A tab opened on a
 * document that is already open reads nothing: the document is still the bytes it had, so the stamp must stay as it is,
 * or another program's change made since would be recorded as seen, and a save would write over it.
 * Another spelling of the same file counts as the same document (the registry joins them): then nothing is read.
 * Returns the stamp to give to finishAcquire (undefined when nothing is read).
 */
export async function prepareAcquire(source: DocumentSource): Promise<Stamp | undefined> {
  if (source.kind !== 'path') return undefined;
  const openId = documentRegistry.sameFileId(pathDocId(source.path));
  if (documentRegistry.isSuspended(openId)) await wakeDocument(openId);
  const readsFile = documentRegistry.get(documentRegistry.sameFileId(pathDocId(source.path))) === undefined;
  return readsFile ? await statFile(source.path) : undefined;
}

/**
 * What an open does right AFTER it acquired the document, for every way a document is opened (a tab, the second pane of a
 * restored split). The steps that belong to the document's first open (its record, the "stopped responding" watch, the file
 * stamp, the replay of an earlier session's edits) run only for the open that creates the record, so doing this twice for one
 * document (a tab and a split pane on the same file) adds nothing; the other steps are idempotent themselves.
 */
export function finishAcquire(handle: DocHandle, source: DocumentSource, password: string | undefined, stampBeforeRead: Stamp | undefined): void {
  // Kept in memory while the document is open, so a save can reopen an encrypted file (see sessionPasswords.ts).
  rememberSessionPassword(handle.docId, password);
  // A document opened for the first time (not a second tab on it) may have unsaved edits from an earlier session.
  const isNew = useDocumentsStore.getState().docs[handle.docId] === undefined;
  adoptDocument(handle, source.name, source.kind === 'bytes' ? source.bytes.byteLength : undefined);
  // A document whose engine stops answering gets the "stopped responding" bar (Wait or Reopen); a new document only.
  if (isNew) watchUnresponsive(handle.docId, handle.doc, currentIdOf);
  // A save later checks that the file is unchanged since this moment.
  if (source.kind === 'path') {
    if (isNew && stampBeforeRead !== undefined) {
      const path = source.path;
      if (stampBeforeRead) recordFileStamp(path, stampBeforeRead);
      // The main process answers a stat only for a path it has granted, and a file opened by drop, Recent or the command
      // line may not be granted until it is read. Then the stamp is taken now (without holding up the page), unless a save
      // has stamped the file meanwhile. Without a stamp the watch has nothing to compare and says nothing.
      else void statFile(path).then((now) => (fileStampOf(path) === undefined ? recordFileStamp(path, now) : undefined));
    }
    watchDocumentFile(handle.docId, source.path);
    if (isNew) void restoreEditLog(handle.docId, source.path);
  }
}

async function attachDocument(
  tabId: string,
  source: DocumentSource,
  password: string | undefined,
  view?: ViewState,
  remember = true,
): Promise<void> {
  try {
    const stampBeforeRead = await prepareAcquire(source);
    const handle = await acquireWithTimeout(source, {
      password,
      onProgress: (progress) => {
        if (tabIsOpen(tabId)) patchTab(tabId, { status: { kind: 'loading', progress } });
      },
    });
    if (!tabIsOpen(tabId)) {
      // The tab was closed while the file was opening. Give the reference back.
      documentRegistry.release(handle.docId);
      return;
    }
    awaitingPassword.delete(tabId);
    finishAcquire(handle, source, password, stampBeforeRead);

    const pane: Pane = { id: newId('pane'), docId: handle.docId, view: view ?? defaultView(handle.docId) };
    patchTab(tabId, { status: { kind: 'ready' }, panes: [pane], split: null });
    if (useUiStore.getState().passwordTabId === tabId) useUiStore.getState().closePassword();
    // Only byte sources go into the cache. Path sources are recovered from their path.
    if (source.kind === 'bytes') void putFile(handle.docId, source.name, source.bytes);
    if (remember) fileService.noteOpened(source);
  } catch (error) {
    showOpenError(tabId, source, error);
  }
}

/** Creates the shared document record the first time a file is seen, and measures page sizes in the background. */
export function adoptDocument(handle: DocHandle, name: string, byteSize: number | undefined): void {
  const { docs, putDoc, setSizes } = useDocumentsStore.getState();
  if (docs[handle.docId]) return;

  const { docId, pageCount, doc } = handle;
  // A MuPDF document already reported its page list (uids and revs), which is the list the panes use from now on.
  const reported = useEditStore.getState().byDoc[docId];
  putDoc({
    docId,
    name,
    pageCount,
    pages: reported ? pageListFromPages(docId, reported.uids, reported.revs, doc instanceof MupdfDocument ? doc.generation : undefined) : createPageList(docId, pageCount),
    sizes: Array.from({ length: pageCount }, (): PageSize | undefined => undefined),
    byteSize,
  });
  void measureInBackground(
    doc,
    pageCount,
    () => documentRegistry.get(docId) === handle,
    (entries) => setSizes(docId, entries),
  );
}

function showOpenError(tabId: string, source: DocumentSource, error: unknown): void {
  if (!tabIsOpen(tabId)) return;
  if (isPdfOpenError(error) && (error.kind === 'PasswordNeeded' || error.kind === 'WrongPassword')) {
    awaitingPassword.set(tabId, source);
    patchTab(tabId, { status: { kind: 'needsPassword' } });
    const ui = useUiStore.getState();
    ui.openPassword(tabId);
    if (error.kind === 'WrongPassword') ui.setPasswordError(ERROR_MESSAGES.WrongPassword);
    return;
  }
  awaitingPassword.delete(tabId);
  const message = isPdfOpenError(error) ? ERROR_MESSAGES[error.kind] : 'This file could not be opened.';
  patchTab(tabId, { status: { kind: 'error', message } });
}

/** Retries a file that asked for a password. The password is used once and not stored. */
export async function submitPassword(tabId: string, password: string): Promise<void> {
  const source = awaitingPassword.get(tabId);
  if (!source) return;
  useUiStore.getState().setPasswordError(null);
  patchTab(tabId, { status: { kind: 'loading', progress: 0 } });
  await attachDocument(tabId, source, password);
}

/** Closes a tab that is waiting for a password. */
export function cancelPassword(tabId: string): void {
  awaitingPassword.delete(tabId);
  useUiStore.getState().closePassword();
  closeTab(tabId);
}

/**
 * Gives back one reference of a document (a tab's pane, or a split pane). The last reference frees the document and
 * everything kept for it: its record, its session password, its edit state, its queued renders. The one release every close
 * path shares (a tab, a split pane, Close others). A caller that may lose unsaved edits asks first (closeFlow.releaseWithPrompt).
 */
export function releaseDocumentRef(docId: string): void {
  documentRegistry.release(docId);
  if (documentRegistry.refCount(docId) > 0) return;
  renderScheduler.cancelWhere((key) => key.startsWith(`${docId}|`));
  useDocumentsStore.getState().removeDoc(docId);
  forgetSessionPassword(docId);
  forgetEditState(docId);
}

/** Closes a tab, releasing its document references. The last tab for a file frees the file. */
export function closeTab(tabId: string): void {
  const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  for (const pane of tab.panes) releaseDocumentRef(pane.docId);
  awaitingPassword.delete(tabId);
  if (useUiStore.getState().passwordTabId === tabId) useUiStore.getState().closePassword();
  useWorkspaceStore.getState().removeTab(tabId);
}

/** Opens a second tab on the same file, sharing its document. */
export function duplicateTab(tabId: string): void {
  const { tabs } = useWorkspaceStore.getState();
  const index = tabs.findIndex((t) => t.id === tabId);
  const source = tabs[index];
  const pane = source?.panes[0];
  if (!source || !pane) return;
  documentRegistry.retain(pane.docId);
  useWorkspaceStore.getState().addTab(
    {
      id: newId('tab'),
      title: source.title,
      origin: source.origin,
      status: { kind: 'ready' },
      panes: [{ id: newId('pane'), docId: pane.docId, view: { ...pane.view } }],
      split: null,
    },
    index + 1,
  );
}
