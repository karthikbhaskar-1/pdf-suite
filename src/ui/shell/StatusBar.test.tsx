import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltins } from '../../app/registerBuiltins';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { registerViewer, resetViewerBus, type ViewerRequest } from '../viewer/viewerBus';
import { StatusBar, parseZoomInput, sliderKeyPercent, ZOOM_MENU_PRESETS } from './StatusBar';
import { useJobStore } from '../../core/stores/jobStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { STATUS_BREAKPOINTS, statusLayout } from './statusLayout';

// Recovery reads IndexedDB, which jsdom does not have. The status bar does not need it.
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

function openDocument(count = 12): void {
  useDocumentsStore.setState({
    docs: { [DOC]: { docId: DOC, name: 'doc.pdf', pageCount: count, pages: pages(count), sizes: Array.from({ length: count }, () => ({ width: 612, height: 792 })), byteSize: 1000 } },
  } as never);
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

const setView = (patch: Record<string, unknown>) => act(() => useWorkspaceStore.getState().setView('pane1', patch as never));

let requests: ViewerRequest[] = [];

beforeAll(() => registerBuiltins());
beforeEach(() => {
  resetViewerBus();
  requests = [];
  registerViewer('pane1', (request) => {
    requests.push(request);
    return true;
  });
  useEditStore.setState({ progress: {} });
  openDocument();
});
afterEach(() => {
  cleanup();
  resetViewerBus();
});

describe('progress footer focus', () => {
  it('moves focus to .main when the footer unmounts with focus inside it', () => {
    const main = document.createElement('main');
    main.className = 'main';
    main.tabIndex = -1;
    document.body.appendChild(main);
    act(() => useJobStore.getState().start('split' as never, () => undefined));
    render(<StatusBar />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    expect(document.activeElement).toBe(cancel);
    act(() => useJobStore.getState().finish());
    expect(document.activeElement).toBe(main);
    main.remove();
  });

  it('leaves focus alone when it was elsewhere', () => {
    const other = document.createElement('button');
    document.body.appendChild(other);
    act(() => useJobStore.getState().start('split' as never, () => undefined));
    render(<StatusBar />);
    other.focus();
    act(() => useJobStore.getState().finish());
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

describe('status bar content', () => {
  it('shows "Page [n] of Y" with an editable page number, and the zoom controls on the right', () => {
    render(<StatusBar />);
    expect((screen.getByLabelText('Go to page') as HTMLInputElement).value).toBe('1');
    expect(screen.getByText('of 12')).toBeTruthy();
    const zoom = screen.getByRole('group', { name: 'Zoom' });
    for (const name of ['Fit page', 'Fit width', 'Zoom out', 'Zoom in', 'Zoom presets']) expect(within(zoom).getByRole('button', { name })).toBeTruthy();
    expect((screen.getByLabelText('Zoom level') as HTMLInputElement).value).toBe('100%');
    expect(screen.getByLabelText('Zoom slider')).toBeTruthy();
  });

  it('with a document the zoom controls have their ordinary tooltips, not the reason', () => {
    render(<StatusBar />);
    expect(screen.getByRole('button', { name: 'Zoom in' }).getAttribute('data-tooltip')).toBe('Zoom in (Ctrl+=)');
    expect(screen.getByRole('button', { name: 'Zoom presets' }).getAttribute('data-tooltip')).toBe('Zoom presets');
    expect(screen.getByLabelText('Zoom level').closest('[data-tooltip]')).toBeNull();
  });

  it('shows the page size of the page on screen, and the rotation of the view only when it is turned', () => {
    const { container } = render(<StatusBar />);
    expect(container.querySelector('.status-info')?.textContent).toMatch(/8\.5 × 11 in|215\.9 × 279\.4 mm/);
    setView({ rotation: 90 });
    expect(container.querySelector('.status-info')?.textContent).toMatch(/Rotated 90°/);
  });

  it('says "No file open" with no document', () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null } as never);
    render(<StatusBar />);
    expect(screen.getByText('No file open')).toBeTruthy();
    // The zoom controls stay, off, so the bar keeps its shape while a tab loads or asks for a password.
    expect((screen.getByLabelText('Zoom level') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true);
    // The presets button is off too, and says what it is.
    const presets = screen.getByRole('button', { name: 'Zoom presets' }) as HTMLButtonElement;
    expect(presets.disabled).toBe(true);
    // Every disabled zoom control says why, like the other disabled controls.
    const reason = 'Open a PDF to use zoom.';
    expect(presets.getAttribute('data-tooltip')).toBe(reason);
    for (const name of ['Fit page', 'Fit width', 'Zoom out', 'Zoom in']) {
      expect(screen.getByRole('button', { name }).getAttribute('data-tooltip'), name).toBe(reason);
    }
    expect(screen.getByLabelText('Zoom level').closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(reason);
    expect(screen.getByLabelText('Zoom slider').closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(reason);
    fireEvent.click(presets);
    expect(screen.queryByRole('menu', { name: 'Zoom presets' })).toBeNull();
    expect(screen.queryByLabelText('Go to page')).toBeNull();
  });

  it('shows the progress of a long edit, with Cancel, in place of the controls', () => {
    useEditStore.setState({ progress: { [DOC]: { label: 'Deleting pages', done: 3, total: 10 } } } as never);
    render(<StatusBar />);
    expect(screen.getByRole('progressbar', { name: 'Deleting pages' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByLabelText('Zoom level')).toBeNull();
  });
});

describe('page box', () => {
  it('Enter goes to that page, kept within the page count', () => {
    render(<StatusBar />);
    const box = screen.getByLabelText('Go to page');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(requests.at(-1)).toEqual({ kind: 'goto', index: 6 });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '999' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(requests.at(-1)).toEqual({ kind: 'goto', index: 11 });
  });

  it('ignores text that is not a number, and Escape leaves without going anywhere', () => {
    render(<StatusBar />);
    const box = screen.getByLabelText('Go to page');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '4' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(requests).toEqual([]);
  });

  it('follows the page the viewer reports', () => {
    render(<StatusBar />);
    setView({ pageId: `${DOC}:4`, offset: 0 });
    expect((screen.getByLabelText('Go to page') as HTMLInputElement).value).toBe('5');
  });
});

describe('zoom controls', () => {
  it('Fit page, Fit width, Zoom in and Zoom out run their commands', async () => {
    render(<StatusBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fit page' }));
      fireEvent.click(screen.getByRole('button', { name: 'Fit width' }));
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    });
    expect(requests).toEqual([
      { kind: 'fit', mode: 'page' },
      { kind: 'fit', mode: 'width' },
      { kind: 'zoomStep', direction: 1 },
      { kind: 'zoomStep', direction: -1 },
    ]);
  });

  it('a typed percentage sets the zoom on Enter, with or without the % sign', () => {
    render(<StatusBar />);
    const box = screen.getByLabelText('Zoom level');
    for (const [typed, zoom] of [['150', 1.5], ['75%', 0.75], [' 200 % ', 2]] as const) {
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: typed } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(requests.at(-1)).toEqual({ kind: 'setZoom', zoom });
    }
  });

  it('focusing the zoom box selects its text without changing it, so that typing replaces it', () => {
    render(<StatusBar />);
    const box = screen.getByLabelText('Zoom level') as HTMLInputElement;
    fireEvent.focus(box);
    expect(box.value).toBe('100%');
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 4]);
    const page = screen.getByLabelText('Go to page') as HTMLInputElement;
    fireEvent.focus(page);
    expect(page.value).toBe('1');
    expect([page.selectionStart, page.selectionEnd]).toEqual([0, 1]);
  });

  it('the mouse-up that ends the click which focused a box is cancelled, so the selection stays (a real click)', () => {
    render(<StatusBar />);
    for (const label of ['Zoom level', 'Go to page']) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.focus(box);
      expect(fireEvent.mouseUp(box), `${label}: the first mouse-up is cancelled`).toBe(false);
      // A later click inside the box places the caret as usual.
      expect(fireEvent.mouseUp(box), `${label}: a later mouse-up is left alone`).toBe(true);
      fireEvent.blur(box);
    }
  });

  it('a typed value outside the range is brought into it, and text that is not a number is ignored', () => {
    render(<StatusBar />);
    const box = screen.getByLabelText('Zoom level');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '5000' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(requests.at(-1)).toEqual({ kind: 'setZoom', zoom: 8 });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '1' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(requests.at(-1)).toEqual({ kind: 'setZoom', zoom: 0.1 });
    const count = requests.length;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'big' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(requests).toHaveLength(count);
  });

  it('shows the current zoom as a percentage, and follows a zoom made elsewhere', () => {
    render(<StatusBar />);
    setView({ zoom: 1.25 });
    expect((screen.getByLabelText('Zoom level') as HTMLInputElement).value).toBe('125%');
  });

  it('the presets menu lists 50, 75, 100, 125, 150, 200 and 400, marks the current one, and sets the zoom', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }));
    const menu = screen.getByRole('menu', { name: 'Zoom presets' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent?.replace('●', ''))).toEqual(ZOOM_MENU_PRESETS.map((p) => `${p}%`));
    expect(items.find((i) => i.getAttribute('aria-checked') === 'true')?.textContent).toContain('100%');
    fireEvent.click(items.find((i) => i.textContent?.includes('200%'))!);
    expect(requests.at(-1)).toEqual({ kind: 'setZoom', zoom: 2 });
  });

  it('the slider sets the zoom, and Zoom out is a command like the shortcut', () => {
    render(<StatusBar />);
    fireEvent.change(screen.getByLabelText('Zoom slider'), { target: { value: '1000' } });
    expect((requests.at(-1) as { zoom: number }).zoom).toBeCloseTo(8, 5);
  });
});

