import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { commands } from '../../core/commands/registry';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { CommandPalette } from './CommandPalette';
import { filterEntries } from '../../features/palette/fuzzy';

// The real filter, wrapped so a test can see every query it was given.
vi.mock('../../features/palette/fuzzy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../features/palette/fuzzy')>();
  return { ...original, filterEntries: vi.fn(original.filterEntries) };
});

let available = false;
const run = vi.fn();
if (!commands.has('test.stale')) {
  commands.register({ id: 'test.stale', label: 'Test: Stale command', enabled: () => available, run: () => run() });
}

// A command that sorts first, so an unfiltered list puts it on top, and one that is only found by typing its name.
const runFirst = vi.fn();
const runTyped = vi.fn();
if (!commands.has('test.aaa-first')) commands.register({ id: 'test.aaa-first', label: '0 First in the list', run: () => runFirst() });
if (!commands.has('test.typed')) commands.register({ id: 'test.typed', label: 'Test: Typed command', run: () => runTyped() });

afterEach(() => {
  runFirst.mockClear();
  runTyped.mockClear();
  vi.mocked(filterEntries).mockClear();
  cleanup();
  available = false;
  run.mockClear();
  act(() => useOverlayStore.getState().setPaletteOpen(false));
});

const option = () => screen.getByRole('option', { name: /Test: Stale command/ });

describe('CommandPalette enabled state', () => {
  it('follows a command that becomes available after the palette opened, when the query changes', () => {
    render(<CommandPalette />);
    act(() => useOverlayStore.getState().setPaletteOpen(true));
    expect(option().getAttribute('aria-disabled')).toBe('true');
    available = true;
    fireEvent.change(screen.getByLabelText('Type a command'), { target: { value: 'Stale' } });
    expect(option().getAttribute('aria-disabled')).toBe('false');
  });

  it('follows a store change without typing', () => {
    render(<CommandPalette />);
    act(() => useOverlayStore.getState().setPaletteOpen(true));
    expect(option().getAttribute('aria-disabled')).toBe('true');
    available = true;
    act(() => useSelectionStore.setState({ ...useSelectionStore.getState() }));
    expect(option().getAttribute('aria-disabled')).toBe('false');
  });

  it('checks again when Enter runs the command', () => {
    render(<CommandPalette />);
    act(() => useOverlayStore.getState().setPaletteOpen(true));
    const input = screen.getByLabelText('Type a command');
    fireEvent.change(input, { target: { value: 'Stale command' } });
    available = true; // became available after the list was drawn
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run a command that became unavailable after the list was drawn, and stays open', () => {
    available = true;
    render(<CommandPalette />);
    act(() => useOverlayStore.getState().setPaletteOpen(true));
    const input = screen.getByLabelText('Type a command');
    fireEvent.change(input, { target: { value: 'Stale command' } });
    available = false;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(run).not.toHaveBeenCalled();
    expect(useOverlayStore.getState().paletteOpen).toBe(true);
  });
});

describe('CommandPalette reopen', () => {
  const open = () => act(() => useOverlayStore.getState().setPaletteOpen(true));
  const close = () => act(() => useOverlayStore.getState().setPaletteOpen(false));
  const inputEl = () => screen.getByLabelText('Type a command') as HTMLInputElement;

  it('starts empty and unfiltered on the first render after a close and reopen', () => {
    render(<CommandPalette />);
    open();
    fireEvent.change(inputEl(), { target: { value: 'Typed command' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    close();
    expect(screen.queryByRole('dialog')).toBeNull();

    vi.mocked(filterEntries).mockClear();
    open();
    // Right after the open, with no effect or event run in between: nothing of the old query.
    expect(inputEl().value).toBe('');
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('0 First in the list');
    const queries = vi.mocked(filterEntries).mock.calls.map((call) => call[1]);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q === '')).toBe(true);
  });

  it('starts at the first row after a reopen, even if another row was active before', () => {
    render(<CommandPalette />);
    open();
    fireEvent.keyDown(inputEl(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    close();
    open();
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('runs the typed command both times when the same text is typed twice in a row', () => {
    render(<CommandPalette />);
    for (let n = 1; n <= 2; n++) {
      open();
      fireEvent.change(inputEl(), { target: { value: 'Typed command' } });
      fireEvent.keyDown(inputEl(), { key: 'Enter' });
      expect(runTyped).toHaveBeenCalledTimes(n);
      expect(useOverlayStore.getState().paletteOpen).toBe(false);
    }
    expect(runFirst).not.toHaveBeenCalled();
  });

  it('focuses the input on open, and gives focus back on Escape', () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    render(<CommandPalette />);
    open();
    expect(document.activeElement).toBe(inputEl());
    fireEvent.keyDown(inputEl(), { key: 'Escape' });
    expect(useOverlayStore.getState().paletteOpen).toBe(false);
    expect(document.activeElement).toBe(before);
    before.remove();
  });
});
