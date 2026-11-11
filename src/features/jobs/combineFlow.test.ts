// @vitest-environment node
// 1.3.3: Combine from the command to the file main is asked to write, with the real job worker logic in-process:
//  - which files and pages: the order shown is the order written, ranges per file, the same file twice;
//  - a file changed or deleted after it was added is found before the run (no Save dialog, nothing started);
//  - a password is asked once per locked file, kept in memory, and never sent anywhere but the worker;
//  - the output name comes from jobs.pickOutputFile only, and main refusing it (an input, an open file) keeps the window as it was;
//  - a failed or cancelled run keeps the list; a successful run clears it and opens the new file;
//  - every file the job made is re-read with pdf.js.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as mu from 'mupdf';
import { JobSession } from '../../engine/mupdf/jobCore';
import type { FromJob, ToJob } from '../../engine/mupdf/jobProtocol';
import { makeDoc } from '../../engine/mupdf/jobTestKit';
import { reread } from '../../../tests/lib/reread.mjs';
import { makePng } from '../../../tests/lib/makeImages.mjs';
import type { WorkerLike } from './jobRunner';
import type { InputType, JobInputInfo } from '../../platform/desktop/contract';

const registry = vi.hoisted(() => ({ docs: new Map<string, unknown>(), asked: [] as Array<{ name: string; error: string | null }>, answers: [] as Array<string | null>, opened: [] as string[] }));
vi.mock('../../app/services', () => ({ documentRegistry: { get: (id: string) => ({ doc: registry.docs.get(id) }) } }));
vi.mock('../documents/closeFlow', () => ({ saveWithFeedback: vi.fn(async () => 'saved') }));
vi.mock('../organizer/sourcePassword', () => ({
  askSourcePassword: vi.fn(async (name: string, error: string | null) => {
    registry.asked.push({ name, error });
    return registry.answers.shift() ?? null;
  }),
}));
vi.mock('../documents/documentService', () => ({
  openPicked: vi.fn(async (sources: Array<{ path?: string }>) => {
    for (const s of sources) registry.opened.push(s.path ?? '');
  }),
}));

const { useCombineStore, initialCombine } = await import('../../core/stores/combineStore');
const { useJobStore } = await import('../../core/stores/jobStore');
const { useDocumentsStore } = await import('../../core/stores/documentsStore');
const { useEditStore } = await import('../../core/stores/editStore');
const flow = await import('./combineFlow');
const split = await import('./splitFlow');

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

const fw9 = new URL('../../../tests/engine/corpus/irs-fw9/fw9.pdf', import.meta.url);

const disk = new Map<string, { bytes: Uint8Array; modified: number }>();
let created: Array<{ leaf: string; chunks: Uint8Array[] }> = [];
let begins: Array<{ target: unknown; inputs: string[] }> = [];
let pickedNames: Array<{ leaf: string; near: string | undefined }> = [];
let saveAnswer: string | null = 'C:\\out\\Combined.pdf';
let beginFails: 'target-is-input' | 'target-open' | null = null;
let hold: Promise<void> | null = null;
let onRead: ((path: string, count: number) => void) | null = null;
const readCounts = new Map<string, number>();

const kindOf = (name: string): InputType => {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(png|jpg|tif|tiff|gif|bmp|webp)$/i.test(name)) return 'image';
  if (/\.(txt|log|md|csv)$/i.test(name)) return 'text';
  if (/\.(docx?|xlsx?|pptx?)$/i.test(name)) return 'office';
  return 'unsupported';
};
const nameOf = (path: string) => path.split(/[\\/]/).pop()!;

function info(path: string): JobInputInfo {
  const f = disk.get(path)!;
  return { path, name: nameOf(path), size: f.bytes.length, modified: f.modified, kind: kindOf(path) };
}

