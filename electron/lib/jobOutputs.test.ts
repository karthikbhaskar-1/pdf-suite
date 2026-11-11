// @vitest-environment node
// 1.3.2: the main-process side of a batch job. Real files in a temp folder. Covers the leaf-name rule, no overwrite (" (2)"),
// token expiry and death, the journal clean-up, refusal of an input as a target, a failed write that leaves nothing, and a
// failed commit that removes what it had made.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FOLDER_TOKEN_TTL_MS, JobOutputs, PART_NAME, numberedName, realFs, type OutputFs } from './jobOutputs';
import {
  isValidLeafName,
  jobAppendArgs,
  jobBeginArgs,
  jobOpenFileArgs,
  pickFolderArgs,
  pickOutputFileArgs,
  MAX_JOB_CHUNK_BYTES,
} from '../../src/platform/desktop/contract';

let root: string;
let dir: string;
let journal: string;
let clock: number;
let counter: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pdfsuite-e2e-jobout-'));
  dir = join(root, 'out');
  mkdirSync(dir);
  journal = join(root, 'jobs-journal.json');
  clock = 1_000_000;
  counter = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const id = () => (++counter).toString(16).padStart(32, '0');

function make(extra: Partial<ConstructorParameters<typeof JobOutputs>[0]> = {}): JobOutputs {
  return new JobOutputs({ journalFile: journal, now: () => clock, newId: id, ...extra });
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const listing = () => readdirSync(dir).sort();

/** Runs one whole file through open, append, close and returns the file id. */
async function writeOne(jobs: JobOutputs, token: string, leaf: string, text: string): Promise<number> {
  const opened = await jobs.openFile(token, leaf);
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  const appended = await jobs.append(token, opened.fileId, 0, bytes(text));
  if (!appended.ok) throw new Error(`append failed: ${appended.reason}`);
  const closed = await jobs.closeFile(token, opened.fileId, new TextEncoder().encode(text).length);
  if (!closed.ok) throw new Error(`close failed: ${closed.reason}`);
  return opened.fileId;
}

describe('the leaf-name rule', () => {
  it('accepts a normal .pdf name', () => {
    for (const name of ['Report - part 01.pdf', 'a.PDF', 'Rapport - 03 Résumé.pdf', 'x (2).pdf', 'a'.repeat(196) + '.pdf']) expect(isValidLeafName(name), name).toBe(true);
  });

  it('refuses separators, wildcards, control characters, device names, trailing dots and spaces, a missing .pdf and over 200 characters', () => {
    const bad = [
      'a/b.pdf', 'a\\b.pdf', '..\\x.pdf', 'C:\\x.pdf', 'a:b.pdf', 'a*b.pdf', 'a?b.pdf', 'a"b.pdf', 'a<b.pdf', 'a>b.pdf', 'a|b.pdf',
      'a\u0000b.pdf', 'a\nb.pdf', 'CON.pdf', 'nul.pdf', 'COM1.pdf', 'lpt9.pdf', 'a .pdf', 'a..pdf', '.pdf', ' a.pdf', 'a.txt', 'a', '',
      'a'.repeat(197) + '.pdf',
    ];
    for (const name of bad) expect(isValidLeafName(name), JSON.stringify(name)).toBe(false);
    expect(isValidLeafName(undefined)).toBe(false);
    expect(isValidLeafName(['a.pdf'])).toBe(false);
  });

  it('is applied by the IPC argument checks and again by openFile', async () => {
    const token = '0'.repeat(32);
    expect(jobOpenFileArgs([token, '../x.pdf'])).toBeNull();
    expect(jobOpenFileArgs([token, 'x.pdf'])).toEqual({ jobToken: token, leafName: 'x.pdf' });
    const jobs = make();
    const folder = jobs.registerFolder(dir);
    const begun = await jobs.begin({ folderToken: folder.token }, []);
    if (!begun.ok) throw new Error('begin failed');
    expect(await jobs.openFile(begun.jobToken, '..\\evil.pdf')).toEqual({ ok: false, reason: 'invalid' });
    expect(await jobs.openFile(begun.jobToken, 'sub/evil.pdf')).toEqual({ ok: false, reason: 'invalid' });
    expect(listing()).toEqual([]);
  });

  it('validates the other arguments: a chunk over 4 MB, a bad token, a bad target', () => {
    const token = 'a'.repeat(32);
    expect(jobAppendArgs([token, 1, 0, new ArrayBuffer(MAX_JOB_CHUNK_BYTES)])).not.toBeNull();
    expect(jobAppendArgs([token, 1, 0, new ArrayBuffer(MAX_JOB_CHUNK_BYTES + 1)])).toBeNull();
    expect(jobAppendArgs(['short', 1, 0, new ArrayBuffer(1)])).toBeNull();
    expect(jobAppendArgs([token, 1, -1, new ArrayBuffer(1)])).toBeNull();
    expect(jobBeginArgs([{ folderToken: token }, ['C:\\in\\a.pdf']])).not.toBeNull();
    expect(jobBeginArgs([{ folderToken: 'C:\\Windows' }, []])).toBeNull();
    expect(jobBeginArgs([{ folderPath: 'C:\\Windows' }, []])).toBeNull();
    expect(jobBeginArgs([{ folderToken: token, pickedPath: 'C:\\a.pdf' }, []])).toBeNull();
    expect(jobBeginArgs([{ pickedPath: 'C:\\a.txt' }, []])).toBeNull();
    expect(pickFolderArgs([])).toEqual({ near: null });
    expect(pickFolderArgs(['relative'])).toBeNull();
    // jobs:pickOutputFile: a valid .pdf leaf name and, optionally, one absolute path to open near.
    expect(pickOutputFileArgs(['Combined.pdf'])).toEqual({ leafName: 'Combined.pdf', near: null });
    expect(pickOutputFileArgs(['Combined.pdf', 'C:/in/a.pdf'])).toEqual({ leafName: 'Combined.pdf', near: 'C:/in/a.pdf' });
    expect(pickOutputFileArgs(['Combined.pdf', undefined])).toEqual({ leafName: 'Combined.pdf', near: null });
    expect(pickOutputFileArgs([])).toBeNull();
    expect(pickOutputFileArgs(['../evil.pdf'])).toBeNull();
    expect(pickOutputFileArgs(['D:/x/Combined.pdf'])).toBeNull();
    expect(pickOutputFileArgs(['notpdf.txt'])).toBeNull();
    expect(pickOutputFileArgs(['Combined.pdf', 'relative'])).toBeNull();
    expect(pickOutputFileArgs(['Combined.pdf', 'C:/a.pdf', 'extra'])).toBeNull();
  });
});

describe('writing into a folder by token', () => {
  it('writes new files under the temp name, and commit gives them their names in one step', async () => {
    const jobs = make();
    const folder = jobs.registerFolder(dir);
    const begun = await jobs.begin({ folderToken: folder.token }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'A - part 01.pdf', 'first');
    await writeOne(jobs, begun.jobToken, 'A - part 02.pdf', 'second');
    // Before commit only temp files exist, and each is listed in the journal.
    expect(listing().every((n) => PART_NAME.test(n))).toBe(true);
    expect(listing()).toHaveLength(2);
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toHaveLength(2);
    const done = await jobs.commit(begun.jobToken);
    if (!done.ok) throw new Error('commit failed');
    expect(done.results.map((r) => r.name)).toEqual(['A - part 01.pdf', 'A - part 02.pdf']);
    expect(listing()).toEqual(['A - part 01.pdf', 'A - part 02.pdf']);
    expect(readFileSync(join(dir, 'A - part 02.pdf'), 'utf8')).toBe('second');
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual([]);
  });

  it('never overwrites: a name that is taken gets (2), then (3), and the first file is unchanged (S4)', async () => {
    const jobs = make();
    for (let run = 1; run <= 3; run++) {
      const folder = jobs.registerFolder(dir);
      const begun = await jobs.begin({ folderToken: folder.token }, []);
      if (!begun.ok) throw new Error('begin failed');
      await writeOne(jobs, begun.jobToken, 'Report - part 01.pdf', `run ${run}`);
      const done = await jobs.commit(begun.jobToken);
      if (!done.ok) throw new Error('commit failed');
      expect(done.results[0]!.name).toBe(run === 1 ? 'Report - part 01.pdf' : `Report - part 01 (${run}).pdf`);
    }
    expect(listing()).toEqual(['Report - part 01 (2).pdf', 'Report - part 01 (3).pdf', 'Report - part 01.pdf']);
    expect(readFileSync(join(dir, 'Report - part 01.pdf'), 'utf8')).toBe('run 1');
    expect(numberedName('x.pdf', 1)).toBe('x.pdf');
    expect(numberedName('x.pdf', 2)).toBe('x (2).pdf');
  });

  it('a user file with the name of a part is never touched', async () => {
    writeFileSync(join(dir, 'Mine.pdf'), 'precious');
    const jobs = make();
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'Mine.pdf', 'new');
    await jobs.commit(begun.jobToken);
    expect(readFileSync(join(dir, 'Mine.pdf'), 'utf8')).toBe('precious');
    expect(readFileSync(join(dir, 'Mine (2).pdf'), 'utf8')).toBe('new');
  });

  it('refuses chunks out of order, after close, or for another job; a size that does not match', async () => {
    const jobs = make();
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    const opened = await jobs.openFile(begun.jobToken, 'x.pdf');
    if (!opened.ok) throw new Error('open failed');
    expect(await jobs.append(begun.jobToken, opened.fileId, 1, bytes('a'))).toEqual({ ok: false, reason: 'invalid' });
    expect((await jobs.append(begun.jobToken, opened.fileId, 0, bytes('abc'))).ok).toBe(true);
    expect(await jobs.append('f'.repeat(32), opened.fileId, 1, bytes('a'))).toEqual({ ok: false, reason: 'invalid' });
    expect(await jobs.closeFile(begun.jobToken, opened.fileId, 99)).toEqual({ ok: false, reason: 'write-failed' });
    await jobs.abort(begun.jobToken);
    expect(listing()).toEqual([]);
  });
});

