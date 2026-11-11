/** The subset of KeyboardEvent the keymap reads. Keeps tests free of DOM event objects. */
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
};

/** Symbols where Shift is part of the character itself, such as "+" on a US keyboard. */
const SYMBOL_ALIASES: Record<string, string> = {
  '+': '=',
  _: '-',
};

/**
 * Turns a key event into a canonical string such as "Ctrl+Shift+Tab" or "Alt+1".
 * Modifiers come in the order Ctrl, Alt, Shift. Shift is dropped for symbol keys, so
 * Ctrl+Shift+= and Ctrl+= both read as "Ctrl+=".
 */
export function normalizeKey(input: KeyInput): string {
  const { key } = input;
  const isLetter = key.length === 1 && /[a-z]/i.test(key);
  const isSymbol = key.length === 1 && !isLetter;

  let name: string;
  if (isLetter) name = key.toUpperCase();
  else if (isSymbol) name = SYMBOL_ALIASES[key] ?? key;
  else name = NAMED_KEYS[key] ?? key;

  const parts: string[] = [];
  if (input.ctrlKey) parts.push('Ctrl');
  if (input.altKey) parts.push('Alt');
  if (input.shiftKey && !isSymbol) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

/** Normalizes a binding written by hand, such as "ctrl+shift+tab", to the canonical form. */
export function normalizeBinding(binding: string): string {
  const pieces = binding.split('+');
  // A binding like "Ctrl++" ends in "+" as the key itself.
  const key = binding.endsWith('++') ? '+' : (pieces.pop() ?? '');
  const flags = new Set(pieces.map((p) => p.trim().toLowerCase()));
  return normalizeKey({
    key: bindingKeyName(key),
    ctrlKey: flags.has('ctrl'),
    altKey: flags.has('alt'),
    shiftKey: flags.has('shift'),
  });
}

/** Maps the spelled-out key names used in bindings to KeyboardEvent.key values. */
function bindingKeyName(key: string): string {
  const table: Record<string, string> = {
    pgup: 'PageUp',
    pgdn: 'PageDown',
    tab: 'Tab',
    esc: 'Escape',
    enter: 'Enter',
    f3: 'F3',
    f6: 'F6',
  };
  return table[key.toLowerCase()] ?? key;
}
