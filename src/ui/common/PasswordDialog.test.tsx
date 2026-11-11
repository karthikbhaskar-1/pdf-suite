import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('../../features/documents/documentService', () => ({
  cancelPassword: vi.fn(),
  submitPassword: vi.fn(async () => undefined),
}));

import { cancelPassword } from '../../features/documents/documentService';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { PasswordDialog } from './PasswordDialog';
import { cycleFocus } from './focusTrap';

/** A stand-in for the app frame: a control behind the dialog, and the dialog as a direct child, as in AppShell. */
function Shell() {
  return (
    <div className="app">
      <button type="button">Behind</button>
      <PasswordDialog />
    </div>
  );
}

beforeEach(() => {
  vi.mocked(cancelPassword).mockClear();
  useWorkspaceStore.setState({
    tabs: [{ id: 't1', title: 'locked.pdf', origin: { kind: 'bytes' }, status: { kind: 'needsPassword' }, panes: [], split: null }],
    activeTabId: 't1',
    activePaneId: null,
  });
  useUiStore.setState({ passwordTabId: null, passwordError: null });
});

afterEach(() => {
  useUiStore.setState({ passwordTabId: null, passwordError: null });
});

describe('cycleFocus', () => {
  it('wraps forward from the last item to the first, and backward from the first to the last', () => {
    expect(cycleFocus(['a', 'b', 'c'], 'c', false)).toBe('a');
    expect(cycleFocus(['a', 'b', 'c'], 'a', true)).toBe('c');
    expect(cycleFocus(['a', 'b', 'c'], 'a', false)).toBe('b');
  });

  it('starts at the ends when the current item is not in the list, and is null for an empty list', () => {
    expect(cycleFocus(['a', 'b'], 'x', false)).toBe('a');
    expect(cycleFocus(['a', 'b'], 'x', true)).toBe('b');
    expect(cycleFocus([], 'x', false)).toBeNull();
  });
});

describe('password dialog', () => {
  /** Renders the shell, focuses the control behind, then opens the dialog as a real open does. */
  function openDialog() {
    const view = render(<Shell />);
    const behind = view.getByRole('button', { name: 'Behind' });
    behind.focus();
    act(() => useUiStore.setState({ passwordTabId: 't1' }));
    return { view, behind };
  }

  it('makes the rest of the app inert while open, and not the dialog itself', () => {
    const { view, behind } = openDialog();
    expect(behind.hasAttribute('inert')).toBe(true);
    const backdrop = view.container.querySelector('.modal-backdrop');
    expect(backdrop?.hasAttribute('inert')).toBe(false);
    view.unmount();
  });

  it('keeps Tab inside the dialog, forward and backward', () => {
    const { view } = openDialog();
    const input = view.getByLabelText('Password') as HTMLInputElement;
    const open = view.getByRole('button', { name: 'Open' });
    expect(document.activeElement).toBe(input);

    open.focus();
    fireEvent.keyDown(open, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(open);
    view.unmount();
  });

  it('Escape cancels the open', () => {
    const { view } = openDialog();
    fireEvent.keyDown(view.getByLabelText('Password'), { key: 'Escape' });
    expect(cancelPassword).toHaveBeenCalledWith('t1');
    view.unmount();
  });

  it('on close, restores the app and gives focus back to the element that had it before', () => {
    const { view, behind } = openDialog();
    act(() => useUiStore.setState({ passwordTabId: null }));
    expect(behind.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(behind);
    view.unmount();
  });
});