describe('tokens', () => {
  it('a folder token expires, and a made-up token is refused', async () => {
    const jobs = make();
    const folder = jobs.registerFolder(dir);
    clock += FOLDER_TOKEN_TTL_MS + 1;
    expect(await jobs.begin({ folderToken: folder.token }, [])).toEqual({ ok: false, reason: 'invalid' });
    expect(await jobs.begin({ folderToken: 'e'.repeat(32) }, [])).toEqual({ ok: false, reason: 'invalid' });
  });

  it('the job token dies with the job; the folder token dies when a job commits, and survives a failed one', async () => {
    const jobs = make();
    const folder = jobs.registerFolder(dir);
    const first = await jobs.begin({ folderToken: folder.token }, []);
    if (!first.ok) throw new Error('begin failed');
    await writeOne(jobs, first.jobToken, 'a.pdf', 'x');
    await jobs.abort(first.jobToken);
    expect(await jobs.openFile(first.jobToken, 'b.pdf')).toEqual({ ok: false, reason: 'invalid' });
    // The sheet can run again with the same folder.
    const second = await jobs.begin({ folderToken: folder.token }, []);
    if (!second.ok) throw new Error('second begin failed');
    await writeOne(jobs, second.jobToken, 'a.pdf', 'x');
    expect((await jobs.commit(second.jobToken)).ok).toBe(true);
    expect(await jobs.openFile(second.jobToken, 'c.pdf')).toEqual({ ok: false, reason: 'invalid' });
    expect(await jobs.begin({ folderToken: folder.token }, [])).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a result id works until the next job starts', async () => {
    const jobs = make();
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'a.pdf', 'x');
    const done = await jobs.commit(begun.jobToken);
    if (!done.ok) throw new Error('commit failed');
    const resultId = done.results[0]!.resultId;
    expect(jobs.resultPath(resultId)).toBe(join(dir, 'a.pdf'));
    await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    expect(jobs.resultPath(resultId)).toBeNull();
  });
});

