/**
 * The contract between the Electron main process, the preload script and the renderer.
 * Pure code only (no Node or DOM imports), so the preload bundle and every side can share it.
 */

export const CHANNELS = {
  filesPick: 'files:pick',
  filesRead: 'files:read',
  filesStat: 'files:stat',
  /** Renderer to main: a document of this path is open in a tab (accepted only for a path main just read). */
  filesDocumentOpened: 'files:documentOpened',
  /** Renderer to main: the document of this path was closed. The path loses its write right. */
  filesDocumentClosed: 'files:documentClosed',
  filesSaveAtomic: 'files:saveAtomic',
  /**
   * Renderer to main: the page asks to open a path the main process itself knows (a tab of the last session, or a Recent entry).
   * Accepted once per session per path, and only for those (lib/reopenRecord.ts). Every other path needs a user choice.
   */
  filesOpenKnown: 'files:openKnown',
  /** Native Save dialog. The chosen path is granted in the main process, so the save that follows may write it. */
  filesSaveDialog: 'files:saveDialog',
  filesTakePending: 'files:takePending',
  filesOpenRequested: 'files:openRequested',
  recentList: 'recent:list',
  recentAdd: 'recent:add',
  clipboardWriteText: 'clipboard:writeText',
  /** Recovery of unsaved edits. Keys and names are validated here; the main process builds every path. */
  recoveryWrite: 'recovery:write',
  recoveryRead: 'recovery:read',
  recoveryWriteStash: 'recovery:writeStash',
  recoveryReadStash: 'recovery:readStash',
  recoveryList: 'recovery:list',
  recoveryClear: 'recovery:clear',
  /** Moves a document's log and stashes aside as its one "previous" copy (a refused restore must not be overwritten). */
  recoverySetAside: 'recovery:setAside',
  /** Removes a document's previous copy (the document was saved, or the user chose Discard). */
  recoveryClearPrevious: 'recovery:clearPrevious',
  /** Preload to main only, sent from a trusted drop event. Grants the dropped PDF paths. */
  filesGrantDropped: 'files:grantDropped',
  /** Main to renderer: write the session snapshot now, then send sessionFlushed. */
  sessionFlush: 'session:flush',
  /** Renderer to main: the session snapshot is written. */
  sessionFlushed: 'session:flushed',
  /** Main to renderer: the window is about to close or the app is quitting. The renderer asks about unsaved changes. */
  appCloseRequested: 'app:closeRequested',
  /** Main to renderer: the close request the page is answering has ended (cancelled), so its prompt is stale. */
  appCloseEnded: 'app:closeEnded',
  /** Renderer to main, invoked: 'close' lets the window go, 'cancel' keeps it open. */
  appCloseDecision: 'app:closeDecision',
  /** Renderer to main, invoked: the page got the close request and is showing the prompt (or answering). Ends the timeout. */
  appCloseAck: 'app:closeAck',
  /** Renderer to main: asks the window to close, which runs the same close flow as the title-bar button. */
  appRequestClose: 'app:requestClose',
  /** Renderer to main: clears the recent-files list. */
  recentClear: 'recent:clear',
  /** Renderer to main: opens the app's data folder (the logs and recovery files live there). */
  appOpenLogs: 'app:openLogs',
  /** Renderer to main: the window's title-bar buttons take the dark or the light colors. */
  windowOverlay: 'window:overlay',
  /**
   * Batch jobs (Split into Files, Combine; blueprint A3). The page never names a folder: main shows the folder dialog and
   * hands back an opaque token; every output is (token, leaf name), written as a new .pdf that never overwrites.
   */
  jobsPickInputs: 'jobs:pickInputs',
  jobsDescribeInputs: 'jobs:describeInputs',
  jobsReadInput: 'jobs:readInput',
  jobsPickFolder: 'jobs:pickFolder',
  jobsPickOutputFile: 'jobs:pickOutputFile',
  jobsBegin: 'jobs:begin',
  jobsOpenFile: 'jobs:openFile',
  jobsAppend: 'jobs:append',
  jobsCloseFile: 'jobs:closeFile',
  jobsCommit: 'jobs:commit',
  jobsAbort: 'jobs:abort',
  jobsReveal: 'jobs:reveal',
  jobsOpenResult: 'jobs:openResult',
} as const;

