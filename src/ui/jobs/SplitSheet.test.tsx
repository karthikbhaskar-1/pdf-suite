import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// The flow is replaced by spies: this file checks what the sheet shows and which function each control calls.
vi.mock('../../features/jobs/splitFlow', async () => {
  const actual = await vi.importActual<typeof import('../../features/jobs/splitFlow')>('../../features/jobs/splitFlow');
  return {
    ...actual,
    chooseFolder: vi.fn(async () => undefined),
    chooseMethod: vi.fn(async () => undefined),
    closeSplitSheet: vi.fn(),
    saveAndContinue: vi.fn(async () => undefined),
    startSplit: vi.fn(async () => undefined),
    stopBlankSearch: vi.fn(),
  };
});

import { SplitSheet, middleTruncate } from './SplitSheet';
import { useSplitStore, type SplitSheet as SheetState } from '../../core/stores/splitStore';
import * as flow from '../../features/jobs/splitFlow';

const base: SheetState = {
  docId: 'path:C:\\a.pdf',
  path: 'C:\\a.pdf',
  name: 'Report.pdf',
  stage: 'ready',
  refusal: null,
  pages: 120,
  byteLength: 48.2 * 1024 * 1024,
  facts: { encrypted: false, fields: 0, layers: false, attachments: 0 },
  method: 'count',
  perFileText: '10',
  sizeText: '10',
  sizeUnit: 'MB',
  sensitivity: 'normal',
  measures: null,
  looking: null,
  unticked: [],
  blankKeep: 'drop',
  entries: null,
  folder: null,
  baseName: 'Report',
  keepPassword: true,
  passwordNote: null,
  hidden: false,
};

const show = (patch: Partial<SheetState> = {}) => {
  useSplitStore.setState({ sheet: { ...base, ...patch } });
  return render(<SplitSheet />);
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  useSplitStore.setState({ sheet: null });
});

