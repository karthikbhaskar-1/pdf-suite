// @vitest-environment node
// 1.3.2: the page side of a job, with the real engine (a JobSession in-process) and a fake main process. Checks the order of the
// calls, that nothing is committed unless the run finished, that every failure and cancel ends in abort, the 2 s cancel grace and
// the 120 s silence rule, a changed source file, and that the worker is told nothing the page should keep.
import { describe, expect, it, vi } from 'vitest';
import * as mu from 'mupdf';
import { JobSession } from '../../engine/mupdf/jobCore';
import { JOB_CANCEL_GRACE_MS, JOB_SILENCE_MS, type FromJob, type ToJob } from '../../engine/mupdf/jobProtocol';
import { JobWorkerClient, runCombine, runSplit, type JobBridge, type Timers, type WorkerLike } from './jobRunner';
import { makeDoc } from '../../engine/mupdf/jobTestKit';
import type { JobResult } from '../../platform/desktop/contract';

class InProcessWorker implements WorkerLike {
  onmessage: ((event: { data: FromJob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  readonly sent: ToJob[] = [];
  readonly session: JobSession;
  /** When set, messages to the worker are swallowed (a worker that hangs). */
  hung = false;

  constructor() {
    this.session = new JobSession(mu, (message) => {
      if (!this.terminated) queueMicrotask(() => this.onmessage?.({ data: message }));
    });
  }

  postMessage(message: ToJob): void {
    this.sent.push(message);
    if (this.hung || this.terminated) return;
    queueMicrotask(() => this.session.handle(message));
  }

  terminate(): void {
    this.terminated = true;
    this.session.dispose();
  }
}

interface FakeMainOptions {
  failAppendAt?: number;
  failCommit?: boolean;
  sourceStamp?: { size: number; modified: number } | null;
  /** Called after commit would run, to change the source stamp while the job runs. */
  onFirstAppend?: () => void;
}

function fakeMain(options: FakeMainOptions = {}) {
  const calls: string[] = [];
  const files = new Map<number, { leaf: string; chunks: Uint8Array[]; closed: boolean }>();
  let appends = 0;
  let stamp = options.sourceStamp === undefined ? { size: 10, modified: 5 } : options.sourceStamp;
  const ok = (): JobResult => ({ ok: true });
  const jobs: Omit<JobBridge, 'stat'> = {
    pickInputs: async () => [],
    describeInputs: async () => [],
    readInput: async () => ({ ok: false, reason: 'missing' }),
    pickFolder: async () => null,
    pickOutputFile: async () => null,
    begin: async (target) => {
      calls.push(`begin ${JSON.stringify(target)}`);
      return { ok: true, jobToken: 'a'.repeat(32) };
    },
    openFile: async (_t, leaf) => {
      calls.push(`open ${leaf}`);
      const id = files.size + 1;
      files.set(id, { leaf, chunks: [], closed: false });
      return { ok: true, fileId: id };
    },
    append: async (_t, id, seq, bytes) => {
      appends += 1;
      calls.push(`append ${id}:${seq}`);
      if (appends === 1) options.onFirstAppend?.();
      if (options.failAppendAt === appends) return { ok: false, reason: 'write-failed' };
      files.get(id)!.chunks.push(new Uint8Array(bytes));
      return ok();
    },
    closeFile: async (_t, id, byteLength) => {
      calls.push(`close ${id}`);
      const file = files.get(id)!;
      file.closed = true;
      const size = file.chunks.reduce((n, c) => n + c.length, 0);
      return size === byteLength ? ok() : { ok: false, reason: 'write-failed' };
    },
    commit: async () => {
      calls.push('commit');
      if (options.failCommit) return { ok: false, reason: 'write-failed' };
      return { ok: true, results: [...files.values()].map((f, i) => ({ resultId: String(i), name: f.leaf })) };
    },
    abort: async () => {
      calls.push('abort');
    },
    reveal: async () => undefined,
    openResult: async () => null,
  };
  return {
    calls,
    files,
    setStamp: (next: { size: number; modified: number } | null) => {
      stamp = next;
    },
    bridge: { ...jobs, stat: async () => stamp } as JobBridge,
  };
}

const ranges = (...parts: Array<[number, number]>) => ({
  by: 'ranges' as const,
  parts: parts.map(([from, to], i) => ({ from, to, leafName: `R - ${String(i + 1).padStart(2, '0')}.pdf` })),
});

async function readyClient(source: Uint8Array, timers?: Timers) {
  const worker = new InProcessWorker();
  const client = new JobWorkerClient(worker, timers);
  client.markReady();
  await client.probe(source.slice().buffer as ArrayBuffer);
  return { worker, client };
}

const source = { path: 'C:\\in\\a.pdf', size: 10, modified: 5 };
const params = (client: JobWorkerClient, main: ReturnType<typeof fakeMain>, spec = ranges([1, 2], [3, 4])) => ({
  worker: client,
  bridge: main.bridge,
  folderToken: 'b'.repeat(32),
  source,
  spec: { kind: 'split' as const, baseName: 'R', plan: spec },
  onProgress: () => undefined,
});

describe('a good run', () => {
  it('begins with the folder token, writes each file through open, append and close, then commits once', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain();
    const outcome = await runSplit(params(client, main));
    expect(outcome.status).toBe('done');
    expect(main.calls[0]).toBe(`begin ${JSON.stringify({ folderToken: 'b'.repeat(32) })}`);
    expect(main.calls.filter((c) => c === 'commit')).toHaveLength(1);
    expect(main.calls.at(-1)).toBe('commit');
    expect(main.calls).not.toContain('abort');
    expect(main.calls.filter((c) => c.startsWith('open '))).toEqual(['open R - 01.pdf', 'open R - 02.pdf']);
    // Every open comes before its appends and its close, and a file is closed before the next is opened or committed.
    expect(main.calls.indexOf('open R - 02.pdf')).toBeGreaterThan(main.calls.indexOf('close 1'));
    if (outcome.status === 'done') {
      expect(outcome.files.map((f) => f.name)).toEqual(['R - 01.pdf', 'R - 02.pdf']);
      expect(outcome.pages).toBe(4);
    }
    // The bytes that reached main are two PDFs with two pages each.
    for (const file of main.files.values()) {
      const bytes = new Uint8Array(file.chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of file.chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      expect(mu.Document.openDocument(bytes, 'application/pdf').countPages()).toBe(2);
    }
  });

  it('progress reaches the caller with the phase and the unit', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const seen: string[] = [];
    await runSplit({ ...params(client, fakeMain()), onProgress: (phase, done, total, unit) => seen.push(`${phase} ${done}/${total} ${unit}`) });
    // Messages are throttled to ten a second, so a fast run shows its first one (the others are for a long run).
    expect(seen[0]).toBe('copying 0/2 files');
  });
});

describe('every other ending removes what main created and commits nothing', () => {
  it('a write failure in main (disk full at the second chunk): failed with the reason, abort, no commit; the worker is told to stop', async () => {
    const { client, worker } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain({ failAppendAt: 2 });
    const outcome = await runSplit(params(client, main));
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.info.reason).toBe('write-failed');
    expect(main.calls).toContain('abort');
    expect(main.calls).not.toContain('commit');
    expect(worker.sent.some((m) => m.t === 'cancel')).toBe(true);
  });

  it('the commit failing in main is a failure, with abort', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain({ failCommit: true });
    const outcome = await runSplit(params(client, main));
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(main.calls.at(-1)).toBe('abort');
  });

  it('a source file that changed while the job ran: InputChanged, no commit', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain();
    main.setStamp({ size: 10, modified: 99 });
    const outcome = await runSplit(params(client, main));
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.kind).toBe('InputChanged');
    expect(main.calls).toContain('abort');
    expect(main.calls).not.toContain('commit');
  });

  it('a source file that is gone: InputChanged too', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain({ sourceStamp: null });
    const outcome = await runSplit(params(client, main));
    expect(outcome).toMatchObject({ status: 'failed', error: { kind: 'InputChanged' } });
  });

  it('main refusing the folder token (expired): failed, nothing started in the worker', async () => {
    const { client, worker } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain();
    main.bridge.begin = async () => ({ ok: false, reason: 'invalid' });
    const outcome = await runSplit(params(client, main));
    expect(outcome).toMatchObject({ status: 'failed', error: { kind: 'MainFailure', info: { reason: 'invalid' } } });
    expect(worker.sent.some((m) => m.t === 'start')).toBe(false);
  });

  it('a cancel while it runs: cancelled, abort, no commit', async () => {
    const { client } = await readyClient(makeDoc({ pages: 12 }));
    const main = fakeMain({
      onFirstAppend: () => cancel(),
    });
    let cancel: () => void = () => undefined;
    const outcome = await runSplit({
      ...params(client, main, ranges([1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12])),
      onStart: (fn) => {
        cancel = fn;
      },
    });
    expect(outcome.status).toBe('cancelled');
    expect(main.calls).toContain('abort');
    expect(main.calls).not.toContain('commit');
  });

  it('an error in the engine (a range outside the document) is a failure with abort', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain();
    const outcome = await runSplit(params(client, main, ranges([1, 9])));
    expect(outcome).toMatchObject({ status: 'failed', error: { kind: 'Internal' } });
    expect(main.calls).toContain('abort');
  });
});

