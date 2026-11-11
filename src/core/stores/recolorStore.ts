import { create } from 'zustand';
import { DEFAULT_RECOLOR, type RecolorMode, type RecolorSettings } from '../../features/recolor/recolorFilter';

const STORAGE_KEY = 'pdfSuite.recolor';

/** Reads the saved setting. Storage can be missing or blocked, and bad data is ignored. */
export function loadRecolor(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): RecolorSettings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RECOLOR;
    const value = JSON.parse(raw) as Partial<RecolorSettings>;
    const modes: RecolorMode[] = ['off', 'invert', 'sepia', 'night', 'contrast', 'custom'];
    return {
      mode: modes.includes(value.mode as RecolorMode) ? (value.mode as RecolorMode) : DEFAULT_RECOLOR.mode,
      background: typeof value.background === 'string' ? value.background : DEFAULT_RECOLOR.background,
      text: typeof value.text === 'string' ? value.text : DEFAULT_RECOLOR.text,
    };
  } catch {
    return DEFAULT_RECOLOR;
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function saveRecolor(settings: RecolorSettings): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage is unavailable. The choice still applies for this session.
  }
}

interface RecolorState extends RecolorSettings {
  setMode: (mode: RecolorMode) => void;
  setColors: (colors: { background?: string; text?: string }) => void;
}

/** Page recolor. Applied to the page layer and the loupe, never to thumbnails. Persisted. */
export const useRecolorStore = create<RecolorState>()((set, get) => {
  const commit = (next: RecolorSettings) => {
    saveRecolor(next);
    set(next);
  };
  return {
    ...loadRecolor(),
    setMode: (mode) => {
      const { background, text } = get();
      commit({ mode, background, text });
    },
    setColors: (colors) => {
      const { mode, background, text } = get();
      commit({ mode, background: colors.background ?? background, text: colors.text ?? text });
    },
  };
});

/** The current recolor settings, without the actions. */
export function selectRecolor(state: RecolorState): RecolorSettings {
  return { mode: state.mode, background: state.background, text: state.text };
}
