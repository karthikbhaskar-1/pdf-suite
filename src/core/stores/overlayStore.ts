import { create } from 'zustand';

/** One row of a context menu. A row with `items` opens a submenu inline. */
export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  onSelect?: () => void;
  items?: MenuItem[];
}

export interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  /** Opened from the keyboard (Shift+F10, the Menu key): focus moves into the menu, and gives back when it closes. */
  keyboard?: boolean;
}

interface OverlayState {
  menu: OpenMenu | null;
  paletteOpen: boolean;
  openMenu: (x: number, y: number, items: MenuItem[], options?: { keyboard?: boolean }) => void;
  closeMenu: () => void;
  setPaletteOpen: (open: boolean) => void;
}

/** Context menus and the command palette. Only one menu is open at a time. */
export const useOverlayStore = create<OverlayState>()((set) => ({
  menu: null,
  paletteOpen: false,
  openMenu: (x, y, items, options) => set({ menu: { x, y, items, ...(options?.keyboard ? { keyboard: true } : {}) } }),
  closeMenu: () => set({ menu: null }),
  setPaletteOpen: (open) => set({ paletteOpen: open, menu: null }),
}));
