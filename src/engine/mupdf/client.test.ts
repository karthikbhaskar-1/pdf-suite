// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PdfOpenError } from '../errors';
import { WorkerClient, toError } from './client';
import { Priority, type Request } from './protocol';

/** A stand-in for a Worker that records what it is sent and lets the test send replies back. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Request[] = [];
  terminated = false;

  postMessage(message: Request): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: unknown): void {
    this.onmessage?.({ data: message });
  }
}

function setup() {
  const worker = new FakeWorker();
  const client = new WorkerClient(worker as unknown as Worker);
  return { worker, client };
}

describe('WorkerClient requests', () => {
  it('resolves a request with the reply that has its id, and gives each request a new id', async () => {
    const { worker, client } = setup();
    const first = client.request<number>({ op: 'stats' }, Priority.Visible);
    const second = client.request<number>({ op: 'outline' }, Priority.Visible);
    const [a, b] = worker.sent;
    expect(a!.id).not.toBe(b!.id);
    expect(a!.pri).toBe(Priority.Visible);
    worker.reply({ id: b!.id, ok: true, version: 1, result: 2 });
    worker.reply({ id: a!.id, ok: true, version: 1, result: 1 });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  it('turns an open error reply into the typed PdfOpenError the app already handles', async () => {
    const { worker, client } = setup();
    const pending = client.request({ op: 'open', bytes: new ArrayBuffer(4) }, Priority.Visible);
    worker.reply({ id: worker.sent[0]!.id, ok: false, version: 0, error: { kind: 'WrongPassword', message: 'x' } });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfOpenError);
    expect((error as PdfOpenError).kind).toBe('WrongPassword');
  });

  it('aborting a request cancels it in the worker and rejects with an AbortError', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const pending = client.request({ op: 'render', args: { page: 0, scale: 1, rotation: 0 } }, Priority.Visible, {
      signal: controller.signal,
    });
    const id = worker.sent[0]!.id;
    controller.abort();
    const error = (await pending.catch((e: unknown) => e)) as Error;
    expect(error.name).toBe('AbortError');
    const cancel = worker.sent[1]!;
    expect(cancel).toMatchObject({ op: 'cancel', target: id });
  });

  it('a reply for a cancelled request is ignored', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const pending = client.request({ op: 'stats' }, Priority.Visible, { signal: controller.signal });
    const id = worker.sent[0]!.id;
    controller.abort();
    await pending.catch(() => undefined);
    expect(() => worker.reply({ id, ok: true, version: 1, result: 'late' })).not.toThrow();
  });

  it('an already aborted signal rejects without sending anything', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.request({ op: 'stats' }, Priority.Visible, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(worker.sent).toHaveLength(0);
  });
});

describe('WorkerClient abort listeners', () => {
  it('removes the abort listener when a request resolves, so none accumulate on a long-lived signal', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    for (let i = 0; i < 200; i++) {
      const pending = client.request<number>({ op: 'stats' }, Priority.Visible, { signal: controller.signal });
      const id = worker.sent.at(-1)!.id;
      worker.reply({ id, ok: true, version: 1, result: i });
      await expect(pending).resolves.toBe(i);
    }
    expect(add).toHaveBeenCalledTimes(200);
    expect(remove).toHaveBeenCalledTimes(200);
    // The listeners are gone: aborting now posts no cancel to the worker.
    const sent = worker.sent.length;
    controller.abort();
    expect(worker.sent).toHaveLength(sent);
  });

  it('removes the listener when a request fails or is cancelled, too', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const failed = client.request({ op: 'open', bytes: new ArrayBuffer(4) }, Priority.Visible, { signal: controller.signal });
    worker.reply({ id: worker.sent[0]!.id, ok: false, version: 0, error: { kind: 'Corrupt', message: 'x' } });
    await failed.catch(() => undefined);
    const shutdownAsked = client.request({ op: 'stats' }, Priority.Visible, { signal: controller.signal });
    client.terminate();
    await shutdownAsked.catch(() => undefined);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe('WorkerClient events and shutdown', () => {
  it('delivers events that arrived before a handler was set, in order', () => {
    const { worker, client } = setup();
    worker.reply({ event: 'pages', version: 1, uids: ['0'], revs: [0], history: { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } });
    worker.reply({ event: 'sizes', from: 0, sizes: new Float32Array([612, 792, 0]) });
    const seen: string[] = [];
    client.onEvent((event) => seen.push(event.event));
    worker.reply({ event: 'sizes', from: 1, sizes: new Float32Array([1, 1, 0]) });
    expect(seen).toEqual(['pages', 'sizes', 'sizes']);
  });

  it('terminating rejects the requests still waiting and stops the worker', async () => {
    const { worker, client } = setup();
    const pending = client.request({ op: 'outline' }, Priority.Visible);
    client.terminate();
    await expect(pending).rejects.toBeDefined();
    expect(worker.terminated).toBe(true);
    await expect(client.request({ op: 'stats' }, Priority.Visible)).rejects.toThrow('closed');
  });
});

describe('toError', () => {
  it('maps cancellation to an AbortError and open failures to PdfOpenError', () => {
    expect(toError('Cancelled', 'x').name).toBe('AbortError');
    expect(toError('NotPdf', 'x')).toBeInstanceOf(PdfOpenError);
    expect((toError('Corrupt', 'x') as PdfOpenError).kind).toBe('Corrupt');
  });

  it('keeps other faults as plain errors named by their kind', () => {
    const error = toError('Conflict', 'Document is at version 2');
    expect(error.name).toBe('Conflict');
    expect(error.message).toBe('Document is at version 2');
  });
});

describe('settleOnAbort (ticket 1.2.1 review round 2)', () => {
  it('tells the worker about the abort but waits for its answer: a success means the edit stands', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const done = client.request<string>({ op: 'stats' }, Priority.Visible, { signal: controller.signal, settleOnAbort: true });
    const id = worker.sent[0]!.id;
    controller.abort();
    expect(worker.sent.at(-1)).toMatchObject({ op: 'cancel', target: id });
    let settled = false;
    void done.then(() => (settled = true), () => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.reply({ id, ok: true, version: 2, result: 'applied' });
    await expect(done).resolves.toBe('applied');
  });

  it('a Cancelled answer rejects with an AbortError', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const done = client.request({ op: 'stats' }, Priority.Visible, { signal: controller.signal, settleOnAbort: true });
    controller.abort();
    worker.reply({ id: worker.sent[0]!.id, ok: false, version: 1, error: { kind: 'Cancelled', message: 'Cancelled' } });
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('cancel, worker failure and terminate with requests in flight', () => {
  const settle = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: e as Error }));

  it('after Cancel the request stays pending until the worker replies, then a success reply resolves it', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const done = client.request<string>({ op: 'stats' }, Priority.Visible, { signal: controller.signal, settleOnAbort: true });
    const id = worker.sent[0]!.id;
    let state = 'pending';
    void settle(done).then((r) => (state = r.ok ? 'resolved' : 'rejected'));
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(state).toBe('pending');
    expect(worker.sent.at(-1)).toMatchObject({ op: 'cancel', target: id });
    worker.reply({ id, ok: true, version: 3, result: 'applied' });
    await expect(done).resolves.toBe('applied');
  });

  it('a Cancelled reply after the abort rejects with an AbortError', async () => {
    const { worker, client } = setup();
    const controller = new AbortController();
    const done = client.request({ op: 'stats' }, Priority.Visible, { signal: controller.signal, settleOnAbort: true });
    const id = worker.sent[0]!.id;
    controller.abort();
    worker.reply({ id, ok: false, version: 1, error: { kind: 'Cancelled', message: 'Cancelled' } });
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('the worker onerror rejects every pending request', async () => {
    const { worker, client } = setup();
    const a = settle(client.request({ op: 'stats' }, Priority.Visible));
    const b = settle(client.request({ op: 'outline' }, Priority.Visible));
    const c = settle(client.request({ op: 'stats' }, Priority.Visible, { signal: new AbortController().signal, settleOnAbort: true }));
    worker.onerror?.();
    for (const r of await Promise.all([a, b, c])) {
      expect(r.ok).toBe(false);
      expect((r as { e: Error }).e.message).toContain('Something went wrong with this document');
    }
  });

  it('terminate() rejects every pending request', async () => {
    const { worker, client } = setup();
    const a = settle(client.request({ op: 'stats' }, Priority.Visible));
    const b = settle(client.request({ op: 'outline' }, Priority.Visible));
    const c = settle(client.request({ op: 'stats' }, Priority.Visible, { signal: new AbortController().signal, settleOnAbort: true }));
    client.terminate();
    expect(worker.terminated).toBe(true);
    for (const r of await Promise.all([a, b, c])) {
      expect(r.ok).toBe(false);
      expect((r as { e: Error }).e.name).toBe('AbortError');
    }
  });
});

describe('the silence watchdog (ticket 1.5.1 W1)', () => {
  const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

  it('a worker that never answers fires the timer once the silence time passes, and is reported again after another', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup();
      const onSilent = vi.fn();
      client.watchSilence(onSilent, 1000);
      void swallow(client.request({ op: 'stats' }, Priority.Visible));
      await vi.advanceTimersByTimeAsync(999);
      expect(onSilent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(onSilent).toHaveBeenCalledTimes(1);
      // The user chose Wait (nothing is done): the same silence is reported again after another full time.
      await vi.advanceTimersByTimeAsync(1000);
      expect(onSilent).toHaveBeenCalledTimes(2);
      client.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a long job that sends progress does not fire it: every message starts the time again', async () => {
    vi.useFakeTimers();
    try {
      const { worker, client } = setup();
      const onSilent = vi.fn();
      client.watchSilence(onSilent, 1000);
      const job = swallow(client.request({ op: 'apply', baseVersion: 0, edits: [] }, Priority.Visible));
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(900);
        worker.reply({ event: 'progress', label: 'Delete', done: i, total: 20 });
      }
      expect(onSilent).not.toHaveBeenCalled();
      // The progress stops: now it is silent.
      await vi.advanceTimersByTimeAsync(1001);
      expect(onSilent).toHaveBeenCalledTimes(1);
      worker.reply({ id: worker.sent[0]!.id, ok: true, version: 1, result: 1 });
      await job;
    } finally {
      vi.useRealTimers();
    }
  });

  it('is off while nothing is waiting: an idle worker is not silent', async () => {
    vi.useFakeTimers();
    try {
      const { worker, client } = setup();
      const onSilent = vi.fn();
      client.watchSilence(onSilent, 1000);
      const request = client.request<number>({ op: 'stats' }, Priority.Visible);
      await vi.advanceTimersByTimeAsync(500);
      worker.reply({ id: worker.sent[0]!.id, ok: true, version: 1, result: 1 });
      await request;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onSilent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancelled request that was the only one waiting switches it off', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup();
      const onSilent = vi.fn();
      client.watchSilence(onSilent, 1000);
      const controller = new AbortController();
      void swallow(client.request({ op: 'stats' }, Priority.Visible, { signal: controller.signal }));
      controller.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onSilent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('it never ends the worker by itself, and a terminated client stops reporting', async () => {
    vi.useFakeTimers();
    try {
      const { worker, client } = setup();
      const onSilent = vi.fn();
      client.watchSilence(onSilent, 1000);
      void swallow(client.request({ op: 'stats' }, Priority.Visible));
      await vi.advanceTimersByTimeAsync(5000);
      expect(onSilent.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(worker.terminated).toBe(false);
      client.terminate();
      const before = onSilent.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(onSilent.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without watchSilence nothing is watched (the default, so a test or the warm spare is not timed)', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup();
      void swallow(client.request({ op: 'stats' }, Priority.Visible));
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      client.terminate();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the silence watchdog and a steady stream of new requests (1.5.1 review)', () => {
  it('a hung worker that keeps being sent render requests is still reported: sending does not restart the time', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup();
      const onSilent = vi.fn();
      client.watchSilence(onSilent, 1000);
      for (let i = 0; i < 12; i++) {
        void client.request({ op: 'render', args: { page: 0, scale: 1, rotation: 0 } }, Priority.Visible).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(onSilent.mock.calls.length).toBeGreaterThanOrEqual(5);
      // Cancelling stale requests (the viewer does this on every scroll) is the page's doing, not the worker's: still reported.
      const before = onSilent.mock.calls.length;
      for (let i = 0; i < 6; i++) {
        const controller = new AbortController();
        void client.request({ op: 'render', args: { page: 1, scale: 1, rotation: 0 } }, Priority.Visible, { signal: controller.signal }).catch(() => undefined);
        controller.abort();
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(onSilent.mock.calls.length).toBeGreaterThan(before);
      client.terminate();
    } finally {
      vi.useRealTimers();
    }
  });
});
