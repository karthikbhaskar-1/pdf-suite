import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, resolvePlatformBinding } from './keymap';

/** Chords the browser keeps for itself. A web binding must never use one of them. */
const BROWSER_OWNED = ['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Tab', 'Ctrl+Shift+Tab', ...Array.from({ length: 9 }, (_, i) => `Ctrl+${i + 1}`)];

describe('web keyboard profile', () => {
  it('no web binding uses a chord the browser reserves', () => {
    for (const binding of DEFAULT_BINDINGS) {
      if (binding.web === undefined) continue;
      const chords = resolvePlatformBinding(binding, 'web');
      for (const chord of chords) {
        expect(BROWSER_OWNED, `${binding.command} uses ${chord} on the web`).not.toContain(chord);
      }
    }
  });

  it('every command with a browser-owned desktop chord has a web alternative', () => {
    for (const binding of DEFAULT_BINDINGS) {
      const desktop = Array.isArray(binding.keys) ? binding.keys : [binding.keys];
      const owned = (desktop as string[]).some((k) => BROWSER_OWNED.includes(k.replace(/\s/g, '')));
      if (owned) expect(binding.web, `${binding.command} needs a web alternative`).toBeDefined();
    }
  });

  it('new Part B commands have a web binding that is not browser-owned', () => {
    for (const command of ['split.focusNext', 'palette.open']) {
      const binding = DEFAULT_BINDINGS.find((b) => b.command === command);
      expect(binding?.web).toBeDefined();
      expect(resolvePlatformBinding(binding!, 'web')).not.toEqual([]);
    }
  });
});
