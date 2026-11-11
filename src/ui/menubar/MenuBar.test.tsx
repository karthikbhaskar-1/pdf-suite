// 1.5.5 B4 and B5: the menu bar does not draw while the document scrolls, and a resting pointer does not take over the menus.
import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltins } from '../../app/registerBuiltins';
import { commands } from '../../core/commands/registry';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { MenuBar } from './MenuBar';

// Recovery reads IndexedDB, which jsdom does not have. The menu bar does not need it.
vi.mock('../../features/recovery/recoveryService', () => ({
  openRecent: vi.fn(),
  restoreSession: vi.fn(async () => 0),
  startSnapshotWriter: vi.fn(() => () => undefined),
}));
vi.mock('../../platform/recovery/fileCache', () => ({
  listRecentFiles: vi.fn(async () => []),
  getFile: vi.fn(async () => undefined),
  putFile: vi.fn(async () => undefined),
}));

// jsdom has no PointerEvent; the real one is a MouseEvent with a position.
const hadPointerEvent = 'PointerEvent' in window;
beforeAll(() => {
  registerBuiltins();
  if (!hadPointerEvent) Object.assign(window, { PointerEvent: class extends MouseEvent {} });
});
afterAll(() => {
  if (!hadPointerEvent) delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
});

const DOC = 'doc-1';
const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${DOC}:${i}`, docId: DOC, srcIndex: i, rotation: 0 as const, crop: null }));

function openDocument(): void {
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'doc.pdf', pageCount: 5, pages: pages(5), sizes: [], byteSize: 1 } } } as never);
  useWorkspaceStore.setState({
    tabs: [
      {
        id: 'tab1',
        title: 'doc.pdf',
        origin: { kind: 'bytes' },
        status: { kind: 'ready' },
        panes: [{ id: 'pane1', docId: DOC, view: { pageId: `${DOC}:0`, zoom: 1, fit: 'none', offset: 0, rotation: 0 } }],
        split: null,
      },
    ],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
}

let renders = 0;
const mount = () =>
  render(
    <Profiler id="menubar" onRender={() => (renders += 1)}>
      <MenuBar />
    </Profiler>,
  );

beforeEach(() => {
  renders = 0;
  openDocument();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** One scroll frame: the focused pane's view changes (its offset, and now and then its page). */
function scrollFrame(frame: number): void {
  act(() => {
    useWorkspaceStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) => ({
          ...pane,
          view: { ...pane.view, offset: frame * 17, pageId: `${DOC}:${Math.min(4, Math.floor(frame / 25))}` },
        })),
      })),
    }));
  });
}

describe('the menu bar does not draw while scrolling (B5)', () => {
  it('100 scroll frames with all menus closed cause no render of the menu bar', () => {
    mount();
    const before = renders;
    for (let frame = 1; frame <= 100; frame++) scrollFrame(frame);
    expect(renders - before).toBe(0);
  });

  it('shows the closed bar from the fixed top-level menus, and the title', () => {
    mount();
    const names = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(names).toEqual(['File', 'Edit', 'View', 'Pages', 'Window', 'Help']);
    expect(document.querySelector('.menu-title')?.getAttribute('title')).toBe('doc.pdf — PDF Suite');
  });

  it('builds no menu rows until a menu opens', () => {
    mount();
    expect(document.querySelector('.menu-dropdown')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pages' }));
    expect(document.querySelector('.menu-dropdown')).not.toBeNull();
  });

  it('with the Pages menu open, selecting a page still updates the greyed-out rows', () => {
    // The document has five pages, with an edit state, so the Pages commands know what they would act on.
    const uids = ['0', '1', '2', '3', '4'];
    useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids, revs: uids.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false, dirty: false } } } } as never);
    // Delete is on while some pages are selected, and off when every page is (a document keeps one page): a state the
    // selection decides, read through the registry as the menu reads it.
    const real = commands.isEnabled.bind(commands);
    vi.spyOn(commands, 'isEnabled').mockImplementation((id: string) => (id === 'pages.delete' ? useSelectionStore.getState().pageIds.length < 5 : real(id)));
    act(() => useSelectionStore.getState().setSelection([`${DOC}:1`], `${DOC}:1`));
    mount();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pages' }));
    const row = (name: RegExp) => screen.getAllByRole('menuitem').find((el) => name.test(el.textContent ?? '')) as HTMLButtonElement;
    expect(row(/^Delete/).disabled).toBe(false);
    const before = renders;
    // Every page selected: deleting them all is not allowed, and the open menu shows it at once.
    act(() => useSelectionStore.getState().setSelection(uids.map((u) => `${DOC}:${u}`), `${DOC}:0`));
    expect(renders).toBeGreaterThan(before);
    expect(row(/^Delete/).disabled).toBe(true);
  });

  it('a menu that closes stops listening: scroll frames cause no renders again', () => {
    mount();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pages' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    const before = renders;
    for (let frame = 1; frame <= 20; frame++) scrollFrame(frame);
    expect(renders - before).toBe(0);
  });
});

describe('a resting pointer does not take over the menus (B4)', () => {
  const focused = () => document.querySelector('[data-menu-focus="true"]');

  it('Alt, F, Down, Down: the highlight is on the second row, not on a row under the pointer, and no submenu opened', () => {
    mount();
    // The pointer is parked where a row will appear.
    fireEvent.pointerMove(window, { clientX: 60, clientY: 90 });
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyDown(window, { key: 'f', altKey: true });
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.menu-dropdown > [role^="menuitem"], .menu-dropdown > .menu-sub-wrap > [role="menuitem"]'));
    expect(document.querySelector('.menu-dropdown')).not.toBeNull();
    // Opening with the keyboard highlights the first row.
    expect(focused()).toBe(rows()[0]);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    // Rows (including the one with the submenu) appear under the resting pointer: the browser reports an enter at the same place.
    for (const row of rows()) {
      fireEvent.pointerOver(row, { clientX: 60, clientY: 90 });
      fireEvent.pointerEnter(row, { clientX: 60, clientY: 90 });
      fireEvent.pointerMove(row, { clientX: 60, clientY: 90 });
    }
    expect(focused()).toBe(rows()[2]);
    expect(document.querySelector('.menu-sub')).toBeNull();
  });

  it('moving the pointer onto a row highlights it at once', () => {
    mount();
    fireEvent.pointerMove(window, { clientX: 60, clientY: 90 });
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyDown(window, { key: 'f', altKey: true });
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.menu-dropdown > [role^="menuitem"]'));
    const target = rows.find((row) => !(row as HTMLButtonElement).disabled && row !== focused())!;
    fireEvent.pointerMove(target, { clientX: 70, clientY: 120 });
    expect(focused()).toBe(target);
  });

  it('after a key press with no pointer position known, rows appearing under a still pointer do not take the highlight', () => {
    mount();
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyDown(window, { key: 'f', altKey: true });
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.menu-dropdown > [role^="menuitem"]'));
    const first = focused();
    for (const row of rows) {
      fireEvent.pointerOver(row, { clientX: 60, clientY: 90 });
      fireEvent.pointerMove(row, { clientX: 60, clientY: 90 });
    }
    expect(focused()).toBe(first);
    const target = rows.find((row) => !(row as HTMLButtonElement).disabled && row !== first)!;
    fireEvent.pointerMove(target, { clientX: 64, clientY: 120 });
    expect(focused()).toBe(target);
  });
});
