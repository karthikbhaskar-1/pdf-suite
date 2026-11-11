import { normalizeBinding, normalizeKey, type KeyInput } from './keys';

export type Platform = 'web' | 'desktop';

/**
 * One command's shortcuts. `keys` is the desktop/default set; `web` replaces it in the
 * browser build, where Ctrl+W, Ctrl+Tab and Ctrl+1-9 belong to the browser.
 */
export interface KeyBinding {
  command: string;
  keys: string | readonly string[];
  web?: string | readonly string[];
}

export const DEFAULT_BINDINGS: readonly KeyBinding[] = [
  { command: 'file.open', keys: 'Ctrl+O' },
  { command: 'tab.close', keys: 'Ctrl+W', web: 'Alt+W' },
  { command: 'file.closeAll', keys: 'Ctrl+Shift+W' },
  { command: 'tab.next', keys: 'Ctrl+Tab', web: 'Alt+PgDn' },
  { command: 'tab.prev', keys: 'Ctrl+Shift+Tab', web: 'Alt+PgUp' },
  { command: 'view.fitPage', keys: 'Ctrl+0' },
  { command: 'view.fitWidth', keys: 'Ctrl+1', web: 'Alt+1' },
  { command: 'view.zoomIn', keys: ['Ctrl+=', 'Ctrl++'] },
  { command: 'view.zoomOut', keys: 'Ctrl+-' },
  { command: 'nav.pageDown', keys: 'PgDn' },
  { command: 'nav.pageUp', keys: 'PgUp' },
  { command: 'search.open', keys: 'Ctrl+F' },
  { command: 'search.next', keys: 'F3' },
  { command: 'search.prev', keys: 'Shift+F3' },
  { command: 'split.toggle', keys: 'Ctrl+\\' },
  // F6 focuses the address bar and Ctrl+K the omnibox in browsers, so the web build uses Alt chords.
  { command: 'split.focusNext', keys: 'F6', web: 'Alt+S' },
  { command: 'palette.open', keys: 'Ctrl+K', web: 'Alt+K' },
  { command: 'nav.goto', keys: 'Ctrl+G' },
  // Page organizer (1.2.1). Redo has two chords: Ctrl+Y and Ctrl+Shift+Z.
  { command: 'file.save', keys: 'Ctrl+S' },
  { command: 'file.saveAs', keys: 'Ctrl+Shift+S' },
  { command: 'edit.undo', keys: 'Ctrl+Z' },
  { command: 'edit.redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'] },
  { command: 'pages.delete', keys: 'Delete' },
  { command: 'pages.duplicate', keys: 'Ctrl+D' },
  { command: 'pages.rotateRight', keys: 'Ctrl+Shift+R' },
  { command: 'pages.rotateLeft', keys: 'Ctrl+Shift+L' },
  { command: 'pages.moveUp', keys: 'Alt+Up' },
  { command: 'pages.moveDown', keys: 'Alt+Down' },
  { command: 'pages.moveStart', keys: 'Alt+Home' },
  { command: 'pages.moveEnd', keys: 'Alt+End' },
  // Overlay to Compare (1.3.4): shows or hides the overlay while comparing.
  { command: 'compare.toggle', keys: 'F8' },
  // Menu bar commands with shortcuts (1.2.1 menu bar spec).
  { command: 'page.copy', keys: 'Ctrl+C' },
  { command: 'page.selectAll', keys: 'Ctrl+A' },
  { command: 'view.fullscreen', keys: 'F11' },
  { command: 'file.exit', keys: 'Alt+F4' },
];

function asList(keys: string | readonly string[]): readonly string[] {
  return typeof keys === 'string' ? [keys] : keys;
}

/** Chords the browser reserves for itself. The web profile must not rely on these. */
const BROWSER_RESERVED = new Set(['Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9']);

/**
 * The shortcuts a command uses on one platform, in canonical form.
 * Desktop is the primary profile and uses `keys` unchanged. The web profile uses its own
 * `web` alternatives when given, and otherwise drops the chords the browser reserves.
 */
export function resolvePlatformBinding(binding: KeyBinding, platform: Platform): string[] {
  if (platform === 'desktop') return asList(binding.keys).map(normalizeBinding);
  if (binding.web !== undefined) return asList(binding.web).map(normalizeBinding);
  return asList(binding.keys)
    .map(normalizeBinding)
    .filter((key) => !BROWSER_RESERVED.has(key));
}

export interface Keymap {
  platform: Platform;
  /** Canonical shortcut for a command, for tooltips. Undefined if the command has none. */
  shortcutFor(command: string): string | undefined;
  /** Command for a key event, or undefined. */
  lookup(input: KeyInput): string | undefined;
}

export function createKeymap(platform: Platform, bindings: readonly KeyBinding[] = DEFAULT_BINDINGS): Keymap {
  const byKey = new Map<string, string>();
  const byCommand = new Map<string, string>();
  for (const binding of bindings) {
    const keys = resolvePlatformBinding(binding, platform);
    const first = keys[0];
    if (first !== undefined && !byCommand.has(binding.command)) {
      byCommand.set(binding.command, first);
    }
    for (const key of keys) {
      byKey.set(key, binding.command);
    }
  }
  return {
    platform,
    shortcutFor: (command) => byCommand.get(command),
    lookup: (input) => byKey.get(normalizeKey(input)),
  };
}