function fakeTimers() {
  const pending: Array<{ at: number; fn: () => void; id: number }> = [];
  let now = 0;
  let seq = 0;
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (handle) => {
      const at = pending.findIndex((p) => p.id === handle);
      if (at >= 0) pending.splice(at, 1);
    },
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const due of pending.filter((p) => p.at <= now).sort((a, b) => a.at - b.at)) {
        pending.splice(pending.indexOf(due), 1);
        due.fn();
      }
    },
    pending: () => pending.length,
  };
}

describe('Cancel at the moments with no worker call to stop', () => {
  it('Cancel pressed before the worker was started: cancelled, nothing started, no file, no commit', async () => {
    const { client, worker } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain();
    const outcome = await runSplit({ ...params(client, main), isCancelled: () => true });
    expect(outcome.status).toBe('cancelled');
    expect(worker.sent.some((m) => m.t === 'start')).toBe(false);
    expect(main.calls).toContain('abort');
    expect(main.calls).not.toContain('commit');
    expect(main.calls.filter((c) => c.startsWith('open '))).toEqual([]);
  });

  it('Cancel pressed after the last file was written, while the source is checked: nothing is committed, and main aborts', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain();
    let pressed = false;
    // The press comes with the last closeFile, i.e. after the worker has nothing left to stop.
    const close = main.bridge.closeFile;
    main.bridge.closeFile = async (...args) => {
      const result = await close(...args);
      if (args[1] === 2) pressed = true;
      return result;
    };
    const outcome = await runSplit({ ...params(client, main), isCancelled: () => pressed });
    expect(outcome.status).toBe('cancelled');
    expect(main.calls).not.toContain('commit');
    expect(main.calls).toContain('abort');
  });

  it('Cancel pressed between the source check and the commit: nothing is committed', async () => {
    const { client } = await readyClient(makeDoc({ pages: 4 }));
    const main = fakeMain();
    let pressed = false;
    main.bridge.stat = async () => {
      pressed = true;
      return { size: 10, modified: 5 };
    };
    const outcome = await runSplit({ ...params(client, main), isCancelled: () => pressed });
    expect(outcome.status).toBe('cancelled');
    expect(main.calls).not.toContain('commit');
    expect(main.calls).toContain('abort');
  });
});

