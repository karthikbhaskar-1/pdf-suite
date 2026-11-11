import { create } from 'zustand';

export type FloatingId = 'loupe' | 'panZoom';

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingWindowState extends FloatingRect {
  open: boolean;
}

export const FLOATING_MIN_WIDTH = 180;
export const FLOATING_MIN_HEIGHT = 140;

const STORAGE_KEY = 'pdfSuite.floating';

/** Default position and size, used until the user moves or resizes a window. */
export const FLOATING_DEFAULTS: Record<FloatingId, FloatingRect> = {
  loupe: { x: 24, y: 120, width: 300, height: 220 },
  panZoom: { x: 24, y: 360, width: 240, height: 300 },
};

type Stored = Record<FloatingId, FloatingWindowState>;

function defaults(): Stored {
  return {
    loupe: { open: false, ...FLOATING_DEFAULTS.loupe },
    panZoom: { open: false, ...FLOATING_DEFAULTS.panZoom },
  };
}

/** Reads saved positions. Missing or unreadable data falls back to the defaults. */
export function loadFloating(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<Record<FloatingId, Partial<FloatingWindowState>>>;
    const result = defaults();
    for (const id of ['loupe', 'panZoom'] as const) {
      const saved = parsed[id];
      if (!saved) continue;
      result[id] = {
        // Windows are closed at startup, so the user opens them again.
        open: false,
        x: finiteOr(saved.x, result[id].x),
        y: finiteOr(saved.y, result[id].y),
        width: Math.max(FLOATING_MIN_WIDTH, finiteOr(saved.width, result[id].width)),
        height: Math.max(FLOATING_MIN_HEIGHT, finiteOr(saved.height, result[id].height)),
      };
    }
    return result;
  } catch {
    return defaults();
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function save(state: Stored): void {
  try {
    // Only geometry is kept. Open state is session-only.
    const geometry = Object.fromEntries(
      (['loupe', 'panZoom'] as const).map((id) => [id, { x: state[id].x, y: state[id].y, width: state[id].width, height: state[id].height }]),
    );
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(geometry));
  } catch {
    // Storage is unavailable. The windows still work for this session.
  }
}

interface FloatingStore {
  windows: Stored;
  open: (id: FloatingId) => void;
  close: (id: FloatingId) => void;
  toggle: (id: FloatingId) => void;
  move: (id: FloatingId, rect: Partial<FloatingRect>) => void;
  /** Saves the current geometry. Called when a drag or resize ends. */
  commitGeometry: () => void;
}

export const useFloatingStore = create<FloatingStore>()((set, get) => ({
  windows: loadFloating(),
  open: (id) => set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], open: true } } })),
  close: (id) => set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], open: false } } })),
  toggle: (id) => {
    const isOpen = get().windows[id].open;
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], open: !isOpen } } }));
  },
  move: (id, rect) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], ...rect } } })),
  commitGeometry: () => save(get().windows),
}));
