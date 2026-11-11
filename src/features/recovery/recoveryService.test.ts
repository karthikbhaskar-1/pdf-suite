import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({
  documentRegistry: { acquire: vi.fn(), release: vi.fn(), retain: vi.fn(), refCount: vi.fn(() => 0), get: vi.fn() },
  fileService: { noteOpened: vi.fn() },
}));
vi.mock('../../platform/recovery/snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/recovery/snapshot')>()),
  saveSnapshot: vi.fn(async () => undefined),
}));

import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { saveSnapshot } from '../../platform/recovery/snapshot';
import type { Tab } from '../../core/model/types';
import { flushSnapshot, startSnapshotWriter, VIEW_SAVE_DELAY_MS } from './recoveryService';

const view = { pageId: null, zoom: 1, fit: 'none' as const, offset: 0, rotation: 0 as const };
const readyTab = (id: string): Tab => ({
  id,
  title: `${id}.pdf`,
  origin: { kind: 'path', path: `C:/docs/${id}.pdf` },
  status: { kind: 'ready' },
  panes: [{ id: `${id}-pane`, docId: `doc-${id}`, view }],
  split: null,
});

const saves = () => vi.mocked(saveSnapshot).mock.calls.length;
/** Lets the queued save run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveSnapshot).mockClear();
  useWorkspaceStore.setState({ tabs: [readyTab('a')], activeTabId: 'a', activePaneId: 'a-pane' });
  stop = startSnapshotWriter();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe('session writer timing', () => {
  it('saves a structural change right away', async () => {
    useWorkspaceStore.getState().addTab(readyTab('b'), 1);
    await settle();
    expect(saves()).toBe(1);
  });

  it('saves a page or zoom change no later than the view delay, not right away', async () => {
    useWorkspaceStore.getState().setView('a-pane', { zoom: 2 });
    await settle();
    expect(saves()).toBe(0);
    await vi.advanceTimersByTimeAsync(VIEW_SAVE_DELAY_MS - 1);
    expect(saves()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves()).toBe(1);
  });

  it('keeps saving during a long run of view changes, at most one delay apart', async () => {
    for (let i = 0; i < 20; i++) {
      useWorkspaceStore.getState().setView('a-pane', { offset: i / 100 });
      await vi.advanceTimersByTimeAsync(100);
    }
    // Two seconds of scrolling: at least one save per delay window.
    expect(saves()).toBeGreaterThanOrEqual(3);
  });

  it('the saved record reflects the latest state, not the state when the change was made', async () => {
    useWorkspaceStore.getState().addTab(readyTab('b'), 1);
    useWorkspaceStore.getState().patchTab('b', { title: 'renamed.pdf' });
    await settle();
    const last = vi.mocked(saveSnapshot).mock.calls.at(-1)?.[0];
    expect(last?.tabs.map((t) => t.title)).toEqual(['a.pdf', 'renamed.pdf']);
  });
});

describe('flushing the session on quit', () => {
  it('writes now, before any delay has passed', async () => {
    useWorkspaceStore.getState().setView('a-pane', { zoom: 3 });
    await flushSnapshot();
    expect(saves()).toBe(1);
  });

  it('does nothing before the writer has started, so a half-restored session is never saved', async () => {
    stop?.();
    stop = undefined;
    await flushSnapshot();
    expect(saves()).toBe(0);
  });
});
