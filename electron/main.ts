import { finalSavePath, type SavePathDeps } from './lib/savePath';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, screen, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHANNELS,
  MAX_READ_BYTES,
  clipboardTextArgs,
  closeAnswerArgs,
  describeInputsArgs,
  pickOutputFileArgs,
  isOpenablePath,
  jobAppendArgs,
  jobBeginArgs,
  jobCloseFileArgs,
  jobOpenFileArgs,
  pickFolderArgs,
  tokenArg,
  noArgs,
  openPathsValue,
  openablePathArg,
  recoveryKeyOnlyArgs,
  recoveryStashArgs,
  recoveryStashReadArgs,
  recoveryWriteArgs,
  saveArgs,
  saveDialogNameArg,
  statArgs,
  type CloseDecision,
  type FileStat,
  type JobInputInfo,
  type JobReadResult,
  type ReadFailure,
  type ReadResult,
  type SaveResult,
} from '../src/platform/desktop/contract';
import { pdfPathsFromArgv } from './lib/argv';
import { ChangedOnDiskError, saveAtomic } from './lib/atomicWrite';
import { CloseRequest, askWaitOrClose, cancelOnRendererTrouble } from './lib/closeRequest';
import { canonicalSpelling } from './lib/canonicalSpelling';
import { grantChosenPaths } from './lib/chosenGrants';
import { CRASH_LOOP_NOTICE, CrashLoopGuard } from './lib/crashLoop';
import { exactArrayBuffer } from './lib/exactArrayBuffer';
import { sampleOfFile } from './lib/fileSample';
import { ReopenRecord } from './lib/reopenRecord';
import { GrantPersistence } from './lib/grantPersistence';
import { PathGrants, grantKey, restorePersistedGrants } from './lib/pathGrants';
import { classifyFile, sniffFile } from './lib/sniff';
import { JobOutputs } from './lib/jobOutputs';
import { RecentStore, fileExists } from './lib/recentStore';
import { mayWriteWindowsRecent } from './lib/recentPolicy';
import { RecoveryStore, isTemporaryTestProfile } from './lib/recoveryStore';
import { knobWindowArguments, testScreenScale } from '../src/engine/testKnobs';
import {
  APP_HOST,
  APP_SCHEME,
  buildContentSecurityPolicy,
  isAllowedNavigation,
  isAppUrl,
  resolveAppAsset,
  withContentSecurityPolicy,
} from './lib/security';
import { DEFAULT_WINDOW_STATE, centreIn, parseWindowState, pickTestWorkArea, placeOnDisplays, type WindowState } from './lib/windowState';

const APP_NAME = 'PDF Suite';
const APP_ID = 'com.pdfsuite.app';
/** Set by the dev launcher. When present the window loads the Vite dev server instead of the built app. */
// A packaged app never loads a dev server, whatever the environment says: the variable would otherwise point the window (and the
// relaxed dev policy) at any page a local process names.
const DEV_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : undefined;
/** The Content-Security-Policy of the app's pages: sent by the protocol handler (HTML responses) and by the session. */
const APP_CSP = buildContentSecurityPolicy(DEV_ORIGIN);
/** The page the window loads. */
const APP_URL = DEV_URL ?? `${APP_SCHEME}://${APP_HOST}/index.html`;
/** Renderer crashes in a row, so a crash on every restore ends in a start with no tabs instead of a loop. */
const crashGuard = new CrashLoopGuard();
/** Built renderer, next to this bundle's parent folder in both dev and the packaged app. */
const RENDERER_ROOT = join(__dirname, '..', 'dist');
const PRELOAD = join(__dirname, 'preload.cjs');

// The app scheme must be declared before the app is ready. It gives the renderer a real origin for
// workers, IndexedDB and CSP, which file:// does not.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Blocks navigation to other pages and new windows for every web contents, including any future ones.
app.on('web-contents-created', (_event, contents) => {
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!isAllowedNavigation(url, DEV_ORIGIN)) event.preventDefault();
  };
  contents.on('will-navigate', (event, url) => guard(event, url));
  contents.on('will-redirect', (event, url) => guard(event, url));
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

/**
 * Every path the main process may read, stat or write. A path enters only through grantChosen(), from
 * the open dialog, the command line or a second launch, a drop, the Save dialog, or the recent list. Granted
 * paths are saved, so a restored session can still reopen them, but only as read grants: a write (saveAtomic)
 * needs a path the user chose in this session. See electron/lib/pathGrants.ts.
 */
const grants = new PathGrants();
let grantsFile: string;

function loadGrants(): void {
  try {
    const saved = JSON.parse(readFileSync(grantsFile, 'utf8')) as unknown;
    // Saved grants are read-only until the user opens the file again, or picks it in a Save dialog, in this session.
    restorePersistedGrants(grants, saved);
  } catch {
    // No saved grants yet, or the file is unreadable. Nothing is granted by it.
  }
}

/**
 * The paths the main process lets a Recent or session-restore open make writable without a user choice (ruling 8): the tabs
 * open when the last session ended, and the Recent entries, each once per session. It follows this process's own acceptance of
 * opens and closes, and is saved in its own file. See lib/reopenRecord.ts.
 */
let recentCopy: string[] = [];
const reopen = new ReopenRecord(() => recentCopy);
let reopenFile: string;
let reopenPersist: GrantPersistence;

/** The synchronous copy of the Recent list that ReopenRecord reads (RecentStore.list is async). Keep it current after every change. */
function refreshRecentCopy(): void {
  void recent.list().then(
    (list) => {
      recentCopy = list.slice(0, 10);
    },
    () => undefined,
  );
}

