import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { knobsFromArgv } from '../src/engine/testKnobs';
import { CHANNELS, openPathsValue, type PdfSuiteApi } from '../src/platform/desktop/contract';

/**
 * The only bridge between the isolated page and the main process. It exposes a small, typed API as
 * window.pdfSuite. It holds no Node objects and forwards arguments as they are. The main process
 * validates every argument.
 */

// The real paths of the files in the latest drop. A File from the page has no path, so the path is
// read here, during the drop event, which runs before the page's own drop handlers.
let droppedPaths: Promise<string[]> = Promise.resolve([]);
window.addEventListener(
  'drop',
  (event) => {
    // Only a real user drop counts. A drop the page dispatches itself is not trusted, and grants nothing.
    if (!event.isTrusted) return;
    const files = event.dataTransfer?.files;
    const raw = files
      ? Array.from(files, (file) => {
          try {
            return webUtils.getPathForFile(file);
          } catch {
            return '';
          }
        }).filter((p) => p.length > 0)
      : [];
    // The main process grants these paths, so the page can open them, and answers with the one spelling per file the page must use
    // (a junction or the long-path prefix is resolved). The page cannot call this itself.
    droppedPaths =
      raw.length > 0
        ? ipcRenderer.invoke(CHANNELS.filesGrantDropped, raw).then(
            (granted: unknown) => openPathsValue(granted) ?? [],
            () => [],
          )
        : Promise.resolve([]);
  },
  true,
);

