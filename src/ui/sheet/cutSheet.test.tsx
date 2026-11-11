// @vitest-environment jsdom
// The Cut Pages in Half sheet (320 px side sheet) and the guide it draws on the pages: the controls, their words from the UI
// spec, the validation messages, which pages the count and the guide name, and dragging the line.
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
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useSheetStore, type CutDraft } from '../../core/stores/sheetStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { openCutSheet } from '../../features/organizer/actions';
import { CutGuide } from '../organizer/CutGuide';
import { SideSheet } from './SideSheet';

// jsdom has no PointerEvent: a MouseEvent carries the coordinates the drag reads.
if (!('PointerEvent' in window)) {
  (window as unknown as { PointerEvent: unknown }).PointerEvent = class PointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  };
}

afterEach(cleanup);

const DOC = 'path:C:\\work\\A.pdf';
const WIDE = { width: 800, height: 600, rotation: 0 };
const TALL = { width: 600, height: 800, rotation: 0 };
const UIDS = ['0', '1', '2', '3', '4', '5'];

beforeEach(() => {
  useSheetStore.getState().close();
  useWorkspaceStore.setState({
    tabs: [{ id: 't', title: 'A.pdf', origin: { kind: 'path', path: DOC }, status: { kind: 'ready' }, split: null,
      panes: [{ id: 'p', docId: DOC, view: { pageId: pageIdForUid(DOC, '2'), zoom: 1, fit: 'width', offset: 0, rotation: 0 } }] }],
    activeTabId: 't',
    activePaneId: 'p',
  } as never);
  useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: UIDS, revs: UIDS.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } } as never);
  useDocumentsStore.setState({
    docs: { [DOC]: { docId: DOC, name: 'A.pdf', pageCount: 6, pages: [], sizes: [WIDE, WIDE, TALL, WIDE, TALL, WIDE] } },
  } as never);
  useSelectionStore.setState({ pageIds: [], anchorId: null, selection: null });
});

const sheet = () => useSheetStore.getState().sheet as CutDraft;
const apply = () => screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
const summary = (container: HTMLElement) => container.querySelector('[data-cut-summary]')!.textContent;

