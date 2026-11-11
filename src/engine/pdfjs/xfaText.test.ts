// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfjsDocument } from './pdfjsDocument';
import { xfaTextRuns, type XfaNode } from './xfaText';

const corpus = (name: string) => fileURLToPath(new URL(`../../../tests/engine/corpus/${name}`, import.meta.url));

describe('xfaTextRuns', () => {
  it('places a text value in its nearest sized ancestor, with positions accumulated down the tree', () => {
    const tree: XfaNode = {
      name: 'div',
      attributes: { style: { left: '10px', top: '20px', width: '300px', height: '100px' } },
      children: [
        {
          name: 'div',
          attributes: { style: { left: '5px', top: '6px' } },
          children: [{ name: 'p', value: 'Hello sponsor', attributes: { style: { fontSize: '8px' } } }],
        },
      ],
    };
    const [run] = xfaTextRuns(tree);
    expect(run!.text).toBe('Hello sponsor');
    // The sized ancestor is the box: its own position (10, 20), its bottom edge at 120, and its width.
    expect(run!.origin.x).toBeCloseTo(10, 3);
    expect(run!.origin.y).toBeCloseTo(120, 3);
    expect(run!.along.x).toBe(300);
    expect(run!.up.y).toBeLessThan(0);
  });

  it('skips whitespace-only values', () => {
    const tree: XfaNode = { name: 'div', attributes: { style: { width: '10px', height: '10px' } }, children: [{ name: 'span', value: '   ' }] };
    expect(xfaTextRuns(tree)).toEqual([]);
  });
});

// The XFA form is not redistributable (scripts/download-test-corpus.mjs); skipped when it is absent.
describe.skipIf(!existsSync(corpus('xfa/xfa_filled_imm1344e.pdf')))('XFA page text on the corpus form', () => {
  it('reads the form text of an XFA page, so search finds words that only the form has', async () => {
    const data = new Uint8Array(readFileSync(corpus('xfa/xfa_filled_imm1344e.pdf')));
    const pdf = await pdfjs.getDocument({ data: data.slice(), enableXfa: true, isEvalSupported: false, verbosity: 0 } as never).promise;
    const fallback = await pdfjs.getDocument({ data: data.slice(), enableXfa: false, isEvalSupported: false, verbosity: 0 } as never).promise;
    const doc = new PdfjsDocument(pdf as never, false, { xfa: true, fallback: fallback as never });
    const runs = await doc.pageText(0, 0);
    const sponsor = runs.filter((run) => /sponsor/i.test(run.text));
    expect(sponsor.length).toBeGreaterThanOrEqual(5);
    for (const run of sponsor) expect(run.along.x).toBeGreaterThan(0);
    await doc.destroy();
  }, 120000);
});