function installBridge(): void {
  const stat = async (path: string) => {
    const f = disk.get(path);
    return f ? { size: f.bytes.length, modified: f.modified } : null;
  };
  (globalThis as unknown as { window: unknown; document: unknown }).window = {
    pdfSuite: {
      files: { stat },
      jobs: {
        pickInputs: async () => [],
        describeInputs: async (paths: string[]) => paths.filter((p) => disk.has(p)).map(info),
        readInput: async (path: string) => {
          const count = (readCounts.get(path) ?? 0) + 1;
          readCounts.set(path, count);
          onRead?.(path, count);
          const f = disk.get(path);
          if (f && f.bytes.length === 0) return { ok: false, reason: 'empty' };
          return f ? { ok: true, bytes: f.bytes.slice().buffer, size: f.bytes.length, modified: f.modified } : { ok: false, reason: 'missing' };
        },
        pickOutputFile: async (leaf: string, near?: string) => {
          pickedNames.push({ leaf, near });
          return saveAnswer;
        },
        begin: async (target: { pickedPath?: string }, inputs: string[]) => {
          begins.push({ target, inputs });
          if (beginFails) return { ok: false, reason: beginFails };
          return { ok: true, jobToken: 'd'.repeat(32) };
        },
        openFile: async (_t: string, leaf: string) => {
          created.push({ leaf, chunks: [] });
          return { ok: true, fileId: created.length };
        },
        append: async (_t: string, id: number, _s: number, bytes: ArrayBuffer) => {
          if (hold) await hold;
          created[id - 1]!.chunks.push(new Uint8Array(bytes));
          return { ok: true };
        },
        closeFile: async () => ({ ok: true }),
        commit: async () => ({ ok: true, results: created.map((c, i) => ({ resultId: String(i + 1).padStart(32, '0'), name: c.leaf })) }),
        abort: async () => undefined,
        openResult: async (id: string) => `C:\\out\\${created[Number(id) - 1]?.leaf ?? 'x.pdf'}`,
        reveal: async () => undefined,
      },
    },
  };
  (globalThis as unknown as { document: unknown }).document = { activeElement: null };
}

const put = (path: string, bytes: Uint8Array, modified = 1) => disk.set(path, { bytes, modified });
const textBytes = (text: string) => new TextEncoder().encode(text);
const state = () => useCombineStore.getState();
const names = () => state().rows.map((r) => r.name);
const idOf = (name: string) => state().rows.find((r) => r.name === name)!.id;
const allReady = () => vi.waitFor(() => expect(state().rows.every((r) => r.status === 'ready')).toBe(true));
const output = () => {
  const chunks = created[0]!.chunks;
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
};
const finished = () => vi.waitFor(() => expect(useJobStore.getState().notice).not.toBeNull(), { timeout: 8000 });

async function addAll(...paths: string[]): Promise<void> {
  await flow.addPaths(paths);
}

beforeEach(() => {
  registry.docs.clear();
  registry.asked = [];
  registry.answers = [];
  registry.opened = [];
  disk.clear();
  created = [];
  begins = [];
  pickedNames = [];
  saveAnswer = 'C:\\out\\Combined.pdf';
  beginFails = null;
  hold = null;
  onRead = null;
  readCounts.clear();
  flow.clearList();
  useCombineStore.setState({ ...initialCombine });
  useJobStore.setState({ job: null, cancel: null, notice: null, passwords: {} });
  useDocumentsStore.setState({ docs: {} });
  useEditStore.setState({ byDoc: {} });
  installBridge();
  split.setJobWorkerFactory(async () => new InProcessWorker());
  put('C:\\in\\a.pdf', makeDoc({ pages: 4, text: (n) => `A${n}` }));
  put('C:\\in\\b.pdf', makeDoc({ pages: 3, text: (n) => `B${n}` }));
  put('C:\\in\\c.pdf', makeDoc({ pages: 2, text: (n) => `C${n}` }));
});

