import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// The worker-facing functions are spies; the list functions (order, ranges, selection) are the real ones.
vi.mock('../../features/jobs/combineFlow', async () => {
  const actual = await vi.importActual<typeof import('../../features/jobs/combineFlow')>('../../features/jobs/combineFlow');
  return {
    ...actual,
    addFilesFromPicker: vi.fn(async () => undefined),
    addOpenFiles: vi.fn(async () => undefined),
    addPaths: vi.fn(async () => undefined),
    startCombine: vi.fn(async () => undefined),
    showPreview: vi.fn(async () => undefined),
    requestPreviewPages: vi.fn(async () => undefined),
    saveOpenFile: vi.fn(async () => undefined),
  };
});

import { CombineWindow } from './CombineWindow';
import { initialCombine, useCombineStore } from '../../core/stores/combineStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useUiStore } from '../../core/stores/uiStore';
import * as flow from '../../features/jobs/combineFlow';
import type { CombineRow } from '../../features/jobs/combinePlan';

class FakeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;

const row = (name: string, extra: Partial<CombineRow> = {}): CombineRow => ({
  id: `id-${name}`,
  path: `C:\\in\\${name}`,
  name,
  size: 2 * 1024 * 1024,
  modified: 1,
  kind: 'pdf',
  status: 'ready',
  pages: 12,
  rangeText: '',
  facts: { encrypted: false, fields: 0, layers: false, attachments: 0, unprintable: 0 },
  ...extra,
});

const show = (rows: CombineRow[] = [], patch: Partial<typeof initialCombine> = {}) => {
  useCombineStore.setState({ ...initialCombine, open: true, rows, selected: rows[0] ? [rows[0].id] : [], focusId: rows[0]?.id ?? null, ...patch });
  return render(<CombineWindow />);
};

beforeEach(() => {
  vi.clearAllMocks();
  useDocumentsStore.setState({ docs: {} });
  useUiStore.setState({ sourcePassword: null, closePrompt: false });
});
afterEach(() => {
  cleanup();
  useCombineStore.setState({ ...initialCombine });
});

