import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';

interface Call {
  onPage: (r: { pageId: string; pageIndex: number; matches: { rects: { x: number; y: number; width: number; height: number }[] }[] }) => void;
  signal: AbortSignal;
  done: () => void;
}
const calls: Call[] = [];
const reveals: { index: number }[] = [];

vi.mock('../../app/services', () => ({ documentRegistry: { get: () => ({ doc: {} }) } }));
vi.mock('../../ui/viewer/viewerBus', () => ({
  requestViewer: (_pane: string, r: { kind: string; index: number }) => {
    if (r.kind === 'reveal') reveals.push({ index: r.index });
    return true;
  },
}));
vi.mock('./searchRunner', async () => {
  const actual = await vi.importActual<typeof import('./searchRunner')>('./searchRunner');
  return {
    ...actual,
    searchDocument: (o: { onPage: Call['onPage']; signal: AbortSignal }) =>
      new Promise<void>((resolve) => calls.push({ onPage: o.onPage, signal: o.signal, done: resolve })),
  };
});

const { startSearchController, restartSearch } = await import('./searchController');
const { useSearchStore } = await import('./searchStore');

const DOC = 'd';
const N = 400;
const pages = Array.from({ length: N }, (_, i) => ({ id: `${DOC}:${i}`, docId: DOC, srcIndex: i, rotation: 0 as const, crop: null }));
const rect = [{ x: 0, y: 0, width: 1, height: 1 }];
const hit = (call: Call, i: number) => act(() => call.onPage({ pageId: `${DOC}:${i}`, pageIndex: i, matches: [{ rects: rect }] }));
const setView = (patch: Record<string, unknown>) => act(() => useWorkspaceStore.getState().setView('pane1', patch as never));

let stop: () => void;
beforeEach(() => {
  calls.length = 0;
  reveals.length = 0;
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'a.pdf', pageCount: N, pages, sizes: [], byteSize: 1 } } } as never);
  useWorkspaceStore.setState({
    tabs: [{ id: 't', title: 'a', origin: { kind: 'bytes' }, status: { kind: 'ready' }, panes: [{ id: 'pane1', docId: DOC, view: { pageId: `${DOC}:0`, zoom: 1, fit: 'none', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 't',
    activePaneId: 'pane1',
  } as never);
  useSearchStore.setState({ open: true, query: 'x', hits: [], byPage: {}, current: -1, revealSeq: 0, revealDir: 0, running: false, docId: null, paneId: null });
  stop = startSearchController();
  restartSearch();
});
afterEach(() => stop());

describe('search controller: the first match and the view', () => {
  it('(b) with no move, the first match reveals once', () => {
    hit(calls[0]!, 300);
    expect(reveals).toEqual([{ index: 300 }]);
  });

  it('(a) after the user went to another page, the first match does not reveal; (c) F3 shows the first match at or after that page, not hit 1', () => {
    setView({ pageId: `${DOC}:249` });
    hit(calls[0]!, 10);
    hit(calls[0]!, 260);
    hit(calls[0]!, 300);
    expect(reveals).toEqual([]);
    act(() => useSearchStore.getState().step(1));
    expect(useSearchStore.getState().current).toBe(1);
    expect(reveals).toEqual([{ index: 260 }]);
  });

  it('(c) Shift+F3 after a skipped reveal shows the last match before the user\'s page', () => {
    setView({ pageId: `${DOC}:249` });
    hit(calls[0]!, 10);
    hit(calls[0]!, 20);
    hit(calls[0]!, 260);
    act(() => useSearchStore.getState().step(-1));
    expect(useSearchStore.getState().current).toBe(1);
    expect(reveals).toEqual([{ index: 20 }]);
  });

  it('(d) F3 and Shift+F3 always reveal', () => {
    hit(calls[0]!, 10);
    hit(calls[0]!, 20);
    reveals.length = 0;
    act(() => useSearchStore.getState().step(1));
    act(() => useSearchStore.getState().step(-1));
    expect(reveals).toEqual([{ index: 20 }, { index: 10 }]);
  });

  it('a page typed while the query is still being debounced is a move: the first match does not pull the view back', () => {
    vi.useFakeTimers();
    try {
      stop();
      act(() => useSearchStore.setState({ query: '' }));
      stop = startSearchController();
      calls.length = 0;
      act(() => useSearchStore.getState().setQuery('abc'));
      setView({ pageId: `${DOC}:249` });
      act(() => void vi.advanceTimersByTime(200));
      expect(calls.length).toBe(1);
      hit(calls[0]!, 0);
      expect(reveals).toEqual([]);
      act(() => useSearchStore.getState().step(1));
      expect(reveals).toEqual([{ index: 0 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(e) an aborted run never reveals', () => {
    const first = calls[0]!;
    act(() => restartSearch());
    expect(first.signal.aborted).toBe(true);
    hit(first, 5);
    expect(reveals).toEqual([]);
  });

  it('(e) the search of another document starts afresh: the old run does not reveal', () => {
    const first = calls[0]!;
    act(() => restartSearch());
    hit(calls[1]!, 7);
    expect(reveals).toEqual([{ index: 7 }]);
    hit(first, 5);
    expect(reveals).toEqual([{ index: 7 }]);
  });

  it('(f) a re-run caused by an edit never moves the view', () => {
    act(() => restartSearch('edit'));
    hit(calls[1]!, 12);
    expect(reveals).toEqual([]);
  });
});