function loadReopen(): void {
  try {
    reopen.restore(JSON.parse(readFileSync(reopenFile, 'utf8')) as unknown);
  } catch {
    // No saved record yet, or it is unreadable: nothing is reopened without a user choice.
  }
}

/** Saves the granted paths after a short pause, asynchronously and atomically. See grantPersistence.ts. */
let grantsPersist: GrantPersistence;

function persistGrants(): void {
  grantsPersist.schedule();
}

/**
 * Grants paths the user chose, and remembers them. Returns the paths that were granted, for reading. A write right
 * comes only from an open document (the renderer reports it, see filesDocumentOpened) or from the Save dialog.
 */
async function grantChosen(paths: string[], options: { write?: boolean; readOnly?: boolean } = {}): Promise<string[]> {
  // The main process hands the page ONE spelling per file (junctions, the long-path prefix, short names and letter case resolved):
  // the page's registry, recovery key and Recent list work on path text. The resolution is asynchronous and time-limited, so a
  // sleeping network share never blocks the main thread; a read-only grant (the Recent list) resolves nothing at all. A path the
  // user chose (dialog, drop, command line, Save dialog, a result main made) may be opened for writing; a path only shown to the
  // user (the Recent list) gets a read grant, and opening it for writing goes through openKnown. See lib/chosenGrants.ts.
  const granted = await grantChosenPaths(grants, paths, options);
  if (granted.length > 0) persistGrants();
  return granted;
}

/** The granted form of the single path argument, or null when the path was not granted. */
function grantedPathArg(args: readonly unknown[]): string | null {
  const path = openablePathArg(args);
  return path ? grants.canonical(path) : null;
}

/** The documents open in tabs, by grant key. Their files are compared by identity (junctions, short names, long-path spellings), not by text. */
const openDocumentPaths = new Map<string, string>();

/** The two questions of finalSavePath, asked in this process: does the file exist, and replace it? */
function saveQuestions(): SavePathDeps {
  return {
    exists: (path) => fileExists(path),
    confirmReplace: async (path) => {
      if (!mainWindow) return false;
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: `${basename(path)} already exists.`,
        detail: 'Do you want to replace it?',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      return answer.response === 0;
    },
  };
}

let mainWindow: BrowserWindow | null = null;
/** False until the renderer asks for its startup queue. Open requests wait in `pending` until then. */
let rendererReady = false;
let pending: string[] = [];
let recent: RecentStore;
/** The recovery folder. The page sends keys and stash names only, and this process builds every path. */
let recovery: RecoveryStore;
let windowStateFile: string;
/** Where batch jobs write (see lib/jobOutputs.ts). */
let jobs: JobOutputs;
/** The folder the last Split or Combine used this session: the folder dialog opens there when no file is given. */
let lastJobFolder: string | null = null;

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  return typeof url === 'string' && isAppUrl(url, DEV_ORIGIN);
}

/** Registers an IPC handler that only answers the app's own pages. Each handler validates its arguments. */
function handle(channel: string, fn: (args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error(`Blocked IPC call from an untrusted page: ${channel}`);
    return fn(args);
  });
}

const fail = (reason: ReadFailure): ReadResult => ({ ok: false, reason });
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR';

