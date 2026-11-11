import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltins } from '../../app/registerBuiltins';
import { topBar } from '../../core/layout/topBarRegistry';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { TooltipHost, TOOLTIP_DELAY_MS } from '../topbar/Tooltip';
import { resetViewerBus } from '../viewer/viewerBus';
import { TopBar } from './TopBar';

// Recovery reads IndexedDB, which jsdom does not have. The top bar does not need it.
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
}

beforeAll(() => registerBuiltins());
beforeEach(() => {
  resetViewerBus();
  useUiStore.setState({ toolbarLabels: false });
  openDocument();
});
afterEach(() => cleanup());

const items = () => topBar.list().flatMap((g) => g.items.map((i) => ({ group: g.id, id: i.id, priority: i.priority })));

describe('the toolbar items and their priorities (1.2.2 spec)', () => {
  it('Open, Save, Undo, Redo, Find, page navigation and Theme are critical', () => {
    const critical = items().filter((i) => i.priority === 'critical').map((i) => i.id);
    expect(critical).toEqual(['file.open', 'file.save', 'edit.undo', 'edit.redo', 'nav', 'search.open', 'theme.toggle']);
  });

  it('Recent, Rotate, Delete, Insert, Combine files (1.3.3, UI spec: priority high) and Split are high', () => {
    expect(items().filter((i) => i.priority === 'high').map((i) => i.id).sort()).toEqual(['file.recent', 'pages.combine', 'pages.delete', 'pages.insert', 'pages.rotate', 'view.split']);
  });

  it('Loupe, Pan and zoom, Page colors, Crop, Page size, Pages More, Cut pages in half, Split into files and Overlay to compare are normal', () => {
    expect(items().filter((i) => i.priority === 'normal').map((i) => i.id).sort()).toEqual(['pages.crop', 'pages.cutHalf', 'pages.more', 'pages.overlay', 'pages.size', 'pages.splitFiles', 'view.loupe', 'view.panZoom', 'view.recolor']);
  });

  it('a divider comes right before the first of the new Pages buttons, Combine files (1.3.3), inside its slot; Split into files and Cut pages in half follow it without one', () => {
    render(<TopBar />);
    const slot = document.querySelector('[data-slot="pages.combine"]')!;
    expect(slot.firstElementChild?.classList.contains('tb-divider')).toBe(true);
    expect(slot.querySelector('button')).not.toBeNull();
    expect(slot.nextElementSibling?.getAttribute('data-slot')).toBe('pages.splitFiles');
    expect(document.querySelector('[data-slot="pages.splitFiles"]')!.querySelector('.tb-divider')).toBeNull();
    expect(document.querySelector('[data-slot="pages.cutHalf"]')!.querySelector('.tb-divider')).toBeNull();
  });

  it('the Zoom group is gone from the top bar, and Loupe, Pan and zoom and Split stay in the View group', () => {
    expect(topBar.list().map((g) => g.id)).toEqual(['file', 'nav', 'view', 'pages', 'search', 'theme']);
    expect(items().filter((i) => i.group === 'view').map((i) => i.id)).toEqual(['view.split', 'view.loupe', 'view.panZoom', 'view.recolor']);
  });
});

