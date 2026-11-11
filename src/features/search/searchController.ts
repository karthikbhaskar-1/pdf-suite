import { documentRegistry } from '../../app/services';
import { indexOfPage, type PageList } from '../../core/model/pageList';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import type { TextRun } from '../../engine/types';
import { requestViewer } from '../../ui/viewer/viewerBus';
import { pruneTextCache, searchDocument, TextCache } from './searchRunner';
import { currentHit, useSearchStore } from './searchStore';
import type { SearchOptions } from './textSearch';

/** Typing restarts the scan after this pause, so a fast typist does not start a scan per key. */
const QUERY_DEBOUNCE_MS = 150;

let controller: AbortController | null = null;
/**
 * Where the pane was when the running scan began, and why the scan began. The first match of a scan scrolls the view to it
 * only for a new query and only when the user has not moved since (a page typed in the page box while the search runs must
 * not be undone). A scan caused by an edit never moves the view. When the first reveal is skipped, the next Find next or
 * previous shows the match at or after (before) the page the user is on, instead of stepping on from a match never shown.
 */
export type RestartReason = 'query' | 'edit';
/** Where the pane was when the user asked for this scan (typing the query), which is before a debounced scan begins. */
let asked: { paneId: string; pageId: string | null } | null = null;
let run: { paneId: string; pageId: string | null; reason: RestartReason; pendingFirst: boolean } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Text of the last searched document. Kept while the query changes, dropped when the document changes. */
let textCache: { docId: string | null; runs: Map<string, TextRun[]> } = { docId: null, runs: new TextCache() };

interface ActiveView {
  paneId: string;
  docId: string;
  pages: PageList;
}

function activeView(): ActiveView | null {
  const ws = useWorkspaceStore.getState();
  const pane = selectPane(ws, ws.activePaneId);
  if (!pane) return null;
  const doc = useDocumentsStore.getState().docs[pane.docId];
  if (!doc) return null;
  return { paneId: pane.id, docId: pane.docId, pages: doc.pages };
}

function viewedPageId(paneId: string): string | null {
  const ws = useWorkspaceStore.getState();
  return selectPane(ws, paneId)?.view.pageId ?? null;
}

/** Whether the first match of a scan scrolls the view: a new query, and the user still where the scan began. */
export function shouldRevealFirstMatch(
  start: { paneId: string; pageId: string | null; reason: RestartReason },
  now: { paneId: string; pageId: string | null },
): boolean {
  return start.reason === 'query' && start.paneId === now.paneId && start.pageId === now.pageId;
}

function lastIndexBefore(hits: readonly { pageIndex: number }[], page: number): number {
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i]!.pageIndex < page) return i;
  return -1;
}

/** Index of the page the user is on, in the searched document's page list. */
function userPageIndex(paneId: string): number {
  const ws = useWorkspaceStore.getState();
  const pane = selectPane(ws, paneId);
  const pages = pane ? useDocumentsStore.getState().docs[pane.docId]?.pages : undefined;
  const pageId = pane?.view.pageId;
  return pages && pageId ? Math.max(0, indexOfPage(pages, pageId)) : 0;
}

function cancelScan(): void {
  controller?.abort();
  controller = null;
}

/** Stops any running scan and, when there is a query, starts a new one on the active pane's document. */
export function restartSearch(reason: RestartReason = 'query'): void {
  cancelScan();
  run = null;
  const askedFrom = asked;
  asked = null;
  const state = useSearchStore.getState();
  const view = activeView();
  if (!state.open || state.query.length === 0 || !view) {
    state.clearResults();
    return;
  }
  const handle = documentRegistry.get(view.docId);
  if (!handle) {
    state.clearResults();
    return;
  }

  if (textCache.docId !== view.docId) textCache = { docId: view.docId, runs: new TextCache() };
  // Every edit and save gives pages new content names: the text of pages that are no longer in the list is dropped, so the
  // cache holds at most one entry per current page.
  pruneTextCache(textCache.runs, view.pages);
  const ctl = new AbortController();
  controller = ctl;
  // The user's page is the one when the scan was asked for: a page typed into the page box during the debounce wait or
  // the first slices of the scan counts as a move away from where the search started.
  const from = askedFrom && askedFrom.paneId === view.paneId ? askedFrom : { paneId: view.paneId, pageId: viewedPageId(view.paneId) };
  run = { paneId: view.paneId, pageId: from.pageId, reason, pendingFirst: false };
  const options: SearchOptions = { matchCase: state.matchCase, wholeWord: state.wholeWord };
  state.beginRun(view.docId, view.paneId, view.pages.length);

  void searchDocument({
    doc: handle.doc,
    pages: view.pages,
    query: state.query,
    options,
    signal: ctl.signal,
    cache: textCache.runs,
    onPage: ({ pageId, pageIndex, matches }) => {
      if (!ctl.signal.aborted) useSearchStore.getState().addPage(pageId, pageIndex, matches);
    },
    onProgress: (scanned) => {
      if (!ctl.signal.aborted) useSearchStore.getState().setScanned(scanned);
    },
  }).then(() => {
    if (ctl.signal.aborted) return;
    useSearchStore.getState().finishRun();
    if (controller === ctl) controller = null;
  });
}