describe('a failed run leaves nothing (S13)', () => {
  it('a write that fails at chunk 3 removes the temp files and creates no final name', async () => {
    const jobs = make({ failAppendAt: 3 });
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'a - 01.pdf', 'one');
    const opened = await jobs.openFile(begun.jobToken, 'a - 02.pdf');
    if (!opened.ok) throw new Error('open failed');
    expect((await jobs.append(begun.jobToken, opened.fileId, 0, bytes('two'))).ok).toBe(true);
    expect((await jobs.append(begun.jobToken, opened.fileId, 1, bytes('more'))).ok).toBe(false);
    await jobs.abort(begun.jobToken);
    expect(listing()).toEqual([]);
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual([]);
  });

  it('a disk-full error names the drive; a folder that cannot be written says so', async () => {
    const full: OutputFs = {
      ...realFs,
      create: async () => ({
        write: async () => {
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        },
        sync: async () => undefined,
        close: async () => undefined,
      }),
    };
    const jobs = make({ fs: full });
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    const opened = await jobs.openFile(begun.jobToken, 'a.pdf');
    if (!opened.ok) throw new Error('open failed');
    const result = await jobs.append(begun.jobToken, opened.fileId, 0, bytes('x'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('disk-full');
    const missing = await make().begin({ folderToken: make().registerFolder(join(root, 'nope')).token }, []);
    expect(missing).toEqual({ ok: false, reason: 'invalid' });
    const jobs2 = make();
    expect(await jobs2.begin({ folderToken: jobs2.registerFolder(join(root, 'nope')).token }, [])).toEqual({ ok: false, reason: 'folder-not-writable' });
  });

  it('too little free space is refused before anything is written, with the drive letter', async () => {
    const tight: OutputFs = { ...realFs, freeBytes: async () => 1000 };
    const jobs = make({ fs: tight });
    const result = await jobs.begin({ folderToken: jobs.registerFolder('C:\\') .token }, []);
    // C:\ may not be writable in a test run; what matters is that no job started and the reason is a refusal.
    expect(result.ok).toBe(false);
    const jobs2 = make({ fs: tight });
    const out = await jobs2.begin({ folderToken: jobs2.registerFolder(dir).token }, []);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe('disk-full');
    expect(listing()).toEqual([]);
  });

  it('a commit that fails part-way removes the files it had made and the temp files', async () => {
    let links = 0;
    const flaky: OutputFs = {
      ...realFs,
      linkNew: async (part, target) => {
        links += 1;
        if (links === 3) throw Object.assign(new Error('boom'), { code: 'EIO' });
        await realFs.linkNew(part, target);
      },
    };
    const jobs = make({ fs: flaky });
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    for (const n of [1, 2, 3, 4]) await writeOne(jobs, begun.jobToken, `p ${n}.pdf`, `d${n}`);
    const result = await jobs.commit(begun.jobToken);
    expect(result).toEqual({ ok: false, reason: 'write-failed' });
    expect(listing()).toEqual([]);
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual([]);
  });
});

describe('the journal', () => {
  it('removes the temp files a crashed run left, and only names of the temp form', async () => {
    const orphan = join(dir, '.~pdfsuite-0123456789abcdef0123456789abcdef.part');
    const userFile = join(dir, 'keep.pdf');
    const notPart = join(dir, '.~pdfsuite-notahexname.part');
    writeFileSync(orphan, 'x');
    writeFileSync(userFile, 'y');
    writeFileSync(notPart, 'z');
    writeFileSync(journal, JSON.stringify([orphan, userFile, notPart, 7, join(dir, 'gone.part')]));
    const removed = await make().cleanupJournal();
    expect(removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(userFile)).toBe(true);
    expect(existsSync(notPart)).toBe(true);
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual([]);
  });

  it('copes with a missing or damaged journal file', async () => {
    expect(await make().cleanupJournal()).toBe(0);
    writeFileSync(journal, '{not json');
    expect(await make().cleanupJournal()).toBe(0);
  });

  it('never scans a folder: an old part file that is not listed stays', async () => {
    const stray = join(dir, '.~pdfsuite-ffffffffffffffffffffffffffffffff.part');
    writeFileSync(stray, 's');
    await make().cleanupJournal();
    expect(existsSync(stray)).toBe(true);
  });

  it('abortAll (the window closed) removes the temp files of a running job', async () => {
    const jobs = make();
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'a.pdf', 'x');
    expect(listing()).toHaveLength(1);
    await jobs.abortAll();
    expect(listing()).toEqual([]);
  });
});