/** The answer to a close request: close the window (after the user chose Save or Don't save), or keep it open. */
export type CloseDecision = 'close' | 'cancel';

export function closeDecisionArg(args: readonly unknown[]): CloseDecision | null {
  if (args.length !== 1) return null;
  const [value] = args;
  return value === 'close' || value === 'cancel' ? value : null;
}

/** Most recovery keys one close answer may carry (up to two per document, so well above 500 dirty documents). */
export const MAX_CLOSE_KEYS = 4096;

/**
 * The page's answer to a close request: the decision, the recovery keys to remove (only meaningful for 'close', and only
 * valid keys), and the id of the request it answers. Null when malformed. A bare decision (the old one-argument call) is
 * accepted, with no keys and no id.
 */
export function closeAnswerArgs(args: readonly unknown[]): { decision: CloseDecision; keys: string[]; requestId: number | null } | null {
  if (args.length < 1 || args.length > 3) return null;
  const [decision, keys = [], requestId = null] = args;
  if (decision !== 'close' && decision !== 'cancel') return null;
  if (!Array.isArray(keys) || keys.length > MAX_CLOSE_KEYS) return null;
  const valid: string[] = [];
  for (const key of keys) {
    const checked = recoveryKeyArg(key);
    if (checked === null) return null;
    valid.push(checked);
  }
  if (requestId !== null && !(typeof requestId === 'number' && Number.isSafeInteger(requestId) && requestId >= 0)) return null;
  return { decision, keys: valid, requestId };
}

/** Longest text the clipboard IPC accepts, in UTF-16 units. Far above any path or page text the app copies. */
export const MAX_CLIPBOARD_CHARS = 1_000_000;

/**
 * The file-size limits (owner's delegate, 2026-11-10, "Largest supported file"): edit and save up to MAX_EDIT_BYTES (500 MB), open
 * view-only up to MAX_VIEW_BYTES (1 GB). They are defined once, in a leaf file the job worker can also use, and every size
 * message of the app is built from them (src/core/fileLimits.ts).
 */
import { MAX_EDIT_BYTES, MAX_VIEW_BYTES } from '../../engine/mupdf/fileLimitBytes';
export { MAX_EDIT_BYTES, MAX_VIEW_BYTES };
/** Largest file the main process will read into memory for one open: the view limit. */
export const MAX_READ_BYTES = MAX_VIEW_BYTES;
export const MAX_PATH_LENGTH = 4096;

export type ReadFailure = 'missing' | 'unreadable' | 'too-large' | 'invalid-argument' | 'not-pdf' | 'empty';
export type ReadResult = { ok: true; bytes: ArrayBuffer } | { ok: false; reason: ReadFailure };
export type SaveResult = { ok: true } | { ok: false; reason: 'invalid-argument' | 'write-failed' | 'changed-on-disk' };
/** Modified time is milliseconds since the Unix epoch. */
export interface FileStat {
  size: number;
  modified: number;
  /** A hash of the first and last 64 KB of the file (lib/fileSample.ts). Present only when stat was asked for it. */
  sample?: string;
}

/** The size and modified time a save expects the file to still have (it is refused as "changed on disk" otherwise). */
export interface ExpectedStamp {
  size: number;
  modified: number;
}

/** What main says a file is, from its first bytes (and its extension for text). `office` and `unsupported` are refused by Combine. */
export type InputType = 'pdf' | 'image' | 'text' | 'office' | 'unsupported';
export interface JobInputInfo {
  path: string;
  name: string;
  size: number;
  /** Modified time, milliseconds since the Unix epoch. */
  modified: number;
  kind: InputType;
}
export type JobReadResult = { ok: true; bytes: ArrayBuffer; size: number; modified: number } | { ok: false; reason: ReadFailure };

/** Why a job step in main failed. The page turns each into the user's message (jobMessages.ts). */
export type JobFailReason = 'disk-full' | 'folder-not-writable' | 'target-is-input' | 'target-open' | 'write-failed' | 'invalid';
export type JobResult<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; reason: JobFailReason; drive?: string };
/** Where a job writes: a folder token from jobs.pickFolder, or a path chosen in a Save dialog (Combine). */
export type JobTarget = { folderToken: string } | { pickedPath: string };
export interface JobResultFile {
  resultId: string;
  name: string;
}

