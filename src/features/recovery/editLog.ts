import type { PageEdit } from '../../engine/mupdf/protocol';
import { MAX_RECOVERY_BYTES } from '../../platform/desktop/contract';

/**
 * The recovery log of one document's unsaved page edits. Every apply is one step, and the steps are written to disk
 * (through the main process, atomically) at once, on every change, so a crash does not lose them: an edit is one user
 * action, not a stream, and the writes are queued one after another, so there is no delay to widen the loss window. The
 * log stores each source a step used (an insertFrom or replace) as a stash file, so replay does not depend on the source
 * file still existing.
 *
 * A log is replayed only when the base file still has the size and modified time it had when the edits began, and, when
 * the log carries a content sample, the same sample. The replay itself is in replayLog, which takes its engine calls as a
 * port, so it can be tested without a worker.
 *
 * Format: the log stays version 2. Two OPTIONAL fields were added in 1.5.1 (`base.sample` and `loggingStopped`). A
 * version 2 log written without them still parses and replays on size and modified time, exactly as before.
 */

/** What the log knows of a file: its size and modified time, and optionally a sample of its content. */
export interface FileStamp {
  size: number;
  modified: number;
  /** A hash of the first and last 64 KB of the file, made by the main process. Absent when it was not asked for. */
  sample?: string;
}

/** The log as stored. Source references are stash names, which outlive the worker's own source ids. */
export interface EditLogFile {
  /** 2: every step stores the uid counter it started from (`seeds`), so a replay allocates the same uids. */
  version: 2;
  /** The file the edits are on. */
  path: string;
  /** The file's size and modified time (and content sample, when known) when the first edit was made. */
  base: { size: number; modified: number; sample?: string };
  /** The stash files (source PDFs) the steps use, by name. */
  stashes: string[];
  /** The applied steps, in order. One step is one apply, so one undo step. */
  steps: PageEdit[][];
  /** The uid counter each step started from, one per step. Replay passes it back so uids are deterministic. */
  seeds: number[];
  /**
   * True when recording stopped after the last step (the document went on to use something the log cannot hold, such as a
   * password-protected PDF), so edits made later are not in the log. The log still replays up to here; the page says so
   * when it restores it. Absent in logs that never stopped.
   */
  loggingStopped?: true;
}

/**
 * What the log needs from the main process: writes, stashes and removal. A write that resolves false (the main process
 * refused or failed it) counts as failed, like one that rejects. Resolving with nothing counts as done, so an older main
 * process that returns nothing still works.
 */
export interface LogPort {
  write(key: string, text: string): Promise<boolean | void>;
  writeStash(key: string, name: string, bytes: ArrayBuffer): Promise<boolean | void>;
  clear(key: string): Promise<boolean | void>;
}

/** What replay needs from the engine: attach a source, and apply one step. */
export interface ReplayPort {
  attachSource(bytes: ArrayBuffer): Promise<string>;
  applyStep(edits: PageEdit[], uidSeed: number): Promise<void>;
}

/** What failed: the log text, or a stash (a source file) of a step. */
export type LogFailure = 'write' | 'stash';

/** Told what an EditLog could not do. */
export interface LogHooks {
  /**
   * A write or a stash failed. Called once per run of failures: it is called again only after a later write succeeded.
   * The log goes on trying (a queue that failed once is not stuck); the owner decides whether to stop recording.
   */
  onFailure?(reason: LogFailure): void;
}

/**
 * Which field of each edit kind names the live id of a source document, or null for a kind that uses no source. Every
 * kind of PageEdit must be listed: this table is a Record over all kinds, so a new kind (1.3.4 adds `overlay`) does not
 * compile until its author says whether it names a source. A kind that does and is left out would be recorded without its
 * stash, and could not be replayed.
 */
const SOURCE_FIELD: Record<PageEdit['op'], 'sourceDocId' | null> = {
  insertBlank: null,
  insertFrom: 'sourceDocId',
  delete: null,
  move: null,
  duplicate: null,
  rotate: null,
  crop: null,
  resize: null,
  replace: 'sourceDocId',
  reverse: null,
  slice: null,
  overlay: 'sourceDocId',
};

/** The source id an edit names, or null for an edit that uses no source. */
export function sourceOf(edit: PageEdit): string | null {
  const field = SOURCE_FIELD[edit.op];
  return field === null ? null : ((edit as unknown as Record<string, string>)[field] ?? null);
}

/** A copy of an edit with its source id replaced through `map`. */
function withSource(edit: PageEdit, map: (id: string) => string): PageEdit {
  const field = SOURCE_FIELD[edit.op];
  const id = sourceOf(edit);
  return field === null || id === null ? edit : ({ ...edit, [field]: map(id) } as PageEdit);
}