const api: PdfSuiteApi = {
  files: {
    pick: () => ipcRenderer.invoke(CHANNELS.filesPick),
    read: (path) => ipcRenderer.invoke(CHANNELS.filesRead, path),
    stat: (path, withSample) => ipcRenderer.invoke(CHANNELS.filesStat, path, ...(withSample === undefined ? [] : [withSample])),
    openKnown: (path) => ipcRenderer.invoke(CHANNELS.filesOpenKnown, path).then((granted) => (typeof granted === 'string' ? granted : null)),
    documentOpened: (path) => ipcRenderer.invoke(CHANNELS.filesDocumentOpened, path),
    documentClosed: (path) => ipcRenderer.invoke(CHANNELS.filesDocumentClosed, path).then(() => undefined),
    saveAtomic: (path, bytes, expected) => ipcRenderer.invoke(CHANNELS.filesSaveAtomic, path, bytes, ...(expected === undefined ? [] : [expected])),
    saveDialog: (suggestedName) => ipcRenderer.invoke(CHANNELS.filesSaveDialog, suggestedName),
    takePending: () => ipcRenderer.invoke(CHANNELS.filesTakePending),
    onOpenRequested(listener) {
      const handler = (_event: unknown, paths: unknown) => {
        const valid = openPathsValue(paths);
        if (valid) listener(valid);
      };
      ipcRenderer.on(CHANNELS.filesOpenRequested, handler);
      return () => {
        ipcRenderer.removeListener(CHANNELS.filesOpenRequested, handler);
      };
    },
    takeDroppedPaths() {
      const paths = droppedPaths;
      droppedPaths = Promise.resolve([]);
      return paths;
    },
  },
  recent: {
    list: () => ipcRenderer.invoke(CHANNELS.recentList),
    add: (path) => ipcRenderer.invoke(CHANNELS.recentAdd, path),
    clear: () => ipcRenderer.invoke(CHANNELS.recentClear).then(() => undefined),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke(CHANNELS.clipboardWriteText, text),
  },
  recovery: {
    // The main process answers true or false: a refused or failed write must reach the page (the recovery log stops on false).
    write: (key, text) => ipcRenderer.invoke(CHANNELS.recoveryWrite, key, text).then((ok) => ok === true),
    read: (key) => ipcRenderer.invoke(CHANNELS.recoveryRead, key),
    writeStash: (key, name, bytes) => ipcRenderer.invoke(CHANNELS.recoveryWriteStash, key, name, bytes).then((ok) => ok === true),
    readStash: (key, name) => ipcRenderer.invoke(CHANNELS.recoveryReadStash, key, name),
    list: () => ipcRenderer.invoke(CHANNELS.recoveryList),
    clear: (key) => ipcRenderer.invoke(CHANNELS.recoveryClear, key).then((ok) => ok === true),
    setAside: (key) => ipcRenderer.invoke(CHANNELS.recoverySetAside, key).then((ok) => ok === true),
    clearPrevious: (key) => ipcRenderer.invoke(CHANNELS.recoveryClearPrevious, key).then((ok) => ok === true),
  },
  app: {
    onCloseRequested(listener) {
      // The page acknowledges the request first, so the main process stops its timeout and waits for the answer.
      // The request carries an id, which the page echoes in its answer, so a late answer to an older request is ignored.
      const handler = (_event: unknown, requestId: unknown) => {
        void ipcRenderer.invoke(CHANNELS.appCloseAck).catch(() => undefined);
        listener(typeof requestId === 'number' ? requestId : 0);
      };
      ipcRenderer.on(CHANNELS.appCloseRequested, handler);
      return () => {
        ipcRenderer.removeListener(CHANNELS.appCloseRequested, handler);
      };
    },
    onCloseEnded(listener) {
      const handler = () => listener();
      ipcRenderer.on(CHANNELS.appCloseEnded, handler);
      return () => {
        ipcRenderer.removeListener(CHANNELS.appCloseEnded, handler);
      };
    },
    decideClose: (decision, clearKeys, requestId) =>
      ipcRenderer
        .invoke(CHANNELS.appCloseDecision, decision, clearKeys ?? [], ...(requestId === undefined ? [] : [requestId]))
        .then((live) => live === true),
    openLogs: () => ipcRenderer.invoke(CHANNELS.appOpenLogs).then(() => undefined),
    requestClose: () => ipcRenderer.invoke(CHANNELS.appRequestClose).then(() => undefined),
  },
  jobs: {
    pickInputs: () => ipcRenderer.invoke(CHANNELS.jobsPickInputs),
    describeInputs: (paths) => ipcRenderer.invoke(CHANNELS.jobsDescribeInputs, paths),
    readInput: (path) => ipcRenderer.invoke(CHANNELS.jobsReadInput, path),
    pickFolder: (nearPath) => ipcRenderer.invoke(CHANNELS.jobsPickFolder, ...(nearPath === undefined ? [] : [nearPath])),
    pickOutputFile: (leafName, nearPath) => ipcRenderer.invoke(CHANNELS.jobsPickOutputFile, ...(nearPath === undefined ? [leafName] : [leafName, nearPath])),
    begin: (target, inputPaths) => ipcRenderer.invoke(CHANNELS.jobsBegin, target, inputPaths),
    openFile: (jobToken, leafName) => ipcRenderer.invoke(CHANNELS.jobsOpenFile, jobToken, leafName),
    append: (jobToken, fileId, seq, bytes) => ipcRenderer.invoke(CHANNELS.jobsAppend, jobToken, fileId, seq, bytes),
    closeFile: (jobToken, fileId, byteLength) => ipcRenderer.invoke(CHANNELS.jobsCloseFile, jobToken, fileId, byteLength),
    commit: (jobToken) => ipcRenderer.invoke(CHANNELS.jobsCommit, jobToken),
    abort: (jobToken) => ipcRenderer.invoke(CHANNELS.jobsAbort, jobToken).then(() => undefined),
    reveal: (resultId) => ipcRenderer.invoke(CHANNELS.jobsReveal, resultId).then(() => undefined),
    openResult: (resultId) => ipcRenderer.invoke(CHANNELS.jobsOpenResult, resultId),
  },
  chrome: {
    setDark: (dark) => ipcRenderer.invoke(CHANNELS.windowOverlay, dark).then(() => undefined),
  },
  session: {
    onFlushRequested(listener) {
      const handler = () => listener();
      ipcRenderer.on(CHANNELS.sessionFlush, handler);
      return () => {
        ipcRenderer.removeListener(CHANNELS.sessionFlush, handler);
      };
    },
    flushed: () => ipcRenderer.send(CHANNELS.sessionFlushed),
  },
};

contextBridge.exposeInMainWorld('pdfSuite', api);

// Test mode (PDFSUITE_E2E=1 in the main process): the page may expose its diagnostics trace (src/engine/diag.ts). Absent in a normal run.
if (process.argv.includes('--pdfsuite-test-mode')) contextBridge.exposeInMainWorld('__pdfSuiteTestMode', true);
// Test mode only: the measurement knobs (src/engine/testKnobs.ts) from PDFSUITE_TEST_KNOBS, passed by the main process.
const testKnobValues = knobsFromArgv(process.argv);
if (testKnobValues) contextBridge.exposeInMainWorld('__pdfSuiteKnobs', testKnobValues);
