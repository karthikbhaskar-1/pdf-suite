import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltins } from '../../app/registerBuiltins';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { SearchBar } from './SearchBar';
import { useSearchStore } from './searchStore';

beforeAll(() => registerBuiltins());
beforeEach(() => {
  useWorkspaceStore.setState({
    tabs: [{ id: 'tab1', title: 'a.pdf', origin: { kind: 'bytes' }, status: { kind: 'ready' }, panes: [{ id: 'pane1', docId: 'd', view: { pageId: 'd:0', zoom: 1, fit: 'none', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
  act(() => useSearchStore.setState({ open: false, query: '', hits: [], current: -1 }));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function Harness() {
  return (
    <>
      <button type="button" id="opener">
        Search
      </button>
      <main className="main" tabIndex={-1} />
      <SearchBar />
    </>
  );
}

describe('find bar focus and keys (1.5.5 A2, A3)', () => {
  it('Esc closes the bar and gives focus back to the control that had it, and the key goes no further', () => {
    let reached = false;
    document.addEventListener('keydown', () => (reached = true), { once: true });
    render(<Harness />);
    const opener = document.getElementById('opener')!;
    opener.focus();
    act(() => useSearchStore.getState().setOpen(true));
    const box = screen.getByLabelText('Find in document');
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(useSearchStore.getState().open).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(reached).toBe(false);
  });

  it('closing from the x button also returns focus', () => {
    render(<Harness />);
    const opener = document.getElementById('opener')!;
    opener.focus();
    act(() => useSearchStore.getState().setOpen(true));
    fireEvent.click(screen.getByRole('button', { name: 'Close find bar' }));
    expect(document.activeElement).toBe(opener);
  });

  it('with no opener control (opened from the page), focus goes to the page', () => {
    render(<Harness />);
    document.querySelector<HTMLElement>('.main')!.focus();
    act(() => useSearchStore.getState().setOpen(true));
    fireEvent.keyDown(screen.getByLabelText('Find in document'), { key: 'Escape' });
    expect(document.activeElement).toBe(document.querySelector('.main'));
  });

  it('when the opener is disabled, focus goes to the page, never to the body', () => {
    render(<Harness />);
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
    act(() => useSearchStore.getState().setOpen(true));
    opener.disabled = true;
    fireEvent.keyDown(screen.getByLabelText('Find in document'), { key: 'Escape' });
    expect(document.activeElement).toBe(document.querySelector('.main'));
  });

  it('Ctrl+F with focus already in the box keeps the remembered control and selects the text', () => {
    render(<Harness />);
    const opener = document.getElementById('opener')!;
    opener.focus();
    act(() => useSearchStore.getState().setOpen(true));
    const box = screen.getByLabelText('Find in document') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    box.setSelectionRange(5, 5);
    fireEvent.keyDown(box, { key: 'f', ctrlKey: true });
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 5]);
    act(() => useSearchStore.getState().setOpen(true));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  it('the find-bar buttons carry the shortcuts and names of A2', () => {
    render(<Harness />);
    act(() => useSearchStore.getState().setOpen(true));
    expect(screen.getByRole('button', { name: 'Previous match' }).getAttribute('aria-keyshortcuts')).toBe('Shift+F3');
    expect(screen.getByRole('button', { name: 'Next match' }).getAttribute('aria-keyshortcuts')).toBe('F3');
    expect(screen.getByRole('button', { name: 'Close find bar' }).getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(screen.getByRole('button', { name: 'Match case' }).textContent).toBe('Aa');
    expect(screen.getByRole('button', { name: 'Whole word' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous match' }).getAttribute('title')).toBe('Previous match (Shift+F3)');
    expect(screen.getByRole('button', { name: 'Next match' }).getAttribute('title')).toBe('Next match (F3)');
    expect(screen.getByRole('button', { name: 'Close find bar' }).getAttribute('title')).toBe('Close (Esc)');
  });
});
