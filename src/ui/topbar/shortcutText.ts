/** Key names as the keymap writes them, to the names the aria-keyshortcuts attribute uses (KeyboardEvent.key values). */
const ARIA_KEYS: Record<string, string> = {
  Ctrl: 'Control',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  PgUp: 'PageUp',
  PgDn: 'PageDown',
  Esc: 'Escape',
};

/** "Ctrl+Shift+R" as aria-keyshortcuts wants it: "Control+Shift+R". Undefined when the command has no shortcut. */
export function ariaShortcut(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined;
  // A binding such as "Ctrl++" ends in "+" as the key itself.
  const plusKey = shortcut.endsWith('++');
  const parts = (plusKey ? shortcut.slice(0, -2) : shortcut).split('+').map((part) => ARIA_KEYS[part] ?? part);
  if (plusKey) parts.push('+');
  return parts.join('+');
}

/** The tooltip text: "Label (Shortcut)", or just the label when there is no shortcut. */
export function tooltipText(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label} (${shortcut})` : label;
}
