import { describe, expect, it, vi } from 'vitest';
import { DocumentRegistry, defaultHasher } from './documentRegistry';
import { PdfOpenError } from './errors';
import type { DocumentSource, EngineDocument, PdfEngine } from './types';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% fake document\n%%EOF');

/** A stand-in engine that counts opens and destroys. It never touches pdf.js. */
function fakeEngine(pageCount = 3) {
  const destroyed: number[] = [];
  let opens = 0;
  const engine: PdfEngine = {
    open: vi.fn(async () => {
      const id = ++opens;
      const doc: EngineDocument = {
        pageCount,
        pageSize: async () => ({ width: 612, height: 792 }),
        renderBitmap: async () => {
          throw new Error('not used');
        },
        renderTextLayer: async () => () => undefined,
        pageText: async () => [],
        outline: async () => [],
        metadata: async () => ({}),
        isEncrypted: false,
        capabilities: { canEdit: false, htmlLayer: false },
        destroy: async () => {
          destroyed.push(id);
        },
      };
      return doc;
    }),
  };
  return { engine, destroyed, opens: () => opens };
}

const bytesSource = (bytes: Uint8Array = PDF_BYTES): DocumentSource => ({ kind: 'bytes', name: 'a.pdf', bytes });

/** Hash that reads the content as text, so tests can make two files equal or different. */
const hashContent = async (source: DocumentSource) =>
  source.kind === 'bytes' ? `h${new TextDecoder().decode(source.bytes)}` : `p${source.path}`;

describe('DocumentRegistry refcounting', () => {
  it('opens a file once and shares the handle between references', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine, hashContent);

    const first = await registry.acquire(bytesSource());
    const second = await registry.acquire(bytesSource());

    expect(second).toBe(first);
    expect(opens()).toBe(1);
    expect(registry.refCount(first.docId)).toBe(2);
    expect(first.pageCount).toBe(3);
  });

  it('keeps the document open until the last reference is released', async () => {
    const { engine, destroyed } = fakeEngine();
    const registry = new DocumentRegistry(engine, hashContent);
    const handle = await registry.acquire(bytesSource());
    registry.retain(handle.docId);

    registry.release(handle.docId);
    expect(destroyed).toEqual([]);
    expect(registry.get(handle.docId)).toBeDefined();

    registry.release(handle.docId);
    expect(destroyed).toEqual([1]);
    expect(registry.get(handle.docId)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('ignores release of an unknown document', () => {
    const { engine } = fakeEngine();
    const registry = new DocumentRegistry(engine, hashContent);
    expect(() => registry.release('nope')).not.toThrow();
    expect(registry.refCount('nope')).toBe(0);
  });

  it('keeps different files apart', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine, hashContent);
    const a = await registry.acquire(bytesSource(new TextEncoder().encode('%PDF-1.4 one')));
    const b = await registry.acquire(bytesSource(new TextEncoder().encode('%PDF-1.4 two')));
    expect(a.docId).not.toBe(b.docId);
    expect(opens()).toBe(2);
  });

  it('keys path sources by path and never copies bytes', async () => {
    const { engine } = fakeEngine();
    const registry = new DocumentRegistry(engine, hashContent);
    const handle = await registry.acquire({ kind: 'path', path: 'C:/x.pdf', name: 'x.pdf' });
    expect(handle.docId).toBe('pC:/x.pdf');
  });
});

describe('DocumentRegistry rekey (Save As)', () => {
  it('moves an open document to a new id, with its references, and frees the old id', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine, defaultHasher);
    const handle = await registry.acquire({ kind: 'path', name: 'a.pdf', path: 'C:\old.pdf' });
    registry.retain(handle.docId);

    expect(registry.rekey('path:C:\old.pdf', 'path:C:\new.pdf')).toBe(true);

    expect(registry.get('path:C:\new.pdf')?.doc).toBe(handle.doc);
    expect(registry.refCount('path:C:\new.pdf')).toBe(2);
    expect(registry.get('path:C:\old.pdf')).toBeUndefined();
    // The old path is free again: opening it loads the file afresh rather than sharing the saved document.
    const reopened = await registry.acquire({ kind: 'path', name: 'a.pdf', path: 'C:\old.pdf' });
    expect(reopened.doc).not.toBe(handle.doc);
    expect(opens()).toBe(2);
  });

  it('refuses a rekey onto an id that is already open, or from an id that is not open', async () => {
    const { engine } = fakeEngine();
    const registry = new DocumentRegistry(engine, defaultHasher);
    await registry.acquire({ kind: 'path', name: 'a.pdf', path: 'C:\a.pdf' });
    await registry.acquire({ kind: 'path', name: 'b.pdf', path: 'C:\b.pdf' });

    expect(registry.rekey('path:C:\a.pdf', 'path:C:\b.pdf')).toBe(false);
    expect(registry.rekey('path:C:\missing.pdf', 'path:C:\c.pdf')).toBe(false);
    expect(registry.get('path:C:\a.pdf')).toBeDefined();
  });

  it('tells the app about the move, so the page list follows the new id', async () => {
    const { engine } = fakeEngine();
    const moved: string[] = [];
    const registry = new DocumentRegistry(engine, defaultHasher, undefined, (oldId, newId) => moved.push(`${oldId}>${newId}`));
    await registry.acquire({ kind: 'path', name: 'a.pdf', path: 'C:\a.pdf' });
    registry.rekey('path:C:\a.pdf', 'path:C:\b.pdf');
    expect(moved).toEqual(['path:C:\a.pdf>path:C:\b.pdf']);
  });
});

