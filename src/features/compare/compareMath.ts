import type { CompareAddTo, CompareLook, CompareSession } from '../../core/stores/compareStore';
import type { RenderOptions } from '../../engine/types';
import {
  OVERLAY_SCALE_MAX,
  OVERLAY_SCALE_MIN,
  overlayPageFor,
  type OverlayMode,
  type PageMatch,
} from '../../engine/overlayPlacement';

/**
 * Pure rules of "Overlay to Compare" (1.3.4): which overlay page goes with a page, which pages "Add overlay to pages" acts on,
 * the texts the UI spec gives word for word, and the view the viewer asks the engine for. No store reads and no engine calls:
 * every function takes what it works on, so the rules can be tested alone (compareMath.test.ts).
 */

// ---- Texts (docs/milestone-1.3/1.3-ui-spec.md section 4, exact) ----------------------------------------------------------

export const COMPARE_NO_FILE = 'No PDF chosen yet.';
export const COMPARE_DIFFERENCES_LEGEND = 'Red: only in this document. Blue-green: only in the overlay. Black: in both.';
export const COMPARE_NO_PARTNER = 'This page has no overlay page.';
export const COMPARE_DIFFERENT_SIZE = 'The overlay page is a different size.';
export const COMPARE_DIFFERENCES_VIEW_ONLY = '“Differences” is for viewing only. Choose Both or See-through to add the overlay to the pages.';
export const COMPARE_NOT_COPIED = 'Comments and form boxes in the overlay file are not copied.';
export const COMPARE_GONE = 'The overlay file has changed or can no longer be read, so comparing has stopped. Choose the PDF again to carry on.';
/** Not in the spec: what Add says when it has nothing to add to, in the words of the Cut sheet's equivalent. */
export const COMPARE_NO_MATCH = 'No pages match. Choose a different “Add to”.';
export const COMPARE_CHOOSE_FIRST = 'Choose a PDF first.';

export const comparingWith = (name: string): string => `Comparing with ${name}. The overlay is only on screen.`;
export const openingText = (name: string): string => `Opening ${name}…`;
export const unsavedText = (name: string): string => `${name} has unsaved changes. The overlay shows its last saved version.`;
export const xfaText = (name: string): string => `${name} is a kind of form that can't be used as an overlay.`;
export const fileLine = (name: string, pages: number): string => `${name} · ${pages} ${pages === 1 ? 'page' : 'pages'}`;
export const thisPageLine = (partner: number | null): string => (partner === null ? COMPARE_NO_PARTNER : `This page: overlay page ${partner + 1}.`);
export const addedText = (count: number): string => `Added the overlay to ${count} ${count === 1 ? 'page' : 'pages'}`;

// ---- Values --------------------------------------------------------------------------------------------------------------

/** The engine's mode for a look. */
export function modeOf(look: CompareLook): OverlayMode {
  return look === 'both' ? 'multiply' : look === 'seethrough' ? 'blend' : 'difference';
}

/** The pairing rule of a session, as the engine's pure function reads it. */
export function matchOf(session: Pick<CompareSession, 'match' | 'startPage' | 'fixedPage'>): PageMatch {
  return session.match === 'fixed' ? { kind: 'fixed', page: session.fixedPage } : { kind: 'sequential', start: session.startPage };
}

/** The 0-based overlay page for the page at `position` (0-based), or null when it has no partner or no file is attached. */
export function partnerOf(session: Pick<CompareSession, 'match' | 'startPage' | 'fixedPage' | 'file'>, position: number): number | null {
  return session.file ? overlayPageFor(position, matchOf(session), session.file.pages) : null;
}

/** The size from 25 to 400 percent as typed, or null when it is not a whole or decimal number in that range. */
export function parseSizePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= OVERLAY_SCALE_MIN * 100 && value <= OVERLAY_SCALE_MAX * 100 ? value : null;
}

/** An offset moved into the page's size, either way ("± the page size"). A value that is not a number gives 0. */
export function clampOffset(points: number, pageExtent: number): number {
  if (!Number.isFinite(points)) return 0;
  const limit = Math.max(1, pageExtent);
  return Math.min(limit, Math.max(-limit, points));
}

/** The step of an arrow button: one point, and ten with Shift. */
export function nudgeStep(shift: boolean): number {
  return shift ? 10 : 1;
}

/** A whole-number page from the sheet's number field, moved into 1 to `pages`. */
export function clampPage(value: number, pages: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, pages), Math.max(1, Math.round(value)));
}

// ---- The view the viewer asks for ----------------------------------------------------------------------------------------

/** The engine's overlay arguments, as the engine-neutral render options name them. */
type OverlayArgs = NonNullable<RenderOptions['overlay']>;

/** What a page of the viewer needs for its overlay: a key part for the bitmap cache, and the engine's arguments. */
export interface OverlayView {
  /** Names this overlay look for this page. Part of the pseudo document id `${docId}#ov:${hash}` (see engine/bitmapCache.ts). */
  hash: string;
  args: OverlayArgs;
}

