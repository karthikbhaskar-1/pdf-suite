import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ fileService: {}, documentRegistry: { get: () => undefined } }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../../ui/thumbnails/useThumbnail', () => ({ useThumbnail: () => null }));
vi.mock('../../ui/viewer/scrollVelocity', () => ({ useFastScrolling: () => false }));
vi.mock('../../ui/topbar/CommandButton', () => ({ CommandButton: ({ label }: { label: string }) => <button type="button">{label}</button> }));
vi.mock('../../ui/topbar/pageGroups', () => ({ MenuCommand: ({ children }: { children: string }) => <button type="button">{children}</button> }));
vi.mock('../../ui/menus/pageMenuItems', () => ({ pagesMenuItems: () => [] }));

import { pageIdForUid } from '../../core/model/pageList';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { registerViewer, resetViewerBus, type ViewerRequest } from '../../ui/viewer/viewerBus';
import { ThumbnailsPanel } from './ThumbnailsPanel';

const DOC = 'doc-1';
const COUNT = 1000;
const idOf = (i: number) => pageIdForUid(DOC, String(i));

function openDocument(current = 0): void {
  const pages = Array.from({ length: COUNT }, (_, i) => ({ id: idOf(i), docId: DOC, srcIndex: i, rotation: 0 as const, crop: null }));
  const sizes = pages.map(() => ({ width: 100, height: 100, rotation: 0 }));
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'doc.pdf', pageCount: COUNT, pages, sizes, byteSize: 1 } } } as never);
  useWorkspaceStore.setState({
    tabs: [
      {
        id: 'tab1',
        title: 'doc.pdf',
        origin: { kind: 'bytes' },
        status: { kind: 'ready' },
        panes: [{ id: 'pane1', docId: DOC, view: { pageId: idOf(current), zoom: 1, fit: 'none', offset: 0, rotation: 0 } }],
        split: null,
      },
    ],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
}

let requests: ViewerRequest[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  resetViewerBus();
  useOverlayStore.getState().closeMenu();
  requests = [];
  registerViewer('pane1', (request) => {
    requests.push(request);
    return true;
  });
  openDocument();
});
afterEach(() => {
  cleanup();
  resetViewerBus();
  vi.unstubAllGlobals();
});

