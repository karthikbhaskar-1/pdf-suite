import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../features/documents/closeFlow', () => ({ closeTabWithPrompt: vi.fn() }));
vi.mock('../menus/menus', () => ({ buildTabMenu: () => [] }));

import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { TabStrip, unsavedTitle } from './TabStrip';

const pane = (id: string, docId: string) => ({ id, docId, view: { pageId: '0', zoom: 1, fit: 'width', offset: 0, rotation: 0 } });

beforeEach(() => {
  useWorkspaceStore.setState({
    tabs: [{ id: 't1', title: 'Quarterly report draft for the board 2026 v1.pdf', origin: { kind: 'path', path: 'C:\a.pdf' }, status: { kind: 'ready' }, panes: [pane('p1', 'A'), pane('p2', 'B')], split: 'right' }],
    activeTabId: 't1',
    activePaneId: 'p1',
  } as never);
  useDocumentsStore.setState({ docs: { A: { name: 'a.pdf' }, B: { name: 'b.pdf' } } } as never);
});

afterEach(() => {
  cleanup();
  useEditStore.setState({ byDoc: {} });
});

const dirty = (flag: boolean) => ({ history: { dirty: flag } }) as never;

describe('TabStrip', () => {
  it('shows the unsaved dot when only the second pane\'s document is dirty, and names it', () => {
    useEditStore.setState({ byDoc: { A: dirty(false), B: dirty(true) } });
    render(<TabStrip />);
    const dot = screen.getByRole('img', { name: 'Unsaved changes in b.pdf' });
    expect(dot.getAttribute('title')).toBe('Unsaved changes in b.pdf');
  });

  it('shows no dot when no document of the tab is dirty', () => {
    useEditStore.setState({ byDoc: { A: dirty(false), B: dirty(false) } });
    render(<TabStrip />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('the tab keeps the full name as its title and accessible name, cut visually in the middle', () => {
    render(<TabStrip />);
    const tab = screen.getByRole('tab');
    expect(tab.getAttribute('title')).toBe('Quarterly report draft for the board 2026 v1.pdf');
    expect(tab.getAttribute('aria-label')).toBe('Quarterly report draft for the board 2026 v1.pdf');
    expect(tab.textContent).toBe('Quarterly report draft for the board 2026 v1.pdf');
  });

  it('unsavedTitle is plain for a one-document tab', () => {
    expect(unsavedTitle(['a.pdf'], 1)).toBe('Unsaved changes');
  });
});
