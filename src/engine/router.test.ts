// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PdfOpenError } from './errors';
import { createRouter, isXfaDocument, parseEngineName, type RouterDeps } from './router';
import type { MupdfSession } from './mupdf/mupdfDocument';
import type { XfaFacts } from './mupdf/protocol';
import type { DocumentSource, EngineDocument } from './types';

const PDF = new TextEncoder().encode('%PDF-1.7\n%% test\n%%EOF');
const plain: XfaFacts = { needsRendering: false, xfaPresent: false, fieldCount: 0 };
const xfaRender: XfaFacts = { needsRendering: true, xfaPresent: true, fieldCount: 0 };
const xfaNoFields: XfaFacts = { needsRendering: false, xfaPresent: true, fieldCount: 0 };
const xfaWithFields: XfaFacts = { needsRendering: false, xfaPresent: true, fieldCount: 4 };

function fakeDocument(name: string): EngineDocument {
  return { name, pageCount: 1 } as unknown as EngineDocument;
}

function fakeSession(xfa: XfaFacts): MupdfSession & { discard: ReturnType<typeof vi.fn>; document: ReturnType<typeof vi.fn> } {
  return {
    xfa,
    bytes: PDF.slice().buffer,
    document: vi.fn(() => fakeDocument('mupdf')),
    discard: vi.fn(),
  };
}

function setup(options: { xfa?: XfaFacts; override?: 'mupdf' | 'pdfjs'; mupdfError?: unknown } = {}) {
  const session = fakeSession(options.xfa ?? plain);
  const deps = {
    readBytes: vi.fn(async (source: DocumentSource) => (source.kind === 'bytes' ? source.bytes : PDF)),
    openMupdf: vi.fn(async () => {
      if (options.mupdfError) throw options.mupdfError;
      return session;
    }),
    pdfjs: { open: vi.fn(async () => fakeDocument('pdfjs')) },
    pdfjsXfa: { open: vi.fn(async () => fakeDocument('pdfjs-xfa')) },
    override: () => options.override,
  };
  const router = createRouter(deps as unknown as RouterDeps);
  const source: DocumentSource = { kind: 'bytes', name: 'a.pdf', bytes: PDF };
  return { router, deps, session, source };
}

describe('isXfaDocument', () => {
  it('routes a catalog that asks for XFA rendering', () => {
    expect(isXfaDocument(xfaRender)).toBe(true);
  });

  it('routes an XFA form with no AcroForm fields', () => {
    expect(isXfaDocument(xfaNoFields)).toBe(true);
  });

  it('keeps an XFA form that also has fields on MuPDF, and any plain PDF', () => {
    expect(isXfaDocument(xfaWithFields)).toBe(false);
    expect(isXfaDocument(plain)).toBe(false);
  });
});

describe('engine override', () => {
  it('accepts only the two engine names', () => {
    expect(parseEngineName('mupdf')).toBe('mupdf');
    expect(parseEngineName('pdfjs')).toBe('pdfjs');
    expect(parseEngineName('pdfium')).toBeUndefined();
    expect(parseEngineName(null)).toBeUndefined();
  });
});

describe('createRouter', () => {
  it('opens an ordinary document with MuPDF and keeps it', async () => {
    const { router, deps, session, source } = setup();
    const doc = await router.open(source, {});
    expect(doc).toEqual(fakeDocument('mupdf'));
    expect(session.document).toHaveBeenCalledOnce();
    expect(deps.pdfjs.open).not.toHaveBeenCalled();
  });

  it('sends an XFA form to pdf.js with XFA support, and gives MuPDF back', async () => {
    const { router, deps, session, source } = setup({ xfa: xfaRender });
    const doc = await router.open(source, {});
    expect(doc).toEqual(fakeDocument('pdfjs-xfa'));
    expect(session.discard).toHaveBeenCalledOnce();
    expect(deps.pdfjsXfa.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bytes', name: 'a.pdf' }), {});
    expect(deps.pdfjs.open).not.toHaveBeenCalled();
  });

  it('stops at the precheck: empty and non-PDF bytes never reach an engine', async () => {
    const { router, deps } = setup();
    const empty = router.open({ kind: 'bytes', name: 'e.pdf', bytes: new Uint8Array(0) }, {});
    await expect(empty).rejects.toMatchObject({ kind: 'Empty' });
    const text = router.open({ kind: 'bytes', name: 'n.pdf', bytes: new TextEncoder().encode('hello') }, {});
    await expect(text).rejects.toMatchObject({ kind: 'NotPdf' });
    expect(deps.openMupdf).not.toHaveBeenCalled();
  });

  it('gives a corrupt file one try in pdf.js', async () => {
    const { router, deps, source } = setup({ mupdfError: new PdfOpenError('Corrupt') });
    await expect(router.open(source, {})).resolves.toEqual(fakeDocument('pdfjs'));
    expect(deps.pdfjs.open).toHaveBeenCalledOnce();
  });

  it('does not retry a wrong password in pdf.js: the error is the answer', async () => {
    const { router, deps, source } = setup({ mupdfError: new PdfOpenError('WrongPassword') });
    await expect(router.open(source, { password: 'x' })).rejects.toMatchObject({ kind: 'WrongPassword' });
    expect(deps.pdfjs.open).not.toHaveBeenCalled();
  });

  it('forced to pdf.js, opens with pdf.js and never starts MuPDF', async () => {
    const { router, deps, source } = setup({ override: 'pdfjs' });
    await expect(router.open(source, {})).resolves.toEqual(fakeDocument('pdfjs'));
    expect(deps.openMupdf).not.toHaveBeenCalled();
  });

  it('forced to MuPDF, keeps XFA forms on MuPDF and does not fall back', async () => {
    const { router, deps, session, source } = setup({ override: 'mupdf', xfa: xfaRender });
    await expect(router.open(source, {})).resolves.toEqual(fakeDocument('mupdf'));
    expect(session.discard).not.toHaveBeenCalled();
    expect(deps.pdfjsXfa.open).not.toHaveBeenCalled();

    const corrupt = setup({ override: 'mupdf', mupdfError: new PdfOpenError('Corrupt') });
    await expect(corrupt.router.open(corrupt.source, {})).rejects.toMatchObject({ kind: 'Corrupt' });
    expect(corrupt.deps.pdfjs.open).not.toHaveBeenCalled();
  });
});
