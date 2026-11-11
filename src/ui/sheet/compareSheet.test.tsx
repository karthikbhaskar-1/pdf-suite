// @vitest-environment jsdom
// The Overlay to Compare sheet (1.3.4, UI spec section 4): the controls, their words, each control's effect on the compare
// store (which the viewer follows at once), the two ways out ([»] hides, the x and Leave compare leave), F8 and the info bar.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ fileService: {}, documentRegistry: { get: () => undefined } }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../../features/documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(async () => true),
  attachSourceLogged: vi.fn(),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../../features/documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));
vi.mock('../thumbnails/useThumbnail', () => ({ useThumbnail: () => null }));
vi.mock('../../panels/thumbnails/ThumbnailsPanel', () => ({ THUMB_WIDTH_PX: 120 }));

import { pageIdForUid } from '../../core/model/pageList';
import { sessionOf, useCompareStore } from '../../core/stores/compareStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { COMPARE_DIFFERENCES_LEGEND, COMPARE_DIFFERENCES_VIEW_ONLY, COMPARE_DIFFERENT_SIZE, COMPARE_NOT_COPIED, COMPARE_NO_FILE } from '../../features/compare/compareMath';
import { setComparePorts, startCompare } from '../../features/compare/compareSession';
import { CompareBar } from '../documents/CompareBar';
import { SideSheet } from './SideSheet';

afterEach(() => {
  cleanup();
  setComparePorts(null);
});

const DOC = 'path:C:\\work\\A.pdf';
const LETTER = { width: 612, height: 792, rotation: 0 };
const UIDS = ['0', '1', '2', '3', '4', '5'];

beforeEach(() => {
  useSheetStore.getState().close();
  useCompareStore.getState().end();
  useWorkspaceStore.setState({
    tabs: [{ id: 't', title: 'A.pdf', origin: { kind: 'path', path: DOC }, status: { kind: 'ready' }, split: null,
      panes: [{ id: 'p', docId: DOC, view: { pageId: pageIdForUid(DOC, '1'), zoom: 1, fit: 'width', offset: 0, rotation: 0 } }] }],
    activeTabId: 't',
    activePaneId: 'p',
  } as never);
  useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: UIDS, revs: UIDS.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'A.pdf', pageCount: 6, pages: [], sizes: UIDS.map(() => LETTER) } } } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
  setComparePorts({ unit: () => 'mm', documentOf: () => ({ sourceSize: async () => ({ width: 595, height: 842 }), detachSource: async () => ({}) }) as never });
});

/** Starts a compare and puts a ready overlay file in it, as if one had been chosen. */
function open(withFile = true) {
  startCompare(DOC);
  if (withFile) {
    useCompareStore.getState().patch({ phase: 'ready', file: { path: 'C:\\plans\\Plan-rev2.pdf', name: 'Plan-rev2.pdf', pages: 4 }, sourceDocId: 'src1', attach: 1 });
  }
  return render(
    <>
      <CompareBar />
      <SideSheet />
    </>,
  );
}

const session = () => sessionOf(DOC)!;
const add = () => screen.getByRole('button', { name: 'Add overlay to pages' }) as HTMLButtonElement;

