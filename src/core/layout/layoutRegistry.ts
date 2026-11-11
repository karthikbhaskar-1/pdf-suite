/**
 * Named layout presets. Only the "default" preset exists in Milestone 1.1. Split and
 * floating-window layouts will register more presets here.
 */
export interface LayoutPreset {
  id: string;
  label: string;
  /** Whether the left rail is shown. */
  railVisible: boolean;
}

export class LayoutRegistry {
  private readonly presets = new Map<string, LayoutPreset>();
  private activeId = 'default';

  register(preset: LayoutPreset): void {
    this.presets.set(preset.id, preset);
  }

  setActive(id: string): void {
    if (this.presets.has(id)) this.activeId = id;
  }

  active(): LayoutPreset {
    return this.presets.get(this.activeId) ?? { id: 'default', label: 'Default', railVisible: true };
  }
}

export const layouts = new LayoutRegistry();
layouts.register({ id: 'default', label: 'Default', railVisible: true });
