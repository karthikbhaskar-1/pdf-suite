import { create } from 'zustand';
import type { BlankMeasure, BlankSensitivity } from '../../engine/mupdf/blankDetect';
import type { SizeUnit } from '../../features/jobs/splitPlan';
import type { BlankKeep, SplitMethod } from '../../features/jobs/splitSheetModel';
import type { SplitRefusalKind } from '../../features/jobs/jobMessages';

/**
 * The Split into Files side sheet (UI spec section 2). It acts on ONE document, the one that was in front when the command
 * ran, and on its SAVED file. `stage` says what the sheet shows: it is checking the file, asking to save first, ready, or
 * showing why this document cannot be split.
 */

export type SplitStage = 'checking' | 'unsaved' | 'ready' | 'refused';

export interface SplitFacts {
  encrypted: boolean;
  fields: number;
  layers: boolean;
  attachments: number;
}

export interface SplitSheet {
  docId: string;
  /** The saved file the split reads, and its name. */
  path: string;
  name: string;
  stage: SplitStage;
  refusal: SplitRefusalKind | null;
  pages: number;
  byteLength: number;
  facts: SplitFacts | null;
  method: SplitMethod;
  perFileText: string;
  sizeText: string;
  sizeUnit: SizeUnit;
  sensitivity: BlankSensitivity;
  measures: readonly BlankMeasure[] | null;
  /** The blank-page search is running: pages done and total. */
  looking: { done: number; total: number } | null;
  unticked: readonly number[];
  blankKeep: BlankKeep;
  entries: ReadonlyArray<{ title: string; page: number }> | null;
  folder: { token: string; label: string } | null;
  baseName: string;
  keepPassword: boolean;
  /** Shown under the box "Keep the password" after CannotKeepPassword. */
  passwordNote: string | null;
  /** The sheet is hidden while its job runs. */
  hidden: boolean;
}

interface SplitState {
  sheet: SplitSheet | null;
  open: (sheet: SplitSheet) => void;
  update: (patch: Partial<SplitSheet>) => void;
  close: () => void;
}

export const useSplitStore = create<SplitState>()((set, get) => ({
  sheet: null,
  open: (sheet) => set({ sheet }),
  update: (patch) => {
    const current = get().sheet;
    if (current) set({ sheet: { ...current, ...patch } });
  },
  close: () => set({ sheet: null }),
}));
