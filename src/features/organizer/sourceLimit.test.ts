// @vitest-environment node
// 1.5.10: Insert from PDF and Replace pick a source and attach it. A source over the edit limit (500 MB), or one that would take the
// document past it (the document's saved size plus the source's size), is refused BEFORE the file is read, with the reason, and
// nothing is attached or changed. Sizes are numbers: no real file.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { attach, bridge, pickPdfs } = vi.hoisted(() => ({
  attach: vi.fn(),
  pickPdfs: vi.fn(),
  bridge: { files: { read: vi.fn(), stat: vi.fn() } },
}));

vi.mock('../../app/services', () => ({ fileService: { pickPdfs }, documentRegistry: { get: () => undefined } }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(),
  attachSourceLogged: attach,
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useUiStore } from '../../core/stores/uiStore';
import { addedBytesOf, noteAdded, resetAdded } from '../documents/addedBytes';
import { attachPickedSource } from './actions';

const MB = 1024 * 1024;
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n').buffer;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const documentOfSize = (bytes: number | undefined) =>
  useDocumentsStore.setState({ docs: { doc: { docId: 'doc', name: 'a.pdf', pageCount: 1, pages: [], sizes: [], byteSize: bytes } } } as never);

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ sourcePassword: null, toasts: [] });
  documentOfSize(10 * MB);
  pickPdfs.mockResolvedValue([{ kind: 'path', path: 'C:\\in\\source.pdf', name: 'source.pdf' }]);
  bridge.files.read.mockResolvedValue({ ok: true, bytes: PDF });
  bridge.files.stat.mockResolvedValue({ size: 1 * MB, modified: 1 });
  attach.mockResolvedValue({ sourceDocId: 'src1', pages: 2 });
  resetAdded('doc');
});

describe('Insert from PDF and Replace: the source', () => {
  it('just under the limit (a 490 MB source into a 10 MB document) is read and attached', async () => {
    bridge.files.stat.mockResolvedValue({ size: 490 * MB, modified: 1 });
    await expect(attachPickedSource('doc')).resolves.toEqual({ sourceDocId: 'src1', pages: 2, name: 'source.pdf' });
    expect(bridge.files.read).toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it('just over: a source one byte over 500 MB is refused with the reason, before it is read', async () => {
    bridge.files.stat.mockResolvedValue({ size: 500 * MB + 1, modified: 1 });
    await expect(attachPickedSource('doc')).resolves.toBeNull();
    expect(bridge.files.read).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['That PDF is too large to add (the limit is 500 MB). Nothing was changed.']);
  });

  it('a source that fits alone but takes the document past 500 MB is refused with both sizes (document 300 MB + source 201 MB)', async () => {
    documentOfSize(300 * MB);
    bridge.files.stat.mockResolvedValue({ size: 201 * MB, modified: 1 });
    await expect(attachPickedSource('doc')).resolves.toBeNull();
    expect(bridge.files.read).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['That PDF is too large to add to this document: together they would be over the 500 MB limit (the document is about 300 MB and the PDF is 201 MB). Nothing was changed.']);
  });

  it('exactly at the limit by the estimate (300 MB + 200 MB) goes through', async () => {
    documentOfSize(300 * MB);
    bridge.files.stat.mockResolvedValue({ size: 200 * MB, modified: 1 });
    await expect(attachPickedSource('doc')).resolves.toMatchObject({ sourceDocId: 'src1' });
    expect(attach).toHaveBeenCalled();
  });

  it('with no stat available the size of the bytes read decides, and nothing is attached', async () => {
    bridge.files.stat.mockResolvedValue(null);
    const huge = Object.create(ArrayBuffer.prototype, { byteLength: { value: 500 * MB + 1 } }) as ArrayBuffer;
    bridge.files.read.mockResolvedValue({ ok: true, bytes: huge });
    await expect(attachPickedSource('doc')).resolves.toBeNull();
    expect(attach).not.toHaveBeenCalled();
    expect(toasts()[0]).toMatch(/too large to add/);
  });

  it('a document of unknown size checks the source alone', async () => {
    documentOfSize(undefined);
    bridge.files.stat.mockResolvedValue({ size: 499 * MB, modified: 1 });
    await expect(attachPickedSource('doc')).resolves.toMatchObject({ sourceDocId: 'src1' });
  });
});

// The sources already attached since the last save count too: two 90 MB inserts into a 400 MB document are about 580 MB, which
// cannot be saved, although each one alone fits beside the file on disk. (attachSourceLogged, which adds the bytes, is mocked here;
// it is tested for real in documents/editOpsProtected.test.ts and saveGuards.test.ts.)
describe('Insert from PDF in a row: the running total of attached sources', () => {
  /** One insert of a source of this size: the stat says so, and the attach adds its bytes, as attachSourceLogged does. */
  const insert = async (mb: number) => {
    bridge.files.stat.mockResolvedValue({ size: mb * MB, modified: 1 });
    attach.mockImplementation(async (docId: string) => {
      noteAdded(docId, mb * MB);
      return { sourceDocId: 'src', pages: 2 };
    });
    return attachPickedSource('doc');
  };

  it('two inserts: 400 MB + 90 MB is allowed, a second 90 MB is not (about 490 MB now)', async () => {
    documentOfSize(400 * MB);
    await expect(insert(90)).resolves.toMatchObject({ sourceDocId: 'src' });
    expect(addedBytesOf('doc')).toBe(90 * MB);
    toasts().length = 0;
    await expect(insert(90)).resolves.toBeNull();
    expect(toasts()).toEqual(['That PDF is too large to add to this document: together they would be over the 500 MB limit (the document is about 490 MB and the PDF is 90 MB). Nothing was changed.']);
    expect(addedBytesOf('doc')).toBe(90 * MB);
  });

  it('three inserts: 100 MB + 150 MB + 150 MB fits, the third 150 MB does not (about 400 MB now)', async () => {
    documentOfSize(100 * MB);
    await expect(insert(150)).resolves.toMatchObject({ sourceDocId: 'src' });
    await expect(insert(150)).resolves.toMatchObject({ sourceDocId: 'src' });
    await expect(insert(150)).resolves.toBeNull();
    expect(toasts().at(-1)).toMatch(/the document is about 400 MB and the PDF is 150 MB/);
  });

  it('insert, save, insert: a save starts the count again, so the second insert is allowed', async () => {
    documentOfSize(400 * MB);
    await expect(insert(90)).resolves.toMatchObject({ sourceDocId: 'src' });
    resetAdded('doc'); // what a save, a reload from disk and Discard do
    documentOfSize(490 * MB); // the saved file is now about 490 MB: the next source must fit beside it
    await expect(insert(10)).resolves.toMatchObject({ sourceDocId: 'src' });
    await expect(insert(1)).resolves.toBeNull();
  });
});