describe('the sheet opens as the spec says', () => {
  it('has the title, the defaults, the focus on "Choose a PDF…", and "No PDF chosen yet."', () => {
    open(false);
    expect(screen.getByRole('dialog', { name: 'Overlay to compare' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose a PDF…' }));
    expect(screen.getByText(COMPARE_NO_FILE)).toBeTruthy();
    expect(screen.getByText('Show overlay (F8)')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Both' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('radio', { name: 'Page by page' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Overlay start page') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Size in percent') as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText('Add to') as HTMLSelectElement).value).toBe('current');
    // Opacity is for See-through only.
    expect(screen.queryByLabelText('Opacity in percent')).toBeNull();
    expect(screen.getByText(COMPARE_NOT_COPIED)).toBeTruthy();
  });

  it('shows the file line with its page count once a file is chosen, and the info bar names it', () => {
    open();
    expect(screen.getByText('Plan-rev2.pdf · 4 pages')).toBeTruthy();
    expect(screen.getByText('Comparing with Plan-rev2.pdf. The overlay is only on screen.')).toBeTruthy();
  });

  it('Add overlay to pages is off until a file is chosen', () => {
    open(false);
    expect(add().disabled).toBe(true);
    expect(add().title).toBe('Choose a PDF first.');
  });
});

describe('the looks', () => {
  it('See-through shows Opacity (50 by default), and Both does not', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'See-through' }));
    expect(session().look).toBe('seethrough');
    expect((screen.getByLabelText('Opacity in percent') as HTMLInputElement).value).toBe('50');
    fireEvent.change(screen.getByLabelText('Opacity in percent'), { target: { value: '35' } });
    expect(session().opacity).toBe(35);
    fireEvent.change(screen.getByLabelText('Opacity of the overlay, percent'), { target: { value: '80' } });
    expect(session().opacity).toBe(80);
    fireEvent.click(screen.getByRole('radio', { name: 'Both' }));
    expect(screen.queryByLabelText('Opacity in percent')).toBeNull();
  });

  it('an opacity that is not 0 to 100 is flagged and changes nothing', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'See-through' }));
    fireEvent.change(screen.getByLabelText('Opacity in percent'), { target: { value: '120' } });
    expect(session().opacity).toBe(50);
    expect(screen.getByLabelText('Opacity in percent').getAttribute('aria-invalid')).toBe('true');
  });

  it('Differences shows the legend, turns Add off with the spec message under it, and the note about comments stays', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Differences' }));
    expect(screen.getByText(COMPARE_DIFFERENCES_LEGEND)).toBeTruthy();
    expect(add().disabled).toBe(true);
    expect(add().title).toBe(COMPARE_DIFFERENCES_VIEW_ONLY);
    expect(screen.getByText(COMPARE_DIFFERENCES_VIEW_ONLY)).toBeTruthy();
    expect(screen.getByText(COMPARE_NOT_COPIED)).toBeTruthy();
  });

  it('Show overlay is a checkbox that follows the store', () => {
    open();
    const box = screen.getByRole('checkbox', { name: 'Show overlay' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(session().show).toBe(false);
    expect(box.checked).toBe(false);
  });
});

describe('match pages and the page line', () => {
  it('Page by page from a start page, and the line says which overlay page this page gets', () => {
    open();
    // The current page is the second page (index 1): overlay page 2 at start 1.
    expect(screen.getByText('This page: overlay page 2.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Overlay start page'), { target: { value: '3' } });
    expect(session().startPage).toBe(3);
    expect(screen.getByText('This page: overlay page 4.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Overlay start page'), { target: { value: '4' } });
    // Page 2 would need overlay page 5, which the 4-page overlay does not have.
    expect(screen.getByText('This page has no overlay page.')).toBeTruthy();
  });

  it('the same overlay page on every page', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Same overlay page on every page' }));
    expect(session().match).toBe('fixed');
    fireEvent.change(screen.getByLabelText('Overlay page on every page'), { target: { value: '2' } });
    expect(session().fixedPage).toBe(2);
    expect(screen.getByText('This page: overlay page 2.')).toBeTruthy();
  });

  it('a page number outside the overlay file is flagged and changes nothing', () => {
    open();
    fireEvent.change(screen.getByLabelText('Overlay start page'), { target: { value: '9' } });
    expect(session().startPage).toBe(1);
    expect(screen.getByLabelText('Overlay start page').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('line up', () => {
  it('the arrow buttons move 1 pt and, with Shift, 10 pt, in the directions they name', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Move the overlay right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move the overlay down' }));
    expect([session().dx, session().dy]).toEqual([1, 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Move the overlay left' }), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Move the overlay up' }), { shiftKey: true });
    expect([session().dx, session().dy]).toEqual([-9, -9]);
  });

  it('with the focus in the pad the arrow keys nudge too, and Shift makes it 10', () => {
    open();
    const pad = screen.getByRole('group', { name: 'Line up' });
    fireEvent.keyDown(pad, { key: 'ArrowRight' });
    fireEvent.keyDown(pad, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(pad, { key: 'ArrowDown' });
    expect([session().dx, session().dy]).toEqual([11, 1]);
  });

  it('Across and Down are typed in the chosen unit (mm here) and kept in points', () => {
    open();
    fireEvent.change(screen.getByLabelText('Across'), { target: { value: '10' } });
    expect(session().dx).toBeCloseTo(28.3465, 3);
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'pt' } });
    expect(session().unit).toBe('pt');
    expect((screen.getByLabelText('Across') as HTMLInputElement).value).toBe('28.35');
    fireEvent.change(screen.getByLabelText('Down'), { target: { value: '-12' } });
    expect(session().dy).toBe(-12);
  });

  it('an offset is kept inside the page size', () => {
    open();
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'pt' } });
    fireEvent.change(screen.getByLabelText('Across'), { target: { value: '5000' } });
    expect(session().dx).toBe(612);
  });

  it('Size takes 25 to 400 and flags anything else', () => {
    open();
    fireEvent.change(screen.getByLabelText('Size in percent'), { target: { value: '150' } });
    expect(session().size).toBe(150);
    fireEvent.change(screen.getByLabelText('Size in percent'), { target: { value: '20' } });
    expect(session().size).toBe(150);
    expect(screen.getByLabelText('Size in percent').getAttribute('aria-invalid')).toBe('true');
  });

  it('Reset puts Across, Down and Size back', () => {
    open();
    useCompareStore.getState().patch({ dx: 5, dy: 6, size: 200 });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect([session().dx, session().dy, session().size]).toEqual([0, 0, 100]);
  });

  it('a page of another size says so, and Fit to page sets the size and the position', async () => {
    open();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The overlay page is A4 (595 x 842) and the page is Letter (612 x 792).
    expect(screen.getByText(COMPARE_DIFFERENT_SIZE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to page' }));
    const scale = Math.min(612 / 595, 792 / 842);
    expect(session().size).toBeCloseTo(scale * 100, 1);
    expect(session().dx).toBeCloseTo((612 - 595 * scale) / 2, 3);
    expect(session().dy).toBeCloseTo((792 - 842 * scale) / 2, 3);
  });
});

