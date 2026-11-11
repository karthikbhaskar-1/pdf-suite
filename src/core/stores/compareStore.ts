import { create } from 'zustand';
import type { LengthUnit } from './sheetStore';

/**
 * The state of "Overlay to Compare" (1.3.4). One session at a time, tied to one document: starting a compare on another
 * document ends the first (the UI spec's rule), and closing the document ends it. The sheet draws from this store, so every
 * control changes the view at once; the viewer reads it to ask the engine for the overlay (see ui/viewer/usePageBitmap.ts).
 *
 * The password of a protected overlay file is NOT kept here. It lives in features/compare/compareSession.ts, in memory only.
 */

/** The three looks of the sheet: Both (Multiply), See-through (Blend) and Differences (view only). */
export type CompareLook = 'both' | 'seethrough' | 'differences';
/** Page by page from a start page, or one overlay page on every page. */
export type CompareMatch = 'sequential' | 'fixed';
/** Which pages "Add overlay to pages" goes on. */
export type CompareAddTo = 'current' | 'selected' | 'all';

/** The overlay file as the sheet shows it. */
export interface CompareFile {
  /** The path it was read from, or null when it has none (it is then used as long as the session lasts, and cannot be re-read). */
  path: string | null;
  name: string;
  pages: number;
}

export interface CompareSession {
  /** Names this compare for as long as it lasts, whatever the document's id becomes (a Save As changes the id). */
  key: number;
  docId: string;
  /** 'none': no file yet. 'opening': a file is being read. 'ready': the overlay is attached. 'reattaching': read again after a save. */
  phase: 'none' | 'opening' | 'ready' | 'reattaching';
  file: CompareFile | null;
  /** The id of the overlay in the document's worker. Null while nothing is attached (the page then shows plain). */
  sourceDocId: string | null;
  /** Counts attachments. It is part of the view key, so a re-attached overlay never finds the bitmaps of the old one. */
  attach: number;
  show: boolean;
  look: CompareLook;
  /** 0 to 100. Used by See-through only. */
  opacity: number;
  match: CompareMatch;
  /** 1-based. The overlay page that goes with page 1 (Page by page). */
  startPage: number;
  /** 1-based. The overlay page that goes on every page (Same overlay page on every page). */
  fixedPage: number;
  /** Across and Down, in points of the page as shown (the placement maths are in engine/overlayPlacement.ts). */
  dx: number;
  dy: number;
  unit: LengthUnit;
  /** The overlay's size in percent, 25 to 400. */
  size: number;
  addTo: CompareAddTo;
  /** Display sizes of the overlay's pages that were asked for, by 0-based page. For "different size" and Fit to page. */
  sizes: Record<number, { width: number; height: number }>;
  /** A message that replaces the file line while it applies ("Opening «name»…"), or a failure. */
  note: string | null;
}

interface CompareState {
  session: CompareSession | null;
  /** Starts a session on a document, with the sheet's defaults. */
  begin: (docId: string, unit: LengthUnit) => void;
  /** Merges a change into the session. Does nothing when there is none. */
  patch: (patch: Partial<CompareSession>) => void;
  /** Ends the session. */
  end: () => void;
  /** The document was given a new id (Save As): the session follows it. */
  rekey: (oldId: string, newId: string) => void;
}

let sessionSeq = 0;

export function newSession(docId: string, unit: LengthUnit): CompareSession {
  sessionSeq += 1;
  return {
    key: sessionSeq,
    docId,
    phase: 'none',
    file: null,
    sourceDocId: null,
    attach: 0,
    show: true,
    look: 'both',
    opacity: 50,
    match: 'sequential',
    startPage: 1,
    fixedPage: 1,
    dx: 0,
    dy: 0,
    unit,
    size: 100,
    addTo: 'current',
    sizes: {},
    note: null,
  };
}

export const useCompareStore = create<CompareState>()((set, get) => ({
  session: null,
  begin: (docId, unit) => set({ session: newSession(docId, unit) }),
  patch: (patch) => {
    const current = get().session;
    if (!current) return;
    set({ session: { ...current, ...patch } });
  },
  end: () => set({ session: null }),
  rekey: (oldId, newId) => {
    const current = get().session;
    if (current?.docId === oldId) set({ session: { ...current, docId: newId } });
  },
}));

/** The session of `docId`, or null when that document is not being compared. */
export function sessionOf(docId: string | undefined): CompareSession | null {
  const session = useCompareStore.getState().session;
  return docId !== undefined && session?.docId === docId ? session : null;
}