/** The API the preload exposes as `window.pdfSuite`. Every method is a thin, validated IPC call. */
export interface PdfSuiteApi {
  files: {
    /** Native Open dialog. Resolves to the chosen paths (any file type), or [] when cancelled. */
    pick(): Promise<string[]>;
    read(path: string): Promise<ReadResult>;
    /** `withSample` also returns the content sample (a cheap hash of the file's two ends), for a recovery log's base. */
    stat(path: string, withSample?: boolean): Promise<FileStat | null>;
    /**
     * Asks the main process to open a path it knows (a tab of the last session or a Recent entry): once per session per path.
     * Resolves the path in the spelling the page must open (the existing grant's), so the open that follows may be written, or
     * null when refused (the file then opens read-only under the spelling the page has).
     */
    openKnown(path: string): Promise<string | null>;
    /** Tells the main process a document of this path is open. A file is written only while one is open (or after a Save dialog). */
    documentOpened(path: string): Promise<boolean>;
    documentClosed(path: string): Promise<void>;
    /** `expected`: the main process refuses with 'changed-on-disk' when the file is not as the app last saw it, just before it replaces it. */
    saveAtomic(path: string, bytes: ArrayBuffer, expected?: ExpectedStamp): Promise<SaveResult>;
    /**
     * Native Save dialog with a suggested file name. Resolves to the chosen .pdf path, which is granted for writing, or
     * null when the user cancels.
     */
    saveDialog(suggestedName: string): Promise<string | null>;
    /** Paths the main process queued (command line, or a second launch) before the renderer was ready. Clears the queue. */
    takePending(): Promise<string[]>;
    /** Calls `listener` with paths sent by a second launch. Returns the unsubscribe function. */
    onOpenRequested(listener: (paths: string[]) => void): () => void;
    /** Real paths of the files in the most recent drop, captured by the preload. Clears them. */
    takeDroppedPaths(): Promise<string[]>;
  };
  recent: {
    /** Recent file paths, newest first, with missing files removed. */
    list(): Promise<string[]>;
    add(path: string): Promise<void>;
    /** Empties the recent-files list. */
    clear(): Promise<void>;
  };
  clipboard: {
    /** Writes plain text through the main process. Resolves to false when the write did not happen. */
    writeText(text: string): Promise<boolean>;
  };
  recovery: {
    /** Writes a document's edit log (JSON text), atomically. Resolves false when the main process refused or failed the write. */
    write(key: string, text: string): Promise<boolean>;
    /** The log text of a document, or null. */
    read(key: string): Promise<string | null>;
    /** Writes a source file of the log (a stash). */
    writeStash(key: string, name: string, bytes: ArrayBuffer): Promise<boolean>;
    /** A source file of the log, or null. */
    readStash(key: string, name: string): Promise<ArrayBuffer | null>;
    /** The keys of the documents that have a log. */
    list(): Promise<string[]>;
    /** Removes a document's log and its stashes. Leaves the previous copy. */
    clear(key: string): Promise<boolean>;
    /** Moves the document's log and stashes aside as its one previous copy, replacing an older one. True when done (or nothing to move). */
    setAside(key: string): Promise<boolean>;
    /** Removes the document's previous copy. */
    clearPrevious(key: string): Promise<boolean>;
  };
  session: {
    /** Calls `listener` when the main process wants the session snapshot written before quitting. Returns the unsubscribe function. */
    onFlushRequested(listener: () => void): () => void;
    /** Tells the main process the snapshot is written. */
    flushed(): void;
  };
  app: {
    /**
     * Calls `listener` when the window is about to close or the app is quitting, with the id of the request. Returns the
     * unsubscribe function.
     */
    onCloseRequested(listener: (requestId: number) => void): () => void;
    /** Calls `listener` when the main process ended the request the page is answering (cancelled). Returns the unsubscribe function. */
    onCloseEnded(listener: () => void): () => void;
    /**
     * Answers the close request `requestId`. For 'close', `clearKeys` are recovery keys the main process removes, only when the
     * request is still waiting (a stale answer changes nothing). Resolves true when the request was still waiting and took
     * the answer.
     */
    decideClose(decision: CloseDecision, clearKeys?: string[], requestId?: number): Promise<boolean>;
    /** Opens the app's data folder in the file manager. */
    openLogs(): Promise<void>;
    /**
     * Asks the main process to close the window (File, Exit). It goes through the window's close handler, like the
     * title-bar button, so a document with unsaved edits is asked about first.
     */
    requestClose(): Promise<void>;
  };
  jobs: {
    /** Native multi-select picker for Combine. Every chosen path gets a read grant. */
    pickInputs(): Promise<JobInputInfo[]>;
    /** Types files. Grants nothing: answers only for paths that already hold a read grant (a trusted drop, an open tab). */
    describeInputs(paths: string[]): Promise<JobInputInfo[]>;
    /** Reads a granted file in full (no PDF check), with its size and modified time. */
    readInput(path: string): Promise<JobReadResult>;
    /** Native folder dialog, opening at the folder of a read-granted `nearPath`, else the last folder used. Null when cancelled. */
    pickFolder(nearPath?: string): Promise<{ token: string; label: string } | null>;
    /**
     * Native Save dialog for Combine's one output file. Opens at the folder of a read-granted `nearPath` (the first file's), named
     * `leafName`. The chosen path gets a write grant (as a Save dialog path does) and is returned; null when cancelled.
     */
    pickOutputFile(leafName: string, nearPath?: string): Promise<string | null>;
    begin(target: JobTarget, inputPaths: string[]): Promise<JobResult<{ jobToken: string }>>;
    openFile(jobToken: string, leafName: string): Promise<JobResult<{ fileId: number }>>;
    append(jobToken: string, fileId: number, seq: number, bytes: ArrayBuffer): Promise<JobResult>;
    closeFile(jobToken: string, fileId: number, byteLength: number): Promise<JobResult>;
    commit(jobToken: string): Promise<JobResult<{ results: JobResultFile[] }>>;
    abort(jobToken: string): Promise<void>;
    reveal(resultId: string): Promise<void>;
    /** Grants read for a file the job created and returns its path, so the page can open it. Null for an unknown result. */
    openResult(resultId: string): Promise<string | null>;
  };
  chrome: {
    /** Sets the colors of the window's own minimize, maximize and close buttons: dark when true. */
    setDark(dark: boolean): Promise<void>;
  };
}

