// 1.5.5 B3: the palette is a combobox with a list, and hover never takes a row from the keyboard.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { commands } from '../../core/commands/registry';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { CommandPalette } from './CommandPalette';

// jsdom has no PointerEvent; the real one is a MouseEvent with a position.
if (!('PointerEvent' in window)) Object.assign(window, { PointerEvent: class extends MouseEvent {} });

let allowed = true;
const ids = ['cb.rot1', 'cb.rot2', 'cb.rot3'];
ids.forEach((id, i) => {
  if (!commands.has(id)) commands.register({ id, label: `Combo: Rotate ${i + 1}`, run: () => undefined });
});
// Twelve more rows, so Page Down has room to move by 8.
for (let i = 0; i < 12; i++) {
  const id = `cb.many${String(i).padStart(2, '0')}`;
  if (!commands.has(id)) commands.register({ id, label: `Combo: Many ${String(i).padStart(2, '0')}`, run: () => undefined });
}
if (!commands.has('cb.blocked')) {
  commands.register({
    id: 'cb.blocked',
    label: 'Pages: Delete pages',
    enabled: () => allowed,
    disabledReason: () => 'Open a document first.',
    run: vi.fn(),
  } as never);
}

afterEach(() => {
  cleanup();
  allowed = true;
  act(() => useOverlayStore.getState().setPaletteOpen(false));
});

const open = () => {
  render(<CommandPalette />);
  act(() => useOverlayStore.getState().setPaletteOpen(true));
};
const input = () => screen.getByRole('combobox') as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const activeRow = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '');

describe('command palette as a combobox', () => {
  it('has the combobox attributes and a named listbox', () => {
    open();
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(input().getAttribute('aria-autocomplete')).toBe('list');
    expect(input().getAttribute('aria-controls')).toBe(list.id);
    expect(screen.getAllByRole('option').every((row) => row.id !== '')).toBe(true);
  });

  it('after typing "rot", aria-activedescendant names the first row; Down moves it to the second row', () => {
    open();
    type('rot');
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(3);
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0]!.id);
  });

  it('keeps the highlighted row in view', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    open();
    scroll.mockClear();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    // @ts-expect-error test cleanup of a jsdom gap
    delete Element.prototype.scrollIntoView;
  });

  it('Page Down and Page Up move by 8 rows and stop at the ends; Home and End stay with the text', () => {
    open();
    type('Many');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(input(), { key: 'PageDown' });
    expect(activeRow()).toBe(options[8]);
    fireEvent.keyDown(input(), { key: 'PageDown' });
    expect(activeRow()).toBe(options[11]);
    fireEvent.keyDown(input(), { key: 'PageUp' });
    expect(activeRow()).toBe(options[3]);
    fireEvent.keyDown(input(), { key: 'PageUp' });
    expect(activeRow()).toBe(options[0]);
    const home = fireEvent.keyDown(input(), { key: 'Home' });
    const end = fireEvent.keyDown(input(), { key: 'End' });
    expect(home && end).toBe(true); // not prevented: the caret moves in the text
    expect(activeRow()).toBe(options[0]);
  });

  it('a row that is not available keeps aria-disabled and names the reason; Enter does nothing', () => {
    allowed = false;
    open();
    type('Delete pages');
    const row = screen.getByRole('option', { name: 'Pages: Delete pages. Not available: Open a document first.' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(useOverlayStore.getState().paletteOpen).toBe(true);
  });

  it('with no match, a status line says so and the list has no options', () => {
    open();
    type('zzzzqqqq');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('No commands match');
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    type('');
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('a resting pointer does not take the highlight', () => {
  it('ignores a row that appears under the pointer after a key press, and follows real movement', () => {
    open();
    type('rot');
    const options = screen.getAllByRole('option');
    // The pointer rests at (10, 10); a key press follows.
    fireEvent.pointerMove(window, { clientX: 10, clientY: 10 });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeRow()).toBe(options[1]);
    // A row slides under the resting pointer: the browser sends an enter, with no movement.
    fireEvent.pointerOver(options[2]!, { clientX: 10, clientY: 10 });
    fireEvent.pointerEnter(options[2]!, { clientX: 10, clientY: 10 });
    expect(activeRow()).toBe(options[1]);
    // The pointer really moves: the row under it takes the highlight at once.
    fireEvent.pointerMove(options[2]!, { clientX: 14, clientY: 30 });
    expect(activeRow()).toBe(options[2]);
  });

  it('with no pointer movement seen at all (Ctrl+K, pointer resting), rows under the pointer do not take the highlight or Enter', () => {
    open();
    type('rot');
    const options = screen.getAllByRole('option');
    // The browser reports the rows that appeared under the resting pointer, at the one position, again and again.
    for (let n = 0; n < 3; n++) {
      fireEvent.pointerOver(options[2]!, { clientX: 40, clientY: 80 });
      fireEvent.pointerEnter(options[2]!, { clientX: 40, clientY: 80 });
      fireEvent.pointerMove(options[2]!, { clientX: 40, clientY: 80 });
    }
    expect(activeRow()).toBe(options[0]);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    // A later event at another position is a real movement.
    fireEvent.pointerMove(options[2]!, { clientX: 44, clientY: 96 });
    expect(activeRow()).toBe(options[2]);
  });
});