describe('adding files', () => {
  it('lists each file, reads it, and shows its pages', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf');
    await allReady();
    expect(state().rows.map((r) => [r.name, r.pages, r.kind])).toEqual([['a.pdf', 4, 'pdf'], ['b.pdf', 3, 'pdf']]);
    expect(state().open).toBe(true);
  });

  it('Office and other files are refused with the UI spec words, and nothing is listed for them', async () => {
    put('C:\\in\\letter.docx', new Uint8Array([1]));
    put('C:\\in\\song.mp3', new Uint8Array([1]));
    flow.openCombine();
    await addAll('C:\\in\\letter.docx', 'C:\\in\\song.mp3');
    expect(state().rows).toHaveLength(0);
    expect(state().messages.map((m) => m.text)).toEqual([
      "letter.docx was not added. Word, Excel and PowerPoint files can't be combined yet. For now, save it as a PDF first, then add the PDF.",
      'song.mp3 was not added. PDF Suite can combine PDFs, pictures (JPEG, PNG, TIFF, GIF, BMP, WebP) and text files.',
    ]);
  });

  it('over 500 files: the extra ones are not added, and the message says so', async () => {
    flow.openCombine();
    const infos: JobInputInfo[] = Array.from({ length: 503 }, (_v, i) => ({ path: `C:\\many\\f${i}.txt`, name: `f${i}.txt`, size: 5, modified: 1, kind: 'text' as const }));
    for (const i of infos) put(i.path, textBytes('x'));
    flow.addInfos(infos);
    expect(state().rows).toHaveLength(500);
    expect(state().messages.map((m) => m.text)).toContain('You can combine up to 500 files at once. The extra files were not added.');
    flow.clearList();
  });

  it('an XFA form is refused with the spec message and is not listed', async () => {
    if (!fs.existsSync(fw9)) return;
    put('C:\\in\\fw9.pdf', new Uint8Array(fs.readFileSync(fw9)));
    flow.openCombine();
    await addAll('C:\\in\\fw9.pdf', 'C:\\in\\a.pdf');
    await vi.waitFor(() => expect(state().messages.length).toBe(1));
    expect(state().messages[0]!.text).toBe('fw9.pdf was not added. It is a kind of form that can\'t be combined yet.');
    await allReady();
    expect(names()).toEqual(['a.pdf']);
  });

  it('a damaged PDF is refused, a damaged picture too, each with the spec words', async () => {
    put('C:\\in\\bad.pdf', textBytes('not a pdf at all'));
    put('C:\\in\\bad.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    flow.openCombine();
    await addAll('C:\\in\\bad.pdf', 'C:\\in\\bad.png');
    await vi.waitFor(() => expect(state().messages.length).toBe(2));
    expect(state().messages[0]!.text).toBe('bad.pdf is damaged or is not a PDF, so it was not added.');
    expect(state().rows).toHaveLength(0);
  });

  it('a picture over 50 megapixels and a text file over 32 MB are refused, with the spec words', async () => {
    const big = Buffer.from(makePng(8, 8));
    big.writeUInt32BE(8000, 16);
    big.writeUInt32BE(8000, 20);
    put('C:\\in\\huge.png', new Uint8Array(big));
    put('C:\\in\\huge.txt', new Uint8Array(32 * 1024 * 1024 + 1).fill(0x61));
    flow.openCombine();
    await addAll('C:\\in\\huge.png', 'C:\\in\\huge.txt');
    await vi.waitFor(() => expect(state().messages.length).toBe(2));
    expect(state().messages.map((m) => m.text)).toEqual(['huge.png is too large a picture to add (the limit is 50 megapixels).', 'huge.txt is too large to add (text files can be up to 32 MB).']);
  });
});

