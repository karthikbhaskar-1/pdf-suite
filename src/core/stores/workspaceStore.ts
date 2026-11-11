import { create } from 'zustand';
import type { Pane, Tab, ViewState } from '../model/types';

export interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  /** The focused pane. Keyboard commands and the panels act on it. */
  activePaneId: string | null;
  addTab: (tab: Tab, index?: number) => void;
  patchTab: (tabId: string, patch: Partial<Pick<Tab, 'title' | 'status' | 'panes' | 'split' | 'origin'>>) => void;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setActivePane: (paneId: string) => void;
  setView: (paneId: string, patch: Partial<ViewState>) => void;
  replaceTabs: (tabs: Tab[], activeTabId: string | null) => void;
}

function findPane(tabs: Tab[], paneId: string): Pane | undefined {
  for (const tab of tabs) {
    const pane = tab.panes.find((p) => p.id === paneId);
    if (pane) return pane;
  }
  return undefined;
}

function firstPaneId(tab: Tab | undefined): string | null {
  return tab?.panes[0]?.id ?? null;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  tabs: [],
  activeTabId: null,
  activePaneId: null,

  addTab: (tab, index) =>
    set((s) => {
      const tabs = [...s.tabs];
      const at = index === undefined ? tabs.length : Math.min(Math.max(index, 0), tabs.length);
      tabs.splice(at, 0, tab);
      return { tabs, activeTabId: tab.id, activePaneId: firstPaneId(tab) };
    }),

  patchTab: (tabId, patch) =>
    set((s) => {
      const tabs = s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
      if (s.activeTabId !== tabId) return { tabs };
      // The tab may have gained its first pane after it became active (files open asynchronously).
      // If the focused pane is not in this tab, focus its first pane.
      const tab = tabs.find((t) => t.id === tabId);
      const focusedIsHere = tab?.panes.some((p) => p.id === s.activePaneId) ?? false;
      return focusedIsHere ? { tabs } : { tabs, activePaneId: firstPaneId(tab) };
    }),

  removeTab: (tabId) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === tabId);
      if (index < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== tabId);
      if (s.activeTabId !== tabId) {
        return { tabs };
      }
      const next = tabs[Math.min(index, tabs.length - 1)];
      return { tabs, activeTabId: next?.id ?? null, activePaneId: firstPaneId(next) };
    }),

  setActiveTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return s;
      return { activeTabId: tabId, activePaneId: firstPaneId(tab) };
    }),

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  setView: (paneId, patch) =>
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.panes.some((p) => p.id === paneId)
          ? {
              ...tab,
              panes: tab.panes.map((p) => (p.id === paneId ? { ...p, view: { ...p.view, ...patch } } : p)),
            }
          : tab,
      ),
    })),

  replaceTabs: (tabs, activeTabId) => {
    const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
    set({ tabs, activeTabId: active?.id ?? null, activePaneId: firstPaneId(active) });
  },
}));

export function selectActiveTab(state: WorkspaceState): Tab | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

export function selectPane(state: WorkspaceState, paneId: string | null): Pane | undefined {
  return paneId ? findPane(state.tabs, paneId) : undefined;
}
