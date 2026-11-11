import type { ComponentType, ReactNode } from 'react';
import type { DockSide } from '../stores/uiStore';

export interface PanelDef {
  id: string;
  title: string;
  icon: ReactNode;
  component: ComponentType;
  /** Default dock side. The user can move a panel later from its header. */
  dock: DockSide;
}

/** Panels shown in the left rail. The rail holds up to 10 icons, and the rest go under "more". */
export const RAIL_CAPACITY = 10;

export class PanelRegistry {
  private readonly panels = new Map<string, PanelDef>();

  register(def: PanelDef): void {
    if (this.panels.has(def.id)) throw new Error(`Panel already registered: ${def.id}`);
    this.panels.set(def.id, def);
  }

  get(id: string): PanelDef | undefined {
    return this.panels.get(id);
  }

  list(): PanelDef[] {
    return [...this.panels.values()];
  }
}

export const panels = new PanelRegistry();