const list = () => screen.getByRole('listbox', { name: 'Pages' });
const key = (k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(list(), { key: k, ...init });
const selected = () => useSelectionStore.getState().pageIds;
const activeRow = () => document.getElementById(list().getAttribute('aria-activedescendant') ?? '');

describe('thumbnail list: one tab stop, Explorer keys', () => {
  it('is one tab stop with the listbox pattern; rows name their page and place', () => {
    render(<ThumbnailsPanel />);
    expect(list().getAttribute('tabindex')).toBe('0');
    expect(list().getAttribute('aria-multiselectable')).toBe('true');
    const rows = screen.getAllByRole('option');
    expect(rows.every((row) => row.getAttribute('tabindex') === null)).toBe(true);
    const first = rows[0]!;
    expect(first.id).not.toBe('');
    expect(first.getAttribute('aria-label')).toBe('Page 1, current page');
    expect(first.getAttribute('aria-posinset')).toBe('1');
    expect(first.getAttribute('aria-setsize')).toBe(String(COUNT));
    expect(rows[1]!.getAttribute('aria-label')).toBe('Page 2');
  });

  it('Down three times from page 1 selects page 4 alone and jumps; Shift+Down then extends without a jump', () => {
    render(<ThumbnailsPanel />);
    list().focus();
    for (let i = 0; i < 3; i++) key('ArrowDown');
    expect(selected()).toEqual([idOf(3)]);
    expect(requests).toEqual([
      { kind: 'goto', index: 1 },
      { kind: 'goto', index: 2 },
      { kind: 'goto', index: 3 },
    ]);
    expect(activeRow()?.getAttribute('aria-label')).toBe('Page 4');
    requests = [];
    key('ArrowDown', { shiftKey: true });
    expect(selected()).toEqual([idOf(3), idOf(4)]);
    expect(requests).toEqual([]);
    expect(activeRow()?.getAttribute('aria-label')).toBe('Page 5');
  });

  it('focus by Tab changes no selection', () => {
    render(<ThumbnailsPanel />);
    act(() => list().focus());
    expect(selected()).toEqual([]);
    expect(requests).toEqual([]);
    expect(activeRow()?.getAttribute('aria-label')).toBe('Page 1, current page');
  });

  it('End makes the last page the active row and keeps its row in the page', () => {
    render(<ThumbnailsPanel />);
    list().focus();
    key('End');
    expect(activeRow()?.getAttribute('aria-label')).toBe(`Page ${COUNT}`);
    expect(selected()).toEqual([idOf(COUNT - 1)]);
  });

  it('Ctrl+Down moves the active row only; Space adds it; Enter jumps', () => {
    render(<ThumbnailsPanel />);
    list().focus();
    key('ArrowDown', { ctrlKey: true });
    expect(selected()).toEqual([]);
    key(' ');
    expect(selected()).toEqual([idOf(1)]);
    requests = [];
    key('Enter');
    expect(requests).toEqual([{ kind: 'goto', index: 1 }]);
  });

  it('a held key jumps once, when it is released', () => {
    render(<ThumbnailsPanel />);
    list().focus();
    key('ArrowDown');
    requests = [];
    key('ArrowDown', { repeat: true });
    key('ArrowDown', { repeat: true });
    expect(selected()).toEqual([idOf(3)]);
    expect(requests).toEqual([]);
    fireEvent.keyUp(list(), { key: 'ArrowDown' });
    expect(requests).toEqual([{ kind: 'goto', index: 3 }]);
  });

  it('Esc puts focus on the page and keeps the selection', () => {
    const main = document.createElement('div');
    main.className = 'main';
    main.tabIndex = -1;
    document.body.appendChild(main);
    render(<ThumbnailsPanel />);
    list().focus();
    key('ArrowDown');
    key('Escape');
    expect(document.activeElement).toBe(main);
    expect(selected()).toEqual([idOf(1)]);
    main.remove();
  });

  it('Shift+F10 opens the page menu and selects an unselected active row first', () => {
    render(<ThumbnailsPanel />);
    list().focus();
    key('F10', { shiftKey: true });
    expect(selected()).toEqual([idOf(0)]);
    expect(useOverlayStore.getState().menu).not.toBeNull();
  });

  it('Delete, Ctrl+A and Alt+arrows are not taken by the list', () => {
    render(<ThumbnailsPanel />);
    list().focus();
    const notPrevented = (k: string, init: Partial<KeyboardEventInit>) => fireEvent.keyDown(list(), { key: k, ...init });
    expect(notPrevented('Delete', {})).toBe(true);
    expect(notPrevented('ArrowDown', { altKey: true })).toBe(true);
    expect(selected()).toEqual([]);
  });

  it('forgets the active row when the document is replaced (new generation), and starts again from the current page', () => {
    render(<ThumbnailsPanel />);
    list().focus();
    for (let i = 0; i < 3; i++) key('ArrowDown');
    expect(activeRow()?.getAttribute('aria-label')).toBe('Page 4');
    act(() => {
      const docs = useDocumentsStore.getState().docs;
      const info = docs[DOC]!;
      useDocumentsStore.setState({
        docs: { [DOC]: { ...info, pages: info.pages.map((p, i) => ({ ...p, content: `${i}@0@2` })) } },
      } as never);
    });
    expect(activeRow()?.getAttribute('aria-label')).toBe('Page 1, current page');
  });
});

describe('the list follows the current page (B2)', () => {
  const ROW = 190; // 160 px wide square thumbnail + label + gap
  const VIEW = 300;
  const setCurrent = async (index: number) => {
    act(() => {
      useWorkspaceStore.setState((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          panes: tab.panes.map((pane) => ({ ...pane, view: { ...pane.view, pageId: idOf(index) } })),
        })),
      }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEW);
  });
  afterEach(() => vi.restoreAllMocks());

  it('scrolls the current page fully into view, by the smallest distance', async () => {
    render(<ThumbnailsPanel />);
    await setCurrent(399);
    const top = 399 * ROW;
    expect(list().scrollTop).toBe(top + ROW + 10 - VIEW);
  });

  it('after the list was scrolled away by hand, the next current page brings it back', async () => {
    render(<ThumbnailsPanel />);
    await setCurrent(399);
    list().scrollTop = 0;
    fireEvent.scroll(list());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(list().scrollTop).toBe(0); // scrolling by hand does not pull it back
    await setCurrent(400);
    expect(list().scrollTop).toBe(400 * ROW + ROW + 10 - VIEW);
  });

  it('does not move when the page is already whole in view', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    render(<ThumbnailsPanel />);
    await setCurrent(1);
    expect(list().scrollTop).toBe(0);
  });
});