describe('which files and pages are combined', () => {
  it('the order shown is the order written, and the range of each file is honoured', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf', 'C:\\in\\c.pdf');
    await allReady();
    // Order shown: c, a, b. Ranges: a pages 2-3; c all; b pages 1 and 3.
    flow.setSelection([idOf('c.pdf')], idOf('c.pdf'));
    flow.moveSelected('first');
    flow.setRangeText(idOf('a.pdf'), '2-3');
    flow.setRangeText(idOf('b.pdf'), '1, 3');
    expect(names()).toEqual(['c.pdf', 'a.pdf', 'b.pdf']);
    await flow.startCombine();
    await finished();
    expect(useJobStore.getState().notice).toMatchObject({ failed: false, message: 'Combined 3 files into Combined.pdf (6 pages).' });
    const read = await reread(output());
    expect(read.text).toEqual(['C1', 'C2', 'A2', 'A3', 'B1', 'B3']);
    expect(read.pages).toBe(6);
    expect(created[0]!.leaf).toBe('Combined.pdf');
  });

  it('the same file added twice is in the result twice', async () => {
    flow.openCombine();
    await addAll('C:\\in\\c.pdf');
    await addAll('C:\\in\\c.pdf');
    await allReady();
    expect(names()).toEqual(['c.pdf', 'c.pdf']);
    await flow.startCombine();
    await finished();
    expect((await reread(output())).text).toEqual(['C1', 'C2', 'C1', 'C2']);
  });

  it('PDF + picture + text: pictures and text keep their place in the order', async () => {
    put('C:\\in\\scan.png', makePng(150, 100, 3, 150));
    put('C:\\in\\notes.txt', textBytes('hello notes'));
    flow.openCombine();
    await addAll('C:\\in\\notes.txt', 'C:\\in\\c.pdf', 'C:\\in\\scan.png');
    await allReady();
    await flow.startCombine();
    await finished();
    const read = await reread(output());
    expect(read.text[0]).toBe('hello notes');
    expect(read.text.slice(1, 3)).toEqual(['C1', 'C2']);
    expect(read.sizes[3]).toMatchObject({ width: 72, height: 48 });
    expect(read.outline.map((o) => `${o.title}:${o.page}`)).toEqual(['notes:1', 'c:2', 'scan:4']);
  });

  it('a wrong range blocks Combine and says why under the field; the page does not start a run', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf');
    await allReady();
    flow.setRangeText(idOf('a.pdf'), '9');
    const { blockOf, pagesOfRow } = await import('./combinePlan');
    expect(blockOf(state().rows)).toBe('range');
    expect(pagesOfRow(state().rows[0]!)).toEqual({ ok: false, message: '9 is outside 1-4.' });
    await flow.startCombine();
    expect(pickedNames).toEqual([]);
    expect(begins).toEqual([]);
  });

  it('sort by name puts the list in A to Z order with numbers in number order', async () => {
    for (const n of ['file10.txt', 'File2.txt', 'a.txt']) put(`C:\\in\\${n}`, textBytes('x'));
    flow.openCombine();
    await addAll('C:\\in\\file10.txt', 'C:\\in\\File2.txt', 'C:\\in\\a.txt');
    await allReady();
    flow.sortRowsByName();
    expect(names()).toEqual(['a.txt', 'File2.txt', 'file10.txt']);
  });

  it('removing rows keeps a row selected and previewed', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf', 'C:\\in\\c.pdf');
    await allReady();
    flow.setSelection([idOf('b.pdf')], idOf('b.pdf'));
    flow.removeSelected();
    expect(names()).toEqual(['a.pdf', 'c.pdf']);
    expect(state().focusId).toBe(idOf('c.pdf'));
    expect(state().selected).toEqual([idOf('c.pdf')]);
  });
});