describe('Add to', () => {
  it('names how many pages would get an overlay page, from the live selection', () => {
    open();
    expect(screen.getByText('1 page would get an overlay page.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add to'), { target: { value: 'all' } });
    // 6 pages, an overlay of 4 pages from page 1: 4 pages.
    expect(screen.getByText('4 pages would get an overlay page.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add to'), { target: { value: 'selected' } });
    expect(screen.getByText('0 pages would get an overlay page.')).toBeTruthy();
    expect(add().disabled).toBe(true);
    act(() => useSelectionStore.getState().setSelection([pageIdForUid(DOC, '0'), pageIdForUid(DOC, '2')], pageIdForUid(DOC, '0')));
    expect(screen.getByText('2 pages would get an overlay page.')).toBeTruthy();
    expect(add().disabled).toBe(false);
  });
});

describe('the ways out', () => {
  it('[»] hides the sheet and keeps comparing; the bar brings it back with Show settings', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Hide settings' }));
    expect(screen.queryByRole('dialog', { name: 'Overlay to compare' })).toBeNull();
    expect(sessionOf(DOC)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show settings' }));
    expect(screen.getByRole('dialog', { name: 'Overlay to compare' })).toBeTruthy();
  });

  it('the x, Leave compare in the sheet, Leave compare in the bar, and Esc each leave', () => {
    const exits: Array<[string, () => void]> = [
      ['the x of the sheet', () => fireEvent.click(document.querySelector('.side-sheet-head button.side-sheet-close:last-child')!)],
      ['Leave compare in the sheet', () => fireEvent.click(document.querySelector('.compare-foot-buttons button')!)],
      ['Leave compare in the bar', () => fireEvent.click(document.querySelector('[data-compare-bar] button:last-child')!)],
      ['Esc', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ];
    for (const [name, leave] of exits) {
      open();
      expect(sessionOf(DOC), name).not.toBeNull();
      leave();
      expect(sessionOf(DOC), name).toBeNull();
      expect(useSheetStore.getState().sheet, name).toBeNull();
      cleanup();
    }
  });

  it('with the sheet hidden, Esc leaves the compare, and with another sheet open it does not', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Hide settings' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sessionOf(DOC)).toBeNull();
    cleanup();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Hide settings' }));
    act(() => useSheetStore.getState().open({ kind: 'rotate', docId: DOC, uids: ['1'], degrees: 0 }));
    fireEvent.keyDown(window, { key: 'Escape' });
    // The Rotate sheet took the Esc, and the compare is still on.
    expect(sessionOf(DOC)).not.toBeNull();
  });

  it('changing tabs does not leave: the bar belongs to its document, and another document shows none', () => {
    open();
    act(() => {
      useWorkspaceStore.setState({
        tabs: [
          ...useWorkspaceStore.getState().tabs,
          { id: 't2', title: 'B.pdf', origin: { kind: 'path', path: 'C:\\work\\B.pdf' }, status: { kind: 'ready' }, split: null, panes: [{ id: 'p2', docId: 'path:C:\\work\\B.pdf', view: { pageId: null, zoom: 1, fit: 'width', offset: 0, rotation: 0 } }] },
        ],
        activeTabId: 't2',
        activePaneId: 'p2',
      } as never);
    });
    expect(screen.queryByText(/Comparing with/)).toBeNull();
    expect(sessionOf(DOC)).not.toBeNull();
    act(() => useWorkspaceStore.setState({ activeTabId: 't', activePaneId: 'p' } as never));
    expect(screen.getByText(/Comparing with Plan-rev2.pdf/)).toBeTruthy();
  });
});
