// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
// pdf.js creates a DOMMatrix at module load. Node has none, and parsing never uses it,
// so a placeholder is enough for these parse-only tests.
vi.hoisted(() => {
  if (!('DOMMatrix' in globalThis)) {
    (globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrixStub {};
  }
});

import { PdfOpenError } from './errors';
import { precheckBytes } from './precheck';
import { classifyPdfjsError } from './pdfjs/classifyPdfjsError';
import { pdfjsEngine } from './pdfjs/pdfjsEngine';

/** A small but complete PDF, built as text so the xref offsets are right. */
function buildPdf(): string {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xref = body.length;
  body += `xref\n0 4\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  body += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

describe('precheckBytes', () => {
  it('reports empty bytes', () => {
    expect(precheckBytes(new Uint8Array(0))?.kind).toBe('Empty');
  });

  it('reports bytes without the PDF signature', () => {
    expect(precheckBytes(new TextEncoder().encode('hello world'))?.kind).toBe('NotPdf');
  });

  it('accepts bytes that start with the signature', () => {
    expect(precheckBytes(new TextEncoder().encode(buildPdf()))).toBeNull();
  });
});

describe('classifyPdfjsError', () => {
  it('maps pdf.js password codes to the typed errors', () => {
    const need = Object.assign(new Error('need'), { name: 'PasswordException', code: 1 });
    const wrong = Object.assign(new Error('wrong'), { name: 'PasswordException', code: 2 });
    expect(classifyPdfjsError(need, false).kind).toBe('PasswordNeeded');
    expect(classifyPdfjsError(need, true).kind).toBe('WrongPassword');
    expect(classifyPdfjsError(wrong, true).kind).toBe('WrongPassword');
  });

  it('treats any other failure as damage', () => {
    const broken = Object.assign(new Error('bad'), { name: 'InvalidPDFException' });
    const result = classifyPdfjsError(broken, false);
    expect(result).toBeInstanceOf(PdfOpenError);
    expect(result.kind).toBe('Corrupt');
  });
});

describe('pdf.js open of a truncated file', () => {
  it('reports a truncated PDF as damaged', async () => {
    const full = buildPdf();
    // Cut the file in the middle of the object section, so the cross-reference table is gone.
    const truncated = new TextEncoder().encode(full.slice(0, Math.floor(full.length / 3)));
    const error = await pdfjsEngine
      .open({ kind: 'bytes', name: 'cut.pdf', bytes: truncated }, {})
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(PdfOpenError);
    expect((error as PdfOpenError).kind).toBe('Corrupt');
  });
});