describe('parsing a typed zoom', () => {
  it('reads whole and decimal percentages', () => {
    expect(parseZoomInput('100')).toBe(1);
    expect(parseZoomInput('62.5%')).toBeCloseTo(0.625, 5);
    expect(parseZoomInput('62,5')).toBeCloseTo(0.625, 5);
    expect(parseZoomInput('  33 % ')).toBeCloseTo(0.33, 5);
  });

  it('rejects anything else', () => {
    for (const text of ['', 'abc', '12abc', '-5', '0', '%', '1e3', '10 20']) expect(parseZoomInput(text), text).toBeNull();
  });
});

describe('narrow widths', () => {
  it('leaves out the slider first, then the document info, then Fit page and Fit width', () => {
    expect(statusLayout(2000)).toEqual({ slider: true, info: true, fit: true, pageWord: true, shortChip: false });
    expect(statusLayout(STATUS_BREAKPOINTS.slider - 1)).toEqual({ slider: false, info: true, fit: true, pageWord: true, shortChip: false });
    expect(statusLayout(STATUS_BREAKPOINTS.info - 1)).toEqual({ slider: false, info: false, fit: true, pageWord: true, shortChip: true });
    expect(statusLayout(STATUS_BREAKPOINTS.fit - 1)).toEqual({ slider: false, info: false, fit: false, pageWord: false, shortChip: true });
    expect(STATUS_BREAKPOINTS.slider).toBeGreaterThan(STATUS_BREAKPOINTS.info);
    expect(STATUS_BREAKPOINTS.info).toBeGreaterThan(STATUS_BREAKPOINTS.fit);
  });
});

