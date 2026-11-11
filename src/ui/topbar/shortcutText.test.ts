import { describe, expect, it } from 'vitest';
import { ariaShortcut, tooltipText } from './shortcutText';

describe('shortcut text for buttons', () => {
  it('writes aria-keyshortcuts with the names KeyboardEvent.key uses', () => {
    expect(ariaShortcut('Ctrl+Shift+R')).toBe('Control+Shift+R');
    expect(ariaShortcut('Ctrl+O')).toBe('Control+O');
    expect(ariaShortcut('Alt+Up')).toBe('Alt+ArrowUp');
    expect(ariaShortcut('PgDn')).toBe('PageDown');
    expect(ariaShortcut('Delete')).toBe('Delete');
    expect(ariaShortcut('Ctrl++')).toBe('Control++');
    expect(ariaShortcut('Ctrl+=')).toBe('Control+=');
    expect(ariaShortcut(undefined)).toBeUndefined();
  });

  it('the tooltip reads "Label (Shortcut)", or just the label', () => {
    expect(tooltipText('Save', 'Ctrl+S')).toBe('Save (Ctrl+S)');
    expect(tooltipText('Undo Delete 3 pages', 'Ctrl+Z')).toBe('Undo Delete 3 pages (Ctrl+Z)');
    expect(tooltipText('Recent files', undefined)).toBe('Recent files');
  });
});