function registerIpc(): void {
  handle(CHANNELS.filesPick, async (args): Promise<string[]> => {
    if (!noArgs(args) || !mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open PDF',
      properties: ['openFile', 'multiSelections'],
      // PDF first (the default), then every file: the user may choose a file that is not a PDF, and it
      // then opens with the engine's message ("This isn't a PDF.") instead of being dropped.
      filters: [
        { name: 'PDF documents', extensions: ['pdf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return await grantChosen(result.canceled ? [] : result.filePaths.filter(isOpenablePath));
  });

  handle(CHANNELS.filesGrantDropped, async (args): Promise<string[]> => {
    // Only the preload calls this, from a trusted drop event. The page has no way to reach it. The answer is the granted paths in
    // the one spelling the page must use (the preload hands them to the page's drop handler).
    const paths = args.length === 1 ? openPathsValue(args[0]) : null;
    return paths ? await grantChosen(paths) : [];
  });

  handle(CHANNELS.filesRead, async (args): Promise<ReadResult> => {
    const path = grantedPathArg(args);
    if (!path) return fail('invalid-argument');
    try {
      const info = await fs.stat(path);
      if (!info.isFile()) return fail('unreadable');
      // The first 1 KB decides whether this is a PDF. A file that is not one is never read in full.
      const sniffed = await sniffFile(path);
      if (sniffed.kind === 'empty') return fail('empty');
      if (sniffed.kind === 'not-pdf') return fail('not-pdf');
      if (info.size > MAX_READ_BYTES) return fail('too-large');
      const data = await fs.readFile(path);
      const bytes = exactArrayBuffer(data);
      // This process read the file for the renderer, so the renderer may now report a document open on it.
      grants.noteRead(path);
      return { ok: true, bytes };
    } catch (error) {
      return fail(isMissing(error) ? 'missing' : 'unreadable');
    }
  });

  handle(CHANNELS.filesStat, async (args): Promise<FileStat | null> => {
    const parsed = statArgs(args);
    const path = parsed ? grants.canonical(parsed.path) : null;
    if (!parsed || !path) return null;
    try {
      const info = await fs.stat(path);
      if (!info.isFile()) return null;
      const stat: FileStat = { size: info.size, modified: info.mtimeMs };
      // The content sample reads up to 128 KB, so only a caller that asked for it pays for it (not the disk watch).
      if (parsed.withSample) stat.sample = await sampleOfFile(path);
      return stat;
    } catch {
      return null;
    }
  });

  handle(CHANNELS.filesDocumentOpened, (args): boolean => {
    const path = openablePathArg(args);
    const accepted = path ? grants.markOpen(path) : false;
    // Only an open this process accepted is recorded: the page cannot add a path to the record.
    if (path && accepted) {
      openDocumentPaths.set(grantKey(path), path);
      reopen.noteOpen(path);
      reopenPersist.schedule();
    }
    return accepted;
  });

  handle(CHANNELS.filesDocumentClosed, (args): void => {
    const path = openablePathArg(args);
    if (!path) return;
    grants.markClosed(path);
    openDocumentPaths.delete(grantKey(path));
    reopen.noteClosed(path);
    reopenPersist.schedule();
  });

  // A tab of the last session or a Recent entry, opened by the page: accepted once per session per path, and only for those.
  // Answers the path in the spelling of the EXISTING grant (the page opens that one), or null. The requested path's text is tried
  // first; only when it matches no grant is it resolved, once and asynchronously. Stored grants and the reopen record are compared by
  // text and never resolved again, so no file-system call blocks the main thread. No new grant is made: a spelling that only reaches
  // a granted file (a junction, a hard link) gets nothing of its own.
  handle(CHANNELS.filesOpenKnown, async (args): Promise<string | null> => {
    const path = openablePathArg(args);
    if (path === null) return null;
    const granted = await grants.findGranted(path, (p) => canonicalSpelling(p));
    // Granted first, then in the record and not used yet: the order keeps a refused path from using up its one time.
    return granted !== null && reopen.allowOnce(granted) && grants.allowOpen(granted) ? granted : null;
  });

  handle(CHANNELS.filesSaveAtomic, async (args): Promise<SaveResult> => {
    const parsed = saveArgs(args);
    // Writing needs a write grant: a Save dialog path, or a file the user opened in this session (not a restored grant).
    const path = parsed ? grants.canonicalForWrite(parsed.path) : null;
    if (!parsed || !path) return { ok: false, reason: 'invalid-argument' };
    try {
      await saveAtomic(path, new Uint8Array(parsed.bytes), parsed.expected ? { expected: parsed.expected } : {});
      return { ok: true };
    } catch (error) {
      // The file is not the one the app last saw: nothing was replaced, and the page shows the "changed on disk" choice.
      if (error instanceof ChangedOnDiskError) return { ok: false, reason: 'changed-on-disk' };
      return { ok: false, reason: 'write-failed' };
    }
  });

  handle(CHANNELS.filesSaveDialog, async (args): Promise<string | null> => {
    const name = saveDialogNameArg(args);
    if (!name || !mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save PDF As',
      defaultPath: name,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    // The dialog may return a name without the extension. A saved file is always a .pdf; a file that the added extension would replace
    // is asked about first (the dialog only confirmed the name as typed).
    const final = await finalSavePath(result.filePath, saveQuestions());
    if (final.kind !== 'path') return null;
    // A path that reaches a file open in another tab by another spelling (a junction, a short name, a long-path form) is that file.
    // Resolved once, asynchronously (never on the main thread), and compared by text with the open documents' canonical spellings.
    const wanted = grantKey(await canonicalSpelling(final.path));
    if ([...openDocumentPaths.values()].some((open) => grantKey(open) !== grantKey(final.path) && grantKey(open) === wanted)) {
      await dialog.showMessageBox(mainWindow, { type: 'warning', message: 'That file is open in PDF Suite.', detail: 'Close its tab first, or choose a different name.', buttons: ['OK'] });
      return null;
    }
    // The user chose this path in the dialog, so it is granted for the save that follows.
    return (await grantChosen([final.path], { write: true }))[0] ?? null;
  });

  handle(CHANNELS.filesTakePending, (args): string[] => {
    if (!noArgs(args)) return [];
    rendererReady = true;
    const batch = pending;
    pending = [];
    return batch;
  });

  // Clipboard writes go through the main process. The page's own clipboard permission is denied, so
  // navigator.clipboard fails in the packaged app.
  handle(CHANNELS.clipboardWriteText, (args): boolean => {
    const text = clipboardTextArgs(args);
    if (text === null) return false;
    clipboard.writeText(text);
    return true;
  });

  handle(CHANNELS.recentList, async (args): Promise<string[]> => {
    if (!noArgs(args)) return [];
    // The list is shown to the user, so its entries get READ grants here. Opening one for writing goes through openKnown.
    const paths = await recent.list();
    recentCopy = paths.slice(0, 10);
    await grantChosen(paths, { readOnly: true });
    return paths;
  });

  // Recovery calls take a document key and a stash name, never a path, so they do not use the path grants.
  handle(CHANNELS.recoveryWrite, async (args): Promise<boolean> => {
    const parsed = recoveryWriteArgs(args);
    if (!parsed) return false;
    try {
      await recovery.write(parsed.key, parsed.text);
      return true;
    } catch {
      return false;
    }
  });

  handle(CHANNELS.recoveryRead, async (args): Promise<string | null> => {
    const key = recoveryKeyOnlyArgs(args);
    return key === null ? null : recovery.read(key);
  });

  handle(CHANNELS.recoveryWriteStash, async (args): Promise<boolean> => {
    const parsed = recoveryStashArgs(args);
    if (!parsed) return false;
    try {
      await recovery.writeStash(parsed.key, parsed.name, new Uint8Array(parsed.bytes));
      return true;
    } catch {
      return false;
    }
  });

  handle(CHANNELS.recoveryReadStash, async (args): Promise<ArrayBuffer | null> => {
    const parsed = recoveryStashReadArgs(args);
    return parsed ? recovery.readStash(parsed.key, parsed.name) : null;
  });

  handle(CHANNELS.recoveryList, async (args): Promise<string[]> => (noArgs(args) ? recovery.list() : []));

  handle(CHANNELS.recoveryClear, async (args): Promise<boolean> => {
    const key = recoveryKeyOnlyArgs(args);
    if (key === null) return false;
    try {
      await recovery.clear(key);
      return true;
    } catch {
      return false;
    }
  });

  handle(CHANNELS.recoverySetAside, async (args): Promise<boolean> => {
    const key = recoveryKeyOnlyArgs(args);
    if (key === null) return false;
    try {
      await recovery.setAside(key);
      return true;
    } catch {
      return false;
    }
  });

  handle(CHANNELS.recoveryClearPrevious, async (args): Promise<boolean> => {
    const key = recoveryKeyOnlyArgs(args);
    if (key === null) return false;
    try {
      await recovery.clearPrevious(key);
      return true;
    } catch {
      return false;
    }
  });

  handle(CHANNELS.recentClear, async (args): Promise<void> => {
    if (!noArgs(args)) return;
    await recent.clear();
    recentCopy = [];
  });

  // File, Exit: the window closes through its own close handler (below), so the Save / Don't save / Cancel flow runs.
  handle(CHANNELS.appRequestClose, (args): void => {
    if (!noArgs(args)) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  handle(CHANNELS.appOpenLogs, async (args): Promise<void> => {
    if (!noArgs(args)) return;
    await shell.openPath(app.getPath('userData'));
  });

  // The title-bar buttons follow the app's theme. The overlay is a Windows feature; elsewhere the call does nothing.
  handle(CHANNELS.windowOverlay, (args): void => {
    const dark = args.length === 1 && typeof args[0] === 'boolean' ? args[0] : null;
    if (dark === null || !mainWindow || process.platform !== 'win32') return;
    try {
      mainWindow.setTitleBarOverlay({
        color: dark ? '#24272e' : '#eceef2',
        symbolColor: dark ? '#e6e8ec' : '#1d2026',
        height: MENU_ROW_HEIGHT,
      });
    } catch {
      // The window keeps its colors when the overlay cannot change.
    }
  });

  // The renderer's answer to a close request. Only the request in flight can be answered, and only with its own id. A "Don't
  // save" carries the recovery keys to remove; they are removed only when this answer is for the live request, before the window
  // closes (a late answer to a request that already ended changes nothing). Resolves true when the request took the answer.
  handle(CHANNELS.appCloseDecision, async (args): Promise<boolean> => {
    const answer = closeAnswerArgs(args);
    const request = closeRequest;
    if (!answer || !request) return false;
    if (answer.requestId !== null && answer.requestId !== closeRequestId) return false;
    if (answer.decision === 'close' && answer.keys.length > 0) {
      return request.answerAfter('close', async () => {
        await recovery.clearKeys(answer.keys);
      });
    }
    return request.answer(answer.decision);
  });

  // The page got the close request: from here on the window waits for the user's answer, with no timeout.
  handle(CHANNELS.appCloseAck, (args): void => {
    if (noArgs(args)) closeRequest?.acknowledge();
  });

  // ---- Batch jobs (Split into Files, Combine): see lib/jobOutputs.ts and docs/milestone-1.3/1.3-blueprint.md A3 ----------------

  const describe = async (paths: string[]): Promise<JobInputInfo[]> => {
    const out: JobInputInfo[] = [];
    for (const raw of paths) {
      // A path without a read grant is not answered.
      const path = grants.canonical(raw);
      if (!path) continue;
      try {
        const info = await fs.stat(path);
        if (!info.isFile()) continue;
        const { kind } = await classifyFile(path);
        out.push({ path, name: path.split(/[\\/]/).pop() ?? path, size: info.size, modified: info.mtimeMs, kind });
      } catch {
        // A missing or unreadable file is left out of the answer.
      }
    }
    return out;
  };

  handle(CHANNELS.jobsPickInputs, async (args): Promise<JobInputInfo[]> => {
    if (!noArgs(args) || !mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDFs, pictures and text files', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'gif', 'bmp', 'webp', 'txt', 'log', 'md', 'csv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const granted = await grantChosen(result.canceled ? [] : result.filePaths.filter(isOpenablePath));
    return describe(granted);
  });

  // Types files and grants nothing.
  handle(CHANNELS.jobsDescribeInputs, async (args): Promise<JobInputInfo[]> => {
    const paths = describeInputsArgs(args);
    return paths ? describe(paths) : [];
  });

  // A job input is read in full from a granted path. No PDF check (Combine takes pictures and text) and no noteRead: reading
  // for a job never lets the page report a document open on the path.
  handle(CHANNELS.jobsReadInput, async (args): Promise<JobReadResult> => {
    const path = grantedPathArg(args);
    if (!path) return { ok: false, reason: 'invalid-argument' };
    try {
      const info = await fs.stat(path);
      if (!info.isFile()) return { ok: false, reason: 'unreadable' };
      if (info.size === 0) return { ok: false, reason: 'empty' };
      if (info.size > MAX_READ_BYTES) return { ok: false, reason: 'too-large' };
      const data = await fs.readFile(path);
      const bytes = exactArrayBuffer(data);
      // The size is what was read, so a file that changed between the stat and the read is caught by the caller's comparison.
      return { ok: true, bytes, size: data.byteLength, modified: info.mtimeMs };
    } catch (error) {
      return { ok: false, reason: isMissing(error) ? 'missing' : 'unreadable' };
    }
  });

  handle(CHANNELS.jobsPickFolder, async (args): Promise<{ token: string; label: string } | null> => {
    const parsed = pickFolderArgs(args);
    if (!parsed || !mainWindow) return null;
    // Opens at the folder of a read-granted file, else the folder used last this session.
    const near = parsed.near ? grants.canonical(parsed.near) : null;
    const defaultPath = near ? dirname(near) : (lastJobFolder ?? undefined);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for the new files',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (!chosen || !isOpenablePath(chosen)) return null;
    lastJobFolder = chosen;
    return jobs.registerFolder(chosen);
  });

  // Combine's output: a Save dialog that opens in the first input's folder. The chosen path is write-granted like any Save dialog
  // path; jobs.begin then refuses a path that is one of the inputs or is open in a tab.
  handle(CHANNELS.jobsPickOutputFile, async (args): Promise<string | null> => {
    const parsed = pickOutputFileArgs(args);
    if (!parsed || !mainWindow) return null;
    const near = parsed.near ? grants.canonical(parsed.near) : null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save the combined PDF',
      defaultPath: near ? join(dirname(near), parsed.leafName) : parsed.leafName,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const final = await finalSavePath(result.filePath, saveQuestions(), { checkLeaf: true });
    if (final.kind === 'bad-name') {
      await dialog.showMessageBox(mainWindow, { type: 'error', message: "That file name can't be used.", detail: 'Choose a shorter name without special characters.', buttons: ['OK'] });
      return null;
    }
    if (final.kind !== 'path') return null;
    return (await grantChosen([final.path], { write: true }))[0] ?? null;
  });

  handle(CHANNELS.jobsBegin, async (args) => {
    const parsed = jobBeginArgs(args);
    // Input paths must hold a read grant: a job can only name files the user chose.
    const inputs = parsed ? parsed.inputPaths.map((p) => grants.canonical(p)) : [];
    if (!parsed || inputs.some((p) => p === null)) return { ok: false, reason: 'invalid' };
    return jobs.begin(parsed.target, inputs as string[]);
  });

  handle(CHANNELS.jobsOpenFile, async (args) => {
    const parsed = jobOpenFileArgs(args);
    return parsed ? jobs.openFile(parsed.jobToken, parsed.leafName) : { ok: false, reason: 'invalid' };
  });

  handle(CHANNELS.jobsAppend, async (args) => {
    const parsed = jobAppendArgs(args);
    return parsed ? jobs.append(parsed.jobToken, parsed.fileId, parsed.seq, parsed.bytes) : { ok: false, reason: 'invalid' };
  });

  handle(CHANNELS.jobsCloseFile, async (args) => {
    const parsed = jobCloseFileArgs(args);
    return parsed ? jobs.closeFile(parsed.jobToken, parsed.fileId, parsed.byteLength) : { ok: false, reason: 'invalid' };
  });

  handle(CHANNELS.jobsCommit, async (args) => {
    const token = tokenArg(args);
    return token ? jobs.commit(token) : { ok: false, reason: 'invalid' };
  });

  handle(CHANNELS.jobsAbort, async (args): Promise<void> => {
    const token = tokenArg(args);
    if (token) await jobs.abort(token);
  });

  handle(CHANNELS.jobsReveal, (args): void => {
    const token = tokenArg(args);
    const path = token ? jobs.resultPath(token) : null;
    if (path && !E2E_MODE) shell.showItemInFolder(path);
  });

  handle(CHANNELS.jobsOpenResult, async (args): Promise<string | null> => {
    const token = tokenArg(args);
    const path = token ? jobs.resultPath(token) : null;
    // Main made this file, so the page may read it (and open it in a tab).
    if (!path) return null;
    return (await grantChosen([path]))[0] ?? null;
  });


  handle(CHANNELS.recentAdd, async (args): Promise<void> => {
    const path = grantedPathArg(args);
    // Only a path open in a tab now (this process accepted its open) may enter the Recent list: the Recent list is one of the two
    // sources openKnown trusts, and the page must not be able to put any saved grant there.
    if (!path || !grants.isOpen(path) || !(await fileExists(path))) return;
    await recent.add(path);
    refreshRecentCopy();
    // Never in test mode: it writes to the user's Windows Recent list (see lib/recentPolicy.ts).
    if (mayWriteWindowsRecent(process.env)) app.addRecentDocument(path);
  });
}

/** Sends queued paths to the renderer once it is listening. A send clears the queue, so nothing opens twice. */
function flushOpenRequests(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || !rendererReady || pending.length === 0) return;
  const batch = pending;
  pending = [];
  win.webContents.send(CHANNELS.filesOpenRequested, batch);
}

async function queueOpenRequests(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  pending.push(...(await grantChosen(paths)));
  flushOpenRequests();
}

/**
 * Drops directories from command-line paths. A "." or a folder name is not a file to open. A path
 * that does not exist is kept, so its tab shows "This file was moved, renamed or deleted.", as a named file would.
 */
async function withoutDirectories(paths: string[]): Promise<string[]> {
  const directory = await Promise.all(paths.map((path) => fs.stat(path).then((info) => info.isDirectory(), () => false)));
  return paths.filter((_, index) => !directory[index]);
}

function loadWindowState(): WindowState {
  try {
    return parseWindowState(JSON.parse(readFileSync(windowStateFile, 'utf8')) as unknown);
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function persistWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const bounds = win.getNormalBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized(),
  };
  try {
    // A small file written synchronously, so it is on disk even if the app quits right after.
    writeFileSync(windowStateFile, JSON.stringify(state));
  } catch {
    // Losing the window position is not worth a crash.
  }
}

/**
 * How long a close waits for the renderer to ACKNOWLEDGE the request (see lib/closeRequest.ts). For a renderer that never does
 * (hung), the main process asks "Wait / Close" (onNoAnswer below); it is never closed without asking, except in test mode. Once
 * it has acknowledged, the window waits for the user's answer to Save / Don't save / Cancel with no timeout. Test mode only (PDFSUITE_E2E=1) may shorten this with
 * PDFSUITE_E2E_CLOSE_ACK_TIMEOUT_MS, so a test can prove the prompt outlives it.
 */
const CLOSE_ACK_TIMEOUT_MS = 60_000;
function closeAckTimeoutMs(): number {
  const override = Number(process.env.PDFSUITE_E2E_CLOSE_ACK_TIMEOUT_MS);
  return E2E_MODE && Number.isFinite(override) && override > 0 ? override : CLOSE_ACK_TIMEOUT_MS;
}
/** True once the window may close for real. Set after the renderer answered 'close' and the session was written. */
let closeApproved = false;
/** The close request in flight, answered by the renderer. */
let closeRequest: CloseRequest | null = null;
/** Numbers the close requests; the page echoes the id of the request it answers, so an answer to an older one is ignored. */
let closeRequestSeq = 0;
let closeRequestId = 0;

/**
 * Test mode (PDFSUITE_E2E=1): closing and quitting discard edits silently, with no prompt, and the recovery logs are
 * dropped. Only the tests that check the close prompt itself set PDFSUITE_E2E_PROMPTS=1, which keeps the prompt on.
 * Test windows also open inactive (see createWindow), so a run never takes the user's focus.
 */
const E2E_MODE = process.env.PDFSUITE_E2E === '1';
/**
 * Silent close needs the test mode AND a throwaway profile (a pdfsuite-e2e-* folder in the system temp folder): a run that forgot
 * --user-data-dir gets the normal close prompt and never discards the owner's edits. Read when a close is asked, not at load.
 */
const e2eSilentClose = (): boolean =>
  E2E_MODE && process.env.PDFSUITE_E2E_PROMPTS !== '1' && isTemporaryTestProfile(app.getPath('userData'), app.getPath('temp'));

/**
 * DIAGNOSTICS ONLY (ticket 1.2.1 probe), test mode only: writes one JSON line to stderr and, when PDFSUITE_DIAG_LOG names
 * a file, appends it there. Used for render-process-gone and child-process-gone, with the memory of every process.
 */
function diagLog(event: string, details: Record<string, unknown>): void {
  if (!E2E_MODE) return;
  let metrics: unknown = null;
  try {
    metrics = app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, privateMB: Math.round((m.memory.privateBytes ?? 0) / 1024), wsMB: Math.round(m.memory.workingSetSize / 1024), peakWsMB: Math.round(m.memory.peakWorkingSetSize / 1024) }));
  } catch {
    // Left null.
  }
  const line = JSON.stringify({ diag: event, at: new Date().toISOString(), ...details, system: process.getSystemMemoryInfo(), metrics });
  try {
    console.error(`[pdfsuite-diag] ${line}`);
    if (process.env.PDFSUITE_DIAG_LOG) appendFileSync(process.env.PDFSUITE_DIAG_LOG, `${line}
`);
  } catch {
    // Diagnostics never fail the app.
  }
}

if (E2E_MODE) {
  app.on('child-process-gone', (_event, details) => {
    diagLog('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode, exitCodeHex: `0x${(details.exitCode >>> 0).toString(16)}`, name: details.name ?? null, serviceName: details.serviceName ?? null });
  });
}

/** True once Windows is ending the session (log off, shut down). It never reaches the test-mode deletion below. */
let sessionEnding = false;

async function discardRecoveryLogsForTests(): Promise<void> {
  // Test-mode close deletes EVERY recovery log in the profile it runs in: only a temporary test profile (a pdfsuite-e2e-* folder
  // in the system temp folder, made by the test helpers with --user-data-dir) may be emptied. A probe that forgot
  // --user-data-dir must not touch the owner's real recovery copies (register M13). A session end never deletes anything.
  if (sessionEnding || !isTemporaryTestProfile(app.getPath('userData'), app.getPath('temp'))) return;
  try {
    for (const key of await recovery.list()) await recovery.clear(key);
  } catch {
    // Nothing to drop, or the folder is already gone.
  }
}

/**
 * Asks the renderer whether the window may close. The renderer shows Save / Don't save / Cancel when there are unsaved
 * changes, and answers at once when there are none. Resolves with 'close' or 'cancel'.
 */
function requestCloseDecision(win: BrowserWindow): Promise<CloseDecision> {
  if (e2eSilentClose()) return discardRecoveryLogsForTests().then((): CloseDecision => 'close');
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve('close');
  const id = (closeRequestSeq += 1);
  closeRequestId = id;
  const request = new CloseRequest(closeAckTimeoutMs(), () => win.webContents.send(CHANNELS.appCloseRequested, id), {
    // A page that does not answer is asked about ("PDF Suite is not responding. Wait / Close"), never closed silently. Never in
    // test mode (TESTING-RULES section 1: no box is left for the owner); a test that shortens the timeout closes as before.
    onNoAnswer: E2E_MODE ? undefined : (dismissed) => askWaitOrClose((options, signal) => dialog.showMessageBox({ ...options, buttons: [...options.buttons], signal }), dismissed),
    // The page's prompt for this request is now stale: it comes down.
    onCancelled: () => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.appCloseEnded);
    },
  });
  closeRequest = request;
  return request.start().finally(() => {
    if (closeRequest === request) closeRequest = null;
  });
}

/** How long quitting waits for the renderer to write its session snapshot before the app goes on anyway. */
const SESSION_FLUSH_TIMEOUT_MS = 2000;
/** True once the session for this quit has been written, or cannot be (no renderer left). */
let sessionFlushed = false;

/**
 * Asks the renderer to write its session snapshot now, and resolves when it acks or the timeout passes.
 * The renderer's write is awaited before the ack, so the snapshot is on disk when this resolves.
 */
function flushRendererSession(win: BrowserWindow): Promise<void> {
  if (sessionFlushed) return Promise.resolve();
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    sessionFlushed = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener(CHANNELS.sessionFlushed, onAck);
      sessionFlushed = true;
      resolve();
    };
    const onAck = (event: IpcMainEvent) => {
      if (event.sender === win.webContents) finish();
    };
    ipcMain.on(CHANNELS.sessionFlushed, onAck);
    timer = setTimeout(finish, SESSION_FLUSH_TIMEOUT_MS);
    win.webContents.send(CHANNELS.sessionFlush);
  });
}

