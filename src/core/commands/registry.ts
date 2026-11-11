import { diag } from '../../engine/diag';

export interface CommandDef {
  id: string;
  label: string;
  /** Runs the command. `arg` is set by menus that act on one item of a list (a recent file, a tab). */
  run: (arg?: string) => void | Promise<void>;
  /** When this returns false the command is shown disabled and does not run. */
  enabled?: () => boolean;
  /** Why the command is disabled, for its tooltip (for example a form that cannot be edited). Undefined when none. */
  disabledReason?: () => string | undefined;
  /**
   * Called when the command's shortcut is pressed while the command is disabled (for example to say why, in a toast).
   * Returning false means it had nothing to say, and the key is left to the browser as if no command had it.
   */
  onBlockedKey?: () => void | boolean;
  /** A label that changes with the state, such as "Undo Delete 3 pages". Used by the menus and palette when set. */
  dynamicLabel?: () => string | undefined;
  /** For toggles and radio choices: whether the command is on. Menus show a checkmark or a bullet. */
  checked?: () => boolean;
}

/** Every user action is a command. Buttons, shortcuts and menus all point at these. */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDef>();

  register(def: CommandDef): void {
    if (this.commands.has(def.id)) {
      throw new Error(`Command already registered: ${def.id}`);
    }
    this.commands.set(def.id, def);
  }

  get(id: string): CommandDef | undefined {
    return this.commands.get(id);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  isEnabled(id: string): boolean {
    const def = this.commands.get(id);
    return def !== undefined && (def.enabled?.() ?? true);
  }

  /** The reason a command is disabled, or undefined when there is none. */
  reasonDisabled(id: string): string | undefined {
    return this.commands.get(id)?.disabledReason?.();
  }

  /** The label to show now: the dynamic label when the command has one that applies, else its label. */
  labelOf(id: string): string | undefined {
    const def = this.commands.get(id);
    if (!def) return undefined;
    return def.dynamicLabel?.() ?? def.label;
  }

  /** Runs a command if it exists and is enabled. Returns whether it ran. */
  async run(id: string, arg?: string): Promise<boolean> {
    const def = this.commands.get(id);
    if (!def || !(def.enabled?.() ?? true)) {
      diag('cmd.blocked', { id });
      return false;
    }
    diag('cmd.run', { id });
    await def.run(arg);
    return true;
  }

  list(): CommandDef[] {
    return [...this.commands.values()];
  }
}

export const commands = new CommandRegistry();