describe('narrow widths (1.5.5 A4 rows)', () => {
  it('returns the spec rows at 719, 639, 519, 419 and 320 px', () => {
    expect(statusLayout(719)).toEqual({ slider: true, info: true, fit: true, pageWord: true, shortChip: false });
    expect(statusLayout(639)).toEqual({ slider: false, info: true, fit: true, pageWord: true, shortChip: false });
    expect(statusLayout(519)).toEqual({ slider: false, info: false, fit: true, pageWord: true, shortChip: true });
    expect(statusLayout(419)).toEqual({ slider: false, info: false, fit: false, pageWord: false, shortChip: true });
    expect(statusLayout(320)).toEqual({ slider: false, info: false, fit: false, pageWord: false, shortChip: true });
  });
});

describe('zoom slider keys (1.5.5 A1)', () => {
  it('the key table in percent', () => {
    expect(sliderKeyPercent('ArrowRight', 100)).toBe(110);
    expect(sliderKeyPercent('ArrowUp', 100)).toBe(110);
    expect(sliderKeyPercent('ArrowLeft', 110)).toBe(100);
    expect(sliderKeyPercent('ArrowDown', 110)).toBe(100);
    expect(sliderKeyPercent('ArrowRight', 10)).toBe(11);
    expect(sliderKeyPercent('ArrowLeft', 11)).toBe(10);
    expect(sliderKeyPercent('ArrowLeft', 10)).toBe(10);
    expect(sliderKeyPercent('ArrowRight', 800)).toBe(800);
    expect(sliderKeyPercent('ArrowRight', 795)).toBe(800);
    expect(sliderKeyPercent('Home', 300)).toBe(10);
    expect(sliderKeyPercent('End', 300)).toBe(800);
    expect(sliderKeyPercent('a', 100)).toBeNull();
  });

  it('the slider sends the zoom in percent, and Page Up / Page Down step like Zoom In / Zoom Out', () => {
    render(<StatusBar />);
    const slider = screen.getByLabelText('Zoom slider');
    requests.length = 0;
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'PageUp' });
    fireEvent.keyDown(slider, { key: 'PageDown' });
    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(requests).toEqual([
      { kind: 'setZoom', zoom: 1.1 },
      { kind: 'setZoom', zoom: 0.91 },
      { kind: 'zoomStep', direction: 1 },
      { kind: 'zoomStep', direction: -1 },
      { kind: 'setZoom', zoom: 0.1 },
      { kind: 'setZoom', zoom: 8 },
    ]);
  });

  it('keeps aria-valuetext as the percent', () => {
    setView({ zoom: 1.1 });
    render(<StatusBar />);
    expect(screen.getByLabelText('Zoom slider').getAttribute('aria-valuetext')).toBe('110%');
  });
});