/** Window/taskbar icon. Packaged builds read the copy in resources; dev runs read build/. */
function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '..', 'build', 'icon.ico');
}

/** The height of the in-app menu row. The title-bar overlay has the same height, so the window buttons sit in that row. */
const MENU_ROW_HEIGHT = 28;

function createWindow(): BrowserWindow {
  sessionFlushed = false;
  closeApproved = false;
  const saved = loadWindowState();
  let placed = placeOnDisplays(saved, screen.getAllDisplays().map((d) => d.workArea));
  if (E2E_MODE && placed.x === undefined) {
    // Test mode: a fresh window opens on the second monitor so the main one stays free (PDFSUITE_E2E_DISPLAY=primary opts out).
    const area = pickTestWorkArea(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.env.PDFSUITE_E2E_DISPLAY === 'primary');
    if (area) {
      const c = centreIn(area, placed.width, placed.height);
      placed = { ...placed, x: c.x, y: c.y, width: c.width, height: c.height };
    }
  }
  const win = new BrowserWindow({
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    icon: appIconPath(),
    autoHideMenuBar: true,
    // The menu bar is drawn in the page (see src/ui/menubar). The window keeps its own min, max and close buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#eceef2', symbolColor: '#1d2026', height: MENU_ROW_HEIGHT },
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      // Test mode only: the preload reads this and tells the page (see preload.ts), so the trace is never exposed in a normal run.
      additionalArguments: E2E_MODE ? ['--pdfsuite-test-mode', ...(onTemporaryTestProfile() ? knobWindowArguments(process.env) : [])] : [],
    },
  });

  if (saved.maximized) win.maximize();
  // In test mode the window never takes focus or comes to the front (see E2E_MODE).
  win.once('ready-to-show', () => (E2E_MODE ? win.showInactive() : win.show()));

  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistWindowState(win), 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  let closeAsked = false;
  win.on('close', (event) => {
    if (closeApproved) {
      clearTimeout(saveTimer);
      persistWindowState(win);
      return;
    }
    // Hold the close: the renderer answers first (unsaved changes ask Save / Don't save / Cancel). On 'close' the
    // session is written, then the window closes for real.
    event.preventDefault();
    if (closeAsked) return;
    closeAsked = true;
    void requestCloseDecision(win).then(async (decision) => {
      closeAsked = false;
      if (decision === 'cancel' || win.isDestroyed()) return;
      closeApproved = true;
      // The tabs that close from here on are not "closed by the user": the saved list is what was open now.
      reopen.freeze();
      await Promise.all([flushRendererSession(win), reopenPersist.flush()]);
      if (!win.isDestroyed()) win.close();
    });
  });
  win.on('closed', () => {
    void jobs.abortAll();
    if (mainWindow === win) mainWindow = null;
    rendererReady = false;
  });

  // A page that calls window.close() makes Electron destroy the window without its 'close' event, so the close flow
  // would be skipped. The page's window.close is therefore replaced with a request to this process (the same call File,
  // Exit makes), which goes through the 'close' handler above. Applied again after every load.
  win.webContents.on('dom-ready', () => {
    void win.webContents
      .executeJavaScript(
        "try { Object.defineProperty(window, 'close', { configurable: true, writable: true, value: () => { window.pdfSuite && window.pdfSuite.app.requestClose(); } }); } catch (e) {}",
      )
      .catch(() => undefined);
  });

  cancelOnRendererTrouble(win.webContents, () => closeRequest);
  win.webContents.on('did-start-loading', () => {
    // A reload starts a new renderer that must ask for its queue again.
    rendererReady = false;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    // A job of the lost page can no longer be finished: its temp files are removed.
    void jobs.abortAll();
    diagLog('render-process-gone', { reason: details.reason, exitCode: details.exitCode, exitCodeHex: `0x${(details.exitCode >>> 0).toString(16)}` });
    // The renderer crashed. Reloading lets crash recovery restore the tabs from the saved session. After two crashes within a
    // minute the next start comes up with no tabs and a notice (?noRestore=1): a file that crashes the page on restore would
    // otherwise loop. The saved session and the recovery logs are not touched; the page keeps the session snapshot until a
    // tab is opened, and each file's unsaved edits are offered when it is opened.
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) {
      // A reload after a start with no tabs (?noRestore=1) must not keep that address: it loads the normal page, so a later single
      // crash restores the session as usual.
      if (crashGuard.recordCrash(Date.now())) void win.loadURL(APP_URL);
      else {
        crashGuard.reset();
        diagLog('crash-loop', { notice: CRASH_LOOP_NOTICE });
        void win.loadURL(`${APP_URL}?noRestore=1`);
      }
    }
  });
  // Windows is ending the session (log off or shut down): nothing is deleted on the way out, in test mode or not.
  win.on('session-end', () => {
    sessionEnding = true;
  });

  void win.loadURL(APP_URL);
  return win;
}

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    const file = resolveAppAsset(RENDERER_ROOT, url.pathname);
    if (!file) return new Response('Not found', { status: 404 });
    // The policy travels with the HTML itself: Electron does not promise that webRequest.onHeadersReceived runs for this scheme.
    return withContentSecurityPolicy(await net.fetch(pathToFileURL(file).toString()), file, APP_CSP);
  });
}