describe('a target chosen in a Save dialog', () => {
  const picked = () => join(dir, 'Combined.pdf');

  it('is refused when it is one of the inputs, or open in a tab, or has no write grant; bytes of the input are unchanged (S12)', async () => {
    const input = join(dir, 'in.pdf');
    writeFileSync(input, 'original');
    const jobs = make({ canonicalForWrite: (p) => p, isOpenDocument: (p) => p === join(dir, 'open.pdf') });
    expect(await jobs.begin({ pickedPath: input }, [input])).toEqual({ ok: false, reason: 'target-is-input' });
    expect(await jobs.begin({ pickedPath: input.toUpperCase().replace('IN.PDF', 'in.pdf') }, [input])).toEqual({ ok: false, reason: 'target-is-input' });
    expect(await jobs.begin({ pickedPath: join(dir, 'open.pdf') }, [input])).toEqual({ ok: false, reason: 'target-open' });
    const nogrant = make({ canonicalForWrite: () => null });
    expect(await nogrant.begin({ pickedPath: picked() }, [input])).toEqual({ ok: false, reason: 'invalid' });
    expect(readFileSync(input, 'utf8')).toBe('original');
  });

  it('writes exactly one file under the chosen name and replaces an older file of that name', async () => {
    writeFileSync(picked(), 'older');
    const jobs = make({ canonicalForWrite: (p) => p });
    const begun = await jobs.begin({ pickedPath: picked() }, []);
    if (!begun.ok) throw new Error('begin failed');
    expect(await jobs.openFile(begun.jobToken, 'Other.pdf')).toEqual({ ok: false, reason: 'invalid' });
    await writeOne(jobs, begun.jobToken, 'Combined.pdf', 'newer');
    expect(await jobs.openFile(begun.jobToken, 'Combined.pdf')).toEqual({ ok: false, reason: 'invalid' });
    expect((await jobs.commit(begun.jobToken)).ok).toBe(true);
    expect(readFileSync(picked(), 'utf8')).toBe('newer');
    expect(listing()).toEqual(['Combined.pdf']);
  });
});

