import { create } from 'zustand';

/**
 * The right-docked side sheet of the page organizer (320 px, no scrim, live preview). One sheet is open at a time. Each
 * kind keeps its own draft. The draft is read when the sheet's Apply runs; the document is not changed before then.
 */

export type InsertTemplate = 'blank' | 'lined' | 'grid';
export type SizeName = 'letter' | 'a4' | 'legal' | 'custom';
export type LengthUnit = 'in' | 'mm' | 'pt';
/** Where new pages go: before the current page, after it, or at a 1-based position. */
export type InsertPosition = 'before' | 'after' | 'at';
export type CropScope = 'current' | 'selected' | 'all' | 'odd' | 'even';
export type FitMode = 'scale' | 'center';
/** Cut Pages in Half: 'vertical' makes a left and a right page, 'horizontal' a top and a bottom page. */
export type CutDirection = 'vertical' | 'horizontal';
export type CutScope = 'current' | 'selected' | 'all' | 'wide';

/** Margins of a crop, in points, measured on the display page. */
export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface DraftBase {
  /** The document the sheet acts on. The sheet closes when another document is shown. */
  docId: string;
}

export interface InsertDraft extends DraftBase {
  kind: 'insert';
  template: InsertTemplate;
  size: SizeName;
  custom: { width: number; height: number };
  unit: LengthUnit;
  count: number;
  position: InsertPosition;
  /** The 1-based position used by "At #". */
  at: number;
  /** The page the sheet was opened on. Before, after and At are measured from it. */
  pageIndex: number;
}

export interface FromDraft extends DraftBase {
  kind: 'from';
  pageIndex: number;
  sourceDocId: string | null;
  sourceName: string | null;
  sourcePages: number;
  range: string;
  position: InsertPosition;
  at: number;
}

export interface ReplaceDraft extends DraftBase {
  kind: 'replace';
  /** The uid of the page to replace. */
  uid: string;
  pageNumber: number;
  sourceDocId: string | null;
  sourceName: string | null;
  sourcePages: number;
  /** The 1-based page of the source file. */
  sourcePage: number;
}

export interface RotateDraft extends DraftBase {
  kind: 'rotate';
  uids: string[];
  degrees: number;
}

export interface CropDraft extends DraftBase {
  kind: 'crop';
  uids: string[];
  /** The page the on-page box is drawn on. */
  pageId: string;
  scope: CropScope;
  unit: LengthUnit;
  margins: Margins;
  /** True after Auto-crop was applied. Cancel then undoes it. */
  autoApplied: boolean;
  /** The document version the Auto-crop preview produced. Cancel undoes it only while the document is still at it. */
  autoVersion?: number;
  /** The generation of the document instance that version belongs to. A save restarts the version counter. */
  autoGeneration?: number;
}

export interface SizeDraft extends DraftBase {
  kind: 'size';
  uids: string[];
  size: SizeName;
  custom: { width: number; height: number };
  unit: LengthUnit;
  fit: FitMode;
  scope: 'selected' | 'all';
}

/**
 * Cut Pages in Half. The pages it acts on are not kept here: "Apply to" is read from the live selection, current page and
 * page list whenever the sheet draws, the guide draws and Apply runs (see features/organizer/cutMath.ts).
 */
export interface CutDraft extends DraftBase {
  kind: 'cut';
  direction: CutDirection;
  /** The cut position in percent, as typed. */
  percentText: string;
  /** Which half comes first for a left and right cut. */
  first: 'left' | 'right';
  scope: CutScope;
}

/**
 * Overlay to Compare (1.3.4). The sheet only says which document it belongs to: every setting lives in the compare store
 * (core/stores/compareStore.ts), because the view follows each control at once and keeps going while the sheet is hidden ([»]).
 */
export interface CompareDraft extends DraftBase {
  kind: 'compare';
}

export interface ConfirmDeleteDraft extends DraftBase {
  kind: 'confirmDelete';
  uids: string[];
  total: number;
}

export type SheetDraft = InsertDraft | FromDraft | ReplaceDraft | RotateDraft | CropDraft | SizeDraft | CutDraft | CompareDraft | ConfirmDeleteDraft;

interface SheetState {
  sheet: SheetDraft | null;
  open: (sheet: SheetDraft) => void;
  /** Merges a change into the open sheet's draft. Does nothing when no sheet is open. */
  update: (patch: Partial<SheetDraft>) => void;
  close: () => void;
}

export const useSheetStore = create<SheetState>()((set, get) => ({
  sheet: null,
  open: (sheet) => set({ sheet }),
  update: (patch) => {
    const current = get().sheet;
    if (!current) return;
    set({ sheet: { ...current, ...patch } as SheetDraft });
  },
  close: () => set({ sheet: null }),
}));
