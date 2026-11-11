import type { ReactNode } from 'react';

/** How much a toolbar item matters when the bar is too narrow (see ui/topbar/overflow.ts). */
export type ToolbarPriority = 'critical' | 'high' | 'normal';

/** One row of a toolbar menu: a dropdown of a menu button, or the "…" overflow menu. */
export type MenuEntry =
  /** A registered command. Its enabled state, reason and shortcut come from the registry and the keymap. */
  | { kind: 'command'; command: string; label: string; check?: 'check' | 'radio'; checked?: boolean; stay?: boolean }
  /** A row that does something else, such as opening one recent file. */
  | { kind: 'run'; label: string; run: () => void; checked?: boolean }
  /** A row that says something (for example "No recent files"). It is not a choice. */
  | { kind: 'note'; label: string }
  /** A small heading over the rows that follow (a group or a submenu of the bar). */
  | { kind: 'heading'; label: string; sub?: boolean }
  | { kind: 'sep' }
  /** A color picker row (the custom page colors). */
  | { kind: 'color'; label: string; ariaLabel: string; value: string; onChange: (value: string) => void };

/** What an item is told when it renders. */
export interface ToolbarRenderContext {
  /** True when labels show beside the icons right now (Show Labels is on and there is room). */
  labels: boolean;
}

/** One button or control of the top bar. */
export interface ToolbarItem {
  id: string;
  priority: ToolbarPriority;
  /** The plain label, used for the label beside the icon and the overflow menu. */
  label: string;
  /** The control in the bar. */
  render: (context: ToolbarRenderContext) => ReactNode;
  /** The rows the item has in the "…" menu when it is collapsed. Read when the menu opens and while it is open. */
  menu: () => MenuEntry[];
}

/**
 * One group in the top bar (File, Nav, View, Pages, Search, Theme). Each group is one entry, so a group can be added or
 * removed without touching the shell. Items of one group and one priority collapse into the "…" menu together.
 */
export interface TopBarGroup {
  id: string;
  order: number;
  /** The heading the group's collapsed items have in the "…" menu. */
  label: string;
  items: ToolbarItem[];
}

export class TopBarRegistry {
  private readonly groups = new Map<string, TopBarGroup>();

  register(group: TopBarGroup): void {
    if (this.groups.has(group.id)) throw new Error(`Top bar group already registered: ${group.id}`);
    this.groups.set(group.id, group);
  }

  list(): TopBarGroup[] {
    return [...this.groups.values()].sort((a, b) => a.order - b.order);
  }
}

export const topBar = new TopBarRegistry();