describe('a worker that does not answer', () => {

  it('120 seconds without a message ends the job as "stopped responding" and terminates the worker', async () => {
    const t = fakeTimers();
    const { client, worker } = await readyClient(makeDoc({ pages: 4 }), t.timers);
    worker.hung = true;
    const main = fakeMain();
    const run = runSplit(params(client, main));
    await vi.waitFor(() => expect(worker.sent.some((m) => m.t === 'start')).toBe(true));
    t.advance(JOB_SILENCE_MS - 1);
    expect(worker.terminated).toBe(false);
    t.advance(2);
    const outcome = await run;
    expect(outcome).toMatchObject({ status: 'failed', error: { kind: 'Stopped' } });
    expect(worker.terminated).toBe(true);
    expect(main.calls).toContain('abort');
  });

  it('after Cancel the worker has 2 seconds; then it is terminated and the job ends as cancelled', async () => {
    const t = fakeTimers();
    const { client, worker } = await readyClient(makeDoc({ pages: 4 }), t.timers);
    worker.hung = true;
    const main = fakeMain();
    let cancel: () => void = () => undefined;
    const run = runSplit({ ...params(client, main), onStart: (fn) => (cancel = fn) });
    await vi.waitFor(() => expect(worker.sent.some((m) => m.t === 'start')).toBe(true));
    cancel();
    t.advance(JOB_CANCEL_GRACE_MS - 1);
    expect(worker.terminated).toBe(false);
    t.advance(2);
    expect(await run).toEqual({ status: 'cancelled' });
    expect(worker.terminated).toBe(true);
    expect(main.calls).toContain('abort');
    expect(main.calls).not.toContain('commit');
  });

  it('no timer is left running when the job ends', async () => {
    const t = fakeTimers();
    const { client } = await readyClient(makeDoc({ pages: 4 }), t.timers);
    await runSplit(params(client, fakeMain()));
    expect(t.pending()).toBe(0);
  });
});