function configureSession(): void {
  const ses = session.defaultSession;
  // The app asks for no device, notification or file permissions.
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  const csp = APP_CSP;
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!isAppUrl(details.url, DEV_ORIGIN)) {
      callback({});
      return;
    }
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
}

function startApp(): void {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId(APP_ID);
  const userData = app.getPath('userData');
  recent = new RecentStore(join(userData, 'recent-files.json'));
  recovery = new RecoveryStore(join(userData, 'recovery'));
  windowStateFile = join(userData, 'window-state.json');
  jobs = new JobOutputs({
    journalFile: join(userData, 'jobs-journal.json'),
    canonicalForWrite: (path) => grants.canonicalForWrite(path),
    isOpenDocument: (path) => grants.isOpen(path),
    openPaths: () => [...openDocumentPaths.values()],
    // Test mode only: the Nth chunk of a run fails to write, to prove a failed run leaves nothing behind.
    ...(E2E_MODE && Number(process.env.PDFSUITE_E2E_JOB_FAIL_APPEND) > 0 ? { failAppendAt: Number(process.env.PDFSUITE_E2E_JOB_FAIL_APPEND) } : {}),
  });
  // Temp files a crashed run left, from the journal only.
  void jobs.cleanupJournal();
  grantsFile = join(userData, 'path-grants.json');
  grantsPersist = new GrantPersistence(grantsFile, () => grants.list());
  loadGrants();
  reopenFile = join(userData, 'reopen-record.json');
  reopenPersist = new GrantPersistence(reopenFile, () => reopen.list());
  loadReopen();
  refreshRecentCopy();

  registerAppProtocol();
  configureSession();
  registerIpc();

  // Files named on the command line open once the renderer is ready.
  void withoutDirectories(pdfPathsFromArgv(process.argv.slice(1), process.cwd())).then(queueOpenRequests);
  mainWindow = createWindow();
}

