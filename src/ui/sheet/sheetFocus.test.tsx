// @vitest-environment jsdom
// 1.5.5 part C: radio-group keys in the segmented choices (C1), where focus lands when a sheet opens and where it goes back (C2),
// Esc order with a Help panel (section 0), and the read-only fields while Apply runs (C5).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ fileService: {}, documentRegistry: { get: () => undefined } }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../../features/documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(async () => true),
  attachSourceLogged: vi.fn(),
  cancelOperation: vi.fn(),
  settleEdits: vi.fn(async () => undefined),
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
import { useSheetStore, type CutDraft } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { applyPageEdits } from '../../features/documents/editOps';
import { openCutSheet } from '../../features/organizer/actions';
import { useApplyStore } from '../../features/organizer/sheetActions';
import { SideSheet } from './SideSheet';

afterEach(() => {
  cleanup();
  useApplyStore.setState({ docId: null, applying: false, closeRequested: false, focusApply: false });
  useUiStore.setState({ helpDialog: null });
});

const DOC = 'path:C:\\work\\A.pdf';
const UIDS = ['0', '1', '2', '3', '4', '5'];
const SIZE = { width: 800, height: 600, rotation: 0 };

beforeEach(() => {
  useSheetStore.getState().close();
  useWorkspaceStore.setState({
    tabs: [{ id: 't', title: 'A.pdf', origin: { kind: 'path', path: DOC }, status: { kind: 'ready' }, split: null,
      panes: [{ id: 'p', docId: DOC, view: { pageId: pageIdForUid(DOC, '2'), zoom: 1, fit: 'width', offset: 0, rotation: 0 } }] }],
    activeTabId: 't',
    activePaneId: 'p',
  } as never);
  useEditStore.setState({ byDoc: { [DOC]: { version: 1, uids: UIDS, revs: UIDS.map(() => 0), sizes: null, history: { canUndo: false, canRedo: false } } } } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'A.pdf', pageCount: 6, pages: [], sizes: UIDS.map(() => SIZE) } } } as never);
});

const open = (draft: object) => useSheetStore.getState().open({ docId: DOC, ...draft } as never);
const radio = (name: string) => screen.getByRole('radio', { name });
const direction = () => (useSheetStore.getState().sheet as CutDraft).direction;

describe('segmented choices are radio groups (C1)', () => {
  it('arrows choose the next or previous option and wrap, Home and End the ends; one tab stop', () => {
    openCutSheet();
    render(<SideSheet />);
    const group = screen.getByRole('radiogroup', { name: 'Cut into' });
    expect(radio('Left and right').tabIndex).toBe(0);
    expect(radio('Top and bottom').tabIndex).toBe(-1);
    expect(group.querySelectorAll('[tabindex="0"]').length).toBe(1);
    fireEvent.keyDown(radio('Left and right'), { key: 'ArrowRight' });
    expect(direction()).toBe('horizontal');
    expect(document.activeElement).toBe(radio('Top and bottom'));
    expect(screen.queryByRole('radiogroup', { name: 'Page order' })).toBeNull();
    fireEvent.keyDown(radio('Top and bottom'), { key: 'ArrowRight' });
    expect(direction()).toBe('vertical');
    expect(document.activeElement).toBe(radio('Left and right'));
    fireEvent.keyDown(radio('Left and right'), { key: 'ArrowLeft' });
    expect(direction()).toBe('horizontal');
    fireEvent.keyDown(radio('Top and bottom'), { key: 'Home' });
    expect(direction()).toBe('vertical');
    fireEvent.keyDown(radio('Left and right'), { key: 'End' });
    expect(direction()).toBe('horizontal');
  });
});

describe('focus on open (C2)', () => {
  const active = () => document.activeElement;

  it('Rotate: the angle box; Crop: the Top margin box', () => {
    open({ kind: 'rotate', uids: ['2'], degrees: 0 });
    const first = render(<SideSheet />);
    expect(active()).toBe(screen.getByLabelText('Angle in degrees'));
    first.unmount();
    useSheetStore.getState().close();
    open({ kind: 'crop', uids: ['2'], pageId: pageIdForUid(DOC, '2'), scope: 'current', unit: 'in', margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoApplied: false });
    render(<SideSheet />);
    expect(active()).toBe(screen.getByLabelText('Top margin'));
  });

  it('Page size: the chosen size; Delete pages?: Cancel', () => {
    open({ kind: 'size', uids: ['0'], size: 'a4', custom: { width: 7, height: 10 }, unit: 'in', fit: 'center', scope: 'all' });
    const first = render(<SideSheet />);
    expect(active()).toBe(radio('A4'));
    first.unmount();
    useSheetStore.getState().close();
    open({ kind: 'confirmDelete', uids: ['0', '1', '2', '3'], total: 6 });
    render(<SideSheet />);
    expect(active()).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('is non-modal, and gives the focus back to the opener when it closes', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    open({ kind: 'rotate', uids: ['2'], degrees: 0 });
    render(<SideSheet />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBeNull();
    act(() => useSheetStore.getState().close());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('a redraw of the same sheet does not move the focus', () => {
    open({ kind: 'rotate', uids: ['2'], degrees: 0 });
    render(<SideSheet />);
    const preset = screen.getByRole('button', { name: 'Reset' });
    preset.focus();
    act(() => useSheetStore.getState().update({ degrees: 12 } as never));
    expect(document.activeElement).toBe(preset);
  });
});

describe('Esc closes one thing', () => {
  it('a Help panel takes the key before the sheet', () => {
    open({ kind: 'rotate', uids: ['2'], degrees: 0 });
    render(<SideSheet />);
    act(() => useUiStore.setState({ helpDialog: 'about' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSheetStore.getState().sheet).not.toBeNull();
    act(() => useUiStore.setState({ helpDialog: null }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSheetStore.getState().sheet).toBeNull();
  });
});

describe('while Apply runs (C5)', () => {
  it('the fields are read-only, Apply is off and a Cancel in progress reads "Cancelling…"', () => {
    open({ kind: 'rotate', uids: ['2'], degrees: 30 });
    const { container } = render(<SideSheet />);
    act(() => useApplyStore.setState({ docId: DOC, applying: true }));
    expect(container.querySelector('fieldset')!.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useApplyStore.setState({ closeRequested: true }));
    expect((screen.getByRole('button', { name: 'Cancelling…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an Apply that leaves the sheet open keeps the focus where it was', async () => {
    vi.mocked(applyPageEdits).mockRejectedValueOnce(new Error('The pages could not be changed.'));
    open({ kind: 'rotate', uids: ['2'], degrees: 30 });
    render(<SideSheet />);
    const reset = screen.getByRole('button', { name: 'Reset' });
    reset.focus();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(useSheetStore.getState().sheet).not.toBeNull();
    expect(document.activeElement).toBe(reset);
  });

  it("another document's Apply does not lock this sheet", () => {
    open({ kind: 'rotate', uids: ['2'], degrees: 30 });
    const { container } = render(<SideSheet />);
    act(() => useApplyStore.setState({ docId: 'other', applying: true }));
    expect(container.querySelector('fieldset')!.disabled).toBe(false);
  });

  it('after a cancel from the status bar the sheet stays and focus goes to Apply', () => {
    open({ kind: 'rotate', uids: ['2'], degrees: 30 });
    render(<SideSheet />);
    act(() => useApplyStore.setState({ docId: DOC, applying: true }));
    act(() => useApplyStore.setState({ applying: false, focusApply: true }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Apply' }));
    expect(useSheetStore.getState().sheet).not.toBeNull();
  });
});