describe('the buttons', () => {
  it('every button has a name and, where the command has one, aria-keyshortcuts', () => {
    render(<TopBar />);
    const bar = screen.getByRole('toolbar', { name: 'Toolbar' });
    const buttons = within(bar).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(15);
    for (const button of buttons) expect(button.getAttribute('aria-label') ?? button.textContent, button.outerHTML).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Open' }).getAttribute('aria-keyshortcuts')).toBe('Control+O');
    expect(within(bar).getByRole('button', { name: 'Save' }).getAttribute('aria-keyshortcuts')).toBe('Control+S');
    expect(within(bar).getByRole('button', { name: 'Find' }).getAttribute('aria-keyshortcuts')).toBe('Control+F');
  });

  it('the tooltip text reads "Label (Shortcut)"', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Open' }).getAttribute('data-tooltip')).toBe('Open (Ctrl+O)');
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('data-tooltip')).toBe('Save (Ctrl+S)');
  });

  it('Loupe and Pan and zoom are toggles that say whether they are on', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Loupe' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Pan and zoom' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('menu buttons say they open a menu, and whether it is open', () => {
    render(<TopBar />);
    const insert = screen.getByRole('button', { name: 'Insert pages' });
    expect(insert.getAttribute('aria-haspopup')).toBe('menu');
    expect(insert.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(insert);
    expect(insert.getAttribute('aria-expanded')).toBe('true');
  });

  it('labels are in the page for every critical and high item only (and show when the bar says so)', () => {
    useUiStore.setState({ toolbarLabels: true });
    render(<TopBar />);
    const labeled = [...document.querySelectorAll('.tb-slot')].filter((slot) => slot.querySelector('.tb-label'));
    expect(labeled.map((s) => (s as HTMLElement).dataset.slot)).toEqual(
      expect.arrayContaining(['file.open', 'file.save', 'edit.undo', 'edit.redo', 'file.recent', 'view.split', 'pages.insert', 'pages.delete', 'pages.rotate', 'search.open', 'theme.toggle']),
    );
    for (const id of ['view.loupe', 'view.panZoom', 'view.recolor', 'pages.crop', 'pages.size', 'pages.more', 'pages.cutHalf', 'pages.splitFiles', 'pages.overlay']) {
      expect(document.querySelector(`[data-slot="${id}"] .tb-label`), id).toBeNull();
    }
  });
});

