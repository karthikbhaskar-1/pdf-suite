// @vitest-environment node
// 1.3.2: WHICH pages and WHICH file Split into Files acts on, from the command to the files main is asked to write:
//  - another document open with a selection: ignored; the focused document is split, all of its pages;
//  - unsaved edits: the sheet asks to save first and reads nothing; Save and continue then reads the saved file;
//  - after Save: the saved file; after Save As: the new path;
//  - the output folder reaches main only as a token; the page never names a path to write to;
//  - a file that changed since it was read is read again instead of split; closing the source tab does not stop the job.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mu from 'mupdf';
import { JobSession } from '../../engine/mupdf/jobCore';
import type { FromJob, ToJob } from '../../engine/mupdf/jobProtocol';
import { makeDoc } from '../../engine/mupdf/jobTestKit';
import type { WorkerLike } from './jobRunner';

// The document registry: the focused document is a MuPDF document that can be edited.
const registry = vi.hoisted(() => ({ docs: new Map<string, unknown>() }));
vi.mock('../../app/services', () => ({ documentRegistry: { get: (id: string) => ({ doc: registry.docs.get(id) }) } }));
vi.mock('../documents/closeFlow', () => ({ saveWithFeedback: vi.fn(async () => 'saved') }));

const { MupdfDocument } = await import('../../engine/mupdf/mupdfDocument');
const { useDocumentsStore } = await import('../../core/stores/documentsStore');
const { useEditStore } = await import('../../core/stores/editStore');
const { useSplitStore } = await import('../../core/stores/splitStore');
const { useJobStore } = await import('../../core/stores/jobStore');
const { rekeyDocument } = await import('../documents/saveDocument');
const flow = await import('./splitFlow');
const closeFlow = await import('../documents/closeFlow');

/** A MuPDF document that can be edited, as far as the Split command looks. */
function editableDoc(): unknown {
  const doc = Object.create(MupdfDocument.prototype) as { capabilities: { canEdit: boolean; htmlLayer: boolean } };
  doc.capabilities = { canEdit: true, htmlLayer: false };
  return doc;
}

class InProcessWorker implements WorkerLike {
  onmessage: ((event: { data: FromJob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly session = new JobSession(mu, (message) => queueMicrotask(() => this.onmessage?.({ data: message })));
  postMessage(message: ToJob): void {
    queueMicrotask(() => this.session.handle(message));
  }
  terminate(): void {
    this.session.dispose();
  }
}

/** Files on the fake disk: path to bytes, with a modified stamp. */
const disk = new Map<string, { bytes: Uint8Array; modified: number }>();
const calls: string[] = [];
let created: Array<{ leaf: string; bytes: Uint8Array[] }> = [];
let beginTargets: unknown[] = [];
/** When set, the first chunk is held until the test releases it: a job that is still running. */
let hold: Promise<void> | null = null;
/** Called inside begin: the user presses Cancel at the moment the job has no worker call yet. */
let duringBegin: (() => void) | null = null;
let folderLabel = 'D:\\Example\\Out';

function installBridge(): void {
  const stat = async (path: string) => {
    const f = disk.get(path);
    return f ? { size: f.bytes.length, modified: f.modified } : null;
  };
  (globalThis as unknown as { window: unknown }).window = {
    pdfSuite: {
      files: { stat },
      jobs: {
        readInput: async (path: string) => {
          calls.push(`read ${path}`);
          const f = disk.get(path);
          return f ? { ok: true, bytes: f.bytes.slice().buffer, size: f.bytes.length, modified: f.modified } : { ok: false, reason: 'missing' };
        },
        pickFolder: async (near?: string) => {
          calls.push(`pickFolder near ${near ?? '-'}`);
          return { token: 'c'.repeat(32), label: folderLabel };
        },
        begin: async (target: unknown, inputs: string[]) => {
          duringBegin?.();
          beginTargets.push(target);
          calls.push(`begin ${JSON.stringify(target)} inputs ${JSON.stringify(inputs)}`);
          return { ok: true, jobToken: 'd'.repeat(32) };
        },
        openFile: async (_t: string, leaf: string) => {
          created.push({ leaf, bytes: [] });
          return { ok: true, fileId: created.length };
        },
        append: async (_t: string, id: number, _s: number, bytes: ArrayBuffer) => {
          if (hold) await hold;
          created[id - 1]!.bytes.push(new Uint8Array(bytes));
          return { ok: true };
        },
        closeFile: async () => ({ ok: true }),
        commit: async () => ({ ok: true, results: created.map((c, i) => ({ resultId: String(i).padStart(32, '0'), name: c.leaf })) }),
        abort: async () => {
          calls.push('abort');
        },
        reveal: async () => undefined,
      },
    },
  };
}

function open(docId: string, pages: number, name: string, dirty = false): void {
  useDocumentsStore.getState().putDoc({ docId, name, pageCount: pages, pages: { order: [], ids: [] } as never, sizes: [] });
  registry.docs.set(docId, editableDoc());
  useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: { ...(s.byDoc[docId] as object), history: { dirty, canUndo: dirty, canRedo: false, undoLabel: null, redoLabel: null } } } as never }));
  void name;
}

