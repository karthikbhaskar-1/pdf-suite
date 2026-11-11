// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readTextPages } from './textJob';
import type { PageTextData } from './protocol';

const page = (index: number): PageTextData => ({ page: index, runs: [] });

describe('readTextPages: cooperative cancel', () => {
  it('reads every page of the run in order when nothing cancels it', async () => {
    const read: number[] = [];
    const out = await readTextPages({
      from: 2,
      count: 3,
      pageCount: 10,
      readPage: (index) => (read.push(index), page(index)),
      isCancelled: () => false,
      yieldTurn: async () => undefined,
    });
    expect(read).toEqual([2, 3, 4]);
    expect(out.map((p) => p.page)).toEqual([2, 3, 4]);
  });

  it('stops before the next page once cancelled, and reads no page after that', async () => {
    const read: number[] = [];
    let cancelled = false;
    const job = readTextPages({
      from: 0,
      count: 64,
      pageCount: 64,
      readPage: (index) => {
        read.push(index);
        // A cancel arrives while page 3 is being read.
        if (index === 3) cancelled = true;
        return page(index);
      },
      isCancelled: () => cancelled,
      yieldTurn: async () => undefined,
    });
    await expect(job).rejects.toMatchObject({ kind: 'Cancelled' });
    expect(read).toEqual([0, 1, 2, 3]);
  });

  it('yields between pages, so queued messages can run while the job is still going', async () => {
    const events: string[] = [];
    await readTextPages({
      from: 0,
      count: 3,
      pageCount: 3,
      readPage: (index) => (events.push(`read ${index}`), page(index)),
      isCancelled: () => false,
      yieldTurn: async () => {
        events.push('yield');
      },
    });
    expect(events).toEqual(['read 0', 'yield', 'read 1', 'yield', 'read 2', 'yield']);
  });

  it('stops at the last page of the document', async () => {
    const out = await readTextPages({
      from: 4,
      count: 10,
      pageCount: 6,
      readPage: page,
      isCancelled: () => false,
      yieldTurn: async () => undefined,
    });
    expect(out.map((p) => p.page)).toEqual([4, 5]);
  });
});