describe('the Combine window', () => {
  it('is a modal dialog named Combine files, with the buttons of the spec, in the spec order', () => {
    show([row('a.pdf')]);
    const dialog = screen.getByRole('dialog', { name: 'Combine files' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const bar = within(dialog).getByRole('toolbar', { name: 'Files' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Add files…', 'Add open files', 'Remove', 'Move up', 'Move down', 'Sort by name']);
  });

  it('empty: the spec text, Combine… is off, and focus is on Add files…', () => {
    show([]);
    expect(screen.getByText('Add the files you want to combine. Drop them here, or choose Add files…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Combine…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement?.textContent).toBe('Add files…');
    expect((screen.getByRole('button', { name: 'Add open files' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Add open files is on when a document with a saved file is open', () => {
    useDocumentsStore.getState().putDoc({ docId: 'path:C:\\x.pdf', name: 'x.pdf', pageCount: 1, pages: { order: [], ids: [] } as never, sizes: [] });
    show([]);
    expect((screen.getByRole('button', { name: 'Add open files' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add open files' }));
    expect(flow.addOpenFiles).toHaveBeenCalled();
  });

  it('the list is a multi-select listbox; each row shows name, pages and size; focus is on the list when it has files', () => {
    show([row('a.pdf'), row('b.pdf', { pages: 1, size: 500 })]);
    const list = screen.getByRole('listbox', { name: 'Files to combine' });
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(document.activeElement).toBe(list);
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(options[0]!.textContent).toContain('12 pages · 2.0 MB');
    expect(options[1]!.textContent).toContain('1 page · 500 bytes');
  });

  it('a row being read says Reading…', () => {
    show([row('a.pdf', { status: 'reading', pages: 0 })]);
    expect(within(screen.getByRole('listbox', { name: 'Files to combine' })).getByText('Reading…')).toBeTruthy();
  });

  it('footer: files, pages and size; Combine… is on when every row is read', () => {
    show([row('a.pdf'), row('b.pdf', { rangeText: '1-2' })]);
    expect(screen.getByText('2 files · 14 pages · 4.0 MB')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Combine…' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Combine…' }));
    expect(flow.startCombine).toHaveBeenCalled();
  });

  it('over 500 MB: the footer says so and Combine… is off', () => {
    show([row('big.pdf', { size: 600 * 1024 * 1024 })]);
    expect(screen.getByText('These files are too large to combine at once (the limit is 500 MB in total).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Combine…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('order and removal, with the keyboard', () => {
  const list = () => screen.getByRole('listbox', { name: 'Files to combine' });
  const names = () => useCombineStore.getState().rows.map((r) => r.name);

  it('Alt+Down and Alt+Up move the selected file, Alt+End and Alt+Home go to the ends, and a live region says where it went', () => {
    show([row('a.pdf'), row('b.pdf'), row('c.pdf')]);
    fireEvent.keyDown(list(), { key: 'ArrowDown', altKey: true });
    expect(names()).toEqual(['b.pdf', 'a.pdf', 'c.pdf']);
    expect(useCombineStore.getState().announcement).toBe('a.pdf moved to 2 of 3');
    fireEvent.keyDown(list(), { key: 'End', altKey: true });
    expect(names()).toEqual(['b.pdf', 'c.pdf', 'a.pdf']);
    fireEvent.keyDown(list(), { key: 'Home', altKey: true });
    expect(names()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('Down and Up choose a row (and show it in the preview); Shift extends; Ctrl+A selects all; Delete removes the selection', () => {
    show([row('a.pdf'), row('b.pdf'), row('c.pdf')]);
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    expect(useCombineStore.getState().selected).toEqual(['id-b.pdf']);
    expect(useCombineStore.getState().focusId).toBe('id-b.pdf');
    fireEvent.keyDown(list(), { key: 'ArrowDown', shiftKey: true });
    expect(useCombineStore.getState().selected).toEqual(['id-b.pdf', 'id-c.pdf']);
    fireEvent.keyDown(list(), { key: 'a', ctrlKey: true });
    expect(useCombineStore.getState().selected).toHaveLength(3);
    fireEvent.keyDown(list(), { key: 'Delete' });
    expect(names()).toEqual([]);
  });

  it('the buttons do the same: Move down, Move up, Remove, Sort by name', () => {
    show([row('b.pdf'), row('a.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
    expect(names()).toEqual(['a.pdf', 'b.pdf']);
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    expect(names()).toEqual(['b.pdf', 'a.pdf']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by name' }));
    expect(names()).toEqual(['a.pdf', 'b.pdf']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(names()).toEqual(['a.pdf']);
  });
});

describe('page ranges and the preview', () => {
  it('a PDF row has a Pages field (empty = all pages); a wrong range is shown under it and turns Combine… off', () => {
    show([row('a.pdf')]);
    const field = screen.getByLabelText('Pages of a.pdf') as HTMLInputElement;
    expect(field.placeholder).toBe('All pages');
    fireEvent.change(field, { target: { value: '99' } });
    expect(screen.getByText('99 is outside 1-12.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Combine…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: '1-3, 8' } });
    expect(screen.queryByText('99 is outside 1-12.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Combine…' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('single pictures and text files have no Pages field; a multi-page TIFF has one', () => {
    show([row('p.png', { kind: 'image', pages: 1 }), row('t.txt', { kind: 'text', pages: 3 }), row('s.tif', { kind: 'image', pages: 6 })]);
    expect(screen.queryByLabelText('Pages of p.png')).toBeNull();
    expect(screen.queryByLabelText('Pages of t.txt')).toBeNull();
    expect(screen.getByLabelText('Pages of s.tif')).toBeTruthy();
  });

  it('the preview shows the page checkboxes of the selected file; clicking leaves a page out and rewrites Pages; clicking again puts it back', () => {
    show([row('a.pdf', { pages: 5 })]);
    const page3 = () => screen.getByRole('checkbox', { name: /^Page 3/ });
    expect(page3().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(page3());
    expect(page3().getAttribute('aria-checked')).toBe('false');
    expect(page3().getAttribute('aria-label')).toBe('Page 3, left out');
    expect((screen.getByLabelText('Pages of a.pdf') as HTMLInputElement).value).toBe('1-2, 4-5');
    fireEvent.click(page3());
    expect((screen.getByLabelText('Pages of a.pdf') as HTMLInputElement).value).toBe('');
  });

  it('typing a range marks the pages left out in the preview', () => {
    show([row('a.pdf', { pages: 5 })]);
    fireEvent.change(screen.getByLabelText('Pages of a.pdf'), { target: { value: '2-3' } });
    expect(screen.getAllByRole('checkbox', { name: /^Page/ }).map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true', 'true', 'false', 'false']);
  });

  it('a text file previews its pages as they will be made (no checkboxes)', () => {
    show([row('t.txt', { kind: 'text', pages: 3 })]);
    expect(screen.queryAllByRole('checkbox', { name: /^Page/ })).toHaveLength(0);
    expect(screen.getAllByRole('img', { name: /^Page \d$/ })).toHaveLength(3);
  });

  it('only one preview page is in the tab order', () => {
    show([row('a.pdf', { pages: 5 })]);
    expect(screen.getAllByRole('checkbox', { name: /^Page/ }).filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });
});

describe('notices and messages', () => {
  it('"Before you combine:" lists the notices as a status region; a row with a notice shows ⚠ that points at it', () => {
    show([row('f.pdf', { facts: { encrypted: false, fields: 3, layers: false, attachments: 0, unprintable: 0 } }), row('plain.pdf')]);
    const region = screen.getByText('Before you combine:').closest('[role="status"]') as HTMLElement;
    expect(region.textContent).toContain('Fillable forms in f.pdf: what is filled in stays visible');
    const warn = screen.getByLabelText('Notice');
    expect(warn.getAttribute('aria-describedby')).toBe(region.id);
    expect(screen.getAllByLabelText('Notice')).toHaveLength(1);
  });

  it('a message such as a refused file is a status, and can be dismissed', () => {
    show([row('a.pdf')]);
    act(() => useCombineStore.getState().addMessage('x.docx was not added. Something.'));
    const message = screen.getByText('x.docx was not added. Something.');
    expect(message.closest('[role="status"]')).toBeTruthy();
    fireEvent.click(within(message.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('x.docx was not added. Something.')).toBeNull();
  });

  it('the footer shows why the name was refused, as an alert', () => {
    show([row('a.pdf')], { targetMessage: 'Choose a different name: that file is one of the files being combined.' });
    expect(screen.getByRole('alert').textContent).toBe('Choose a different name: that file is one of the files being combined.');
  });
});

describe('options', () => {
  it('the defaults of the spec: bookmark for each file on, open the new file on, pictures the same size, text Letter', () => {
    show([row('a.pdf')]);
    expect((screen.getByLabelText('Add a bookmark for each file') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Open the new file when it is ready') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Picture pages') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Same size as the picture');
    expect((screen.getByLabelText('Text pages') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Letter');
    fireEvent.click(screen.getByLabelText('Add a bookmark for each file'));
    expect(useCombineStore.getState().fileBookmarks).toBe(false);
  });
});

describe('keyboard and focus', () => {
  it('Esc closes the window, but not while a password prompt is open over it', () => {
    show([row('a.pdf')]);
    const dialog = screen.getByRole('dialog', { name: 'Combine files' });
    act(() => useUiStore.setState({ sourcePassword: { name: 'x.pdf', error: null } }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useCombineStore.getState().open).toBe(true);
    act(() => useUiStore.setState({ sourcePassword: null }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useCombineStore.getState().open).toBe(false);
  });

  it('Tab stays inside the window: from the last control it goes to the first', () => {
    show([row('a.pdf')]);
    const combine = screen.getByRole('button', { name: 'Combine…' });
    combine.focus();
    fireEvent.keyDown(combine, { key: 'Tab' });
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('the window is inert-free for itself and makes the app behind it inert', () => {
    const app = document.createElement('div');
    app.className = 'app';
    const behind = document.createElement('div');
    app.appendChild(behind);
    document.body.appendChild(app);
    useCombineStore.setState({ ...initialCombine, open: true, rows: [] });
    const view = render(<CombineWindow />, { container: app.appendChild(document.createElement('div')) });
    expect(behind.hasAttribute('inert')).toBe(true);
    view.unmount();
    expect(behind.hasAttribute('inert')).toBe(false);
    app.remove();
  });
});
