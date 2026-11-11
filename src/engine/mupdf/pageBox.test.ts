// @vitest-environment node
// Page size = CropBox intersected with MediaBox, with /Rotate and /UserUnit applied. MuPDF and pdf.js must agree.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Mu from 'mupdf';
// pdf.js creates a DOMMatrix at module load. Parsing never uses it, so a placeholder is enough here.
vi.hoisted(() => {
  if (!('DOMMatrix' in globalThis)) (globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrixStub {};
});

import { MupdfCore } from './core';

/** A one-page PDF with the given entries in its page dictionary. The xref offsets are computed, so it opens cleanly. */
export function minimalPdf(pageEntries: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R ${pageEntries} >>`,
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  // The /ID keeps pdf.js from hashing the file, whose hash helper does not run under Node.
  const id = '<0123456789abcdef0123456789abcdef>';
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /ID [${id} ${id}] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

let mu: typeof Mu;
let wasm: unknown;

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../node_modules/mupdf/dist/mupdf-wasm.wasm', import.meta.url));
  const compiled = await WebAssembly.compile(readFileSync(wasmPath));
  const host = globalThis as unknown as { $libmupdf_wasm_Module?: unknown };
  host.$libmupdf_wasm_Module = {
    instantiateWasm(imports: WebAssembly.Imports, ready: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(compiled, imports).then((instance) => ready(instance, compiled));
      return {};
    },
  };
  mu = (await import('mupdf')) as typeof Mu;
  wasm = host.$libmupdf_wasm_Module;
}, 60000);

interface PdfPage {
  rotate: number;
  getViewport(options: { scale: number }): { width: number; height: number };
}

async function sizesOf(bytes: Uint8Array): Promise<{ mupdf: number[]; pdfjs: { width: number; height: number; rotation: number } }> {
  const core = new MupdfCore(mu, wasm);
  core.open(bytes, undefined);
  const [w = 0, h = 0, rot = 0] = core.sizes(0, 1);
  core.close();
  // The legacy build runs under Node; the default build needs browser crypto helpers.
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
  const lib = (await import(specifier)) as {
    getDocument(options: object): { promise: Promise<{ getPage(n: number): Promise<PdfPage> }> };
  };
  const pdf = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  return { mupdf: [w, h, rot], pdfjs: { width: viewport.width, height: viewport.height, rotation: page.rotate } };
}

describe('page size matches between engines', () => {
  it('uses the CropBox when it is smaller than the MediaBox', async () => {
    const result = await sizesOf(minimalPdf('/MediaBox [0 0 300 400] /CropBox [50 60 250 360]'));
    expect(result.mupdf.slice(0, 2)).toEqual([200, 300]);
    expect(result.pdfjs.width).toBeCloseTo(200, 3);
    expect(result.pdfjs.height).toBeCloseTo(300, 3);
  });

  it('clips a CropBox larger than the MediaBox to the MediaBox', async () => {
    const result = await sizesOf(minimalPdf('/MediaBox [0 0 300 400] /CropBox [0 0 500 600]'));
    expect(result.mupdf.slice(0, 2)).toEqual([300, 400]);
    expect(result.pdfjs.width).toBeCloseTo(300, 3);
    expect(result.pdfjs.height).toBeCloseTo(400, 3);
  });

  it('applies /Rotate and /UserUnit to the cropped size', async () => {
    const result = await sizesOf(minimalPdf('/MediaBox [0 0 300 400] /CropBox [50 60 250 360] /Rotate 90 /UserUnit 2'));
    expect(result.mupdf).toEqual([600, 400, 90]);
    expect(result.pdfjs.width).toBeCloseTo(600, 3);
    expect(result.pdfjs.height).toBeCloseTo(400, 3);
    expect(result.pdfjs.rotation).toBe(90);
  });
});
