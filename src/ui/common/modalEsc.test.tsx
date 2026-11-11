import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../features/jobs/splitFlow', async () => {
  const actual = await vi.importActual<typeof import('../../features/jobs/splitFlow')>('../../features/jobs/splitFlow');
  return { ...actual, closeSplitSheet: vi.fn() };
});
vi.mock('../../features/organizer/sourcePassword', () => ({ answerSourcePassword: vi.fn() }));
vi.mock('../../features/documents/closeFlow', () => ({
  answerClosePrompt: vi.fn(async () => undefined),
  answerJobQuitPrompt: vi.fn(async () => undefined),
  nameOfDoc: () => 'a.pdf',
  promptDocIds: () => ['d1'],
}));

import { useSplitStore, type SplitSheet as SheetState } from '../../core/stores/splitStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import * as flow from '../../features/jobs/splitFlow';
import { answerClosePrompt } from '../../features/documents/closeFlow';
import { answerSourcePassword } from '../../features/organizer/sourcePassword';
import { CloseDialog } from '../documents/CloseDialog';
import { SplitSheet } from '../jobs/SplitSheet';
import { SourcePasswordDialog } from './SourcePasswordDialog';

const sheet = { docId: 'd1', path: 'C:\\a.pdf', name: 'a.pdf', stage: 'ready', refusal: null, pages: 10, byteLength: 100, facts: { encrypted: false, fields: 0, layers: false, attachments: 0 }, method: 'count', perFileText: '2', sizeText: '10', sizeUnit: 'MB', sensitivity: 'normal', measures: null, looking: null, unticked: [], blankKeep: 'drop', entries: null, folder: null, baseName: 'a', keepPassword: true, passwordNote: null, hidden: false } as unknown as SheetState;

function Shell() {
  return (
    <div className="app">
      <button type="button">Behind</button>
      <SplitSheet />
      <SourcePasswordDialog />
      <CloseDialog />
    </div>
  );
}

beforeEach(() => {
  vi.mocked(flow.closeSplitSheet).mockClear();
  vi.mocked(answerSourcePassword).mockClear();
  vi.mocked(answerClosePrompt).mockClear();
  useWorkspaceStore.setState({
    tabs: [{ id: 't1', title: 'a.pdf', origin: { kind: 'bytes' }, status: { kind: 'ready' }, panes: [{ id: 'p1', docId: 'd1', view: { pageId: null, zoom: 1, fit: 'none', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 't1',
    activePaneId: 'p1',
  } as never);
  useSplitStore.setState({ sheet });
});
afterEach(() => {
  cleanup();
  useSplitStore.setState({ sheet: null });
  useUiStore.setState({ sourcePassword: null, closePrompt: false, jobQuitPrompt: false, passwordTabId: null });
});

describe('Esc closes one thing', () => {
  it('with the split sheet and a source password prompt open, one Esc closes only the prompt', () => {
    render(<Shell />);
    act(() => useUiStore.setState({ sourcePassword: { name: 'b.pdf', error: null } } as never));
    fireEvent.keyDown(screen.getByLabelText('Password'), { key: 'Escape' });
    expect(answerSourcePassword).toHaveBeenCalledWith(null);
    expect(flow.closeSplitSheet).not.toHaveBeenCalled();
  });

  it('the split sheet stays put while the file password prompt is open', () => {
    render(<Shell />);
    act(() => useUiStore.setState({ passwordTabId: 't1' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(flow.closeSplitSheet).not.toHaveBeenCalled();
  });
});

describe('close dialog is modal', () => {
  it('makes the app inert, keeps Tab inside, and closing gives focus back', () => {
    const view = render(<Shell />);
    const behind = view.getByRole('button', { name: 'Behind' });
    behind.focus();
    act(() => useUiStore.setState({ closePrompt: true }));
    expect(behind.hasAttribute('inert')).toBe(true);
    const dialog = within(view.getByRole('alertdialog'));
    const save = dialog.getByRole('button', { name: 'Save' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    act(() => useUiStore.setState({ closePrompt: false }));
    expect(behind.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(behind);
  });

  it('when the control that had focus is gone after closing, focus goes to .main', () => {
    const view = render(<Shell />);
    const main = document.createElement('main');
    main.className = 'main';
    main.tabIndex = -1;
    view.container.querySelector('.app')!.appendChild(main);
    const behind = view.getByRole('button', { name: 'Behind' });
    behind.focus();
    act(() => useUiStore.setState({ closePrompt: true }));
    behind.remove();
    act(() => useUiStore.setState({ closePrompt: false }));
    expect(document.activeElement).toBe(main);
  });
});