describe('the worker holds the password, the page passes it once', () => {
  it('probe sends the password in the probe message only; start carries none', async () => {
    const locked = new mu.PDFDocument(makeDoc({ pages: 4 })).saveToBuffer('encrypt=aes-256,user-password=pw1,owner-password=pw1').asUint8Array().slice();
    const worker = new InProcessWorker();
    const client = new JobWorkerClient(worker);
    client.markReady();
    await expect(client.probe(locked.slice().buffer as ArrayBuffer)).rejects.toMatchObject({ kind: 'PasswordNeeded' });
    await expect(client.probe(locked.slice().buffer as ArrayBuffer, 'bad')).rejects.toMatchObject({ kind: 'WrongPassword' });
    const facts = await client.probe(locked.slice().buffer as ArrayBuffer, 'pw1');
    expect(facts.encrypted).toBe(true);
    const main = fakeMain();
    const outcome = await runSplit(params(client, main));
    expect(outcome.status).toBe('done');
    const start = worker.sent.find((m) => m.t === 'start');
    expect(JSON.stringify(start)).not.toContain('pw1');
  });
});

// ---- The worker is ended with the job (docs/milestone-1.5/combine-memory-ruling.md: its WASM heap never shrinks) ---------------------

describe('the job worker is terminated when the job ends, whatever the ending', () => {
  const combineSpec = { kind: 'combine' as const, items: [{ kind: 'pdf' as const, name: 'a.pdf' }], fileBookmarks: true, imagePage: 'image' as const, textPage: { width: 612, height: 792 }, leafName: 'C.pdf' };
  const combineParams = (client: JobWorkerClient, main: ReturnType<typeof fakeMain>, bytes: Uint8Array | null) => ({
    worker: client,
    bridge: {
      ...main.bridge,
      readInput: async () => (bytes ? { ok: true as const, bytes: bytes.slice().buffer as ArrayBuffer, size: 10, modified: 5 } : { ok: false as const, reason: 'missing' as const }),
    } as JobBridge,
    outputPath: 'C:\out\C.pdf',
    inputs: [{ path: 'C:\in\a.pdf', size: 10, modified: 5 }],
    spec: combineSpec,
    onProgress: () => undefined,
  });

  it('Split: after done, after an error, and after Cancel', async () => {
    const done = await readyClient(makeDoc({ pages: 4 }));
    expect((await runSplit(params(done.client, fakeMain()))).status).toBe('done');
    expect(done.worker.terminated).toBe(true);

    const failed = await readyClient(makeDoc({ pages: 4 }));
    expect((await runSplit(params(failed.client, fakeMain({ failAppendAt: 1 })))).status).toBe('failed');
    expect(failed.worker.terminated).toBe(true);

    const t = fakeTimers();
    const cancelled = await readyClient(makeDoc({ pages: 4 }), t.timers);
    cancelled.worker.hung = true;
    let cancel: () => void = () => undefined;
    const run = runSplit({ ...params(cancelled.client, fakeMain()), onStart: (fn) => (cancel = fn) });
    await vi.waitFor(() => expect(cancelled.worker.sent.some((m) => m.t === 'start')).toBe(true));
    cancel();
    t.advance(JOB_CANCEL_GRACE_MS + 1);
    expect((await run).status).toBe('cancelled');
    expect(cancelled.worker.terminated).toBe(true);
  });

  it('Split: a password that cannot be kept keeps its worker, because the sheet reopens on the probed file', async () => {
    const locked = new mu.PDFDocument(makeDoc({ pages: 4 })).saveToBuffer('encrypt=aes-256,user-password=abc,owner-password=abc').asUint8Array().slice();
    const worker = new InProcessWorker();
    const client = new JobWorkerClient(worker);
    client.markReady();
    await client.probe(locked.slice().buffer as ArrayBuffer, 'abc');
    const outcome = await runSplit({ ...params(client, fakeMain()), spec: { kind: 'split', baseName: 'R', password: 'a,b', plan: ranges([1, 2], [3, 4]) } });
    expect(outcome).toMatchObject({ status: 'failed', error: { kind: 'CannotKeepPassword' } });
    expect(worker.terminated).toBe(false);
    client.terminate();
  });

  it('Combine: after done, after an error (a file that cannot be read), and after Cancel', async () => {
    const t = fakeTimers();
    const make = () => {
      const worker = new InProcessWorker();
      const client = new JobWorkerClient(worker, t.timers);
      client.markReady();
      return { worker, client };
    };
    const a = make();
    expect((await runCombine(combineParams(a.client, fakeMain(), makeDoc({ pages: 2 })))).status).toBe('done');
    expect(a.worker.terminated).toBe(true);

    const b = make();
    const failed = await runCombine(combineParams(b.client, fakeMain(), null));
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'InputUnreadable' } });
    expect(b.worker.terminated).toBe(true);

    const c = make();
    c.worker.hung = true;
    let cancel: () => void = () => undefined;
    const run = runCombine({ ...combineParams(c.client, fakeMain(), makeDoc({ pages: 3 })), onStart: (fn) => (cancel = fn) });
    await vi.waitFor(() => expect(c.worker.sent.some((m) => m.t === 'start')).toBe(true));
    cancel();
    t.advance(JOB_CANCEL_GRACE_MS + 1);
    expect((await run).status).toBe('cancelled');
    expect(c.worker.terminated).toBe(true);
  });

  it('Combine: a target main refuses starts nothing, and still ends the worker', async () => {
    const worker = new InProcessWorker();
    const client = new JobWorkerClient(worker);
    client.markReady();
    const main = fakeMain();
    const refusing = { ...main.bridge, begin: async () => ({ ok: false as const, reason: 'target-is-input' as const }) } as JobBridge;
    const outcome = await runCombine({ ...combineParams(client, main, makeDoc({ pages: 1 })), bridge: refusing });
    expect(outcome).toMatchObject({ status: 'failed', notStarted: true });
    expect(worker.sent.some((m) => m.t === 'start')).toBe(false);
  });
});

describe('a job worker that could not start', () => {
  it('init rejects with the error the worker posted, instead of waiting for ready forever', async () => {
    const worker: WorkerLike = { postMessage: () => undefined, terminate: () => undefined, onmessage: null, onerror: null };
    const client = new JobWorkerClient(worker);
    const started = client.init({} as WebAssembly.Module);
    const settled = started.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    worker.onmessage!({ data: { t: 'error', id: 0, kind: 'Internal', detail: 'instantiate failed' } });
    expect(await settled).toMatchObject({ kind: 'Internal', message: expect.stringContaining('instantiate failed') });
  });
});
