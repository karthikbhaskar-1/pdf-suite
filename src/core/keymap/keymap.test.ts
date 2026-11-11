import { describe, expect, it } from 'vitest';
import { createKeymap, resolvePlatformBinding, DEFAULT_BINDINGS } from './keymap';
import { normalizeKey } from './keys';

const key = (k: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe('keymap platform resolution', () => {
  const close = DEFAULT_BINDINGS.find((b) => b.command === 'tab.close');
  const fitWidth = DEFAULT_BINDINGS.find((b) => b.command === 'view.fitWidth');
  const open = DEFAULT_BINDINGS.find((b) => b.command === 'file.open');

  it('uses the desktop shortcuts as the primary profile', () => {
    expect(close && resolvePlatformBinding(close, 'desktop')).toEqual(['Ctrl+W']);
    expect(fitWidth && resolvePlatformBinding(fitWidth, 'desktop')).toEqual(['Ctrl+1']);
  });

  it('uses Alt alternatives on the web, where the browser owns Ctrl+W and Ctrl+1', () => {
    expect(close && resolvePlatformBinding(close, 'web')).toEqual(['Alt+W']);
    expect(fitWidth && resolvePlatformBinding(fitWidth, 'web')).toEqual(['Alt+1']);
  });

  it('keeps shortcuts the browser does not reserve on the web', () => {
    expect(open && resolvePlatformBinding(open, 'web')).toEqual(['Ctrl+O']);
  });

  it('drops browser-reserved chords from the web profile when no alternative is given', () => {
    const tabNext = { command: 'x', keys: 'Ctrl+Tab' };
    expect(resolvePlatformBinding(tabNext, 'web')).toEqual([]);
    expect(resolvePlatformBinding(tabNext, 'desktop')).toEqual(['Ctrl+Tab']);
  });

  it('looks up commands from key events for each platform', () => {
    const desktop = createKeymap('desktop');
    const web = createKeymap('web');
    expect(desktop.lookup(key('w', { ctrl: true }))).toBe('tab.close');
    expect(web.lookup(key('w', { ctrl: true }))).toBeUndefined();
    expect(web.lookup(key('w', { alt: true }))).toBe('tab.close');
    expect(desktop.shortcutFor('tab.close')).toBe('Ctrl+W');
    expect(web.shortcutFor('tab.close')).toBe('Alt+W');
  });

  it('treats Ctrl+= and Ctrl++ as the same zoom-in key', () => {
    const desktop = createKeymap('desktop');
    expect(desktop.lookup(key('=', { ctrl: true }))).toBe('view.zoomIn');
    expect(desktop.lookup(key('+', { ctrl: true, shift: true }))).toBe('view.zoomIn');
    expect(desktop.lookup(key('-', { ctrl: true }))).toBe('view.zoomOut');
  });
});

describe('normalizeKey', () => {
  it('orders modifiers Ctrl, Alt, Shift and names paging keys', () => {
    expect(normalizeKey(key('Tab', { shift: true, ctrl: true }))).toBe('Ctrl+Shift+Tab');
    expect(normalizeKey(key('PageDown'))).toBe('PgDn');
    expect(normalizeKey(key('g', { ctrl: true }))).toBe('Ctrl+G');
  });
});