// Knobs (window argument and screen scale) are honoured only on a throwaway profile in the temp folder, never on a user's real profile.
function onTemporaryTestProfile(): boolean {
  return isTemporaryTestProfile(app.getPath('userData'), app.getPath('temp'));
}

// Test mode only (PDFSUITE_E2E=1 with a screenScale knob): force the screen scale so a probe can measure memory at 1.5 or 2.
// Must be set before the app is ready. A normal run never reaches this.
const forcedScreenScale = onTemporaryTestProfile() ? testScreenScale(process.env) : null;
if (forcedScreenScale !== null) app.commandLine.appendSwitch('force-device-scale-factor', String(forcedScreenScale));

// Single instance: a second launch hands its files to the running window and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // argv[0] is the executable of the second launch, which is not a file to open.
    void withoutDirectories(pdfPathsFromArgv(argv.slice(1), workingDirectory)).then(queueOpenRequests);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) {
      mainWindow = createWindow();
    }
  });

  app.on('window-all-closed', () => app.quit());

  // Quitting from the menu or the shell: the session is written before the process exits.
  let quitAsked = false;
  app.on('before-quit', (event) => {
    if (mainWindow && !closeApproved) {
      // The window is still open, so the renderer answers first, as it does for a close.
      event.preventDefault();
      if (quitAsked) return;
      quitAsked = true;
      const win = mainWindow;
      void requestCloseDecision(win).then(async (decision) => {
        quitAsked = false;
        if (decision === 'cancel') return;
        closeApproved = true;
        reopen.freeze();
        await Promise.all([flushRendererSession(win), grantsPersist.flush(), reopenPersist.flush()]);
        app.quit();
      });
      return;
    }
    // Grants scheduled but not yet written are written before the process exits.
    if (sessionFlushed || !mainWindow) {
      if (!grantsPersist.pending && !reopenPersist.pending) return;
      event.preventDefault();
      void Promise.all([grantsPersist.flush(), reopenPersist.flush()]).then(() => app.quit());
      return;
    }
    event.preventDefault();
    void Promise.all([flushRendererSession(mainWindow), grantsPersist.flush(), reopenPersist.flush()]).then(() => app.quit());
  });

  void app.whenReady().then(startApp);
}
