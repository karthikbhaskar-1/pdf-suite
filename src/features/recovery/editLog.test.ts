// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from '../../engine/mupdf/editCore';
import { contentBytes } from '../../engine/mupdf/pageOps';
import type { PageEdit } from '../../engine/mupdf/protocol';
import { EditLog, isLegacyLog, parseEditLog, replayAllowed, replayLog, sourceOf, type LogPort } from './editLog';

/** A PDF of `pages` pages, each with a text marker, as bytes. */
function pdfBytes(marker: string, pages: number): ArrayBuffer {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < pages; i++) {
    pdf.insertPage(pdf.countPages(), pdf.addPage([0, 0, 612, 792], 0, {}, `0 g\n${10 + i} 10 ${20 + i} 20 re\nf % ${marker}${i}`));
  }
  const out = pdf.saveToBuffer('garbage=compact').asUint8Array().slice().buffer as ArrayBuffer;
  pdf.destroy();
  return out;
}

function openPdf(bytes: ArrayBuffer): mu.PDFDocument {
  return mu.Document.openDocument(new Uint8Array(bytes), 'application/pdf').asPDF()!;
}

/** An in-memory recovery folder: what the main process would hold on disk. */
function memoryPort() {
  const logs = new Map<string, string>();
  const stashes = new Map<string, ArrayBuffer>();
  const port: LogPort = {
    write: async (key, text) => {
      logs.set(key, text);
    },
    writeStash: async (_key, name, bytes) => {
      stashes.set(name, bytes.slice(0));
    },
    clear: async (key) => {
      logs.delete(key);
    },
  };
  return { logs, stashes, port };
}

const BASE_STAT = { size: 1234, modified: 1_700_000_000_000 };
const KEY = 'a'.repeat(64);
const PATH = 'C:\\docs\\base.pdf';

