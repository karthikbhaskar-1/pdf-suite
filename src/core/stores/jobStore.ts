import { create } from 'zustand';
import type { JobPhase } from '../../engine/mupdf/jobProtocol';

/**
 * The batch job that is running now (Split into Files; Combine in 1.3.3), app-wide: the status bar of every tab reads it, also
 * with no document open. One job at a time. The result notice stays until it is closed or the next job starts.
 */

export type JobKindName = 'split' | 'combine';

export interface ActiveJob {
  kind: JobKindName;
  phase: JobPhase;
  done: number;
  total: number;
  unit: 'files' | 'pages';
  /** Cancel was pressed: the bar says "Cancelling…" and the button is off. */
  cancelling: boolean;
}

export interface JobNotice {
  id: number;
  /** The text. */
  message: string;
  failed: boolean;
  /** Result ids of the files made, for Show in folder. */
  resultIds: string[];
  /** Combine: the new file was not opened automatically, so the notice offers Open. */
  openResultId?: string;
}

interface JobState {
  job: ActiveJob | null;
  /** The function that cancels the running job. Not state the UI draws. */
  cancel: (() => void) | null;
  notice: JobNotice | null;
  /**
   * Passwords the user gave for encrypted files in Combine, by path. In memory only: never written to disk, a log or a
   * recovery file. They live until the list is cleared or the app closes, so a locked file is asked for once.
   */
  passwords: Record<string, string>;
  rememberPassword: (path: string, password: string) => void;
  forgetPasswords: () => void;
  start: (kind: JobKindName, cancel: () => void) => void;
  progress: (phase: JobPhase, done: number, total: number, unit: 'files' | 'pages') => void;
  setCancelling: () => void;
  finish: () => void;
  setNotice: (notice: Omit<JobNotice, 'id'>) => void;
  dismissNotice: () => void;
}

let noticeSeq = 0;

export const useJobStore = create<JobState>()((set, get) => ({
  job: null,
  cancel: null,
  notice: null,
  passwords: {},
  rememberPassword: (path, password) => set((s) => ({ passwords: { ...s.passwords, [path]: password } })),
  forgetPasswords: () => set({ passwords: {} }),
  start: (kind, cancel) => set({ job: { kind, phase: 'reading', done: 0, total: 0, unit: 'files', cancelling: false }, cancel, notice: null }),
  progress: (phase, done, total, unit) => {
    const job = get().job;
    if (job) set({ job: { ...job, phase, done, total, unit } });
  },
  setCancelling: () => {
    const job = get().job;
    if (job) set({ job: { ...job, cancelling: true } });
  },
  finish: () => set({ job: null, cancel: null }),
  setNotice: (notice) => set({ notice: { ...notice, id: ++noticeSeq } }),
  dismissNotice: () => set({ notice: null }),
}));

/** True while a job runs: Split and Combine are off, and quitting asks. */
export function jobIsRunning(): boolean {
  return useJobStore.getState().job !== null;
}
