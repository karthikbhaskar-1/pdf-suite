import { describe, expect, it } from 'vitest';
import { createKeymap, DEFAULT_BINDINGS } from './keymap';

const press = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key,
  ctrlKey: mods.ctrl === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
});

describe('Close All (menu bar spec: Ctrl+Shift+W)', () => {
  const desktop = createKeymap('desktop');
  const web = createKeymap('web');

  it('Ctrl+Shift+W runs Close All on the desktop, and the File menu can show it', () => {
    expect(desktop.lookup(press('W', { ctrl: true, shift: true }))).toBe('file.closeAll');
    expect(desktop.lookup(press('w', { ctrl: true, shift: true }))).toBe('file.closeAll');
    expect(desktop.shortcutFor('file.closeAll')).toBe('Ctrl+Shift+W');
  });

  it('Close Tab keeps Ctrl+W', () => {
    expect(desktop.lookup(press('w', { ctrl: true }))).toBe('tab.close');
  });

  it('is not bound in the browser, where Ctrl+Shift+W closes the window', () => {
    expect(web.lookup(press('W', { ctrl: true, shift: true }))).toBeUndefined();
    expect(web.shortcutFor('file.closeAll')).toBeUndefined();
  });

  it('no other command uses the chord', () => {
    expect(DEFAULT_BINDINGS.filter((b) => [b.keys].flat().includes('Ctrl+Shift+W')).map((b) => b.command)).toEqual(['file.closeAll']);
  });
});