function scheduleRestart(delay: number, reason: RestartReason = 'query'): void {
  clearTimeout(timer);
  if (asked === null) {
    const view = activeView();
    if (view) asked = { paneId: view.paneId, pageId: viewedPageId(view.paneId) };
  }
  timer = setTimeout(() => restartSearch(reason), delay);
}

/** Scrolls the pane that owns the current match so the match is in view. */
function revealCurrent(): void {
  const state = useSearchStore.getState();
  const hit = currentHit(state);
  const paneId = state.paneId;
  const top = hit?.rects[0];
  if (!hit || !top || !paneId) return;
  requestViewer(paneId, { kind: 'reveal', index: hit.pageIndex, rect: top });
}

/**
 * Keeps the search in step with the app: a new scan when the query or options change (debounced),
 * a new scan when the active pane shows another document, and a scroll when the match moves.
 * Returns a stop function.
 */
export function startSearchController(): () => void {
  const unsubSearch = useSearchStore.subscribe((state, previous) => {
    if (state.open !== previous.open || state.matchCase !== previous.matchCase || state.wholeWord !== previous.wholeWord) {
      scheduleRestart(0);
    } else if (state.query !== previous.query) {
      scheduleRestart(QUERY_DEBOUNCE_MS, 'query');
    }
    if (state.revealSeq !== previous.revealSeq) {
      if (state.revealDir === 0) {
        // The first match of a scan.
        if (!run || !state.paneId) return;
        if (shouldRevealFirstMatch(run, { paneId: state.paneId, pageId: viewedPageId(run.paneId) })) revealCurrent();
        else run.pendingFirst = true;
      } else if (run?.pendingFirst && state.paneId && state.hits.length > 0) {
        // Find next or previous after a skipped first reveal: the match at or after (before) the user's page.
        run.pendingFirst = false;
        const from = userPageIndex(state.paneId);
        const hits = state.hits;
        const forward = state.revealDir === 1;
        let target = forward ? hits.findIndex((h) => h.pageIndex >= from) : lastIndexBefore(hits, from);
        if (target < 0) target = forward ? 0 : hits.length - 1;
        useSearchStore.getState().setCurrent(target);
        revealCurrent();
      } else {
        revealCurrent();
      }
    }
  });

  const unsubWorkspace = useWorkspaceStore.subscribe(() => {
    const search = useSearchStore.getState();
    const view = activeView();
    if (!search.open || search.query.length === 0 || !view) return;
    if (search.docId !== view.docId) {
      scheduleRestart(0);
    } else if (search.paneId !== view.paneId) {
      search.setPaneId(view.paneId);
    }
  });

  // An edit changes the page list of the searched document, so the matches are stale: scan again. Pages whose content
  // did not change keep their text (it is cached by uid@rev), so only the edited pages are read again.
  const unsubDocs = useDocumentsStore.subscribe((state, previous) => {
    // A closed document releases its text at once.
    if (textCache.docId && !state.docs[textCache.docId]) textCache = { docId: null, runs: new TextCache() };
    const search = useSearchStore.getState();
    if (!search.open || search.query.length === 0 || !search.docId) return;
    if (state.docs[search.docId]?.pages !== previous.docs[search.docId]?.pages) scheduleRestart(0, 'edit');
  });

  return () => {
    clearTimeout(timer);
    cancelScan();
    run = null;
    asked = null;
    unsubSearch();
    unsubWorkspace();
    unsubDocs();
  };
}