const A = 'path:C:\\docs\\a.pdf';
const B = 'path:C:\\docs\\b.pdf';

beforeEach(() => {
  registry.docs.clear();
  disk.clear();
  calls.length = 0;
  created = [];
  beginTargets = [];
  hold = null;
  duringBegin = null;
  folderLabel = 'D:\\Example\\Out';
  useSplitStore.getState().close();
  useJobStore.setState({ job: null, cancel: null, notice: null });
  useDocumentsStore.setState({ docs: {} });
  useEditStore.setState({ byDoc: {} });
  disk.set('C:\\docs\\a.pdf', { bytes: makeDoc({ pages: 6 }), modified: 1 });
  disk.set('C:\\docs\\b.pdf', { bytes: makeDoc({ pages: 3, text: (n) => `Other ${n}` }), modified: 1 });
  installBridge();
  flow.setJobWorkerFactory(async () => new InProcessWorker());
});

const settle = () => vi.waitFor(() => expect(useSplitStore.getState().sheet?.stage).not.toBe('checking'));
const pagesOf = (bytes: Uint8Array[]) => {
  const all = new Uint8Array(bytes.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of bytes) {
    all.set(c, at);
    at += c.length;
  }
  const doc = mu.Document.openDocument(all, 'application/pdf');
  return Array.from({ length: doc.countPages() }, (_u, i) => doc.loadPage(i).toStructuredText('').asText().trim());
};

describe('which file and which pages', () => {
  it('another document is open with a selection: the focused document is split, every page of its saved file', async () => {
    open(A, 6, 'a.pdf');
    open(B, 3, 'b.pdf');
    // A selection in B (the other document) must not matter.
    expect(flow.openSplitSheet(A)).toBe(true);
    await settle();
    const sheet = useSplitStore.getState().sheet!;
    expect(sheet).toMatchObject({ docId: A, path: 'C:\\docs\\a.pdf', name: 'a.pdf', pages: 6, stage: 'ready' });
    expect(calls).toContain('read C:\\docs\\a.pdf');
    expect(calls.some((c) => c.includes('b.pdf'))).toBe(false);
    useSplitStore.getState().update({ perFileText: '4' });
    await flow.chooseFolder();
    await flow.startSplit();
    await vi.waitFor(() => expect(useJobStore.getState().notice).not.toBeNull());
    expect(created.map((c) => c.leaf)).toEqual(['a - part 01.pdf', 'a - part 02.pdf']);
    expect(created.map((c) => pagesOf(c.bytes))).toEqual([['Page 1', 'Page 2', 'Page 3', 'Page 4'], ['Page 5', 'Page 6']]);
    expect(useJobStore.getState().notice?.message).toBe('Split a.pdf into 2 files.');
  });

  it('unsaved edits: the sheet says "Save your changes first?" and reads nothing; Save and continue reads the saved file', async () => {
    open(A, 6, 'a.pdf', true);
    expect(flow.openSplitSheet(A)).toBe(true);
    expect(useSplitStore.getState().sheet).toMatchObject({ stage: 'unsaved' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.startsWith('read'))).toEqual([]);
    // The save succeeds (the mocked saveWithFeedback), and the document is clean again.
    vi.mocked(closeFlow.saveWithFeedback).mockImplementationOnce(async () => {
      useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [A]: { history: { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } } } as never }));
      disk.set('C:\\docs\\a.pdf', { bytes: makeDoc({ pages: 8, text: (n) => `Saved ${n}` }), modified: 2 });
      return 'saved';
    });
    await flow.saveAndContinue();
    await settle();
    expect(useSplitStore.getState().sheet).toMatchObject({ stage: 'ready', pages: 8 });
    expect(calls.filter((c) => c.startsWith('read'))).toContain('read C:\\docs\\a.pdf');
  });

  it('edited while the sheet is open: it switches to "Save your changes first?" and drops what it had read', async () => {
    open(A, 6, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    expect(useSplitStore.getState().sheet?.stage).toBe('ready');
    useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, [A]: { history: { dirty: true, canUndo: true, canRedo: false, undoLabel: 'Rotate', redoLabel: null } } } as never }));
    expect(useSplitStore.getState().sheet?.stage).toBe('unsaved');
    // Split is not possible from this stage.
    await flow.startSplit();
    expect(created).toEqual([]);
  });

  it('after Save As the document is known by its new path, and that is the file that is read and split', async () => {
    open(A, 6, 'a.pdf');
    disk.set('C:\\docs\\renamed.pdf', { bytes: makeDoc({ pages: 4, text: (n) => `Renamed ${n}` }), modified: 3 });
    // Save As re-keys the open document: the old id is gone and the new one is its path.
    const NEW = 'path:C:\\docs\\renamed.pdf';
    registry.docs.set(NEW, registry.docs.get(A));
    registry.docs.delete(A);
    useDocumentsStore.getState().putDoc({ docId: NEW, name: 'renamed.pdf', pageCount: 4, pages: { order: [], ids: [] } as never, sizes: [] });
    void rekeyDocument;
    expect(flow.resolveSplitTarget(NEW)).toMatchObject({ kind: 'ok', path: 'C:\\docs\\renamed.pdf', name: 'renamed.pdf' });
    expect(flow.openSplitSheet(NEW)).toBe(true);
    await settle();
    expect(useSplitStore.getState().sheet).toMatchObject({ path: 'C:\\docs\\renamed.pdf', pages: 4, baseName: 'renamed' });
    expect(calls).toContain('read C:\\docs\\renamed.pdf');
    expect(calls).not.toContain('read C:\\docs\\a.pdf');
  });

  it('a document that is not a file on disk (no path) or not open cannot be split', () => {
    expect(flow.resolveSplitTarget(undefined)).toEqual({ kind: 'none' });
    expect(flow.resolveSplitTarget('bytes:abc')).toEqual({ kind: 'none' });
    expect(flow.openSplitSheet(undefined)).toBe(false);
  });
});

