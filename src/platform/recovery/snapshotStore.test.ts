import { beforeEach, describe, expect, it, vi } from 'vitest';

// An in-memory stand-in for the IndexedDB key-value store, so the write order can be inspected.
const records = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: vi.fn(async (key: string) => records.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    records.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    records.delete(key);
  }),
}));

import { del, set } from 'idb-keyval';
import { loadSnapshot, saveSnapshot, type Snapshot } from './snapshot';

const snap = (title: string): Snapshot => ({
  version: 1,
  activeIndex: 0,
  tabs: [
    {
      title,
      origin: { kind: 'path', path: `C:/docs/${title}` },
      view: { pageId: null, zoom: 1, fit: 'width', offset: 0, rotation: 0 },
    },
  ],
});

beforeEach(() => {
  records.clear();
  vi.mocked(set).mockClear();
  vi.mocked(del).mockClear();
});

describe('session snapshot write and read', () => {
  it('writes a temp record first, then the current record, then removes the temp record', async () => {
    await saveSnapshot(snap('a.pdf'));
    const keysInOrder = vi.mocked(set).mock.calls.map((call) => call[0]);
    expect(keysInOrder).toEqual(['snapshot-pending', 'snapshot']);
    expect(vi.mocked(del).mock.calls.map((call) => call[0])).toEqual(['snapshot-pending']);
    expect(records.has('snapshot-pending')).toBe(false);
    expect((await loadSnapshot())?.tabs[0]?.title).toBe('a.pdf');
  });

  it('after a save that was killed before the swap, the newer pending record is the one restored', async () => {
    await saveSnapshot(snap('old.pdf'));
    // Simulate a kill right after the temp record was written: the swap and the cleanup never ran.
    records.set('snapshot-pending', snap('new.pdf'));
    expect((await loadSnapshot())?.tabs[0]?.title).toBe('new.pdf');
  });

  it('keeps the last good record when a save fails before the swap', async () => {
    await saveSnapshot(snap('good.pdf'));
    vi.mocked(set).mockImplementationOnce(async () => {
      throw new Error('quota');
    });
    await saveSnapshot(snap('broken.pdf'));
    expect((await loadSnapshot())?.tabs[0]?.title).toBe('good.pdf');
  });

  it('a snapshot with no tabs is saved and read back as an empty session', async () => {
    await saveSnapshot({ version: 1, activeIndex: 0, tabs: [] });
    expect(await loadSnapshot()).toEqual({ version: 1, activeIndex: 0, tabs: [] });
  });
});