describe('keyboard use of a toolbar menu', () => {
  it('Down opens it, arrows move over the enabled rows, Esc closes it and gives the focus back to the button', () => {
    render(<TopBar />);
    const split = screen.getByRole('button', { name: 'Split' });
    split.focus();
    fireEvent.keyDown(split, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Split' });
    const rows = within(menu).getAllByRole('menuitem');
    expect(rows.map((r) => r.querySelector('.menu-label')?.textContent)).toEqual(['Turn split on', 'Split horizontal', 'Split vertical', 'Sync scroll: off']);
    // The last row (sync) is off with no split, so the arrow keys skip it. The first enabled row has the focus.
    const enabled = rows.filter((r) => !(r as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(3);
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(enabled[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(enabled[2]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Split' })).toBeNull();
    expect(document.activeElement).toBe(split);
  });

  it('a row shows its shortcut, and the More menu has the page actions', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More page actions' }));
    const rows = within(screen.getByRole('menu', { name: 'More page actions' })).getAllByRole('menuitem');
    expect(rows.map((r) => r.querySelector('.menu-label')?.textContent)).toEqual(['Duplicate', 'Replace…', 'Reverse', 'Extract…']);
    expect(rows[0]!.querySelector('.menu-accel')?.textContent).toBe('Ctrl+D');
  });

  it('Enter on the button opens the menu, and a click outside closes it', () => {
    render(<TopBar />);
    const crop = screen.getByRole('button', { name: 'Crop pages' });
    fireEvent.click(crop);
    expect(screen.getByRole('menu', { name: 'Crop pages' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Crop pages' })).toBeNull();
  });

  it('a disabled row says why in its title and is skipped by the arrow keys', () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null } as never);
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert pages' }));
    const menu = screen.getByRole('menu', { name: 'Insert pages' });
    for (const row of within(menu).getAllByRole('menuitem')) expect((row as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('drawing again while the viewer scrolls', () => {
  it('does not draw the top bar again for a scroll within a page, and draws the page box once at a page edge', () => {
    let commits = 0;
    render(
      <Profiler id="bar" onRender={() => (commits += 1)}>
        <TopBar />
      </Profiler>,
    );
    act(() => useWorkspaceStore.getState().setView('pane1', { offset: 0.0011 }));
    const before = commits;
    for (let i = 1; i <= 120; i++) act(() => useWorkspaceStore.getState().setView('pane1', { offset: 0.002 + i / 130 }));
    expect(commits).toBe(before);
    act(() => useWorkspaceStore.getState().setView('pane1', { pageId: `${DOC}:1`, offset: 0.1 }));
    expect((screen.getByLabelText('Page number') as HTMLInputElement).value).toBe('2');
  });
});

describe('the tooltip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hover = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: null })));

  it('appears 500 ms after the pointer rests on a button, reads "Label (Shortcut)", and goes when the pointer leaves', () => {
    render(
      <>
        <TopBar />
        <TooltipHost />
      </>,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    hover(save);
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByRole('tooltip').textContent).toBe('Save (Ctrl+S)');
    act(() => void save.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not appear when the pointer leaves before 500 ms, nor after a click', () => {
    render(
      <>
        <TopBar />
        <TooltipHost />
      </>,
    );
    const open = screen.getByRole('button', { name: 'Open' });
    hover(open);
    act(() => void vi.advanceTimersByTime(300));
    act(() => void open.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })));
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip')).toBeNull();
    hover(open);
    act(() => void document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  describe('on keyboard focus', () => {
    beforeEach(() => {
      // jsdom does not know :focus-visible: say that the keyboard moved the focus.
      const matches = Element.prototype.matches;
      vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        return selector === ':focus-visible' ? true : matches.call(this, selector);
      });
    });
    const focusIn = (el: Element) => act(() => void el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    const move = (el: Element, type: string, x: number, y: number, related: Element | null = null) =>
      act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, relatedTarget: related })));

    it('appears 500 ms after a Tab, also when the browser reports the resting pointer entering and leaving things (same place)', () => {
      render(
        <>
          <TopBar />
          <TooltipHost />
        </>,
      );
      const save = screen.getByRole('button', { name: 'Save' });
      // The pointer rests at (40, 20) on Open (the control that was just used).
      const open = screen.getByRole('button', { name: 'Open' });
      move(open, 'pointermove', 40, 20);
      act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
      focusIn(save);
      // The bar changes under the resting pointer: pointerout and pointerover arrive with the old coordinates.
      move(open, 'pointerout', 40, 20, document.body);
      move(document.body, 'pointerover', 40, 20);
      act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
      expect(screen.getByRole('tooltip').textContent).toBe('Save (Ctrl+S)');
    });

    it('a pointer that really moves to another control takes the tooltip over', () => {
      render(
        <>
          <TopBar />
          <TooltipHost />
        </>,
      );
      const save = screen.getByRole('button', { name: 'Save' });
      const open = screen.getByRole('button', { name: 'Open' });
      move(open, 'pointermove', 40, 20);
      focusIn(save);
      move(open, 'pointerover', 200, 20);
      act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
      expect(screen.getByRole('tooltip').textContent).toBe('Open (Ctrl+O)');
    });

    it('goes when the focus leaves', () => {
      render(
        <>
          <TopBar />
          <TooltipHost />
        </>,
      );
      const save = screen.getByRole('button', { name: 'Save' });
      focusIn(save);
      act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
      expect(screen.getByRole('tooltip')).toBeTruthy();
      act(() => void save.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  it('a disabled button shows the reason in its tooltip when its slot is hovered', () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null } as never);
    render(
      <>
        <TopBar />
        <TooltipHost />
      </>,
    );
    const slot = screen.getByRole('button', { name: 'Save' }).closest('.tb-tip')!;
    hover(slot);
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Save/);
  });
});

describe('collapsing into the "…" menu', () => {
  let width = 2000;
  let resize: ((width: number) => void) | null = null;

  beforeEach(() => {
    // jsdom has no layout: give every item 40 px, the bar the width the test sets, and a ResizeObserver the test can drive.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const w = this.classList.contains('tb-slot') ? 40 : 0;
      return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('top-bar') ? width : 0;
      },
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = (w: number) => callback([{ contentRect: { width: w } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    resize = null;
  });

  const collapsed = () => [...document.querySelectorAll('.tb-slot.tb-collapsed')].map((el) => (el as HTMLElement).dataset.slot);
  const overflowShown = () => !document.querySelector('.tb-overflow')!.classList.contains('tb-collapsed');

  it('shows everything and no "…" button when the bar is wide', () => {
    width = 2000;
    render(<TopBar />);
    expect(collapsed()).toEqual([]);
    expect(overflowShown()).toBe(false);
  });

  it('at a narrow width, collapses the normal items first, and never a critical one', () => {
    width = 18 * 40 + 6 * 2 + 5 * 13 - 10; // just short of everything
    render(<TopBar />);
    expect(collapsed()).toEqual(['pages.crop', 'pages.size', 'pages.more', 'pages.splitFiles', 'pages.cutHalf', 'pages.overlay']);
    expect(overflowShown()).toBe(true);
    act(() => resize!(330));
    const hidden = collapsed();
    for (const id of ['file.open', 'file.save', 'edit.undo', 'edit.redo', 'nav', 'search.open', 'theme.toggle']) expect(hidden, id).not.toContain(id);
    expect(hidden).toEqual(expect.arrayContaining(['view.loupe', 'view.panZoom', 'view.recolor', 'pages.crop', 'pages.size', 'pages.more', 'pages.cutHalf', 'pages.splitFiles', 'pages.overlay']));
  });

  it('puts the collapsed items in the "…" menu, under their group, with their state', () => {
    width = 18 * 40 + 6 * 2 + 5 * 13 - 10;
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More commands' }));
    const menu = screen.getByRole('menu', { name: 'More commands' });
    const text = [...menu.children].map((el) => (el.classList.contains('menu-sep') ? '|' : (el.querySelector('.menu-label')?.textContent ?? el.textContent)));
    expect(text).toEqual(['Pages', 'Crop', 'Crop pages…', 'Auto-crop', 'Page Size…', 'More page actions', 'Duplicate', 'Replace…', 'Reverse', 'Extract…', 'Split into Files…', 'Cut Pages in Half…', 'Overlay to Compare…']);
    // The rows keep their shortcut and their disabled state.
    const duplicate = within(menu).getByRole('menuitem', { name: /Duplicate/ });
    expect(duplicate.querySelector('.menu-accel')?.textContent).toBe('Ctrl+D');
    // Esc closes the menu and the focus goes back to the "…" button.
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'More commands' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More commands' }));
  });

  it('opens the "…" menu with the Down key, and a toggle in it shows its state', () => {
    width = 330;
    render(<TopBar />);
    const more = screen.getByRole('button', { name: 'More commands' });
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const loupe = within(screen.getByRole('menu', { name: 'More commands' })).getByRole('menuitemcheckbox', { name: /Loupe/ });
    expect(loupe.getAttribute('aria-checked')).toBe('false');
  });

  it('a command run from the "…" menu runs, and the menu closes', async () => {
    width = 330;
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More commands' }));
    const { useFloatingStore } = await import('../../core/stores/floatingStore');
    expect(useFloatingStore.getState().windows.loupe.open).toBe(false);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('menu', { name: 'More commands' })).getByRole('menuitemcheckbox', { name: /Loupe/ }));
    });
    expect(useFloatingStore.getState().windows.loupe.open).toBe(true);
    expect(screen.queryByRole('menu', { name: 'More commands' })).toBeNull();
  });

  it('an open "…" menu closes when the bar widens and nothing is collapsed any more', () => {
    width = 330;
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'More commands' }));
    expect(screen.getByRole('menu', { name: 'More commands' })).toBeTruthy();
    act(() => resize!(2000));
    expect(collapsed()).toEqual([]);
    expect(screen.queryByRole('menu', { name: 'More commands' })).toBeNull();
  });

  it('opens up again when the bar gets wider (with the hysteresis margin)', () => {
    width = 330;
    render(<TopBar />);
    expect(collapsed().length).toBeGreaterThan(0);
    act(() => resize!(2000));
    expect(collapsed()).toEqual([]);
    expect(overflowShown()).toBe(false);
  });
});

describe('a layout that would flip between two plans settles (labels on, with an estimate that is too small)', () => {
  beforeEach(() => {
    // A label that is not showing measures 30 px, but once it shows, its button is 50 px wider: the estimate is too small, so
    // the bar would take labels on, find that they do not fit, take them off, and so on without end.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      let w = 0;
      if (this.classList.contains('tb-label')) w = 30;
      else if (this.classList.contains('tb-slot')) w = 40 + (this.querySelector('.tb-label:not(.tb-label-off)') ? 50 : 0);
      return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('top-bar') ? 1300 : 0;
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });

  it('does not loop: the bar is drawn, and it stays within a plan that fits', () => {
    useUiStore.setState({ toolbarLabels: true });
    expect(() => render(<TopBar />)).not.toThrow();
    const hidden = [...document.querySelectorAll('.tb-slot.tb-collapsed')].length;
    const labelsShown = document.querySelector('.tb-slot .tb-label:not(.tb-label-off)') !== null;
    // Either the labels are off, or everything that is shown with them really fits (nothing is collapsed with them on).
    expect(labelsShown ? hidden : 0).toBe(0);
  });
});