/** Parses a stored log. Null when the text is not a log this version wrote. */
export function parseEditLog(text: string): EditLogFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const file = value as Partial<EditLogFile>;
  const base = file.base;
  if (
    file.version !== 2 ||
    typeof file.path !== 'string' ||
    !base ||
    typeof base.size !== 'number' ||
    typeof base.modified !== 'number' ||
    (base.sample !== undefined && typeof base.sample !== 'string') ||
    !Array.isArray(file.stashes) ||
    !Array.isArray(file.steps) ||
    !file.steps.every((step) => Array.isArray(step)) ||
    !Array.isArray(file.seeds) ||
    file.seeds.length !== file.steps.length ||
    !file.seeds.every((seed) => Number.isInteger(seed) && seed >= 0)
  ) {
    return null;
  }
  return {
    version: 2,
    path: file.path,
    base: base.sample === undefined ? { size: base.size, modified: base.modified } : { size: base.size, modified: base.modified, sample: base.sample },
    stashes: [...file.stashes],
    steps: file.steps,
    seeds: [...file.seeds],
    ...(file.loggingStopped === true ? { loggingStopped: true as const } : {}),
  };
}

/**
 * True for a log an earlier version wrote (no uid seeds) that holds steps. Replaying it could hit the wrong pages, so
 * it is never replayed: the caller discards it and says so.
 */
export function isLegacyLog(text: string): boolean {
  try {
    const value = JSON.parse(text) as { version?: unknown; steps?: unknown };
    return value?.version === 1 && Array.isArray(value.steps) && value.steps.length > 0;
  } catch {
    return false;
  }
}

/**
 * True when the file on disk is the one the edits were made on: the same size and modified time, and the same content
 * sample when the log has one. A log written without a sample (an older log, or a file whose sample was not available)
 * is checked on size and modified time alone, so no earlier log is thrown away. Edits name pages by position, so a
 * different file with the same size and time would receive them on the wrong pages: the sample closes that gap.
 */
export function replayAllowed(file: EditLogFile, now: FileStamp | null): boolean {
  if (now === null || now.size !== file.base.size || now.modified !== file.base.modified) return false;
  return file.base.sample === undefined || now.sample === file.base.sample;
}

/**
 * Replays the applied steps of a log onto an open document. Each source the steps use is attached first, from its stash,
 * and each step is applied as one apply, so the undo history matches the steps. Returns the steps applied and the live
 * source id of each stash, so the new session's log can keep writing. On a failure the steps already applied are
 * undone, so the document is left as it was before the replay.
 */
export async function replayLog(
  file: EditLogFile,
  readStash: (name: string) => Promise<ArrayBuffer | null>,
  port: ReplayPort & { undoStep(): Promise<void> },
): Promise<{ applied: number; liveByStash: Map<string, string> }> {
  const liveByStash = new Map<string, string>();
  const liveIdsNeeded = new Set<string>();
  for (const step of file.steps) for (const edit of step) {
    const id = sourceOf(edit);
    if (id !== null) liveIdsNeeded.add(id);
  }
  let applied = 0;
  try {
    for (const name of liveIdsNeeded) {
      const bytes = await readStash(name);
      if (!bytes) throw new Error(`The stash ${name} is missing`);
      liveByStash.set(name, await port.attachSource(bytes));
    }
    for (const step of file.steps) {
      await port.applyStep(
        step.map((edit) => withSource(edit, (name) => liveByStash.get(name) ?? name)),
        file.seeds[applied] ?? 0,
      );
      applied += 1;
    }
  } catch (error) {
    for (let i = 0; i < applied; i++) await port.undoStep().catch(() => undefined);
    throw error;
  }
  return { applied, liveByStash };
}

/**
 * The live log of one open document. record(), undo(), redo() and discard() mirror the document's history, and every
 * change writes the log at once. Writes never overlap: while one is running, only the newest text waits behind it. A
 * write that fails does not stop the queue; it is reported through the hooks, and the next change writes again.
 * clear() removes the log, after a save or a discard.
 */
export class EditLog {
  private file: EditLogFile;
  /** The live source id of each stash, so a step's source can be stored by stash name. */
  private readonly stashByLive = new Map<string, string>();
  private readonly liveByStash = new Map<string, string>();
  private position: number;
  /** The text to write next, while a write is running. Only the newest is kept. */
  private waiting: string | null = null;
  /** The running write loop, or null when the queue is idle. */
  private draining: Promise<void> | null = null;
  private stashSeq: number;
  /** True once a failure was reported and no write has succeeded since, so one run of failures is reported once. */
  private failureReported = false;
  /** True after stopRecording: later changes are ignored. */
  private closed = false;
  /** True once stopRecording asked for the "logging stopped" marker, which every later write carries. */
  private stopped = false;
  /** Whether the latest finished write succeeded. */
  private lastWriteOk = true;

  constructor(
    private readonly key: string,
    path: string,
    base: FileStamp,
    private readonly port: LogPort,
    resumed?: { steps: PageEdit[][]; seeds: number[]; stashes: string[]; liveByStash: Map<string, string> },
    private readonly hooks: LogHooks = {},
  ) {
    this.file = {
      version: 2,
      path,
      base: base.sample === undefined ? { size: base.size, modified: base.modified } : { size: base.size, modified: base.modified, sample: base.sample },
      stashes: resumed ? [...resumed.stashes] : [],
      steps: resumed ? resumed.steps.map((step) => [...step]) : [],
      seeds: resumed ? [...resumed.seeds] : [],
    };
    this.position = this.file.steps.length;
    for (const [name, live] of resumed?.liveByStash ?? []) {
      this.liveByStash.set(name, live);
      this.stashByLive.set(live, name);
    }
    this.stashSeq = this.file.stashes.reduce((max, name) => Math.max(max, Number(/\d+/.exec(name)?.[0] ?? 0)), 0);
  }