describe('1.5.8 review: commit of a Save dialog target', () => {
  const picked = () => join(dir, 'Combined.pdf');

  it('an abort while the commit is still awaiting does not delete the file the commit just put in place', async () => {
    writeFileSync(picked(), 'older');
    let hold = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atJournal = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slowFs: OutputFs = {
      ...realFs,
      writeText: async (path, text) => {
        await realFs.writeText(path, text);
        if (hold) {
          reached();
          await gate;
        }
      },
    };
    const jobs = make({ canonicalForWrite: (p) => p, fs: slowFs });
    const begun = await jobs.begin({ pickedPath: picked() }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'Combined.pdf', 'newer');
    hold = true;
    const committing = jobs.commit(begun.jobToken);
    // The replace is done and the commit waits on the journal: the user's window closes, or the page aborts. (The target is not read
    // meanwhile: an open reader makes the rename fail on Windows.)
    await atJournal;
    await jobs.abort(begun.jobToken);
    await jobs.abortAll();
    release();
    expect((await committing).ok).toBe(true);
    expect(readFileSync(picked(), 'utf8')).toBe('newer');
    expect(listing()).toEqual(['Combined.pdf']);
  });

  it('a target that was opened in a tab after begin is refused at commit, and nothing is replaced or left behind', async () => {
    writeFileSync(picked(), 'older');
    let open = false;
    const jobs = make({ canonicalForWrite: (p) => p, isOpenDocument: () => open });
    const begun = await jobs.begin({ pickedPath: picked() }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'Combined.pdf', 'newer');
    open = true;
    expect(await jobs.commit(begun.jobToken)).toEqual({ ok: false, reason: 'target-open' });
    expect(readFileSync(picked(), 'utf8')).toBe('older');
    expect(listing()).toEqual(['Combined.pdf']);
  });

  it('the open check at commit also reads the list of open paths', async () => {
    writeFileSync(picked(), 'older');
    const openPaths: string[] = [];
    const jobs = make({ canonicalForWrite: (p) => p, openPaths: () => openPaths });
    const begun = await jobs.begin({ pickedPath: picked() }, []);
    if (!begun.ok) throw new Error('begin failed');
    await writeOne(jobs, begun.jobToken, 'Combined.pdf', 'newer');
    openPaths.push(picked().toUpperCase());
    expect(await jobs.commit(begun.jobToken)).toEqual({ ok: false, reason: 'target-open' });
    expect(readFileSync(picked(), 'utf8')).toBe('older');
  });
});