describe('DocumentRegistry error classification', () => {
  it('rejects empty bytes as Empty without opening anything', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine, hashContent);
    await expect(registry.acquire(bytesSource(new Uint8Array(0)))).rejects.toMatchObject({ kind: 'Empty' });
    expect(opens()).toBe(0);
  });

  it('rejects random bytes as NotPdf without opening anything', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine, hashContent);
    const random = new Uint8Array(4096).map((_, i) => (i * 131 + 7) % 251);
    const error = await registry.acquire(bytesSource(random)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfOpenError);
    expect((error as PdfOpenError).kind).toBe('NotPdf');
    expect(opens()).toBe(0);
  });
});

describe('one file under two spellings is one document (1.5.1 review, R10)', () => {
  const pathSource = (path: string): DocumentSource => ({ kind: 'path', name: 'a.pdf', path });

  it('C:\\Docs\\A.pdf and c:\\docs\\a.pdf share one handle: one engine open, two references, the first spelling is the id', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const first = await registry.acquire(pathSource('C:\\Docs\\A.pdf'));
    const second = await registry.acquire(pathSource('c:\\docs\\a.pdf'));
    expect(second).toBe(first);
    expect(second.docId).toBe('path:C:\\Docs\\A.pdf');
    expect(opens()).toBe(1);
    expect(registry.refCount(first.docId)).toBe(2);
    expect(registry.get('path:c:\\docs\\a.pdf')).toBeUndefined();
  });

  it('other spellings join too: forward slashes, a dot part, a trailing separator', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const first = await registry.acquire(pathSource('C:\\Docs\\A.pdf'));
    for (const spelling of ['C:/Docs/A.pdf', 'C:\\Docs\\.\\A.pdf', 'C:\\Docs\\Other\\..\\A.pdf']) {
      expect((await registry.acquire(pathSource(spelling))).docId, spelling).toBe(first.docId);
    }
    expect(opens()).toBe(1);
  });

  it('two opens of two spellings at the same time still make one document', async () => {
    const { engine, destroyed, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const [a, b] = await Promise.all([registry.acquire(pathSource('C:\\Docs\\A.pdf')), registry.acquire(pathSource('c:\\docs\\a.pdf'))]);
    expect(b.docId).toBe(a.docId);
    expect(registry.refCount(a.docId)).toBe(2);
    expect(opens() - destroyed.length).toBe(1);
  });

  it('a different file is a different document, and the file frees only when every spelling has been released', async () => {
    const { engine, destroyed } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const a = await registry.acquire(pathSource('C:\\Docs\\A.pdf'));
    await registry.acquire(pathSource('c:\\docs\\a.pdf'));
    const other = await registry.acquire(pathSource('C:\\Docs\\B.pdf'));
    expect(other.docId).not.toBe(a.docId);
    registry.release(a.docId);
    expect(destroyed).toEqual([]);
    registry.release(a.docId);
    expect(destroyed).toHaveLength(1);
    expect(registry.get(other.docId)).toBeDefined();
  });

  it('sameFileId answers the id an open spelling has, or the asked id when nothing is open', async () => {
    const { engine } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    expect(registry.sameFileId('path:c:\\docs\\a.pdf')).toBe('path:c:\\docs\\a.pdf');
    await registry.acquire(pathSource('C:\\Docs\\A.pdf'));
    expect(registry.sameFileId('path:c:\\docs\\a.pdf')).toBe('path:C:\\Docs\\A.pdf');
    expect(registry.sameFileId('path:C:\\Docs\\B.pdf')).toBe('path:C:\\Docs\\B.pdf');
  });
});