/** True for an absolute Windows path (drive or UNC) or an absolute POSIX path. */
export function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

/**
 * A path IPC will accept for opening: a string, absolute, no NUL, bounded length. Any extension is
 * allowed, because the user chose the file and the engine decides what it is ("This isn't a PDF.").
 */
export function isOpenablePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') &&
    isAbsolutePath(value)
  );
}

/** An openable path that ends in .pdf. Used where only PDFs are written. */
export function isPdfPath(value: unknown): value is string {
  return isOpenablePath(value) && /\.pdf$/i.test(value);
}

/** Arguments of a call that takes exactly one openable path. Returns the path, or null when the call is malformed. */
export function openablePathArg(args: readonly unknown[]): string | null {
  return args.length === 1 && isOpenablePath(args[0]) ? args[0] : null;
}

/** Arguments of a call that takes no arguments. */
export function noArgs(args: readonly unknown[]): boolean {
  return args.length === 0;
}

/**
 * Arguments of a save call: a PDF path, the bytes to write, and optionally the stamp the file is expected to still have (two
 * finite non-negative numbers). Null when malformed or too large.
 */
export function saveArgs(args: readonly unknown[], maxBytes = MAX_EDIT_BYTES): { path: string; bytes: ArrayBuffer; expected?: ExpectedStamp } | null {
  if (args.length !== 2 && args.length !== 3) return null;
  const [path, bytes, expected] = args;
  if (!isPdfPath(path) || !(bytes instanceof ArrayBuffer) || bytes.byteLength > maxBytes) return null;
  if (args.length === 2) return { path, bytes };
  if (!expected || typeof expected !== 'object') return null;
  const { size, modified } = expected as Partial<ExpectedStamp>;
  if (typeof size !== 'number' || typeof modified !== 'number' || !Number.isFinite(size) || !Number.isFinite(modified) || size < 0 || modified < 0) return null;
  return { path, bytes, expected: { size, modified } };
}

