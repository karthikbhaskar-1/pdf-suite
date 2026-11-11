import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { dirname, join, parse, basename } from 'node:path';
import {
  MAX_JOB_CHUNK_BYTES,
  isValidLeafName,
  type JobFailReason,
  type JobResult,
  type JobResultFile,
  type JobTarget,
} from '../../src/platform/desktop/contract';
import { grantKey } from './pathGrants';
import { canonicalSpelling } from './canonicalSpelling';

/**
 * Where a batch job (Split into Files, Combine) may write, held by the main process (blueprint A3).
 *
 *  - The page never names a folder. The main process shows the folder dialog and keeps `token -> folder`; the page sends
 *    `(token, leafName)`. A leaf name is validated here (`isValidLeafName`), so a name can never leave the folder.
 *  - Only NEW `.pdf` files are created, never an existing one and never a read. Each output is written as
 *    `.~pdfsuite-<uuid>.part`, flushed and size-checked, and only `commit` gives the files their names, all in one step: a
 *    name that is taken gets " (2)", " (3)" ... A failed commit removes everything the job created. (A path from a Save
 *    dialog is replaced, as a save does, because the user confirmed that in the dialog.)
 *  - A job token dies with the job (commit or abort). A folder token dies when a job that used it commits; a job that
 *    failed leaves it, so the sheet can run again. Both expire after FOLDER_TOKEN_TTL_MS.
 *  - `jobs-journal.json` lists every temp file before it is created. They are removed on abort, when the window is
 *    gone and at the next start. No user folder is ever scanned.
 */

/** A folder token stays valid this long after it was handed out. */
export const FOLDER_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Files one job may create (blueprint A3). */
export const MAX_FILES_PER_JOB = 2000;
/** Free space kept beyond the input size before a job starts. */
export const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/** The temp file name pattern. Only names of this form are ever removed by the journal clean-up. */
export const PART_NAME = /^\.~pdfsuite-[0-9a-f]{32}\.part$/;