/** Digits of a number for a key: three decimals are far below a pixel. */
function keyNumber(value: number): string {
  return value.toFixed(3);
}

/**
 * Everything that changes the picture except the overlay page: the attachment (a re-read overlay is a new one), the look, the
 * opacity (only when it is used), and the placement. A view's hash is this key and the overlay page, so a bitmap is found again
 * only for exactly the same picture, and the bitmaps of the looks that are gone can be told apart by their prefix.
 */
export function viewKeyOf(session: Pick<CompareSession, 'key' | 'attach' | 'look' | 'opacity' | 'dx' | 'dy' | 'size'>): string {
  const mode = modeOf(session.look);
  return [session.key, session.attach, mode, mode === 'blend' ? keyNumber(session.opacity / 100) : '-', keyNumber(session.dx), keyNumber(session.dy), keyNumber(session.size / 100)].join('.');
}

const viewCache = new WeakMap<object, Map<number, OverlayView | null>>();

/**
 * The overlay of the page at `position` (0-based), or undefined when the page is shown plain: the overlay is hidden (F8),
 * nothing is attached yet, or the page has no overlay page. The same view object comes back for the same session object, so a
 * page of the viewer that is drawn again with the same look does not re-render (the viewer's pages are memoized on their
 * props). A change to the session is a new session object, and so a fresh cache.
 */
export function overlayViewFor(session: CompareSession | null, position: number): OverlayView | undefined {
  if (!session || !session.show || session.phase !== 'ready' || session.sourceDocId === null || !session.file) return undefined;
  let cache = viewCache.get(session);
  if (!cache) {
    cache = new Map();
    viewCache.set(session, cache);
  }
  const cached = cache.get(position);
  if (cached !== undefined) return cached ?? undefined;
  const partner = partnerOf(session, position);
  if (partner === null) {
    cache.set(position, null);
    return undefined;
  }
  const mode = modeOf(session.look);
  const scale = session.size / 100;
  const opacity = session.opacity / 100;
  const view: OverlayView = {
    hash: `${viewKeyOf(session)}.${partner}`,
    args: { sourceDocId: session.sourceDocId, sourcePage: partner, dx: session.dx, dy: session.dy, scale, mode, opacity },
  };
  cache.set(position, view);
  return view;
}

/** The part of a bitmap cache key that names an overlay view: `${docId}#ov:${hash}`. */
export const OVERLAY_KEY_MARK = '#ov:';

/** The cache document id of a page shown with an overlay. */
export function overlayCacheId(docId: string, hash: string): string {
  return `${docId}${OVERLAY_KEY_MARK}${hash}`;
}

// ---- Which pages "Add overlay to pages" acts on --------------------------------------------------------------------------

/** What the scope rules read: the page list, the selection and the focused pane's current page. */
export interface CompareInputs {
  /** The uids of the document's pages, in page order. */
  order: readonly string[];
  /** The selected uids (any order; only those in `order` count). */
  selected: readonly string[];
  /** The focused pane's current page, or null. */
  current: string | null;
}

/** One page the overlay goes on, and the 0-based overlay page that goes on it. */
export interface OverlayPair {
  uid: string;
  sourceIndex: number;
}

export interface CompareTargets {
  /** The pages the scope names that have an overlay page, in page order. */
  pairs: OverlayPair[];
  /** The pages the scope names, with or without a partner. */
  named: number;
}

/**
 * The pages "Add to" names, with their overlay pages. Always read from the live page list, selection and current page (never kept
 * from when the sheet opened), so a save that restarts the uids, a selection changed while the sheet is open, another document
 * with a selection of its own, or a second pane cannot make the sheet act on other pages than the ones it names.
 */
export function compareTargets(
  inputs: CompareInputs,
  scope: CompareAddTo,
  session: Pick<CompareSession, 'match' | 'startPage' | 'fixedPage' | 'file'>,
): CompareTargets {
  const { order } = inputs;
  let named: string[];
  switch (scope) {
    case 'all':
      named = [...order];
      break;
    case 'selected': {
      const picked = new Set(inputs.selected);
      named = order.filter((uid) => picked.has(uid));
      break;
    }
    case 'current':
      named = inputs.current !== null && order.includes(inputs.current) ? [inputs.current] : [];
      break;
  }
  const position = new Map(order.map((uid, i) => [uid, i] as const));
  const pairs: OverlayPair[] = [];
  for (const uid of named) {
    const partner = partnerOf(session, position.get(uid)!);
    if (partner !== null) pairs.push({ uid, sourceIndex: partner });
  }
  return { pairs, named: named.length };
}

/** Why "Add overlay to pages" is off, or null when it can run. */
export function addProblem(session: Pick<CompareSession, 'phase' | 'look' | 'file' | 'sourceDocId'>, targets: CompareTargets): string | null {
  if (session.look === 'differences') return COMPARE_DIFFERENCES_VIEW_ONLY;
  if (!session.file || session.sourceDocId === null || session.phase !== 'ready') return COMPARE_CHOOSE_FIRST;
  if (targets.pairs.length === 0) return COMPARE_NO_MATCH;
  return null;
}
