/**
 * Requests from commands (keyboard, top bar) to a mounted viewer. Each pane has at most one
 * viewer, so requests are addressed by pane id.
 */
export type ViewerRequest =
  | { kind: 'goto'; index: number }
  | { kind: 'scrollScreen'; direction: 1 | -1 }
  | { kind: 'zoomStep'; direction: 1 | -1 }
  | { kind: 'setZoom'; zoom: number }
  | { kind: 'fit'; mode: 'width' | 'page' }
  /**
   * Scrolls so the rectangle's top sits a third of the way down the viewer, and horizontally so that the
   * whole rectangle is in view. The rectangle is in unrotated page points (from the page's top left), as the
   * search layer stores it; the viewer maps it through the pane's view rotation.
   */
  | { kind: 'reveal'; index: number; rect: { x: number; y: number; width: number; height: number } }
  /** Moves the viewer by a distance in page units (a page is 1), keeping its place in the page. Split sync. */
  | { kind: 'nudge'; delta: number }
  /** Scrolls so the top-left of the viewer is at a fraction of a page (pan-and-zoom). */
  | { kind: 'scrollTo'; index: number; fx: number; fy: number }
  /**
   * The document was replaced by one whose page ids start again (a save, a reload): the viewer's own memory of the page it
   * is on (its anchor) names a page by an id that now means another page. `from` and `to` are the old and the new page ids
   * of the document by position. Never queued: a viewer that is not mounted reads its page from the store when it mounts.
   */
  | { kind: 'remapPages'; from: readonly string[]; to: readonly string[] };

/**
 * The page id that takes the place of `pageId` after a replacement (see the `remapPages` request): the id at the same
 * position in `to`, clamped to the last page. Undefined when `pageId` is not in `from` (it is then left as it is).
 */
export function remapPageId(pageId: string | null, from: readonly string[], to: readonly string[]): string | undefined {
  const at = pageId === null ? -1 : from.indexOf(pageId);
  return at < 0 ? undefined : to[Math.min(at, to.length - 1)];
}

/** A viewer returns true when it has taken the request, and false when it is not ready yet (no layout). */
type Handler = (request: ViewerRequest) => boolean;
const handlers = new Map<string, Handler>();
/**
 * The latest request per pane that no viewer has taken yet. A request sent while the pane has no
 * mounted or ready viewer is kept here and delivered when one becomes ready, instead of being dropped.
 * A newer request replaces an older one, so only the latest intent is delivered.
 */
const queued = new Map<string, ViewerRequest>();

function deliver(paneId: string): void {
  const handler = handlers.get(paneId);
  const request = queued.get(paneId);
  if (!handler || !request) return;
  if (handler(request)) queued.delete(paneId);
}

export function registerViewer(paneId: string, handler: Handler): () => void {
  handlers.set(paneId, handler);
  deliver(paneId);
  return () => {
    if (handlers.get(paneId) === handler) handlers.delete(paneId);
  };
}

/** Delivers a queued request for `paneId` if its viewer can take it now. Called when a viewer gets its layout. */
export function flushViewerRequest(paneId: string): void {
  deliver(paneId);
}

/**
 * Sends a request to the viewer for `paneId`. Returns true when the viewer took it now. Otherwise the
 * request is queued for that pane (replacing any older queued request) and delivered later.
 */
export function requestViewer(paneId: string | null, request: ViewerRequest): boolean {
  if (!paneId) return false;
  const handler = handlers.get(paneId);
  if (handler?.(request)) {
    queued.delete(paneId);
    return true;
  }
  // A nudge is a move relative to where the viewer is now, so a late delivery would move it from the wrong place. A remap
  // names ids that mean other pages by then, so a late delivery would move the viewer's anchor to the wrong page.
  if (request.kind !== 'nudge' && request.kind !== 'remapPages') queued.set(paneId, request);
  return false;
}

/** Test helper: forgets all viewers and queued requests. */
export function resetViewerBus(): void {
  handlers.clear();
  queued.clear();
}
