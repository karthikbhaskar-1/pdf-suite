import { create } from 'zustand';
import { diag } from '../../engine/diag';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type DockSide = 'left' | 'right';

/** A button on a toast, such as Undo. The toast closes when it is pressed. */
/** What an encryption choice (Save without a password) is about: where to write, and for an extract, which pages. */
export interface EncryptionPending {
  /** The path the user picked in the Save dialog. Null when the save is to the document's own path. */
  target: string | null;
  /** Set for an extract: the pages and the source name (for the default file name). */
  extract?: { uids: string[]; name: string };
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
  sticky?: boolean;
}

export const DOCK_DEFAULT_WIDTH = 260;
export const DOCK_MIN_WIDTH = 180;
export const DOCK_MAX_WIDTH = 480;

interface UiState {
  theme: ThemeChoice;
  /** Which panel is open in each dock. Null means the dock is closed. */
  openPanel: Record<DockSide, string | null>;
  /** Which dock each panel lives in. Panels default to the left dock. */
  panelSide: Record<string, DockSide>;
  dockWidth: Record<DockSide, number>;
  /** Tab waiting for a password. The password modal is shown while this is set. */
  passwordTabId: string | null;
  passwordError: string | null;
  /**
   * A PDF picked for Insert or Replace asks for its password. The name is shown in the prompt, `error` holds the plain
   * message after a wrong try. Null when no such prompt is open. The password itself is never kept here.
   */
  sourcePassword: { name: string; error: string | null } | null;
  setSourcePassword: (prompt: { name: string; error: string | null } | null) => void;
  toasts: Toast[];
  /** The Save / Don't save / Cancel prompt on close or quit with unsaved changes. Open while true. */
  closePrompt: boolean;
  /** The "Stop and exit?" prompt shown when the window closes while a batch job runs. */
  jobQuitPrompt: boolean;
  setJobQuitPrompt: (open: boolean) => void;
  /** The document whose save needs an encryption choice (see NeedsEncryptionChoice). Null when none. */
  encryptionChoice: string | null;
  /**
   * What the pending encryption choice is for: the path the user picked (a Save As or an extract target), so the choice
   * is carried out there and never on the document's own file, and, for an extract, the pages and name.
   */
  encryptionPending: EncryptionPending | null;
  /** The save that is waiting for "Save anyway" because its estimated size is over the edit limit. Null when none. */
  largeSave: { docId: string; options: { saveAs?: boolean; targetPath?: string; dropEncryption?: boolean } } | null;
  setLargeSave: (pending: { docId: string; options: { saveAs?: boolean; targetPath?: string; dropEncryption?: boolean } } | null) => void;
  setTheme: (theme: ThemeChoice) => void;
  togglePanel: (panelId: string) => void;
  /** Opens a panel in its dock, without closing it if it is already open. */
  showPanel: (panelId: string) => void;
  movePanel: (panelId: string, side: DockSide) => void;
  closePanel: (side: DockSide) => void;
  setDockWidth: (side: DockSide, width: number) => void;
  openPassword: (tabId: string) => void;
  setPasswordError: (message: string | null) => void;
  closePassword: () => void;
  /** `sticky`: the toast stays until it is closed (the crash-loop notice); otherwise it fades after 4 seconds. */
  pushToast: (message: string, action?: ToastAction, options?: { sticky?: boolean }) => void;
  dismissToast: (id: number) => void;
  setClosePrompt: (open: boolean) => void;
  setEncryptionChoice: (docId: string | null, pending?: EncryptionPending | null) => void;
  /** Whether the top bar (the toolbar with File, Nav, Zoom and Pages groups) is shown. Persisted per viewer. */
  toolbarVisible: boolean;
  setToolbarVisible: (visible: boolean) => void;
  /** Whether the toolbar buttons show their labels beside the icons (View > Toolbar > Show Labels). Persisted per viewer. */
  toolbarLabels: boolean;
  setToolbarLabels: (labels: boolean) => void;
  /** The help dialog open from the Help menu, if any. */
  helpDialog: "shortcuts" | "about" | null;
  setHelpDialog: (dialog: "shortcuts" | "about" | null) => void;
}