  /** The recovery key the log is stored under. */
  get logKey(): string {
    return this.key;
  }

  /** Steps applied now, which the undo history counts. */
  get applied(): number {
    return this.position;
  }

  /** A copy of the log as it would be written. */
  snapshot(): EditLogFile {
    return JSON.parse(this.serialize()) as EditLogFile;
  }

  /**
   * Stores a source a step uses, before the step is recorded. The bytes are copied by the caller. Resolves true when the
   * stash is on disk. When the main process refuses or fails it, resolves false and reports the failure: the source is not
   * in the log, so a step that uses it must not be recorded.
   */
  async addSource(liveId: string, bytes: ArrayBuffer): Promise<boolean> {
    if (this.closed) return false;
    // The main process refuses a stash over this size (contract: MAX_RECOVERY_BYTES), so do not even send it: it counts as refused.
    if (bytes.byteLength > MAX_RECOVERY_BYTES) {
      this.report('stash');
      return false;
    }
    this.stashSeq += 1;
    const name = `stash-${this.stashSeq}.pdf`;
    let ok = false;
    try {
      ok = (await this.port.writeStash(this.key, name, bytes)) !== false;
    } catch {
      ok = false;
    }
    if (!ok) {
      this.report('stash');
      return false;
    }
    this.file.stashes.push(name);
    this.stashByLive.set(liveId, name);
    this.liveByStash.set(name, liveId);
    return true;
  }

  /**
   * Records an applied step. Steps that were undone are dropped, as the document's history drops them. Throws when a step
   * names a source that has no stash (nothing is recorded then).
   */
  record(edits: PageEdit[], uidSeed: number): void {
    if (this.closed) return;
    const stored = edits.map((edit) => withSource(edit, (live) => {
      const name = this.stashByLive.get(live);
      if (!name) throw new Error(`The source ${live} has no stash`);
      return name;
    }));
    this.file.steps.length = this.position;
    this.file.seeds.length = this.position;
    this.file.steps.push(stored);
    this.file.seeds.push(uidSeed);
    this.position += 1;
    this.requestWrite();
  }

  /** Mirrors an undo of the document. */
  undo(): void {
    if (this.closed || this.position === 0) return;
    this.position -= 1;
    this.requestWrite();
  }

  /** Mirrors a discard of the latest step: it is undone and can never be redone. */
  discard(): void {
    if (this.closed || this.position === 0) return;
    this.position -= 1;
    this.file.steps.length = this.position;
    this.file.seeds.length = this.position;
    this.requestWrite();
  }

  /** Mirrors a redo of the document. */
  redo(): void {
    if (this.closed || this.position >= this.file.steps.length) return;
    this.position += 1;
    this.requestWrite();
  }

  /** Resolves when every write asked for so far has finished (done or failed). Never rejects. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * Ends recording and marks the log on disk "logging stopped here", so the next start knows that edits made after its
   * last step are not in it. The steps already in the log stay and can be replayed. Later changes are ignored. Resolves
   * true when the marker was written.
   */
  async stopRecording(): Promise<boolean> {
    if (this.closed) return false;
    this.stopped = true;
    this.requestWrite();
    this.closed = true;
    await this.flush();
    return this.lastWriteOk;
  }

  /** Removes the log and its stashes. Pending changes are dropped. */
  async clear(): Promise<void> {
    this.waiting = null;
    this.file.steps = [];
    this.file.seeds = [];
    this.file.stashes = [];
    this.position = 0;
    this.stashByLive.clear();
    this.liveByStash.clear();
    this.stopped = false;
    await this.flush();
    await this.port.clear(this.key);
  }

  private serialize(): string {
    return JSON.stringify({
      ...this.file,
      steps: this.file.steps.slice(0, this.position),
      seeds: this.file.seeds.slice(0, this.position),
      ...(this.stopped ? { loggingStopped: true } : {}),
    });
  }

  /** Writes the log as it is now: at once when idle, else as the one write that follows the running one. */
  private requestWrite(): void {
    this.waiting = this.serialize();
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.waiting !== null) {
        const text = this.waiting;
        this.waiting = null;
        let ok = false;
        try {
          ok = (await this.port.write(this.key, text)) !== false;
        } catch {
          ok = false;
        }
        this.lastWriteOk = ok;
        if (ok) this.failureReported = false;
        else this.report('write');
      }
    } finally {
      this.draining = null;
    }
  }

  private report(reason: LogFailure): void {
    if (this.failureReported) return;
    this.failureReported = true;
    this.hooks.onFailure?.(reason);
  }
}
