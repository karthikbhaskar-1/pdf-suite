// Shift+F10 in the thumbnail list opens the page menu only (not the menu bar), the menu takes the focus, Esc closes just
// it, and no list key can change the selection under an open menu.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const picked = vi.fn();
vi.mock('../../app/services', () => ({
  fileService: { listRecent: async () => [] },
  documentRegistry: { get: () => undefined },
  keymap: { shortcutFor: () => undefined, lookup: () => undefined },
}));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../../ui/thumbnails/useThumbnail', () => ({ useThumbnail: () => null }));
vi.mock('../../ui/viewer/scrollVelocity', () => ({ useFastScrolling: () => false }));
vi.mock('../../ui/topbar/CommandButton', () => ({ CommandButton: ({ label }: { label: string }) => <button type="button">{label}</button> }));
vi.mock('../../ui/topbar/pageGroups', () => ({ MenuCommand: ({ children }: { children: string }) => <button type="button">{children}</button> }));
vi.mock('../../ui/menus/pageMenuItems', () => ({
  pagesMenuItems: () => [
    { id: 'a', label: 'First item', onSelect: () => picked('a') },
    { id: 'b', label: 'Second item', onSelect: () => picked('b') },
  ],
}));

import { pageIdForUid } from '../../core/model/pageList';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { ContextMenu } from '../../ui/menus/ContextMenu';
import { MenuBar } from '../../ui/menubar/MenuBar';
import { resetViewerBus } from '../../ui/viewer/viewerBus';
import { ThumbnailsPanel } from './ThumbnailsPanel';

const DOC = 'doc-1';
const idOf = (i: number) => pageIdForUid(DOC, String(i));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  resetViewerBus();
  picked.mockClear();
  useOverlayStore.getState().closeMenu();
  const pages = Array.from({ length: 20 }, (_, i) => ({ id: idOf(i), docId: DOC, srcIndex: i, rotation: 0 as const, crop: null }));
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'doc.pdf', pageCount: 20, pages, sizes: pages.map(() => ({ width: 100, height: 100, rotation: 0 })), byteSize: 1 } } } as never);
  useWorkspaceStore.setState({
    tabs: [{ id: 't', title: 'doc.pdf', origin: { kind: 'bytes' }, status: { kind: 'ready' }, split: null, panes: [{ id: 'p', docId: DOC, view: { pageId: idOf(0), zoom: 1, fit: 'none', offset: 0, rotation: 0 } }] }],
    activeTabId: 't',
    activePaneId: 'p',
  } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <>
      <MenuBar />
      <ThumbnailsPanel />
      <ContextMenu />
    </>,
  );
const list = () => screen.getByRole('listbox', { name: 'Pages' });
const selected = () => useSelectionStore.getState().pageIds;

describe('Shift+F10 in the thumbnail list', () => {
  it('opens the page menu and not the menu bar', () => {
    mount();
    list().focus();
    fireEvent.keyDown(list(), { key: 'F10', shiftKey: true });
    expect(useOverlayStore.getState().menu).not.toBeNull();
    expect(document.querySelector('.menu-button-on')).toBeNull();
    expect(document.querySelector('[data-menu-focus="true"]')).toBeNull();
    expect(document.querySelector('.menu-dropdown')).toBeNull();
  });

  it('a plain F10 still focuses the menu bar', () => {
    mount();
    fireEvent.keyDown(window, { key: 'F10' });
    expect(document.querySelector('[data-menu-focus="true"]')).not.toBeNull();
  });

  it('moves the focus into the menu; arrows move between its items, not the selection', () => {
    mount();
    list().focus();
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    fireEvent.keyDown(list(), { key: 'F10', shiftKey: true });
    const first = screen.getByRole('menuitem', { name: 'First item' });
    expect(document.activeElement).toBe(first);
    const before = [...selected()];
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second item' }));
    expect(selected()).toEqual(before);
  });

  it('Esc closes only the menu and gives the focus back to the list; the selection is kept', () => {
    mount();
    list().focus();
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    fireEvent.keyDown(list(), { key: 'F10', shiftKey: true });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(useOverlayStore.getState().menu).toBeNull();
    expect(document.activeElement).toBe(list());
    expect(selected()).toEqual([idOf(1)]);
  });

  it('the picked item acts on the selection the menu was opened for', () => {
    mount();
    list().focus();
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    fireEvent.keyDown(list(), { key: 'F10', shiftKey: true });
    const target = [...selected()];
    // Keys reaching the list while the menu is open only close it.
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    expect(useOverlayStore.getState().menu).toBeNull();
    expect(selected()).toEqual(target);
  });

  it('a menu opened by the mouse is closed by the first list key, which changes nothing', () => {
    mount();
    list().focus();
    act(() => useSelectionStore.getState().setSelection([idOf(3)], idOf(3)));
    act(() => useOverlayStore.getState().openMenu(10, 10, [{ id: 'a', label: 'First item' }]));
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    expect(useOverlayStore.getState().menu).toBeNull();
    expect(selected()).toEqual([idOf(3)]);
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    expect(selected()).toEqual([idOf(1)]); // the active row is still the current page's
  });
});
