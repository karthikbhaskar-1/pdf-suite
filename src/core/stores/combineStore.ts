import { create } from 'zustand';
import type { CombineRow, PictureSize, TextSize } from '../../features/jobs/combinePlan';

/**
 * The Combine window (UI spec section 1): the list of files, what is selected, the options, and the messages the window shows.
 * The list is kept when the window closes after a failure or a Cancel (it reopens as it was) and cleared after a success.
 * Passwords are not here: they live in jobStore (memory only).
 */

export interface CombineMessage {
  id: number;
  text: string;
  /** Save now, for a listed file that is open with unsaved changes. */
  action?: { label: string; docId: string };
}

export interface CombineState {
  open: boolean;
  rows: CombineRow[];
  /** Ids of the selected rows. The preview shows the one in `focusId`. */
  selected: string[];
  focusId: string | null;
  messages: CombineMessage[];
  fileBookmarks: boolean;
  openWhenDone: boolean;
  pictureSize: PictureSize;
  textSize: TextSize;
  /** A message about the output name (target-is-input, target-open, disk full...). Shown by the footer. */
  targetMessage: string | null;
  /** The pre-run check is going on, or the Save dialog is open. */
  starting: boolean;
  /** Text for the live region ("Report.pdf moved to 2 of 3"). */
  announcement: string;
  /** Bumped when a preview thumbnail arrives, so the previews draw it. */
  thumbVersion: number;
  set: (patch: Partial<CombineState>) => void;
  setRow: (id: string, patch: Partial<CombineRow>) => void;
  addMessage: (text: string, action?: CombineMessage['action']) => void;
  dismissMessage: (id: number) => void;
}

let messageSeq = 0;

export const initialCombine = {
  open: false,
  rows: [] as CombineRow[],
  selected: [] as string[],
  focusId: null as string | null,
  messages: [] as CombineMessage[],
  fileBookmarks: true,
  openWhenDone: true,
  pictureSize: 'image' as PictureSize,
  textSize: 'Letter' as TextSize,
  targetMessage: null as string | null,
  starting: false,
  announcement: '',
  thumbVersion: 0,
};

export const useCombineStore = create<CombineState>()((set) => ({
  ...initialCombine,
  set: (patch) => set(patch),
  setRow: (id, patch) => set((s) => ({ rows: s.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  addMessage: (text, action) =>
    set((s) => {
      // The same text twice is shown once.
      if (s.messages.some((m) => m.text === text)) return s;
      return { messages: [...s.messages, { id: ++messageSeq, text, ...(action ? { action } : {}) }].slice(-6) };
    }),
  dismissMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
}));