/** The page contents of every page, as text. Two documents with the same pages give the same list. */
function contentsOf(pdf: mu.PDFDocument): string[] {
  const out: string[] = [];
  for (let i = 0; i < pdf.countPages(); i++) out.push(new TextDecoder().decode(contentBytes(pdf.findPage(i))));
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('replay of a recovery log', () => {
  it('round trip: insertFrom still works after the source file is deleted, and the pages match', async () => {
    const base = pdfBytes('B', 4);
    const source = pdfBytes('S', 3);
    const { logs, stashes, port } = memoryPort();

    // Session A: the user inserts two pages of the source, and rotates the first page.
    const pdfA = openPdf(base);
    const sourcesA = new Map<string, mu.PDFDocument>();
    const coreA = new EditCore(pdfA, 4, true, { mu, sources: sourcesA });
    const logA = new EditLog(KEY, PATH, BASE_STAT, port);
    sourcesA.set('src1', openPdf(source));
    await logA.addSource('src1', source);
    const insert: PageEdit[] = [{ op: 'insertFrom', afterUid: '1', sourceDocId: 'src1', sourceUids: ['0', '2'] }];
    logA.record(insert, (await coreA.apply(insert)).uidSeed);
    const rotate: PageEdit[] = [{ op: 'rotate', uids: ['0'], degrees: 90 }];
    logA.record(rotate, (await coreA.apply(rotate)).uidSeed);
    await logA.flush();
    const expectedContents = contentsOf(pdfA);
    const expectedUids = coreA.pages().uids;

    // The source file is gone. Session B has only the base file and the recovery folder.
    sourcesA.clear();

    // Session B: the base file is opened again, and the log is replayed onto it.
    const logText = logs.get(KEY);
    expect(logText).toBeDefined();
    const file = parseEditLog(logText!)!;
    expect(file.steps.length).toBe(2);
    const pdfB = openPdf(base);
    const sourcesB = new Map<string, mu.PDFDocument>();
    const coreB = new EditCore(pdfB, 4, true, { mu, sources: sourcesB });
    let next = 0;
    const replay = await replayLog(
      file,
      async (name) => stashes.get(name)?.slice(0) ?? null,
      {
        attachSource: async (bytes) => {
          next += 1;
          const id = `live${next}`;
          sourcesB.set(id, openPdf(bytes));
          return id;
        },
        applyStep: async (edits, seed) => void (await coreB.apply(edits, undefined, seed)),
        undoStep: async () => coreB.undo(),
      },
    );

    expect(replay.applied).toBe(2);
    expect(coreB.pages().uids).toEqual(expectedUids);
    expect(contentsOf(pdfB)).toEqual(expectedContents);
    // Each replayed step is one undo step, as it was in the session.
    expect(coreB.history.canUndo).toBe(true);
    expect(coreB.pages().uids).toEqual(['0', '1', 'n1', 'n2', '2', '3']);
    coreB.undo();
    expect(coreB.pages().uids).toEqual(['0', '1', 'n1', 'n2', '2', '3']);
  });

  it('a failed replay is undone, so the document is left as it was', async () => {
    const base = pdfBytes('B', 2);
    const pdf = openPdf(base);
    const core = new EditCore(pdf, 2, true, { mu, sources: new Map() });
    const file = {
      version: 2 as const,
      path: PATH,
      base: BASE_STAT,
      stashes: [],
      steps: [[{ op: 'rotate', uids: ['0'], degrees: 90 }], [{ op: 'delete', uids: ['missing'] }]] as PageEdit[][],
      seeds: [0, 0],
    };
    await expect(
      replayLog(file, async () => null, {
        attachSource: async () => 'x',
        applyStep: async (edits, seed) => void (await core.apply(edits, undefined, seed)),
        undoStep: async () => core.undo(),
      }),
    ).rejects.toThrow();
    expect(core.history.canUndo).toBe(false);
    expect(core.pages().revs).toEqual([0, 0]);
  });

  it('refuses a replay when the file size differs from the log base', () => {
    const { port } = memoryPort();
    const log = new EditLog(KEY, PATH, BASE_STAT, port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    const file = parseEditLog(JSON.stringify(log.snapshot()))!;
    expect(replayAllowed(file, { size: BASE_STAT.size, modified: BASE_STAT.modified })).toBe(true);
    expect(replayAllowed(file, { size: BASE_STAT.size + 1, modified: BASE_STAT.modified })).toBe(false);
  });

  it('refuses a replay when the modified time differs, or the file is gone', () => {
    const { port } = memoryPort();
    const log = new EditLog(KEY, PATH, BASE_STAT, port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    const file = parseEditLog(JSON.stringify(log.snapshot()))!;
    expect(replayAllowed(file, { size: BASE_STAT.size, modified: BASE_STAT.modified + 1 })).toBe(false);
    expect(replayAllowed(file, null)).toBe(false);
  });

  it('parseEditLog rejects text this version did not write', () => {
    expect(parseEditLog('not json')).toBeNull();
    expect(parseEditLog(JSON.stringify({ version: 3 }))).toBeNull();
    expect(parseEditLog(JSON.stringify({ version: 1, path: PATH, base: BASE_STAT, stashes: [], steps: [{}], seeds: [0] }))).toBeNull();
  });
});

describe('writing the log (1.5.1 R1, R2)', () => {
  /** A port that records every write, with each one held until the test lets it go, so a write can be "in flight". */
  function heldPort() {
    const { logs, port } = memoryPort();
    const writes: string[] = [];
    const releases: Array<() => void> = [];
    const held: LogPort = {
      ...port,
      write: (key, text) => {
        writes.push(text);
        return new Promise<void>((resolve) => releases.push(() => { logs.set(key, text); resolve(); }));
      },
    };
    return { logs, writes, releases, held };
  }
  const stepsIn = (text: string) => parseEditLog(text)!.steps.length;

  it('one record is one write, started in the same tick, with the step already in it', () => {
    const writes: string[] = [];
    const log = new EditLog(KEY, PATH, BASE_STAT, { ...memoryPort().port, write: async (_k, text) => void writes.push(text) });
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    expect(writes).toHaveLength(1);
    expect(stepsIn(writes[0]!)).toBe(1);
  });

  it('three fast changes end with all three on disk, and a change that arrives during a write waits behind it', async () => {
    const { logs, writes, releases, held } = heldPort();
    const log = new EditLog(KEY, PATH, BASE_STAT, held);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    log.record([{ op: 'rotate', uids: ['1'], degrees: 90 }], 0);
    log.record([{ op: 'rotate', uids: ['2'], degrees: 90 }], 0);
    // The first write is running; the other two changes are not written one by one, only the newest waits.
    expect(writes).toHaveLength(1);
    expect(stepsIn(writes[0]!)).toBe(1);
    releases.shift()!();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(stepsIn(writes[1]!)).toBe(3);
    releases.shift()!();
    await log.flush();
    expect(stepsIn(logs.get(KEY)!)).toBe(3);
    expect(writes).toHaveLength(2);
  });

  it('undo, redo and discard each write the log', async () => {
    const { logs, port } = memoryPort();
    const writes: string[] = [];
    const log = new EditLog(KEY, PATH, BASE_STAT, { ...port, write: async (key, text) => { writes.push(text); await port.write(key, text); } });
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    log.record([{ op: 'rotate', uids: ['1'], degrees: 90 }], 0);
    await log.flush();
    const before = writes.length;
    log.undo();
    await log.flush();
    expect(writes.length).toBe(before + 1);
    expect(stepsIn(logs.get(KEY)!)).toBe(1);
    log.redo();
    await log.flush();
    expect(writes.length).toBe(before + 2);
    expect(stepsIn(logs.get(KEY)!)).toBe(2);
    log.discard();
    await log.flush();
    expect(writes.length).toBe(before + 3);
    expect(stepsIn(logs.get(KEY)!)).toBe(1);
    // After a discard the step is gone for good: a redo does nothing and writes nothing.
    log.redo();
    await log.flush();
    expect(writes.length).toBe(before + 3);
  });

  it('a first write that rejects does not stop the next change from writing, and the failure is reported once', async () => {
    const { logs, port } = memoryPort();
    let calls = 0;
    const failures: string[] = [];
    const log = new EditLog(
      KEY,
      PATH,
      BASE_STAT,
      { ...port, write: async (key, text) => { calls += 1; if (calls === 1) throw new Error('disk full'); await port.write(key, text); } },
      undefined,
      { onFailure: (reason) => failures.push(reason) },
    );
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    await log.flush();
    expect(failures).toEqual(['write']);
    expect(logs.has(KEY)).toBe(false);
    log.record([{ op: 'rotate', uids: ['1'], degrees: 90 }], 0);
    await log.flush();
    expect(stepsIn(logs.get(KEY)!)).toBe(2);
    expect(failures).toEqual(['write']);
  });

  it('a write that resolves false counts as failed, and a run of failures is reported once', async () => {
    const { port } = memoryPort();
    const failures: string[] = [];
    const log = new EditLog(KEY, PATH, BASE_STAT, { ...port, write: async () => false }, undefined, { onFailure: (r) => failures.push(r) });
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    log.record([{ op: 'rotate', uids: ['1'], degrees: 90 }], 0);
    await log.flush();
    log.record([{ op: 'rotate', uids: ['2'], degrees: 90 }], 0);
    await log.flush();
    expect(failures).toEqual(['write']);
  });

  it('a stash that is refused (false) or throws is reported, is not added to the log, and its step cannot be recorded', async () => {
    const { logs, port } = memoryPort();
    const failures: string[] = [];
    const log = new EditLog(KEY, PATH, BASE_STAT, { ...port, writeStash: async () => false }, undefined, { onFailure: (r) => failures.push(r) });
    expect(await log.addSource('src1', new ArrayBuffer(4))).toBe(false);
    expect(failures).toEqual(['stash']);
    expect(log.snapshot().stashes).toEqual([]);
    expect(() => log.record([{ op: 'insertFrom', afterUid: null, sourceDocId: 'src1', sourceUids: ['0'] }], 0)).toThrow(/no stash/);
    expect(log.applied).toBe(0);
    expect(logs.size).toBe(0);
    const throwing = new EditLog(KEY, PATH, BASE_STAT, { ...port, writeStash: async () => { throw new Error('locked'); } }, undefined, { onFailure: (r) => failures.push(r) });
    expect(await throwing.addSource('src1', new ArrayBuffer(4))).toBe(false);
    expect(failures).toEqual(['stash', 'stash']);
  });

  it('stopRecording writes the "logging stopped" marker once, keeps the steps, and ignores later changes', async () => {
    const { logs, port } = memoryPort();
    const log = new EditLog(KEY, PATH, BASE_STAT, port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    expect(await log.stopRecording()).toBe(true);
    const text = logs.get(KEY)!;
    expect(parseEditLog(text)).toMatchObject({ loggingStopped: true, steps: [[{ op: 'rotate', uids: ['0'], degrees: 90 }]] });
    log.record([{ op: 'rotate', uids: ['1'], degrees: 90 }], 0);
    log.undo();
    await log.flush();
    expect(logs.get(KEY)).toBe(text);
  });

  it('an undo moves the logged position back, and a new step drops the undone ones', async () => {
    const { logs, port } = memoryPort();
    const log = new EditLog(KEY, PATH, BASE_STAT, port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    log.record([{ op: 'rotate', uids: ['1'], degrees: 90 }], 0);
    log.undo();
    await log.flush();
    expect(parseEditLog(logs.get(KEY)!)!.steps.length).toBe(1);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 180 }], 0);
    expect(log.snapshot().steps.length).toBe(2);
  });

  it('clear removes the log, so nothing is restored after a save', async () => {
    const { logs, port } = memoryPort();
    const log = new EditLog(KEY, PATH, BASE_STAT, port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    await log.flush();
    expect(logs.has(KEY)).toBe(true);
    await log.clear();
    expect(logs.has(KEY)).toBe(false);
    expect(log.applied).toBe(0);
  });
});

describe('replay allocates the same uids as the live session (ticket 1.2.1 review, item 3)', () => {
  const sizeOf = (pdf: mu.PDFDocument) =>
    Array.from({ length: pdf.countPages() }, (_u, i) => pdf.loadPage(i).getBounds().map(Math.round).slice(2).join('x'));

  it('insert, undo, insert 2, delete one: the replay gives the same pages and uids', async () => {
    const base = pdfBytes('B', 3);
    const { logs, port } = memoryPort();
    const pdfA = openPdf(base);
    const coreA = new EditCore(pdfA, 3, true, { mu });
    const log = new EditLog(KEY, PATH, BASE_STAT, port);
    const apply = async (edits: PageEdit[]) => log.record(edits, (await coreA.apply(edits)).uidSeed);
    await apply([{ op: 'insertBlank', afterUid: '2', size: { width: 200, height: 200 }, template: 'blank', count: 1 }]);
    coreA.undo();
    log.undo();
    await apply([{ op: 'insertBlank', afterUid: '2', size: { width: 300, height: 300 }, template: 'blank', count: 2 }]);
    const doomed = coreA.pages().uids[3]!;
    await apply([{ op: 'delete', uids: [doomed] }]);
    await log.flush();
    const liveUids = coreA.pages().uids;
    const liveSizes = sizeOf(pdfA);

    const file = parseEditLog(logs.get(KEY)!)!;
    const pdfB = openPdf(base);
    const coreB = new EditCore(pdfB, 3, true, { mu });
    const replay = await replayLog(file, async () => null, {
      attachSource: async () => 'x',
      applyStep: async (edits, seed) => void (await coreB.apply(edits, undefined, seed)),
      undoStep: async () => coreB.undo(),
    });
    expect(replay.applied).toBe(2);
    expect(coreB.pages().uids).toEqual(liveUids);
    expect(sizeOf(pdfB)).toEqual(liveSizes);
  });

  it('the live counter does not rewind on undo, so a replay without the seed would name other uids', async () => {
    const base = pdfBytes('B', 3);
    const edit: PageEdit[] = [{ op: 'insertBlank', afterUid: '2', size: { width: 300, height: 300 }, template: 'blank', count: 2 }];
    const live = new EditCore(openPdf(base), 3, true, { mu });
    await live.apply([{ op: 'insertBlank', afterUid: '2', size: { width: 200, height: 200 }, template: 'blank', count: 1 }]);
    live.undo();
    const second = await live.apply(edit);
    expect(second.uidSeed).toBe(1);
    expect(live.pages().uids).toEqual(['0', '1', '2', 'n2', 'n3']);
    const fresh = new EditCore(openPdf(base), 3, true, { mu });
    await fresh.apply(edit);
    expect(fresh.pages().uids).toEqual(['0', '1', '2', 'n1', 'n2']);
    const seeded = new EditCore(openPdf(base), 3, true, { mu });
    await seeded.apply(edit, undefined, second.uidSeed);
    expect(seeded.pages().uids).toEqual(live.pages().uids);
  });

  it('a log from before seeds existed is recognised, never parsed for replay', () => {
    const legacy = JSON.stringify({ version: 1, path: PATH, base: BASE_STAT, stashes: [], steps: [[{ op: 'rotate', uids: ['0'], degrees: 90 }]] });
    expect(parseEditLog(legacy)).toBeNull();
    expect(isLegacyLog(legacy)).toBe(true);
    expect(isLegacyLog(JSON.stringify({ version: 1, steps: [] }))).toBe(false);
    expect(isLegacyLog('garbage')).toBe(false);
  });

  it('the seeds follow the steps through undo, redo and a new step', async () => {
    const { logs, port } = memoryPort();
    const log = new EditLog(KEY, PATH, BASE_STAT, port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 4);
    log.record([{ op: 'rotate', uids: ['1'], degrees: 90 }], 7);
    log.undo();
    log.record([{ op: 'rotate', uids: ['0'], degrees: 180 }], 9);
    await log.flush();
    expect(parseEditLog(logs.get(KEY)!)!.seeds).toEqual([4, 9]);
  });
});

describe('the content sample (1.5.1 R7)', () => {
  const sampled = { ...BASE_STAT, sample: 'abc123' };
  const made = () => {
    const log = new EditLog(KEY, PATH, sampled, memoryPort().port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    return parseEditLog(JSON.stringify(log.snapshot()))!;
  };

  it('is stored in the log base and survives a parse', () => {
    expect(made().base).toEqual(sampled);
  });

  it('a log with a sample is replayed only when the file has the same sample', () => {
    const file = made();
    expect(replayAllowed(file, { ...BASE_STAT, sample: 'abc123' })).toBe(true);
    // Same size and modified time, other content: the edits would land on the wrong pages.
    expect(replayAllowed(file, { ...BASE_STAT, sample: 'other' })).toBe(false);
    // The sample was asked for and the main process gave none: not the same proof, so no replay.
    expect(replayAllowed(file, { ...BASE_STAT })).toBe(false);
  });

  it('a log without a sample is replayed on size and modified time, as before', () => {
    const log = new EditLog(KEY, PATH, BASE_STAT, memoryPort().port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 0);
    const file = parseEditLog(JSON.stringify(log.snapshot()))!;
    expect(file.base).toEqual(BASE_STAT);
    expect(replayAllowed(file, { ...BASE_STAT })).toBe(true);
    expect(replayAllowed(file, { ...BASE_STAT, sample: 'whatever' })).toBe(true);
    expect(replayAllowed(file, { ...BASE_STAT, modified: BASE_STAT.modified + 1 })).toBe(false);
  });

  it('a log whose sample is not a string is not a log', () => {
    const bad = JSON.stringify({ version: 2, path: PATH, base: { ...BASE_STAT, sample: 7 }, stashes: [], steps: [], seeds: [] });
    expect(parseEditLog(bad)).toBeNull();
  });
});

describe('version 2 logs written before 1.5.1 still replay (the format additions are optional)', () => {
  // Exactly what the code before this ticket wrote (EditLog of commit 18f0467: addSource, an insertFrom, a rotate, a
  // delete, then an undo): no base.sample, no loggingStopped.
  const V2_LOG =
    '{"version":2,"path":"C:\\\\docs\\\\base.pdf","base":{"size":1234,"modified":1700000000000},"stashes":["stash-1.pdf"],' +
    '"steps":[[{"op":"insertFrom","afterUid":"1","sourceDocId":"stash-1.pdf","sourceUids":["0","2"]}],[{"op":"rotate","uids":["0"],"degrees":90}]],"seeds":[0,2]}';

  it('parses, passes the size-and-time check, and replays onto the same pages as a live session', async () => {
    const file = parseEditLog(V2_LOG);
    expect(file).not.toBeNull();
    expect(file!.base).toEqual({ size: 1234, modified: 1700000000000 });
    expect(file!.loggingStopped).toBeUndefined();
    expect(replayAllowed(file!, { size: 1234, modified: 1700000000000 })).toBe(true);
    expect(replayAllowed(file!, { size: 1234, modified: 1700000000000, sample: 'x' })).toBe(true);

    const base = pdfBytes('B', 4);
    const source = pdfBytes('S', 3);
    const live = new EditCore(openPdf(base), 4, true, { mu, sources: new Map([['src1', openPdf(source)]]) });
    await live.apply([{ op: 'insertFrom', afterUid: '1', sourceDocId: 'src1', sourceUids: ['0', '2'] }], undefined, 0);
    await live.apply([{ op: 'rotate', uids: ['0'], degrees: 90 }], undefined, 2);

    const pdf = openPdf(base);
    const sources = new Map<string, mu.PDFDocument>();
    const core = new EditCore(pdf, 4, true, { mu, sources });
    const replay = await replayLog(file!, async () => source.slice(0), {
      attachSource: async (bytes) => {
        sources.set('live1', openPdf(bytes));
        return 'live1';
      },
      applyStep: async (edits, seed) => void (await core.apply(edits, undefined, seed)),
      undoStep: async () => core.undo(),
    });
    expect(replay.applied).toBe(2);
    expect(core.pages().uids).toEqual(live.pages().uids);
  });

  it('a log written by the new code with no sample and never stopped is byte-for-byte the old shape', () => {
    const log = new EditLog(KEY, PATH, BASE_STAT, memoryPort().port);
    log.record([{ op: 'rotate', uids: ['0'], degrees: 90 }], 3);
    expect(Object.keys(log.snapshot()).sort()).toEqual(['base', 'path', 'seeds', 'stashes', 'steps', 'version']);
    expect(Object.keys(log.snapshot().base).sort()).toEqual(['modified', 'size']);
  });
});

describe('every kind of edit says whether it names a source (1.5.1 R11)', () => {
  it('insertFrom and replace name one; the others do not; a step with a source and no stash cannot be recorded', () => {
    expect(sourceOf({ op: 'insertFrom', afterUid: null, sourceDocId: 's', sourceUids: [] })).toBe('s');
    expect(sourceOf({ op: 'replace', uid: '0', sourceDocId: 's2', sourceUid: '0' })).toBe('s2');
    expect(sourceOf({ op: 'rotate', uids: ['0'], degrees: 90 })).toBeNull();
    expect(sourceOf({ op: 'delete', uids: ['0'] })).toBeNull();
    const log = new EditLog(KEY, PATH, BASE_STAT, memoryPort().port);
    expect(() => log.record([{ op: 'replace', uid: '0', sourceDocId: 'nope', sourceUid: '0' }], 0)).toThrow(/no stash/);
    expect(log.applied).toBe(0);
  });
});