/** The file operations the outputs use. Injected so tests can fail a write at a chosen chunk or fake a full disk. */
export interface OutputFs {
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
  access(path: string, mode: number): Promise<void>;
  /** Free bytes on the volume of `path`. */
  freeBytes(path: string): Promise<number>;
  /** Creates a new file; fails when it exists. */
  create(path: string): Promise<OutputHandle>;
  /** Gives a finished part its final name without replacing an existing file. Rejects with code EEXIST when the name is taken. */
  linkNew(part: string, target: string): Promise<void>;
  /** Gives a finished part its final name, replacing an existing file. */
  replace(part: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
}

export interface OutputHandle {
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export const realFs: OutputFs = {
  stat: (path) => fsPromises.stat(path),
  access: (path, mode) => fsPromises.access(path, mode),
  async freeBytes(path) {
    const info = await fsPromises.statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  },
  async create(path) {
    const handle = await fsPromises.open(path, 'wx');
    return {
      write: async (bytes) => {
        await handle.write(bytes);
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  async linkNew(part, target) {
    try {
      await fsPromises.link(part, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A volume that cannot make a hard link (a share, FAT): copy without replacing.
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'UNKNOWN') {
        await fsPromises.copyFile(part, target, fsPromises.constants.COPYFILE_EXCL);
        return;
      }
      throw error;
    }
    await fsPromises.rm(part, { force: true });
  },
  replace: (part, target) => fsPromises.rename(part, target),
  remove: (path) => fsPromises.rm(path, { force: true }),
  async readText(path) {
    try {
      return await fsPromises.readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: (path, text) => fsPromises.writeFile(path, text, 'utf8'),
};

export interface JobOutputsDeps {
  journalFile: string;
  fs?: OutputFs;
  now?: () => number;
  /** A 32-hex-character id. Injected for tests. */
  newId?: () => string;
  /** The write-granted form of a path the user picked in a Save dialog, or null (PathGrants.canonicalForWrite). */
  canonicalForWrite?: (path: string) => string | null;
  /** True when a document of this path is open in a tab. */
  isOpenDocument?: (path: string) => boolean;
  /**
   * The one spelling of a path (junctions, short names, long-path spellings, case resolved). ASYNCHRONOUS and time-limited, so a
   * job whose output (or input) is on a sleeping network share cannot block the main thread. Defaults to canonicalSpelling.
   */
  resolve?: (path: string) => Promise<string>;
  /** Every document open in a tab, for the same-file check. */
  openPaths?: () => readonly string[];
  /** Test mode only: the Nth append (1-based, counted over the whole run) fails with write-failed. */
  failAppendAt?: number;
}

interface PartFile {
  id: number;
  leafName: string;
  partPath: string;
  handle: OutputHandle | null;
  nextSeq: number;
  written: number;
  closed: boolean;
  /** The size check at close failed: this file must never be committed. */
  bad: boolean;
}

interface Job {
  token: string;
  dir: string;
  mode: 'new-names' | 'replace';
  /** Set for a job that writes one chosen path. */
  pickedTarget: string | null;
  folderToken: string | null;
  inputKeys: Set<string>;
  files: PartFile[];
  nextFileId: number;
  /** Final files this job has made during commit, removed again when the commit fails. */
  created: string[];
}

const fail = (reason: JobFailReason, drive?: string): { ok: false; reason: JobFailReason; drive?: string } =>
  drive === undefined ? { ok: false, reason } : { ok: false, reason, drive };

/** The drive letter of a Windows path ("C"), or undefined for another kind of path. */
export function driveOf(path: string): string | undefined {
  const root = parse(path).root;
  return /^[A-Za-z]:/.test(root) ? root[0]!.toUpperCase() : undefined;
}

/** "name.pdf" with " (2)" before the extension: "name (2).pdf", "name (3).pdf", ... */
export function numberedName(leafName: string, attempt: number): string {
  if (attempt <= 1) return leafName;
  return `${leafName.slice(0, -4)} (${attempt}).pdf`;
}

export class JobOutputs {
  private readonly fs: OutputFs;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly folders = new Map<string, { path: string; expires: number }>();
  private jobs = new Map<string, Job>();
  private results = new Map<string, string>();
  private journal = new Set<string>();
  private appends = 0;

  constructor(private readonly deps: JobOutputsDeps) {
    this.fs = deps.fs ?? realFs;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomBytes(16).toString('hex'));
  }

  // ---- folder tokens ------------------------------------------------------------------------------------------------

  /** Remembers a folder the user chose in the dialog and returns its token. The label is the folder's path, for display only. */
  registerFolder(path: string): { token: string; label: string } {
    const token = this.newId();
    this.folders.set(token, { path, expires: this.now() + FOLDER_TOKEN_TTL_MS });
    // A few at a time: the oldest go first.
    while (this.folders.size > 8) {
      const oldest = this.folders.keys().next().value;
      if (oldest === undefined) break;
      this.folders.delete(oldest);
    }
    return { token, label: path };
  }

  /** The folder of a token that has not expired, or null. */
  folderOf(token: string): string | null {
    const entry = this.folders.get(token);
    if (!entry) return null;
    if (this.now() > entry.expires) {
      this.folders.delete(token);
      return null;
    }
    return entry.path;
  }

  // ---- jobs ---------------------------------------------------------------------------------------------------------

  /**
   * Starts a job. Checks the target (a folder token that is alive and a folder that exists and can be written, or a Save dialog
   * path that holds a write grant and is neither an input nor open in a tab) and the free space (the inputs' size plus
   * a margin). Starting a job ends the result ids of the one before.
   */
  async begin(target: JobTarget, inputPaths: readonly string[]): Promise<JobResult<{ jobToken: string }>> {
    // One job at a time: a new one removes what an unfinished one left.
    await this.abortAll();
    this.results.clear();
    const inputKeys = new Set(inputPaths.map(grantKey));
    let dir: string;
    let pickedTarget: string | null = null;
    let folderToken: string | null = null;
    if ('folderToken' in target) {
      const folder = this.folderOf(target.folderToken);
      if (folder === null) return fail('invalid');
      dir = folder;
      folderToken = target.folderToken;
    } else {
      const canonical = this.deps.canonicalForWrite?.(target.pickedPath) ?? null;
      if (canonical === null) return fail('invalid');
      // Same file by another spelling (a junction, a short name, the long-path prefix, another case): the inputs and the open
      // documents are in the main process's canonical spelling, so the target is compared by TEXT first (no file-system call),
      // and only when that finds nothing is it resolved, once, asynchronously, and compared again by text.
      const openKeys = new Set((this.deps.openPaths?.() ?? []).map(grantKey));
      const refusal = (path: string): 'target-is-input' | 'target-open' | null => {
        const key = grantKey(path);
        if (inputKeys.has(key)) return 'target-is-input';
        if (this.deps.isOpenDocument?.(path) || openKeys.has(key)) return 'target-open';
        return null;
      };
      let refused = refusal(canonical);
      if (refused === null) {
        const resolved = await (this.deps.resolve ?? ((p: string) => canonicalSpelling(p)))(canonical);
        if (grantKey(resolved) !== grantKey(canonical)) refused = refusal(resolved);
      }
      if (refused !== null) return fail(refused);
      pickedTarget = canonical;
      dir = dirname(canonical);
    }
    try {
      const info = await this.fs.stat(dir);
      if (!info.isDirectory()) return fail('folder-not-writable');
      await this.fs.access(dir, 2);
    } catch {
      return fail('folder-not-writable');
    }
    let inputBytes = 0;
    for (const path of inputPaths) {
      try {
        inputBytes += (await this.fs.stat(path)).size;
      } catch {
        // A missing input is found when it is read.
      }
    }
    try {
      if ((await this.fs.freeBytes(dir)) < inputBytes + FREE_SPACE_MARGIN_BYTES) return fail('disk-full', driveOf(dir));
    } catch {
      // The free space cannot be read (some shares): the first write finds a full disk.
    }
    const token = this.newId();
    this.jobs.set(token, {
      token,
      dir,
      mode: pickedTarget === null ? 'new-names' : 'replace',
      pickedTarget,
      folderToken,
      inputKeys,
      files: [],
      nextFileId: 1,
      created: [],
    });
    return { ok: true, jobToken: token };
  }

  /** Creates the temp file for one output. `leafName` is validated again here. */
  async openFile(jobToken: string, leafName: string): Promise<JobResult<{ fileId: number }>> {
    const job = this.jobs.get(jobToken);
    if (!job || !isValidLeafName(leafName)) return fail('invalid');
    if (job.files.length >= MAX_FILES_PER_JOB) return fail('invalid');
    if (job.pickedTarget !== null && (job.files.length > 0 || basename(job.pickedTarget).toLowerCase() !== leafName.toLowerCase())) return fail('invalid');
    const partPath = join(job.dir, `.~pdfsuite-${this.newId()}.part`);
    try {
      // Listed before it exists, so a crash between the two still finds it.
      await this.addToJournal(partPath);
      const handle = await this.fs.create(partPath);
      const file: PartFile = { id: job.nextFileId++, leafName, partPath, handle, nextSeq: 0, written: 0, closed: false, bad: false };
      job.files.push(file);
      return { ok: true, fileId: file.id };
    } catch (error) {
      await this.dropFromJournal(partPath);
      return this.writeFailure(error, job.dir);
    }
  }

  /** Writes the next chunk of a file. Chunks arrive in order, one at a time, at most MAX_JOB_CHUNK_BYTES each. */
  async append(jobToken: string, fileId: number, seq: number, bytes: ArrayBuffer): Promise<JobResult> {
    const job = this.jobs.get(jobToken);
    const file = job?.files.find((f) => f.id === fileId);
    if (!job || !file || file.closed || !file.handle || seq !== file.nextSeq || bytes.byteLength > MAX_JOB_CHUNK_BYTES) return fail('invalid');
    this.appends += 1;
    if (this.deps.failAppendAt !== undefined && this.appends === this.deps.failAppendAt) return fail('write-failed');
    try {
      await file.handle.write(new Uint8Array(bytes));
      file.nextSeq += 1;
      file.written += bytes.byteLength;
      return { ok: true };
    } catch (error) {
      return this.writeFailure(error, job.dir);
    }
  }

  /** Flushes and closes a file, and checks that it holds exactly the bytes the worker says it sent. */
  async closeFile(jobToken: string, fileId: number, byteLength: number): Promise<JobResult> {
    const job = this.jobs.get(jobToken);
    const file = job?.files.find((f) => f.id === fileId);
    if (!job || !file || file.closed || !file.handle) return fail('invalid');
    try {
      await file.handle.sync();
      await file.handle.close();
      file.handle = null;
      file.closed = true;
      const size = (await this.fs.stat(file.partPath)).size;
      if (size !== byteLength || file.written !== byteLength) {
        file.bad = true;
        return fail('write-failed');
      }
      return { ok: true };
    } catch (error) {
      return this.writeFailure(error, job.dir);
    }
  }

  /**
   * Gives every finished file its name. New names never replace a file: a taken name gets " (2)", " (3)". When anything
   * fails, the files made so far are removed and so are the temp files: nothing is left half-made.
   */
  async commit(jobToken: string): Promise<JobResult<{ results: JobResultFile[] }>> {
    const job = this.jobs.get(jobToken);
    if (!job || job.files.length === 0 || job.files.some((f) => !f.closed || f.bad)) {
      if (job) await this.discard(job);
      return fail('invalid');
    }
    // The job leaves the table first: an abort during one of the awaits below must not find it and delete the file this commit has
    // just made (replace mode: the user's own file). The catch below cleans up what this commit made.
    this.jobs.delete(job.token);
    // The target may have been opened in a tab since begin: replacing a file a tab shows would make that document stale.
    if (job.mode === 'replace' && job.pickedTarget !== null && this.isOpenTarget(job.pickedTarget)) {
      await this.discard(job);
      return fail('target-open');
    }
    const named: JobResultFile[] = [];
    try {
      for (const file of job.files) {
        let finalPath: string;
        if (job.mode === 'replace') {
          finalPath = job.pickedTarget!;
          await this.fs.replace(file.partPath, finalPath);
        } else {
          finalPath = await this.linkUnique(job.dir, file.leafName, file.partPath);
        }
        job.created.push(finalPath);
        await this.dropFromJournal(file.partPath);
        const resultId = this.newId();
        this.results.set(resultId, finalPath);
        named.push({ resultId, name: basename(finalPath) });
      }
    } catch (error) {
      for (const made of job.created) await this.fs.remove(made).catch(() => undefined);
      for (const resultId of named.map((n) => n.resultId)) this.results.delete(resultId);
      await this.discard(job, { keepCreated: true });
      return this.writeFailure(error, job.dir);
    }
    this.jobs.delete(job.token);
    if (job.folderToken !== null) this.folders.delete(job.folderToken);
    return { ok: true, results: named };
  }

  /** Ends a job and removes its temp files (and any file its commit had made). Safe to call twice. */
  async abort(jobToken: string): Promise<void> {
    const job = this.jobs.get(jobToken);
    if (job) await this.discard(job);
  }

  /** Ends every job: the window closed or the renderer went away. */
  async abortAll(): Promise<void> {
    for (const job of [...this.jobs.values()]) await this.discard(job);
  }

  /** The path of a file a job created, for Show in folder and Open. Valid until the next job starts. */
  resultPath(resultId: string): string | null {
    return this.results.get(resultId) ?? null;
  }

  /**
   * Removes the temp files a crashed run left, from the journal only (no folder is scanned), and only names of the
   * temp form. Returns how many were removed.
   */
  async cleanupJournal(): Promise<number> {
    const text = await this.fs.readText(this.deps.journalFile);
    let listed: unknown = [];
    try {
      listed = text === null ? [] : JSON.parse(text);
    } catch {
      listed = [];
    }
    let removed = 0;
    if (Array.isArray(listed)) {
      for (const path of listed) {
        if (typeof path !== 'string' || !PART_NAME.test(basename(path))) continue;
        try {
          await this.fs.remove(path);
          removed += 1;
        } catch {
          // Left for the next start.
        }
      }
    }
    this.journal = new Set();
    await this.fs.writeText(this.deps.journalFile, '[]').catch(() => undefined);
    return removed;
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  /** True when a document of this path is open in a tab now (compared by text, no file-system call). */
  private isOpenTarget(path: string): boolean {
    if (this.deps.isOpenDocument?.(path)) return true;
    const key = grantKey(path);
    return (this.deps.openPaths?.() ?? []).some((open) => grantKey(open) === key);
  }

  private async linkUnique(dir: string, leafName: string, partPath: string): Promise<string> {
    for (let attempt = 1; attempt <= 1000; attempt++) {
      const target = join(dir, numberedName(leafName, attempt));
      try {
        await this.fs.linkNew(partPath, target);
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('No free file name');
  }

  private async discard(job: Job, options: { keepCreated?: boolean } = {}): Promise<void> {
    this.jobs.delete(job.token);
    for (const file of job.files) {
      try {
        await file.handle?.close();
      } catch {
        // Already closed.
      }
      file.handle = null;
      await this.fs.remove(file.partPath).catch(() => undefined);
      await this.dropFromJournal(file.partPath);
    }
    if (!options.keepCreated) for (const made of job.created) await this.fs.remove(made).catch(() => undefined);
  }

  private writeFailure(error: unknown, dir: string): { ok: false; reason: JobFailReason; drive?: string } {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOSPC' || code === 'EDQUOT') return fail('disk-full', driveOf(dir));
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return fail('folder-not-writable');
    return fail('write-failed');
  }

  private async addToJournal(path: string): Promise<void> {
    this.journal.add(path);
    await this.fs.writeText(this.deps.journalFile, JSON.stringify([...this.journal]));
  }

  private async dropFromJournal(path: string): Promise<void> {
    if (!this.journal.delete(path)) return;
    await this.fs.writeText(this.deps.journalFile, JSON.stringify([...this.journal])).catch(() => undefined);
  }
}
