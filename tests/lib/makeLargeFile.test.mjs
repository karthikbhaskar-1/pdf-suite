// @vitest-environment node
// The generator of the 1.5.10 file-size fixtures: a valid PDF of an exact size, with real pages, written fast. Tested at small sizes;
// the big files themselves are never committed.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { makeLargeFile } from './makeLargeFile.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-makelarge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('makeLargeFile', () => {
  it.each([20_000, 1_000_000, 3 * 1024 * 1024 + 1, 9_999_999, 10_000_000])('writes exactly %d bytes', (bytes) => {
    const file = makeLargeFile({ path: join(dir, `f-${bytes}.pdf`), bytes, pages: 5 });
    expect(file.bytes).toBe(bytes);
    expect(statSync(file.path).size).toBe(bytes);
  });

  it('is a valid PDF with its pages and its text, and needs no repair', () => {
    const file = makeLargeFile({ path: join(dir, 'valid.pdf'), bytes: 5 * 1024 * 1024, pages: 7, word: 'needleword' });
    const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(file.path)), 'application/pdf');
    expect(doc.countPages()).toBe(7);
    const text = doc.loadPage(2).toStructuredText('preserve-whitespace').asText();
    expect(text).toContain('needleword page 3');
    expect(doc.asPDF().wasRepaired()).toBe(false);
  });

  it('refuses a size too small for its pages', () => {
    expect(() => makeLargeFile({ path: join(dir, 'tiny.pdf'), bytes: 100, pages: 5 })).toThrow(/too small/);
  });
});