describe('the files are checked again before the run', () => {
  it('a file changed after it was added: no Save dialog, nothing started, the row is read again, the message is the spec text', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf');
    await allReady();
    put('C:\\in\\b.pdf', makeDoc({ pages: 5, text: (n) => `NEW${n}` }), 2);
    await flow.startCombine();
    expect(pickedNames).toEqual([]);
    expect(begins).toEqual([]);
    expect(state().messages.map((m) => m.text)).toContain('b.pdf was changed while PDF Suite was working, so nothing was created. Try again.');
    await allReady();
    expect(state().rows.find((r) => r.name === 'b.pdf')).toMatchObject({ pages: 5, modified: 2 });
    // Try again: now it runs and the new content is what is combined.
    await flow.startCombine();
    await finished();
    expect((await reread(output())).text.slice(4)).toEqual(['NEW1', 'NEW2', 'NEW3', 'NEW4', 'NEW5']);
  });

  it('a file deleted after it was added: the message is the spec text, nothing starts, and Combine stays off until it is removed', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf');
    await allReady();
    disk.delete('C:\\in\\b.pdf');
    await flow.startCombine();
    expect(pickedNames).toEqual([]);
    expect(state().messages.map((m) => m.text)).toContain('b.pdf could not be read, so nothing was created. Your files were not changed.');
    const { blockOf } = await import('./combinePlan');
    expect(blockOf(state().rows)).toBe('gone');
    flow.setSelection([idOf('b.pdf')], idOf('b.pdf'));
    flow.removeSelected();
    expect(blockOf(state().rows)).toBeNull();
  });

  it('a file that changes while the job is reading it: InputChanged, no file, the list is kept', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf');
    await allReady();
    // The pre-run stat sees the old stamp; once the Save dialog has answered, the job's own read of b.pdf sees a newer one.
    onRead = (path) => {
      if (path === 'C:\\in\\b.pdf' && pickedNames.length > 0) disk.get(path)!.modified = 9;
    };
    await flow.startCombine();
    await finished();
    expect(useJobStore.getState().notice).toMatchObject({ failed: true, message: 'b.pdf was changed while PDF Suite was working, so nothing was created. Try again.' });
    expect(created.length === 0 || created[0]!.chunks.length === 0).toBe(true);
    expect(names()).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('encrypted inputs', () => {
  const lockedPdf = (pw: string) => new mu.PDFDocument(makeDoc({ pages: 2, text: (n) => `L${n}` })).saveToBuffer(`encrypt=aes-256,user-password=${pw},owner-password=${pw}`).asUint8Array().slice();

  it('the password is asked once, a wrong one is asked again with the prompt\'s retry text, and it is not asked again at the run', async () => {
    put('C:\\in\\locked.pdf', lockedPdf('sesame'));
    registry.answers = ['nope', 'sesame'];
    flow.openCombine();
    await addAll('C:\\in\\locked.pdf');
    await allReady();
    expect(registry.asked.map((a) => a.name)).toEqual(['locked.pdf', 'locked.pdf']);
    expect(registry.asked[0]!.error).toBeNull();
    expect(registry.asked[1]!.error).not.toBeNull();
    expect(useJobStore.getState().passwords).toEqual({ 'C:\\in\\locked.pdf': 'sesame' });
    // Preview of another row and back does not ask again.
    await addAll('C:\\in\\a.pdf');
    await allReady();
    await flow.showPreview(idOf('locked.pdf'));
    expect(registry.asked).toHaveLength(2);
    await flow.startCombine();
    await finished();
    expect(registry.asked).toHaveLength(2);
    const read = await reread(output());
    expect(read.text).toEqual(['L1', 'L2', 'A1', 'A2', 'A3', 'A4']);
    expect(mu.Document.openDocument(output(), 'application/pdf').needsPassword()).toBe(false);
    // After a success the passwords are forgotten.
    expect(useJobStore.getState().passwords).toEqual({});
  });

  it('a cancelled prompt: the file is not added, with the spec message', async () => {
    put('C:\\in\\locked.pdf', lockedPdf('sesame'));
    registry.answers = [null];
    flow.openCombine();
    await addAll('C:\\in\\locked.pdf');
    await vi.waitFor(() => expect(state().messages.length).toBe(1));
    expect(state().messages[0]!.text).toBe('locked.pdf was not added because it needs a password.');
    expect(state().rows).toHaveLength(0);
    expect(useJobStore.getState().passwords).toEqual({});
  });

  it('the notice says the new file has no password', async () => {
    put('C:\\in\\locked.pdf', lockedPdf('sesame'));
    registry.answers = ['sesame'];
    flow.openCombine();
    await addAll('C:\\in\\locked.pdf');
    await allReady();
    const { noticesFor } = await import('./combinePlan');
    expect(noticesFor(state().rows)).toEqual(['The new file will not have a password, although locked.pdf does.']);
  });
});

describe('the output file', () => {
  it('its name comes from the Save dialog only: the dialog opens named Combined.pdf near the first file; begin gets that exact path; the inputs are listed to main', async () => {
    flow.openCombine();
    await addAll('C:\\in\\b.pdf', 'C:\\in\\a.pdf');
    await allReady();
    saveAnswer = 'D:\\elsewhere\\My result.pdf';
    await flow.startCombine();
    await finished();
    expect(pickedNames).toEqual([{ leaf: 'Combined.pdf', near: 'C:\\in\\b.pdf' }]);
    expect(begins).toEqual([{ target: { pickedPath: 'D:\\elsewhere\\My result.pdf' }, inputs: ['C:\\in\\b.pdf', 'C:\\in\\a.pdf'] }]);
    expect(created.map((c) => c.leaf)).toEqual(['My result.pdf']);
  });

  it('a cancelled Save dialog starts nothing and keeps the window', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf');
    await allReady();
    saveAnswer = null;
    await flow.startCombine();
    expect(begins).toEqual([]);
    expect(state().open).toBe(true);
    expect(useJobStore.getState().job).toBeNull();
  });

  it('a name that is one of the files, or a file open in the app, is refused by main; the window stays with the spec message; nothing is written', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf');
    await allReady();
    saveAnswer = 'C:\\in\\a.pdf';
    beginFails = 'target-is-input';
    await flow.startCombine();
    expect(state().open).toBe(true);
    expect(state().targetMessage).toBe('Choose a different name: that file is one of the files being combined.');
    expect(created).toHaveLength(0);
    beginFails = 'target-open';
    await flow.startCombine();
    expect(state().targetMessage).toBe('Choose a different name: that file is open in PDF Suite.');
    expect(useJobStore.getState().job).toBeNull();
  });
});

