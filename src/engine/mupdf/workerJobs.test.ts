// @vitest-environment node
// Review 1.5.8, items 3, 4 and 5: the worker's turn and size jobs, and the job worker's start, never leave the page waiting.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { endTurn, runSizesJob, SIZE_FALLBACK } from './workerJobs';
import type { WorkerEvent } from './protocol';

const OUTLINE = new URL('../../../tests/fixtures/out/outline-6.pdf', import.meta.url);

function openCore(): MupdfCore {
  const core = new MupdfCore(mu as never, {});
  core.open(new Uint8Array(readFileSync(OUTLINE)), undefined);
  return core;
}

describe('endTurn (item 3)', () => {
  it('posts the next turn when the housekeeping after a job throws', () => {
    const next = vi.fn();
    expect(() =>
      endTurn(() => {
        throw new Error('shrink failed');
      }, next),
    ).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('posts the next turn after housekeeping that works, once', () => {
    const next = vi.fn();
    const after = vi.fn();
    endTurn(after, next);
    expect(after).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('posts the next turn when there is no document', () => {
    const next = vi.fn();
    endTurn(undefined, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('page sizes when a page cannot be measured (item 4)', () => {
  it('core.sizesChecked gives the fallback size for the page that throws, and the others as they are', () => {
    const core = openCore();
    const real = core.sizes(0, 6);
    const proto = MupdfCore.prototype as unknown as { loadPage(index: number): unknown };
    const realLoad = proto.loadPage;
    const spy = vi.spyOn(proto, 'loadPage').mockImplementation(function (this: unknown, index: number) {
      if (index === 2) throw new Error('broken page');
      return realLoad.call(this, index);
    });
    try {
      const out = core.sizesChecked(0, 6);
      expect(out.failed).toEqual([2]);
      expect([...out.sizes.slice(6, 9)]).toEqual([SIZE_FALLBACK.width, SIZE_FALLBACK.height, 0]);
      expect([...out.sizes.slice(0, 6)]).toEqual([...real.slice(0, 6)]);
      expect([...out.sizes.slice(9)]).toEqual([...real.slice(9)]);
      // And sizes() itself no longer throws for it.
      expect(core.sizes(0, 6).length).toBe(18);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runSizesJob (item 4)', () => {
  const posted: Array<{ message: WorkerEvent; transfer: Transferable[] }> = [];
  const post = (message: unknown, transfer: Transferable[] = []) => void posted.push({ message: message as WorkerEvent, transfer });
  afterEach(() => {
    posted.length = 0;
  });

  it('posts the sizes of a job that works', () => {
    runSizesJob(openCore(), { from: 0, count: 3 }, post);
    expect(posted).toHaveLength(1);
    const event = posted[0]!.message as Extract<WorkerEvent, { event: 'sizes' }>;
    expect(event.event).toBe('sizes');
    expect(event.sizes.length).toBe(9);
    expect(event.failed ?? []).toEqual([]);
  });

  it('posts the fallback size for every page of a job that throws, so no size promise is left waiting', () => {
    const core = { sizesChecked: () => { throw new Error('out of memory'); } };
    runSizesJob(core, { from: 16, count: 4 }, post);
    expect(posted).toHaveLength(1);
    const event = posted[0]!.message as Extract<WorkerEvent, { event: 'sizes' }>;
    expect(event.from).toBe(16);
    expect([...event.sizes]).toEqual(Array.from({ length: 4 }, () => [SIZE_FALLBACK.width, SIZE_FALLBACK.height, 0]).flat());
    expect(event.failed).toEqual([16, 17, 18, 19]);
  });

  it('posts the fallback when no document is open', () => {
    runSizesJob(null, { from: 0, count: 2 }, post);
    expect(posted).toHaveLength(1);
    expect((posted[0]!.message as Extract<WorkerEvent, { event: 'sizes' }>).sizes.length).toBe(6);
  });
});

describe('the job worker when the engine cannot load (item 5)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./loadMu');
    delete (globalThis as { self?: unknown }).self;
  });

  it('posts an error message instead of staying silent', async () => {
    vi.doMock('./loadMu', () => ({ loadMu: () => Promise.reject(new Error('instantiate failed')) }));
    const sent: unknown[] = [];
    const scope = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: (m: unknown) => void sent.push(m) };
    (globalThis as { self?: unknown }).self = scope;
    await import('./jobWorker');
    scope.onmessage!({ data: { t: 'init', module: {} } });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]).toMatchObject({ t: 'error', kind: 'Internal' });
    expect((sent[0] as { detail?: string }).detail).toContain('instantiate failed');
  });

  it('answers a message that came after the failed start with an error too, not with nothing', async () => {
    vi.doMock('./loadMu', () => ({ loadMu: () => Promise.reject(new Error('instantiate failed')) }));
    const sent: Array<{ t: string; id?: number }> = [];
    const scope = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: (m: unknown) => void sent.push(m as never) };
    (globalThis as { self?: unknown }).self = scope;
    await import('./jobWorker');
    scope.onmessage!({ data: { t: 'init', module: {} } });
    scope.onmessage!({ data: { t: 'analyse', id: 7, what: 'blank' } });
    await vi.waitFor(() => expect(sent.filter((m) => m.t === 'error').length).toBeGreaterThanOrEqual(2));
    expect(sent.some((m) => m.t === 'error' && m.id === 7)).toBe(true);
  });
});
