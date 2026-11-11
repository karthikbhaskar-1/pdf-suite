// 1.5.5 B6: the page section's heading says which page it describes.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ documentRegistry: { get: () => undefined } }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));

import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { PropertiesPanel } from './PropertiesPanel';
import { pageHeading } from './resolvers';

const DOC = 'doc-1';
const idOf = (n: number) => `${DOC}:${n - 1}`;
const pages = Array.from({ length: 10 }, (_, i) => ({ id: `${DOC}:${i}`, docId: DOC, srcIndex: i, rotation: 0 as const, crop: null }));

beforeEach(() => {
  useDocumentsStore.setState({
    docs: { [DOC]: { docId: DOC, name: 'doc.pdf', pageCount: 10, pages, sizes: pages.map(() => ({ width: 612, height: 792, rotation: 0 })), byteSize: 1 } },
  } as never);
  useWorkspaceStore.setState({
    tabs: [
      {
        id: 'tab1',
        title: 'doc.pdf',
        origin: { kind: 'bytes' },
        status: { kind: 'ready' },
        panes: [{ id: 'pane1', docId: DOC, view: { pageId: idOf(7), zoom: 1, fit: 'none', offset: 0, rotation: 0 } }],
        split: null,
      },
    ],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
});
afterEach(() => cleanup());

const pageSection = (heading: string) => screen.getByRole('heading', { name: heading }).closest('section')!;
const numberOf = (section: HTMLElement) => section.querySelector('dd')?.textContent;

describe('Properties heading (B6)', () => {
  it('says "Current page" for the page in the page box', () => {
    render(<PropertiesPanel />);
    expect(numberOf(pageSection('Current page'))).toBe('7');
  });

  it('says "Selected page" for a picked page that is not the current page, and goes back when the selection is cleared', () => {
    render(<PropertiesPanel />);
    act(() => {
      useSelectionStore.getState().setSelection([idOf(2)], idOf(2));
      useSelectionStore.getState().selectPage(DOC, idOf(2));
    });
    expect(numberOf(pageSection('Selected page'))).toBe('2');
    expect(screen.queryByRole('heading', { name: 'Current page' })).toBeNull();
    act(() => useSelectionStore.getState().clear());
    expect(numberOf(pageSection('Current page'))).toBe('7');
  });

  it('keeps "Current page" when the picked page is the current page', () => {
    render(<PropertiesPanel />);
    act(() => useSelectionStore.getState().selectPage(DOC, idOf(7)));
    expect(screen.getByRole('heading', { name: 'Current page' })).toBeTruthy();
  });

  it('with two or more pages selected, one line says which one is described', () => {
    render(<PropertiesPanel />);
    act(() => {
      useSelectionStore.getState().setSelection([idOf(2), idOf(3), idOf(4)], idOf(2));
      useSelectionStore.getState().selectPage(DOC, idOf(4));
    });
    const section = pageSection('Selected page');
    expect(section.textContent).toContain('3 pages are selected. This is the one you clicked last.');
    act(() => {
      useSelectionStore.getState().setSelection([idOf(4)], idOf(4));
    });
    expect(pageSection('Selected page').textContent).not.toContain('pages are selected');
  });

  it('the heading function', () => {
    expect(pageHeading({ pickedElsewhere: true })).toBe('Selected page');
    expect(pageHeading({ pickedElsewhere: false })).toBe('Current page');
    expect(pageHeading({})).toBe('Current page');
  });
});