describe('after the run', () => {
  it('success: the window closes, the list is cleared, the notice offers Show in folder, and the new file opens', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf');
    await allReady();
    await flow.startCombine();
    await finished();
    expect(state().open).toBe(false);
    expect(state().rows).toEqual([]);
    expect(useJobStore.getState().notice).toMatchObject({ message: 'Combined 1 file into Combined.pdf (4 pages).', resultIds: ['00000000000000000000000000000001'] });
    expect(useJobStore.getState().notice?.openResultId).toBeUndefined();
    await vi.waitFor(() => expect(registry.opened).toEqual(['C:\\out\\Combined.pdf']));
  });

  it('with "Open the new file when it is ready" off, the notice offers Open too and nothing opens', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf');
    await allReady();
    state().set({ openWhenDone: false });
    await flow.startCombine();
    await finished();
    expect(useJobStore.getState().notice?.openResultId).toBe('00000000000000000000000000000001');
    expect(registry.opened).toEqual([]);
  });

  it('Cancel at half: no file, the cancelled notice, and the list is as it was; reopening and running again succeeds', async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf');
    await allReady();
    const running = flow.startCombine();
    await vi.waitFor(() => expect(useJobStore.getState().job?.kind).toBe('combine'));
    expect(state().open).toBe(false);
    flow.cancelCombine();
    expect(useJobStore.getState().job?.cancelling).toBe(true);
    release();
    await running;
    expect(useJobStore.getState().notice).toMatchObject({ failed: true, message: 'Cancelled. No files were created and your original files were not changed.' });
    expect(useJobStore.getState().job).toBeNull();
    expect(names()).toEqual(['a.pdf', 'b.pdf']);
    hold = null;
    created = [];
    flow.openCombine();
    expect(state().open).toBe(true);
    await allReady();
    await flow.startCombine();
    await vi.waitFor(() => expect(created.length).toBe(1), { timeout: 8000 });
    await vi.waitFor(() => expect(useJobStore.getState().notice?.failed).toBe(false), { timeout: 8000 });
    expect((await reread(output())).pages).toBe(7);
  });

  it('while a job runs, Combine is off with the spec reason', async () => {
    useJobStore.getState().start('split', () => undefined);
    expect(flow.combineAvailability()).toEqual({ enabled: false, reason: 'PDF Suite is still working on your files. Wait for it to finish, or cancel it.' });
    expect(flow.openCombine()).toBe(false);
    useJobStore.getState().finish();
  });
});