/** Arguments of a stat call: one openable path, and optionally whether to include the content sample. */
export function statArgs(args: readonly unknown[]): { path: string; withSample: boolean } | null {
  if (args.length < 1 || args.length > 2) return null;
  const [path, withSample = false] = args;
  if (!isOpenablePath(path) || typeof withSample !== 'boolean') return null;
  return { path, withSample };
}

/**
 * Arguments of a Save dialog call: one suggested file name. No path separators, no NUL, bounded length.
 * Returns the name, or null when the call is malformed.
 */
export function saveDialogNameArg(args: readonly unknown[]): string | null {
  if (args.length !== 1) return null;
  const [name] = args;
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\\/:*?"<>|\0]/.test(name) ? name : null;
}

/** Recovery keys: a document's key is 64 lowercase hex characters (a SHA-256 of its path, made by the page). */
export const RECOVERY_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** Source file names inside a document's recovery folder: stash-<n>.pdf. */
export const RECOVERY_STASH_PATTERN = /^stash-\d{1,4}\.pdf$/;
/** Largest edit log or stash the recovery IPC accepts. */
export const MAX_RECOVERY_BYTES = MAX_EDIT_BYTES;

export function recoveryKeyArg(value: unknown): string | null {
  return typeof value === 'string' && RECOVERY_KEY_PATTERN.test(value) ? value : null;
}

export function recoveryStashNameArg(value: unknown): string | null {
  return typeof value === 'string' && RECOVERY_STASH_PATTERN.test(value) ? value : null;
}

/** Arguments of a log write: a key and the log text. Null when malformed or too large. */
export function recoveryWriteArgs(args: readonly unknown[]): { key: string; text: string } | null {
  if (args.length !== 2) return null;
  const key = recoveryKeyArg(args[0]);
  const text = args[1];
  if (key === null || typeof text !== 'string' || text.length > MAX_RECOVERY_BYTES) return null;
  return { key, text };
}

/** Arguments of a stash write: a key, a stash name and the bytes. Null when malformed or too large. */
export function recoveryStashArgs(args: readonly unknown[]): { key: string; name: string; bytes: ArrayBuffer } | null {
  if (args.length !== 3) return null;
  const key = recoveryKeyArg(args[0]);
  const name = recoveryStashNameArg(args[1]);
  const bytes = args[2];
  if (key === null || name === null || !(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_RECOVERY_BYTES) return null;
  return { key, name, bytes };
}

/** Arguments of a call that takes a key and a stash name (read). Null when malformed. */
export function recoveryStashReadArgs(args: readonly unknown[]): { key: string; name: string } | null {
  if (args.length !== 2) return null;
  const key = recoveryKeyArg(args[0]);
  const name = recoveryStashNameArg(args[1]);
  return key === null || name === null ? null : { key, name };
}

/** Arguments of a call that takes only a key (read, clear). Null when malformed. */
export function recoveryKeyOnlyArgs(args: readonly unknown[]): string | null {
  return args.length === 1 ? recoveryKeyArg(args[0]) : null;
}

/** Arguments of a clipboard write: exactly one string of bounded length. Returns the text, or null when malformed. */
export function clipboardTextArgs(args: readonly unknown[]): string | null {
  if (args.length !== 1) return null;
  const [text] = args;
  return typeof text === 'string' && text.length <= MAX_CLIPBOARD_CHARS ? text : null;
}

/** A list of openable paths sent to the renderer. Returns it validated, or null when any entry is not one. */
export function openPathsValue(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(isOpenablePath)) return null;
  return value as string[];
}


// ---- Batch jobs ------------------------------------------------------------------------------------------------------------

/** Limits of a job (blueprint A3). */
export const MAX_JOB_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_LEAF_NAME_LENGTH = 200;
const DEVICE_NAME = new RegExp(String.raw`^(con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3\u2074-\u2079]|lpt[1-9\u00b9\u00b2\u00b3\u2074-\u2079])$`, 'i');
/** Bidi override and isolate characters can make a name read as another one ("gpj.exe" shown as "exe.jpg"). */
const BIDI_CONTROL = new RegExp(String.raw`[\u202a-\u202e\u2066-\u2069]`);

/**
 * A leaf name main will create: ends in .pdf, at most 200 characters, none of \ / : * ? " < > | and no control characters,
 * not a reserved device name, no trailing dot or space before the extension.
 */