const TOOLBAR_KEY = "pdfsuite.toolbarVisible";

/** The saved toolbar setting. Shown unless it was turned off; a storage that cannot be read shows it. */
function readToolbarVisible(): boolean {
  try {
    return globalThis.localStorage?.getItem(TOOLBAR_KEY) !== "false";
  } catch {
    return true;
  }
}

const LABELS_KEY = "pdfsuite.toolbarLabels";

/** The saved Show Labels setting. Off unless it was turned on; a storage that cannot be read leaves it off. */
function readToolbarLabels(): boolean {
  try {
    return globalThis.localStorage?.getItem(LABELS_KEY) === "true";
  } catch {
    return false;
  }
}

let toastSeq = 0;

export const useUiStore = create<UiState>()((set, get) => ({
  theme: 'system',
  openPanel: { left: null, right: null },
  panelSide: {},
  dockWidth: { left: DOCK_DEFAULT_WIDTH, right: DOCK_DEFAULT_WIDTH },
  passwordTabId: null,
  passwordError: null,
  sourcePassword: null,
  toasts: [],
  closePrompt: false,
  jobQuitPrompt: false,
  setJobQuitPrompt: (open) => set({ jobQuitPrompt: open }),
  encryptionChoice: null,
  encryptionPending: null,
  largeSave: null,
  setLargeSave: (pending) => set({ largeSave: pending }),

  setTheme: (theme) => set({ theme }),

  togglePanel: (panelId) => {
    const { openPanel, panelSide } = get();
    const side = panelSide[panelId] ?? 'left';
    const isOpen = openPanel[side] === panelId;
    set({ openPanel: { ...openPanel, [side]: isOpen ? null : panelId } });
  },

  showPanel: (panelId) => {
    const { openPanel, panelSide } = get();
    const side = panelSide[panelId] ?? 'left';
    if (openPanel[side] !== panelId) set({ openPanel: { ...openPanel, [side]: panelId } });
  },

  movePanel: (panelId, side) => {
    const { openPanel, panelSide } = get();
    const from: DockSide = panelSide[panelId] ?? 'left';
    const wasOpen = openPanel[from] === panelId;
    const next = { ...openPanel };
    if (wasOpen) next[from] = null;
    if (wasOpen) next[side] = panelId;
    set({ panelSide: { ...panelSide, [panelId]: side }, openPanel: next });
  },

  closePanel: (side) => set((s) => ({ openPanel: { ...s.openPanel, [side]: null } })),

  setDockWidth: (side, width) =>
    set((s) => ({
      dockWidth: { ...s.dockWidth, [side]: Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, width)) },
    })),

  openPassword: (tabId) => set({ passwordTabId: tabId, passwordError: null }),
  setPasswordError: (message) => set({ passwordError: message }),
  closePassword: () => set({ passwordTabId: null, passwordError: null }),
  setSourcePassword: (prompt) => set({ sourcePassword: prompt }),

  pushToast: (message, action, options) => {
    diag('toast', { message });
    toastSeq += 1;
    const id = toastSeq;
    const toast: Toast = { id, message, ...(action ? { action } : {}), ...(options?.sticky === true ? { sticky: true } : {}) };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    if (options?.sticky !== true) setTimeout(() => get().dismissToast(id), 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setClosePrompt: (open) => set({ closePrompt: open }),
  setEncryptionChoice: (docId, pending = null) => set({ encryptionChoice: docId, encryptionPending: docId === null ? null : pending }),
  toolbarVisible: readToolbarVisible(),
  setToolbarVisible: (visible) => {
    try {
      globalThis.localStorage?.setItem(TOOLBAR_KEY, visible ? "true" : "false");
    } catch {
      // The setting is kept for this session only.
    }
    set({ toolbarVisible: visible });
  },
  toolbarLabels: readToolbarLabels(),
  setToolbarLabels: (labels) => {
    try {
      globalThis.localStorage?.setItem(LABELS_KEY, labels ? "true" : "false");
    } catch {
      // The setting is kept for this session only.
    }
    set({ toolbarLabels: labels });
  },
  helpDialog: null,
  setHelpDialog: (dialog) => set({ helpDialog: dialog }),
}));