describe('the selection chip (1.5.5 A5)', () => {
  const uids = Array.from({ length: 12 }, (_, i) => String(i));
  const select = (...n: number[]) => act(() => useSelectionStore.setState({ pageIds: n.map((i) => `${DOC}:${uids[i]}`) } as never));
  beforeEach(() => {
    useEditStore.setState({ byDoc: { [DOC]: { uids } } } as never);
    act(() => useSelectionStore.getState().clear());
    // The current page is page 1 (pageId doc-1:0); page ids in the store follow pageIdFromUid.
  });
  afterEach(() => act(() => useSelectionStore.getState().clear()));

  it('is not shown with nothing selected', () => {
    render(<StatusBar />);
    expect(document.querySelector('.status-chip')).toBeNull();
  });

  it('says "3 pages selected" with its tooltip and aria-label, and clears on click and moves focus to the page box', () => {
    setView({ pageId: `${DOC}:6` });
    render(<StatusBar />);
    select(0, 1, 2);
    const chip = screen.getByRole('button', { name: '3 pages selected. Page commands act on them. Clear selection.' });
    expect(chip.textContent).toBe('3 pages selected ×');
    expect(chip.getAttribute('title')).toBe('Page commands act on the selected pages, not on page 7. Click to clear the selection.');
    fireEvent.click(chip);
    expect(useSelectionStore.getState().pageIds).toEqual([]);
    expect(document.querySelector('.status-chip')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Go to page'));
  });

  it('says "1 page selected" when one other page is selected, and nothing when it is only the current page', () => {
    setView({ pageId: `${DOC}:6` });
    render(<StatusBar />);
    select(0);
    expect(document.querySelector('.status-chip')?.textContent).toBe('1 page selected ×');
    select(6);
    expect(document.querySelector('.status-chip')).toBeNull();
  });
});

describe('drawing again (the viewer writes its scroll position on every frame)', () => {
  /**
   * Draws the bar inside a profiler that counts every commit of the bar's tree, and watches the DOM for any change. The
   * first update after a mount is let through before counting: React takes one extra look at a hook's state then, and that
   * is not the bar's doing.
   */
  function counted() {
    let commits = 0;
    const { container } = render(
      <Profiler id="status" onRender={() => (commits += 1)}>
        <StatusBar />
      </Profiler>,
    );
    setView({ offset: 0.0011 });
    const changes = new MutationObserver(() => undefined);
    changes.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    return { commits: () => commits, domChanges: () => changes.takeRecords().length };
  }

  it('does not draw again for a scroll inside the page: 120 frames, no commit and no change in the DOM', () => {
    const bar = counted();
    const before = bar.commits();
    for (let i = 1; i <= 120; i++) setView({ offset: 0.002 + i / 130 });
    expect(bar.commits()).toBe(before);
    expect(bar.domChanges()).toBe(0);
  });

  it('a scroll across a page edge draws the bar once, and only the page number changes', () => {
    const bar = counted();
    const sizeBefore = (document.querySelector('.status-info') as HTMLElement).textContent;
    const before = bar.commits();
    setView({ pageId: `${DOC}:1`, offset: 0.2 });
    expect(bar.commits() - before).toBe(1);
    expect((screen.getByLabelText('Go to page') as HTMLInputElement).value).toBe('2');
    expect((document.querySelector('.status-info') as HTMLElement).textContent).toBe(sizeBefore);
  });

  it('does not draw again when the tab list is replaced by an equal one', () => {
    const bar = counted();
    const before = bar.commits();
    act(() => useWorkspaceStore.setState({ tabs: [...useWorkspaceStore.getState().tabs] }));
    expect(bar.commits()).toBe(before);
    expect(bar.domChanges()).toBe(0);
  });

  it('draws again for a zoom change, since the zoom is shown', () => {
    const bar = counted();
    const before = bar.commits();
    setView({ zoom: 1.5 });
    expect(bar.commits()).toBeGreaterThan(before);
  });
});