describe('the sheet', () => {
  it('opens with the spec defaults: left and right, 50 %, left page first, all pages, focus on "Cut into"', () => {
    openCutSheet();
    const { container } = render(<SideSheet />);
    expect(screen.getByRole('dialog', { name: 'Cut pages in half' })).toBeTruthy();
    expect(sheet()).toMatchObject({ direction: 'vertical', percentText: '50', first: 'left', scope: 'all' });
    expect(screen.getByRole('radio', { name: 'Left and right' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Left and right' }));
    expect((screen.getByLabelText('Apply to') as HTMLSelectElement).value).toBe('all');
    expect(summary(container)).toBe('Cuts 6 pages into 12. Comments and links stay with their half.');
    expect(screen.getByText('Choose Right page first for books read right to left.')).toBeTruthy();
  });

  it('has the options the spec lists, with its words', () => {
    openCutSheet();
    render(<SideSheet />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Left and right', 'Top and bottom', 'Left page first', 'Right page first']);
    const options = [...(screen.getByLabelText('Apply to') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['Current page', 'Selected pages', 'All pages', 'Wide pages only']);
    expect(screen.getByRole('button', { name: 'Center' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByLabelText('Cut position, percent of the page width')).toBeTruthy();
  });

  it('Top and bottom hides "Page order", names the slider by height and offers "Tall pages only"', () => {
    openCutSheet();
    render(<SideSheet />);
    fireEvent.click(screen.getByRole('radio', { name: 'Top and bottom' }));
    expect(screen.queryByRole('radio', { name: 'Left page first' })).toBeNull();
    expect(screen.queryByText('Page order')).toBeNull();
    expect(screen.getByLabelText('Cut position, percent of the page height')).toBeTruthy();
    expect([...(screen.getByLabelText('Apply to') as HTMLSelectElement).options].map((o) => o.textContent)).toContain('Tall pages only');
  });

  it('the count follows "Apply to": the current page, the selected pages, the wide pages', () => {
    openCutSheet();
    const { container } = render(<SideSheet />);
    const choose = (value: string) => fireEvent.change(screen.getByLabelText('Apply to'), { target: { value } });
    choose('current');
    expect(summary(container)).toBe('Cuts 1 page into 2. Comments and links stay with their half.');
    choose('wide');
    expect(summary(container)).toBe('Cuts 4 pages into 8. Comments and links stay with their half.');
    fireEvent.click(screen.getByRole('radio', { name: 'Top and bottom' }));
    expect(summary(container)).toBe('Cuts 2 pages into 4. Comments and links stay with their half.');
    // Selecting pages while the sheet is open changes the count at once.
    choose('selected');
    expect(summary(container)).toBe('No pages match. Choose a different “Apply to”.');
    expect(apply().disabled).toBe(true);
    act(() => useSelectionStore.getState().setSelection([pageIdForUid(DOC, '1'), pageIdForUid(DOC, '4'), pageIdForUid(DOC, '5')], pageIdForUid(DOC, '1')));
    expect(summary(container)).toBe('Cuts 3 pages into 6. Comments and links stay with their half.');
    expect(apply().disabled).toBe(false);
  });

  it('Wide pages only while sizes are still being measured: the summary says so, Apply is off, and it comes on when they are known', () => {
    openCutSheet();
    const { container } = render(<SideSheet />);
    const choose = (value: string) => fireEvent.change(screen.getByLabelText('Apply to'), { target: { value } });
    act(() => useDocumentsStore.setState({
      docs: { [DOC]: { docId: DOC, name: 'A.pdf', pageCount: 6, pages: [], sizes: [WIDE, WIDE, undefined, WIDE, TALL, WIDE] } },
    } as never));
    choose('wide');
    expect(summary(container)).toBe('The pages are still being measured. Try again in a moment.');
    expect(apply().disabled).toBe(true);
    act(() => useDocumentsStore.setState({
      docs: { [DOC]: { docId: DOC, name: 'A.pdf', pageCount: 6, pages: [], sizes: [WIDE, WIDE, TALL, WIDE, TALL, WIDE] } },
    } as never));
    expect(summary(container)).toBe('Cuts 4 pages into 8. Comments and links stay with their half.');
    expect(apply().disabled).toBe(false);
  });

  it('a cut position that is not a number from 30 to 70 shows the message and turns Apply off', () => {
    openCutSheet();
    render(<SideSheet />);
    const box = screen.getByLabelText('Cut position in percent');
    for (const text of ['', 'abc', '29', '71']) {
      fireEvent.change(box, { target: { value: text } });
      expect(screen.getByRole('alert').textContent).toBe('Enter a number from 30 to 70.');
      expect(apply().disabled).toBe(true);
    }
    fireEvent.change(box, { target: { value: '62.5' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(apply().disabled).toBe(false);
    expect((screen.getByLabelText('Cut position, percent of the page width') as HTMLInputElement).value).toBe('62.5');
  });

  it('the slider covers 30 to 70 in tenths, so it can show a typed value; arrows go to the next 0.5; Page Up and Page Down move 5, Home and End go to the ends; Center gives 50', () => {
    openCutSheet();
    render(<SideSheet />);
    const slider = screen.getByLabelText('Cut position, percent of the page width') as HTMLInputElement;
    expect([slider.min, slider.max, slider.step]).toEqual(['30', '70', '0.1']);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(sheet().percentText).toBe('50.5');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(sheet().percentText).toBe('49.5');
    fireEvent.click(screen.getByRole('button', { name: 'Center' }));
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(sheet().percentText).toBe('55');
    fireEvent.keyDown(slider, { key: 'PageDown' });
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(sheet().percentText).toBe('45');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(sheet().percentText).toBe('30');
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(sheet().percentText).toBe('30');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(sheet().percentText).toBe('70');
    fireEvent.change(slider, { target: { value: '41.5' } });
    expect(sheet().percentText).toBe('41.5');
    fireEvent.click(screen.getByRole('button', { name: 'Center' }));
    expect(sheet().percentText).toBe('50');
  });

  it('a typed 50.25 becomes 50.3 when the box loses focus; the slider, valuetext and guide show it; arrows land on 0.5', () => {
    openCutSheet();
    render(<SideSheet />);
    const box = screen.getByLabelText('Cut position in percent') as HTMLInputElement;
    const slider = screen.getByLabelText('Cut position, percent of the page width') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '50.25' } });
    fireEvent.blur(box);
    expect(sheet().percentText).toBe('50.3');
    expect(box.value).toBe('50.3');
    expect(slider.value).toBe('50.3');
    expect(slider.getAttribute('aria-valuetext')).toBe('50.3%');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(sheet().percentText).toBe('50.5');
    fireEvent.change(box, { target: { value: '50.3' } });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(sheet().percentText).toBe('50');
  });

  it('an invalid text leaves the slider where it was', () => {
    openCutSheet();
    render(<SideSheet />);
    const box = screen.getByLabelText('Cut position in percent');
    fireEvent.change(box, { target: { value: '40' } });
    fireEvent.change(box, { target: { value: '99' } });
    expect((screen.getByLabelText('Cut position, percent of the page width') as HTMLInputElement).value).toBe('40');
  });

  it('Right page first marks the right half 1 in the preview', () => {
    openCutSheet();
    const { container } = render(<SideSheet />);
    const mark = (n: string) => container.querySelector<HTMLElement>(`[data-cut-preview-mark="${n}"]`)!;
    expect(parseFloat(mark('1').style.left)).toBeLessThan(parseFloat(mark('2').style.left));
    fireEvent.click(screen.getByRole('radio', { name: 'Right page first' }));
    expect(parseFloat(mark('1').style.left)).toBeGreaterThan(parseFloat(mark('2').style.left));
  });

  it('Cancel closes the sheet and changes nothing', () => {
    openCutSheet();
    render(<SideSheet />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useSheetStore.getState().sheet).toBeNull();
  });
});

describe('the guide on the pages', () => {
  const layerProps = (uid: string, rotation = 0) => ({
    paneId: 'p', pageId: pageIdForUid(DOC, uid), docId: DOC, srcIndex: Number(uid), rotation, width: 400, height: 300, zoom: 1,
  });
  const guides = (container: HTMLElement) => [...container.querySelectorAll('[data-cut-guide]')].map((el) => el.getAttribute('data-cut-guide'));

  it('draws nothing while no Cut sheet is open, or for another document', () => {
    const { container, rerender } = render(<CutGuide {...layerProps('1')} />);
    expect(guides(container)).toEqual([]);
    openCutSheet();
    rerender(<CutGuide {...layerProps('1')} docId="path:C:\\work\\B.pdf" pageId="path:C:\\work\\B.pdf:1" />);
    expect(guides(container)).toEqual([]);
  });

  it('is drawn on exactly the pages "Apply to" names, and follows a change of the choice', () => {
    openCutSheet();
    const { container } = render(
      <>
        {UIDS.map((uid) => (
          <CutGuide key={uid} {...layerProps(uid)} />
        ))}
      </>,
    );
    expect(guides(container)).toEqual(UIDS.map((u) => pageIdForUid(DOC, u)));
    act(() => useSheetStore.getState().update({ scope: 'current' } as Partial<CutDraft>));
    expect(guides(container)).toEqual([pageIdForUid(DOC, '2')]);
    act(() => useSheetStore.getState().update({ scope: 'wide' } as Partial<CutDraft>));
    expect(guides(container)).toEqual([0, 1, 3, 5].map((u) => pageIdForUid(DOC, String(u))));
    act(() => useSheetStore.getState().update({ direction: 'horizontal' } as Partial<CutDraft>));
    expect(guides(container)).toEqual([2, 4].map((u) => pageIdForUid(DOC, String(u))));
  });

  it('draws the line at the cut position with the numbers 1 and 2, and keeps it at the last valid position while the text is not valid', () => {
    openCutSheet();
    const { container } = render(<CutGuide {...layerProps('0')} />);
    const line = container.querySelector('line')!;
    expect([line.getAttribute('x1'), line.getAttribute('x2')]).toEqual(['0.5', '0.5']);
    act(() => useSheetStore.getState().update({ percentText: '40' } as Partial<CutDraft>));
    expect(container.querySelector('line')!.getAttribute('x1')).toBe('0.4');
    expect(container.querySelector('[data-cut-mark="1"]')!.textContent).toBe('1');
    expect(container.querySelector('[data-cut-mark="2"]')!.textContent).toBe('2');
    act(() => useSheetStore.getState().update({ percentText: '5' } as Partial<CutDraft>));
    expect(container.querySelector('line')!.getAttribute('x1')).toBe('0.4');
  });

  it('on a page shown turned a quarter, a left and right cut is drawn as a horizontal line', () => {
    openCutSheet();
    const { container } = render(<CutGuide {...layerProps('0', 90)} />);
    const line = container.querySelector('line')!;
    expect(line.getAttribute('y1')).toBe(line.getAttribute('y2'));
    expect(container.querySelector('.cut-guide-grab-h')).not.toBeNull();
  });

  it('dragging the line sets the cut position in the sheet, in steps of 0.5 and never outside 30 to 70', () => {
    openCutSheet();
    const { container } = render(<CutGuide {...layerProps('0')} />);
    const root = container.querySelector<HTMLElement>('.cut-guide')!;
    root.getBoundingClientRect = () => ({ left: 100, top: 0, width: 400, height: 300, right: 500, bottom: 300, x: 100, y: 0, toJSON: () => ({}) });
    const grab = container.querySelector<HTMLElement>('[data-cut-line]')!;
    grab.setPointerCapture = () => undefined;
    grab.hasPointerCapture = () => false;
    fireEvent.pointerDown(grab, { clientX: 300, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grab, { clientX: 100 + 400 * 0.4123, clientY: 100, pointerId: 1 });
    expect(sheet().percentText).toBe('41');
    fireEvent.pointerMove(grab, { clientX: 105, clientY: 100, pointerId: 1 });
    expect(sheet().percentText).toBe('30');
    fireEvent.pointerMove(grab, { clientX: 495, clientY: 100, pointerId: 1 });
    expect(sheet().percentText).toBe('70');
    fireEvent.pointerUp(grab, { pointerId: 1 });
    fireEvent.pointerMove(grab, { clientX: 300, clientY: 100, pointerId: 1 });
    expect(sheet().percentText).toBe('70');
  });
});