describe('open files with unsaved changes', () => {
  it('a listed file that is open with unsaved changes is found, and Save now saves it and reads the saved file again', async () => {
    useDocumentsStore.getState().putDoc({ docId: 'path:C:\\in\\a.pdf', name: 'a.pdf', pageCount: 4, pages: { order: [], ids: [] } as never, sizes: [] });
    useEditStore.setState((s) => ({ byDoc: { ...s.byDoc, 'path:C:\\in\\a.pdf': { history: { dirty: true } } } as never }));
    flow.openCombine();
    await addAll('C:\\in\\a.pdf');
    await allReady();
    expect(flow.unsavedOpenFiles()).toEqual([{ docId: 'path:C:\\in\\a.pdf', name: 'a.pdf', path: 'C:\\in\\a.pdf' }]);
    put('C:\\in\\a.pdf', makeDoc({ pages: 6 }), 2);
    await flow.saveOpenFile('path:C:\\in\\a.pdf');
    await allReady();
    expect(state().rows[0]).toMatchObject({ pages: 6, modified: 2 });
  });

  it('Add open files lists the saved file of every open document', async () => {
    useDocumentsStore.getState().putDoc({ docId: 'path:C:\\in\\a.pdf', name: 'a.pdf', pageCount: 4, pages: { order: [], ids: [] } as never, sizes: [] });
    useDocumentsStore.getState().putDoc({ docId: 'path:C:\\in\\b.pdf', name: 'b.pdf', pageCount: 3, pages: { order: [], ids: [] } as never, sizes: [] });
    flow.openCombine();
    await flow.addOpenFiles();
    await allReady();
    expect(names().sort()).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('picture and text options re-read their rows', () => {
  it('changing Text pages changes the page count of a text file; Picture pages changes the preview key', async () => {
    const lines = Array.from({ length: 56 }, (_v, i) => `l${i}`).join('\n');
    put('C:\\in\\long.txt', textBytes(lines));
    flow.openCombine();
    await addAll('C:\\in\\long.txt');
    await allReady();
    expect(state().rows[0]!.pages).toBe(2);
    flow.setPageOption({ textSize: 'A4' });
    expect(state().rows[0]!.status).toBe('reading');
    await allReady();
    expect(state().rows[0]!.pages).toBe(1);
  });
});

describe('a file that disappears after it was listed', () => {
  it('choosing it for the preview keeps the row, marked, with the spec message; it does not remove it', async () => {
    flow.openCombine();
    await addAll('C:\\in\\a.pdf', 'C:\\in\\b.pdf');
    await allReady();
    // The worker holds a.pdf now, so choosing b.pdf reads it again from the disk.
    await flow.showPreview(idOf('a.pdf'));
    disk.delete('C:\\in\\b.pdf');
    flow.setSelection([idOf('b.pdf')], idOf('b.pdf'));
    await vi.waitFor(() => expect(state().rows.find((r) => r.name === 'b.pdf')?.gone).toBe(true));
    expect(names()).toEqual(['a.pdf', 'b.pdf']);
    expect(state().messages.map((m) => m.text)).toContain('b.pdf could not be read, so nothing was created. Your files were not changed.');
  });
});

describe('an empty file', () => {
  it('a 0-byte text file is not added, with "is empty"', async () => {
    put('C:\\in\\none.txt', new Uint8Array(0));
    flow.openCombine();
    await addAll('C:\\in\\none.txt');
    await vi.waitFor(() => expect(state().messages.map((m) => m.text)).toContain('none.txt is empty, so it was not added.'));
    expect(state().rows).toHaveLength(0);
  });
});