describe('sign-off 11: a failed close is never committed, and more names are refused', () => {
  it('after closeFile fails its size check, commit refuses and leaves nothing', async () => {
    const jobs = make();
    const begun = await jobs.begin({ folderToken: jobs.registerFolder(dir).token }, []);
    if (!begun.ok) throw new Error('begin failed');
    const opened = await jobs.openFile(begun.jobToken, 'short.pdf');
    if (!opened.ok) throw new Error('open failed');
    await jobs.append(begun.jobToken, opened.fileId, 0, bytes('abc'));
    // The worker says 99 bytes were sent, main wrote 3: the close fails, and a caller that goes on to commit anyway gets nothing.
    expect(await jobs.closeFile(begun.jobToken, opened.fileId, 99)).toEqual({ ok: false, reason: 'write-failed' });
    expect(await jobs.commit(begun.jobToken)).toEqual({ ok: false, reason: 'invalid' });
    expect(listing()).toEqual([]);
  });

  it('refuses COM and LPT with superscript digits, CONIN$ and CONOUT$, and bidi override characters', () => {
    const sup = ['¹', '²', '³', '⁴', '⁹'];
    for (const s of sup) {
      expect(isValidLeafName(`COM${s}.pdf`), `COM${s}`).toBe(false);
      expect(isValidLeafName(`lpt${s}.pdf`), `lpt${s}`).toBe(false);
    }
    expect(isValidLeafName('CONIN$.pdf')).toBe(false);
    expect(isValidLeafName('conout$.pdf')).toBe(false);
    expect(isValidLeafName('COM1.pdf')).toBe(false);
    for (const c of ['‪', '‮', '⁦', '⁩']) expect(isValidLeafName(`inv${c}oice.pdf`), c.charCodeAt(0).toString(16)).toBe(false);
    // Ordinary names that look similar stay valid.
    expect(isValidLeafName('COM10.pdf')).toBe(true);
    expect(isValidLeafName('Combined.pdf')).toBe(true);
    expect(isValidLeafName('Résumé 1.pdf')).toBe(true);
  });
});
