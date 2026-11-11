// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planDrop } from './dropRouting';
import type { InputType } from '../../platform/desktop/contract';

const kinds = (entries: Record<string, InputType>) => new Map(Object.entries(entries));

describe('what a drop on the main window does (UI spec section 0)', () => {
  it('one PDF opens, with no toast', () => {
    expect(planDrop(['C:\\a.pdf'], kinds({ 'C:\\a.pdf': 'pdf' }))).toEqual({ open: ['C:\\a.pdf'], toast: null });
  });

  it('three PDFs open, and the toast says "Opened 3 files" with a button that opens Combine with them listed', () => {
    const paths = ['C:\\a.pdf', 'C:\\b.pdf', 'C:\\c.pdf'];
    const plan = planDrop(paths, kinds({ 'C:\\a.pdf': 'pdf', 'C:\\b.pdf': 'pdf', 'C:\\c.pdf': 'pdf' }));
    expect(plan.open).toEqual(paths);
    expect(plan.toast).toEqual({ message: 'Opened 3 files', label: 'Combine them…', combine: paths });
  });

  it('pictures or text files cannot be opened on their own: they are not opened, the PDFs are, and Combine gets all of them', () => {
    const paths = ['C:\\a.pdf', 'C:\\p.png', 'C:\\t.txt'];
    const plan = planDrop(paths, kinds({ 'C:\\a.pdf': 'pdf', 'C:\\p.png': 'image', 'C:\\t.txt': 'text' }));
    expect(plan.open).toEqual(['C:\\a.pdf']);
    expect(plan.toast).toEqual({ message: "Pictures and text files can't be opened on their own", label: 'Combine into a PDF…', combine: paths });
  });

  it('a picture alone gives the toast too', () => {
    const plan = planDrop(['C:\\p.png'], kinds({ 'C:\\p.png': 'image' }));
    expect(plan.open).toEqual([]);
    expect(plan.toast?.combine).toEqual(['C:\\p.png']);
  });

  it('a file main did not describe counts as a PDF and opens as before; other kinds open as before too', () => {
    expect(planDrop(['C:\\x.pdf', 'C:\\y.pdf'], kinds({})).toast?.message).toBe('Opened 2 files');
    expect(planDrop(['C:\\z.docx'], kinds({ 'C:\\z.docx': 'office' }))).toEqual({ open: ['C:\\z.docx'], toast: null });
  });
});

describe('the Combine button of a drop toast', () => {
  it('opens Combine with the dropped files; while a job runs it says so instead of doing nothing', async () => {
    const { combineFromToast, COMBINE_BUSY_TOAST } = await import('./dropRouting');
    const said: string[] = [];
    const opened: Array<readonly string[]> = [];
    combineFromToast(['C:\a.pdf'], (p) => (opened.push(p), true), (m) => said.push(m));
    expect(opened).toEqual([['C:\a.pdf']]);
    expect(said).toEqual([]);
    combineFromToast(['C:\a.pdf'], () => false, (m) => said.push(m));
    expect(said).toEqual(['PDF Suite is still working on your files. Wait for it to finish, or cancel it.']);
    expect(COMBINE_BUSY_TOAST).toBe('PDF Suite is still working on your files. Wait for it to finish, or cancel it.');
  });
});