describe('the Split sheet by stage', () => {
  it('shows nothing without a sheet, and nothing while its job runs (hidden)', () => {
    const { container } = render(<SplitSheet />);
    expect(container.innerHTML).toBe('');
    cleanup();
    const hidden = show({ hidden: true });
    expect(hidden.container.innerHTML).toBe('');
  });

  it('unsaved: only the message with Save and continue and Cancel', () => {
    show({ stage: 'unsaved' });
    expect(screen.getByText('Save your changes first? Split works from the saved file.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(flow.saveAndContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Pages in each file')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(flow.closeSplitSheet).toHaveBeenCalled();
  });

  it('checking: "Checking this document…"', () => {
    show({ stage: 'checking' });
    expect(screen.getByRole('status').textContent).toBe('Checking this document…');
  });

  it('refused: its message and Close, nothing else', () => {
    show({ stage: 'refused', refusal: 'FormValuesLost' });
    expect(screen.getByRole('alert').textContent).toBe("This document can't be split yet, because what is filled in on its form could not be kept in the new files. The document is not changed.");
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull();
  });
});

describe('the Split sheet, ready', () => {
  it('the header line, the four methods with Page count chosen, the count box, and the example under the name', () => {
    show();
    expect(screen.getByText(/Report\.pdf · 120 pages · 48\.2 MB/)).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: 'Split by' });
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['count', 'size', 'blank', 'bookmarks']);
    expect((within(group).getByRole('radio', { name: 'Page count' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Pages in each file') as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('Example: Report - part 01.pdf … Report - part 12.pdf')).toBeTruthy();
    expect(screen.getByText('Makes 12 files.')).toBeTruthy();
    expect(screen.getByText('No folder chosen yet')).toBeTruthy();
    expect(screen.getByText('If a file with that name is already there, the new one gets “(2)”. Nothing is replaced.')).toBeTruthy();
  });

  it('Split is off until a folder is chosen; then it starts the run', () => {
    show();
    expect((screen.getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    show({ folder: { token: 'a'.repeat(32), label: 'D:\\Example\\Reports' } });
    const split = screen.getByRole('button', { name: 'Split' }) as HTMLButtonElement;
    expect(split.disabled).toBe(false);
    expect(screen.getByText('D:\\Example\\Reports').getAttribute('title')).toBe('D:\\Example\\Reports');
    fireEvent.click(split);
    expect(flow.startSplit).toHaveBeenCalledTimes(1);
  });

  it('choosing a method and the folder go through the flow', () => {
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Blank pages' }));
    expect(flow.chooseMethod).toHaveBeenCalledWith('blank');
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(flow.chooseFolder).toHaveBeenCalled();
  });

  it('validation shows under the box and turns Split off; the name rule shows under the name', () => {
    show({ perFileText: '0', folder: { token: 'a'.repeat(32), label: 'C:\\x' } });
    expect(screen.getByText('Enter a whole number from 1 to 119.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    show({ baseName: 'a/b' });
    expect(screen.getByText('A file name can\'t contain \\ / : * ? " < > |')).toBeTruthy();
    cleanup();
    show({ baseName: '' });
    expect(screen.getByText('Enter a name for the new files.')).toBeTruthy();
  });

  it('typing in the box and the name updates the sheet', () => {
    show();
    fireEvent.change(screen.getByLabelText('Pages in each file'), { target: { value: '25' } });
    expect(useSplitStore.getState().sheet?.perFileText).toBe('25');
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'Quarterly' } });
    expect(useSplitStore.getState().sheet?.baseName).toBe('Quarterly');
  });

  it('file size: the box, the unit and the summary sentence', () => {
    show({ method: 'size' });
    expect((screen.getByLabelText('Largest file') as HTMLInputElement).value).toBe('10');
    expect(screen.getByLabelText('Size unit')).toBeTruthy();
    expect(screen.getByText('Each file will be 10 MB or smaller. The number of files depends on the pages.')).toBeTruthy();
  });

  it('blank pages: the search with Stop, then the list as checkboxes named for the page, and the two choices', () => {
    show({ method: 'blank', looking: { done: 40, total: 120 } });
    expect(screen.getByText('Looking for blank pages… 40 of 120')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(flow.stopBlankSearch).toHaveBeenCalled();
    cleanup();
    const measures = Array.from({ length: 120 }, (_u, i) => (i === 12 || i === 26 ? { ink: 0, mark: 0 } : { ink: 0.2, mark: 900 }));
    show({ method: 'blank', measures });
    expect(screen.getByText('Found 2 blank pages. Untick any that should not start a new file.')).toBeTruthy();
    const box = screen.getByLabelText('Page 13, starts a new file') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(useSplitStore.getState().sheet?.unticked).toEqual([12]);
    expect(screen.getByRole('radio', { name: 'Leave out' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Keep at the end of the file before' })).toBeTruthy();
  });

  it('blank pages: the label, the two choices with their help, and "has marks" pages; the wider choice keeps the pages with the file before', () => {
    const measures = Array.from({ length: 20 }, (_u, i) => (i === 3 ? { ink: 0, mark: 0 } : i === 6 ? { ink: 0.0002, mark: 18 } : { ink: 0.2, mark: 900 }));
    show({ method: 'blank', measures });
    const select = screen.getByLabelText('What counts as blank') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Blank pages', 'Blank and nearly blank pages']);
    expect(screen.getByText('Empty pages, and scanned pages with only dust, punch holes or edge shadows.')).toBeTruthy();
    expect(screen.getByText('Found 1 blank page. Untick any that should not start a new file.')).toBeTruthy();
    expect(screen.getByText('Makes 2 files. 1 page will be left out.')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'loose' } });
    expect(useSplitStore.getState().sheet).toMatchObject({ sensitivity: 'loose', blankKeep: 'keepWithPrevious' });
    expect(screen.getByText(/Also pages with very little on them/)).toBeTruthy();
    expect(screen.getByText('Found 2 blank or nearly blank pages. Pages marked “has marks” are not empty. Untick any that should not start a new file.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 7 · has marks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 4' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Keep at the end of the file before' }) as HTMLInputElement).checked).toBe(true);
  });

  it('blank pages with none found shows the spec message', () => {
    show({ method: 'blank', measures: Array(120).fill({ ink: 0.2, mark: 900 }) });
    expect(screen.getByRole('alert').textContent).toBe('No blank pages were found. Try “Blank and nearly blank pages”, or split another way.');
  });

  it('bookmarks: the count, the example with the first title, and none gives the message', () => {
    show({ method: 'bookmarks', entries: [{ title: 'Introduction', page: 1 }, { title: 'End', page: 100 }] });
    expect(screen.getByText(/2 top-level bookmarks/)).toBeTruthy();
    expect(screen.getByText('Example: Report - 01 Introduction.pdf … Report - 02 End.pdf')).toBeTruthy();
    cleanup();
    show({ method: 'bookmarks', entries: [] });
    expect(screen.getByRole('alert').textContent).toBe('This document has no bookmarks to split by.');
  });

  it('a locked file shows "Keep the password on the new files", on; the note shows under it', () => {
    show({ facts: { encrypted: true, fields: 0, layers: false, attachments: 0 }, passwordNote: 'NOTE TEXT' });
    expect((screen.getByLabelText('Keep the password on the new files') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('NOTE TEXT')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Keep the password on the new files'));
    expect(useSplitStore.getState().sheet).toMatchObject({ keepPassword: false, passwordNote: null });
  });

  it('notices for forms, layers and attachments, worded for the new files', () => {
    show({ facts: { encrypted: false, fields: 3, layers: true, attachments: 2 } });
    expect(screen.getByText('This document has a fillable form. In the new files, what is filled in stays visible but the boxes can no longer be typed in. This document is not changed.')).toBeTruthy();
    expect(screen.getByText(/layers that can be shown and hidden/)).toBeTruthy();
    expect(screen.getByText('Files attached inside this document are not copied to the new files.')).toBeTruthy();
  });

  it('arrow keys on the method group change the method', () => {
    show();
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'Split by' }), { key: 'ArrowDown' });
    expect(flow.chooseMethod).toHaveBeenCalledWith('size');
  });

  it('Esc closes the sheet; the close button too', () => {
    show();
    // (With no pane showing this document the sheet closes itself on mount, as it does when another document is shown.)
    vi.mocked(flow.closeSplitSheet).mockClear();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(flow.closeSplitSheet).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    expect(flow.closeSplitSheet).toHaveBeenCalledTimes(2);
  });
});

describe('middleTruncate', () => {
  it('keeps the start and the end of a long path', () => {
    expect(middleTruncate('C:\\short', 38)).toBe('C:\\short');
    const long = 'D:\\Example\\Documents\\Projects\\Quarterly reports\\2024\\Final';
    const cut = middleTruncate(long, 38);
    expect(cut).toHaveLength(38);
    expect(cut.startsWith('D:\\Example')).toBe(true);
    expect(cut.endsWith('Final')).toBe(true);
    expect(cut).toContain('…');
  });
});
