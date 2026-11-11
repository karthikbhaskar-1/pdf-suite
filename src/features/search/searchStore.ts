import { create } from 'zustand';
import type { Rect, TextMatch } from './textSearch';

/** One match, placed on a page. `id` follows the order of the pages in the list. */
export interface SearchHit {
  id: number;
  pageId: string;
  /** Position of the page in the page list when the search ran. */
  pageIndex: number;
  rects: Rect[];
}

interface SearchState {
  open: boolean;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  /** Document and pane the current results belong to. */
  docId: string | null;
  paneId: string | null;
  running: boolean;
  scanned: number;
  total: number;
  hits: SearchHit[];
  /** Hits grouped by page id, for the page overlay. */
  byPage: Record<string, SearchHit[]>;
  /** Index into `hits` of the current match, or -1. */
  current: number;
  /** Bumped whenever the view should scroll to the current match. */
  revealSeq: number;
  /** What last bumped `revealSeq`: 1 or -1 for Find next or previous, 0 for the first match of a scan. */
  revealDir: 1 | -1 | 0;

  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setMatchCase: (value: boolean) => void;
  setWholeWord: (value: boolean) => void;
  setPaneId: (paneId: string | null) => void;
  /** Starts a fresh scan of `docId`. Clears the previous hits. */
  beginRun: (docId: string, paneId: string | null, total: number) => void;
  addPage: (pageId: string, pageIndex: number, matches: TextMatch[]) => void;
  setScanned: (scanned: number) => void;
  finishRun: () => void;
  /** Drops results and the document they belong to. */
  clearResults: () => void;
  /** Moves to the next (1) or previous (-1) match, wrapping at the ends. */
  step: (direction: 1 | -1) => void;
  /** Moves to a given match without asking the view to scroll (the controller scrolls itself). */
  setCurrent: (index: number) => void;
}

export const useSearchStore = create<SearchState>()((set, get) => ({
  open: false,
  query: '',
  matchCase: false,
  wholeWord: false,
  docId: null,
  paneId: null,
  running: false,
  scanned: 0,
  total: 0,
  hits: [],
  byPage: {},
  current: -1,
  revealSeq: 0,
  revealDir: 0,

  setOpen: (open) => set({ open }),
  setQuery: (query) => set({ query }),
  setMatchCase: (value) => set({ matchCase: value }),
  setWholeWord: (value) => set({ wholeWord: value }),
  setPaneId: (paneId) => set({ paneId }),

  beginRun: (docId, paneId, total) =>
    set({ docId, paneId, total, scanned: 0, running: true, hits: [], byPage: {}, current: -1 }),

  addPage: (pageId, pageIndex, matches) =>
    set((s) => {
      if (matches.length === 0) return s;
      const added: SearchHit[] = matches.map((m, i) => ({
        id: s.hits.length + i,
        pageId,
        pageIndex,
        rects: m.rects,
      }));
      const hits = [...s.hits, ...added];
      const byPage = { ...s.byPage, [pageId]: [...(s.byPage[pageId] ?? []), ...added] };
      // The first match becomes current and the view scrolls to it.
      const firstFound = s.current < 0;
      return {
        hits,
        byPage,
        current: firstFound ? 0 : s.current,
        revealSeq: firstFound ? s.revealSeq + 1 : s.revealSeq,
        revealDir: firstFound ? 0 : s.revealDir,
      };
    }),

  setScanned: (scanned) => set({ scanned }),
  finishRun: () => set({ running: false, scanned: get().total }),

  clearResults: () =>
    set({ docId: null, running: false, scanned: 0, total: 0, hits: [], byPage: {}, current: -1 }),

  step: (direction) =>
    set((s) => {
      if (s.hits.length === 0) return s;
      const count = s.hits.length;
      const base = s.current < 0 ? 0 : s.current;
      const next = (((base + direction) % count) + count) % count;
      return { current: next, revealSeq: s.revealSeq + 1, revealDir: direction };
    }),
  setCurrent: (index) => set((s) => (index >= 0 && index < s.hits.length ? { current: index } : s)),
}));

/** Current match, or undefined when there is none. */
export function currentHit(state: Pick<SearchState, 'hits' | 'current'>): SearchHit | undefined {
  return state.current >= 0 ? state.hits[state.current] : undefined;
}
