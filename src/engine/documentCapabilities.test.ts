// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MupdfDocument } from './mupdf/mupdfDocument';
import { WorkerClient } from './mupdf/client';
import { PdfjsDocument } from './pdfjs/pdfjsDocument';

/** A worker that never answers. The capability is a property of the class, so no request is needed. */
function silentWorker(): Worker {
  return { onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined } as unknown as Worker;
}

describe('document capabilities', () => {
  it('a MuPDF document can be edited', () => {
    const doc = new MupdfDocument(new WorkerClient(silentWorker()), { pages: 1, encrypted: false });
    expect(doc.capabilities).toEqual({ canEdit: true, htmlLayer: false });
  });

  it('a MuPDF document opened from a file over the edit limit is view-only: canEdit is false and viewOnly says why', () => {
    const doc = new MupdfDocument(new WorkerClient(silentWorker()), { pages: 1, encrypted: false, viewOnly: true });
    expect(doc.capabilities).toEqual({ canEdit: false, htmlLayer: false, viewOnly: true });
  });

  it('a pdf.js document (XFA form or corrupt-file retry) is read-only', () => {
    const doc = new PdfjsDocument({ numPages: 1 } as never, false);
    expect(doc.capabilities).toEqual({ canEdit: false, htmlLayer: false });
  });
});

describe('pdf.js HTML layer', () => {
  it('a document opened without XFA has no HTML layer, and builds none', async () => {
    const doc = new PdfjsDocument({ numPages: 1 } as never, false);
    expect(doc.capabilities.htmlLayer).toBe(false);
    // Nothing is loaded for a document without XFA: the layer resolves to null before any page is read.
    await expect(doc.renderHtmlLayer(0, {} as HTMLElement, { scale: 1, rotation: 0 })).resolves.toBeNull();
  });

  it('an XFA document reports an HTML layer, and read-only capabilities otherwise', () => {
    const doc = new PdfjsDocument({ numPages: 1 } as never, false, { xfa: true });
    expect(doc.capabilities).toEqual({ canEdit: false, htmlLayer: true });
  });
});
