import { describe, expect, it } from 'vitest';
import { createKeymap } from './keymap';

describe('page organizer shortcuts', () => {
  const desktop = createKeymap('desktop');

  it('uses the spec shortcuts, which the tooltips show', () => {
    expect(desktop.shortcutFor('file.save')).toBe('Ctrl+S');
    expect(desktop.shortcutFor('file.saveAs')).toBe('Ctrl+Shift+S');
    expect(desktop.shortcutFor('edit.undo')).toBe('Ctrl+Z');
    expect(desktop.shortcutFor('edit.redo')).toBe('Ctrl+Y');
    expect(desktop.shortcutFor('pages.delete')).toBe('Delete');
    expect(desktop.shortcutFor('pages.duplicate')).toBe('Ctrl+D');
    expect(desktop.shortcutFor('pages.rotateRight')).toBe('Ctrl+Shift+R');
    expect(desktop.shortcutFor('pages.rotateLeft')).toBe('Ctrl+Shift+L');
    expect(desktop.shortcutFor('pages.moveUp')).toBe('Alt+Up');
    expect(desktop.shortcutFor('pages.moveDown')).toBe('Alt+Down');
    expect(desktop.shortcutFor('pages.moveStart')).toBe('Alt+Home');
    expect(desktop.shortcutFor('pages.moveEnd')).toBe('Alt+End');
  });

  it('looks commands up from key events, including the second redo chord', () => {
    const key = (k: string, ctrl = false, shift = false, alt = false) => ({ key: k, ctrlKey: ctrl, shiftKey: shift, altKey: alt });
    expect(desktop.lookup(key('z', true))).toBe('edit.undo');
    expect(desktop.lookup(key('y', true))).toBe('edit.redo');
    expect(desktop.lookup(key('Z', true, true))).toBe('edit.redo');
    expect(desktop.lookup(key('ArrowUp', false, false, true))).toBe('pages.moveUp');
    expect(desktop.lookup(key('Home', false, false, true))).toBe('pages.moveStart');
    expect(desktop.lookup(key('Delete'))).toBe('pages.delete');
  });

  it('the web build keeps the same keys, since the browser does not reserve them', () => {
    const web = createKeymap('web');
    expect(web.shortcutFor('pages.delete')).toBe('Delete');
    expect(web.shortcutFor('edit.undo')).toBe('Ctrl+Z');
  });
});