export function isValidLeafName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_LEAF_NAME_LENGTH) return false;
  if (!/\.pdf$/i.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  if (BIDI_CONTROL.test(name)) return false;
  const stem = name.slice(0, -4);
  if (stem.length === 0 || /[. ]$/.test(stem) || /^\s/.test(stem)) return false;
  return !DEVICE_NAME.test(stem.split('.')[0]!.trim());
}

/** A token handed out by main: 32 lowercase hex characters. */
export function isJobToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/** Arguments of jobs:begin: a target and the input paths (at most 600). Null when malformed. */
export function jobBeginArgs(args: readonly unknown[]): { target: JobTarget; inputPaths: string[] } | null {
  if (args.length !== 2) return null;
  const [target, inputs] = args;
  if (typeof target !== 'object' || target === null || !Array.isArray(inputs) || inputs.length > 600 || !inputs.every(isOpenablePath)) return null;
  const t = target as Record<string, unknown>;
  const keys = Object.keys(t);
  if (keys.length !== 1) return null;
  if (keys[0] === 'folderToken' && isJobToken(t.folderToken)) return { target: { folderToken: t.folderToken }, inputPaths: inputs };
  if (keys[0] === 'pickedPath' && isPdfPath(t.pickedPath)) return { target: { pickedPath: t.pickedPath }, inputPaths: inputs };
  return null;
}

/** Arguments of jobs:openFile: a job token and a leaf name. */
export function jobOpenFileArgs(args: readonly unknown[]): { jobToken: string; leafName: string } | null {
  if (args.length !== 2 || !isJobToken(args[0]) || !isValidLeafName(args[1])) return null;
  return { jobToken: args[0], leafName: args[1] };
}

/** Arguments of jobs:append: token, file id, sequence number and at most MAX_JOB_CHUNK_BYTES of bytes. */
export function jobAppendArgs(args: readonly unknown[]): { jobToken: string; fileId: number; seq: number; bytes: ArrayBuffer } | null {
  if (args.length !== 4) return null;
  const [jobToken, fileId, seq, bytes] = args;
  if (!isJobToken(jobToken) || !Number.isInteger(fileId) || !Number.isInteger(seq) || (seq as number) < 0) return null;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_JOB_CHUNK_BYTES) return null;
  return { jobToken, fileId: fileId as number, seq: seq as number, bytes };
}

/** Arguments of jobs:closeFile: token, file id, the byte length the worker says it sent. */
export function jobCloseFileArgs(args: readonly unknown[]): { jobToken: string; fileId: number; byteLength: number } | null {
  if (args.length !== 3) return null;
  const [jobToken, fileId, byteLength] = args;
  if (!isJobToken(jobToken) || !Number.isInteger(fileId) || !Number.isInteger(byteLength) || (byteLength as number) < 0) return null;
  return { jobToken, fileId: fileId as number, byteLength: byteLength as number };
}

/** A call that takes one token (commit, abort) or one result id (reveal, openResult). */
export function tokenArg(args: readonly unknown[]): string | null {
  return args.length === 1 && isJobToken(args[0]) ? args[0] : null;
}

/** Arguments of jobs:pickFolder: nothing, or one openable path to open the dialog near. */
export function pickFolderArgs(args: readonly unknown[]): { near: string | null } | null {
  if (args.length === 0) return { near: null };
  if (args.length === 1 && (args[0] === undefined || args[0] === null)) return { near: null };
  if (args.length === 1 && isOpenablePath(args[0])) return { near: args[0] };
  return null;
}

/** Arguments of jobs:pickOutputFile: a leaf name (the default file name) and, optionally, one openable path to open the dialog near. */
export function pickOutputFileArgs(args: readonly unknown[]): { leafName: string; near: string | null } | null {
  if (args.length < 1 || args.length > 2 || !isValidLeafName(args[0])) return null;
  const near = args[1];
  if (near === undefined || near === null) return { leafName: args[0], near: null };
  return isOpenablePath(near) ? { leafName: args[0], near } : null;
}

/** Arguments of jobs:describeInputs: a list of at most 600 openable paths. */
export function describeInputsArgs(args: readonly unknown[]): string[] | null {
  if (args.length !== 1) return null;
  const list = openPathsValue(args[0]);
  return list && list.length <= 600 ? list : null;
}