describe('DocumentRegistry suspend and resume (1.5.4: a background tab ends its engine)', () => {
  const source: DocumentSource = { kind: 'path', name: 'a.pdf', path: 'C:\\Docs\\A.pdf' };

  it('suspend ends the engine, keeps the entry and its references, and hides the handle', async () => {
    const { engine, destroyed } = fakeEngine();
    const closed = vi.fn();
    const registry = new DocumentRegistry(engine, defaultHasher, undefined, undefined, closed);
    const handle = await registry.acquire(source);
    await registry.acquire(source);
    expect(registry.suspend(handle.docId)).toBe(true);
    expect(destroyed).toEqual([1]);
    expect(registry.get(handle.docId)).toBeUndefined();
    expect(registry.isSuspended(handle.docId)).toBe(true);
    expect(registry.refCount(handle.docId)).toBe(2);
    expect(registry.size).toBe(1);
    expect(closed).not.toHaveBeenCalled();
    expect(registry.suspend(handle.docId)).toBe(false);
    // Another spelling of the file is still the same document.
    expect(registry.sameFileId('path:c:\\docs\\a.pdf')).toBe(handle.docId);
  });

  it('resume opens the file again under the same id with the same references, and reports it as opened', async () => {
    const { engine, opens, destroyed } = fakeEngine(4);
    const opened = vi.fn();
    const registry = new DocumentRegistry(engine, defaultHasher, opened);
    const first = await registry.acquire(source);
    registry.suspend(first.docId);
    opened.mockClear();
    const again = await registry.resume(first.docId, source);
    expect(opens()).toBe(2);
    expect(again.docId).toBe(first.docId);
    expect(again.doc).not.toBe(first.doc);
    expect(registry.get(first.docId)).toBe(again);
    expect(registry.refCount(first.docId)).toBe(1);
    expect(opened).toHaveBeenCalledWith(first.docId, again.doc);
    expect(registry.isSuspended(first.docId)).toBe(false);
    expect(destroyed).toEqual([1]);
  });

  it('two resumes at once open the file once', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const first = await registry.acquire(source);
    registry.suspend(first.docId);
    const [a, b] = await Promise.all([registry.resume(first.docId, source), registry.resume(first.docId, source)]);
    expect(a).toBe(b);
    expect(opens()).toBe(2);
  });

  it('a resume of a document that is not suspended changes nothing', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const first = await registry.acquire(source);
    expect(await registry.resume(first.docId, source)).toBe(first);
    expect(opens()).toBe(1);
  });

  it('a failed resume leaves the document suspended, ready to try again', async () => {
    const { engine } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const first = await registry.acquire(source);
    registry.suspend(first.docId);
    vi.mocked(engine.open).mockRejectedValueOnce(new PdfOpenError('Unreadable'));
    await expect(registry.resume(first.docId, source)).rejects.toThrow();
    expect(registry.isSuspended(first.docId)).toBe(true);
    expect((await registry.resume(first.docId, source)).docId).toBe(first.docId);
  });

  it('opening the same file again while it is suspended gives the new holder the live document', async () => {
    const { engine, opens } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const first = await registry.acquire(source);
    registry.suspend(first.docId);
    const second = await registry.acquire(source);
    expect(second.docId).toBe(first.docId);
    expect(opens()).toBe(2);
    expect(registry.refCount(first.docId)).toBe(2);
    expect(registry.get(first.docId)).toBe(second);
  });

  it('releasing the last reference of a suspended document closes it without ending the engine twice', async () => {
    const { engine, destroyed } = fakeEngine();
    const closed = vi.fn();
    const registry = new DocumentRegistry(engine, defaultHasher, undefined, undefined, closed);
    const first = await registry.acquire(source);
    registry.suspend(first.docId);
    registry.release(first.docId);
    expect(closed).toHaveBeenCalledWith(first.docId);
    expect(destroyed).toEqual([1]);
    expect(registry.size).toBe(0);
  });

  it('a document closed while it is being reopened is not brought back', async () => {
    const { engine, destroyed } = fakeEngine();
    const registry = new DocumentRegistry(engine);
    const first = await registry.acquire(source);
    registry.suspend(first.docId);
    const resuming = registry.resume(first.docId, source);
    registry.release(first.docId);
    await expect(resuming).rejects.toThrow('closed');
    expect(registry.size).toBe(0);
    expect(destroyed).toEqual([1, 2]);
  });
});