describe('the output folder', () => {
  it('reaches main only as a token: begin gets { folderToken } and the source path as an input; no folder path is ever sent', async () => {
    open(A, 6, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    useSplitStore.getState().update({ perFileText: '3' });
    await flow.chooseFolder();
    expect(calls).toContain('pickFolder near C:\\docs\\a.pdf');
    expect(useSplitStore.getState().sheet?.folder).toEqual({ token: 'c'.repeat(32), label: folderLabel });
    await flow.startSplit();
    await vi.waitFor(() => expect(useJobStore.getState().notice).not.toBeNull());
    expect(beginTargets).toEqual([{ folderToken: 'c'.repeat(32) }]);
    const begin = calls.find((c) => c.startsWith('begin'))!;
    expect(begin).toContain('inputs ["C:\\\\docs\\\\a.pdf"]');
    // Nothing but the token: the folder's own path is not in any call.
    expect(calls.join('\n')).not.toContain(folderLabel);
  });

  it('Split stays off until a folder is chosen', async () => {
    open(A, 6, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    await flow.startSplit();
    expect(calls.some((c) => c.startsWith('begin'))).toBe(false);
    expect(useJobStore.getState().job).toBeNull();
  });
});

describe('while it runs', () => {
  it('a file that changed since it was read is read again, not split', async () => {
    open(A, 6, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    useSplitStore.getState().update({ perFileText: '3' });
    await flow.chooseFolder();
    disk.set('C:\\docs\\a.pdf', { bytes: makeDoc({ pages: 9 }), modified: 7 });
    await flow.startSplit();
    await vi.waitFor(() => expect(useSplitStore.getState().sheet?.pages).toBe(9));
    expect(calls.some((c) => c.startsWith('begin'))).toBe(false);
    expect(useSplitStore.getState().sheet).toMatchObject({ stage: 'ready', pages: 9 });
    expect(calls.filter((c) => c === 'read C:\\docs\\a.pdf')).toHaveLength(2);
  });

  it('one job at a time: the command is off with the busy reason, and closing the source tab does not stop the job', async () => {
    open(A, 6, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    useSplitStore.getState().update({ perFileText: '3' });
    await flow.chooseFolder();
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (release = resolve));
    const run = flow.startSplit();
    // The job is running now: Split into Files is disabled with the spec's reason.
    await vi.waitFor(() => expect(useJobStore.getState().job).not.toBeNull());
    expect(flow.splitAvailability(A)).toEqual({ enabled: false, reason: 'PDF Suite is still working on your files. Wait for it to finish, or cancel it.' });
    expect(flow.openSplitSheet(A)).toBe(false);
    // The source tab is closed.
    useDocumentsStore.setState({ docs: {} });
    registry.docs.delete(A);
    release();
    await run;
    await vi.waitFor(() => expect(useJobStore.getState().notice).not.toBeNull());
    expect(useJobStore.getState().notice).toMatchObject({ failed: false, message: 'Split a.pdf into 2 files.' });
  });

  it('Cancel leaves no files: the notice says so and main is told to abort', async () => {
    open(A, 40, 'a.pdf');
    disk.set('C:\\docs\\a.pdf', { bytes: makeDoc({ pages: 40 }), modified: 1 });
    flow.openSplitSheet(A);
    await settle();
    useSplitStore.getState().update({ perFileText: '1' });
    await flow.chooseFolder();
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (release = resolve));
    const run = flow.startSplit();
    await vi.waitFor(() => expect(useJobStore.getState().job).not.toBeNull());
    flow.cancelJob();
    release();
    expect(useJobStore.getState().job?.cancelling).toBe(true);
    await run;
    expect(useJobStore.getState().notice).toMatchObject({ failed: true, message: 'Cancelled. No files were created and your original files were not changed.' });
    expect(calls).toContain('abort');
    expect(useJobStore.getState().job).toBeNull();
  });
});

describe('Cancel before the worker has started', () => {
  it('pressed while main is still starting the job: no worker run, no files, the Cancelled notice', async () => {
    open(A, 6, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    useSplitStore.getState().update({ perFileText: '3' });
    await flow.chooseFolder();
    duringBegin = () => flow.cancelJob();
    await flow.startSplit();
    expect(useJobStore.getState().notice).toMatchObject({ failed: true, message: 'Cancelled. No files were created and your original files were not changed.' });
    expect(created).toEqual([]);
    expect(calls).toContain('abort');
    expect(useJobStore.getState().job).toBeNull();
  });
});

describe('what the sheet refuses', () => {
  it('a form whose values cannot be kept is refused on opening, with the spec message', async () => {
    // A box of no size holding a value: it cannot be drawn, so the values would be lost.
    const pdf = new mu.PDFDocument();
    pdf.insertPage(-1, pdf.addPage([0, 0, 300, 200], 0, {}, '0 g 10 10 20 20 re f'));
    const page = pdf.findPage(0);
    const widget = pdf.newDictionary();
    widget.put('Type', pdf.newName('Annot'));
    widget.put('Subtype', pdf.newName('Widget'));
    widget.put('FT', pdf.newName('Tx'));
    widget.put('T', pdf.newString('f'));
    widget.put('V', pdf.newString('LOST'));
    widget.put('F', 4);
    widget.put('DA', pdf.newString('/Helv 12 Tf 0 g'));
    const rect = pdf.newArray();
    for (const n of [50, 100, 50, 100]) rect.push(pdf.newReal(n));
    widget.put('Rect', rect);
    widget.put('P', page);
    const ref = pdf.addObject(widget);
    const annots = pdf.newArray();
    annots.push(ref);
    page.put('Annots', annots);
    const acro = pdf.newDictionary();
    const fields = pdf.newArray();
    fields.push(ref);
    acro.put('Fields', fields);
    pdf.getTrailer().get('Root').put('AcroForm', acro);
    disk.set('C:\\docs\\a.pdf', { bytes: pdf.saveToBuffer('').asUint8Array().slice(), modified: 1 });
    open(A, 1, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    expect(useSplitStore.getState().sheet).toMatchObject({ stage: 'refused', refusal: 'FormValuesLost' });
  });

  it('a file over 500 MB is not even sent to the worker; a damaged file says so', async () => {
    disk.set('C:\\docs\\a.pdf', { bytes: new Uint8Array([1, 2, 3, 4]), modified: 1 });
    open(A, 3, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    expect(useSplitStore.getState().sheet).toMatchObject({ stage: 'refused', refusal: 'Damaged' });
  });

  it('closing the sheet ends its worker and clears the sheet', async () => {
    open(A, 6, 'a.pdf');
    flow.openSplitSheet(A);
    await settle();
    flow.closeSplitSheet();
    expect(useSplitStore.getState().sheet).toBeNull();
  });
});
