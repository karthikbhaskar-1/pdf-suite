// @vitest-environment node
// 1.3.2: Split by file size. fitPart (pure) on simulated sizes, ReachSet, and the guarantee on real files: every part's saved
// bytes are at most the limit, except a single page that alone is over it, which is reported.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ReachSet, fitPart, guessPageCount } from './partSize';
import { JobHarness, makeDoc } from './jobTestKit';
import { reread } from '../../../tests/lib/reread.mjs';

describe('fitPart (pure)', () => {
  /** Part sizes from a table: page n costs `cost[n]`, a part costs a fixed 1000 plus its pages. */
  const sizer = (cost: number[]) => {
    const calls: Array<[number, number]> = [];
    return {
      calls,
      build: async (from: number, k: number) => {
        calls.push([from, k]);
        let size = 1000;
        for (let i = from; i < from + k; i++) size += cost[i]!;
        return { size, keep: { from, k } };
      },
    };
  };

  it('takes the guess when it fits at 90% or more, with one build', async () => {
    const s = sizer(Array(20).fill(1000));
    const r = await fitPart({ from: 0, pages: 20, maxBytes: 10_000, guess: 9, build: s.build });
    expect(r.k).toBe(9);
    expect(r.size).toBe(10_000);
    expect(s.calls).toHaveLength(1);
  });

  it('removes pages when the guess is too big, then stops at a part that fits', async () => {
    const s = sizer(Array(20).fill(1000));
    const r = await fitPart({ from: 0, pages: 20, maxBytes: 10_000, guess: 14, build: s.build });
    expect(r.size).toBeLessThanOrEqual(10_000);
    expect(r.k).toBeGreaterThanOrEqual(8);
    expect(r.k).toBeLessThanOrEqual(9);
  });

  it('tries once to take more when the guess leaves room, and keeps that only if it fits', async () => {
    const s = sizer(Array(20).fill(1000));
    const r = await fitPart({ from: 0, pages: 20, maxBytes: 10_000, guess: 3, build: s.build });
    // One attempt to take more, sized by the average page: 3 pages (4,000 bytes) plus floor(6,000 / 1,333) = 7.
    expect(r.k).toBe(7);
    // A second attempt that does not fit leaves the first result.
    const lumpy = sizer([1000, 1000, 1000, 9000, 1000, 1000]);
    const kept = await fitPart({ from: 0, pages: 6, maxBytes: 10_000, guess: 2, build: lumpy.build });
    expect(kept.size).toBeLessThanOrEqual(10_000);
    expect(kept.k).toBeGreaterThanOrEqual(2);
  });

  it('a single page that is over the limit is accepted and reported, never split', async () => {
    const s = sizer([500, 50_000, 500]);
    const r = await fitPart({ from: 1, pages: 3, maxBytes: 10_000, guess: 1, build: s.build });
    expect(r).toMatchObject({ k: 1, oversize: true });
    expect(r.size).toBe(51_000);
  });

  it('finds the largest fit by binary search when the estimate is badly wrong', async () => {
    const cost = Array.from({ length: 60 }, (_u, i) => 200 + i * 10);
    const s = sizer(cost);
    const r = await fitPart({ from: 0, pages: 60, maxBytes: 5_000, guess: 60, build: s.build });
    expect(r.size).toBeLessThanOrEqual(5_000);
    let best = 0;
    for (let k = 1; k <= 60; k++) {
      const size = 1000 + cost.slice(0, k).reduce((a, b) => a + b, 0);
      if (size <= 5_000) best = k;
    }
    expect(r.k).toBe(best);
  });

  it('never builds past the last page', async () => {
    const s = sizer(Array(5).fill(100));
    const r = await fitPart({ from: 3, pages: 5, maxBytes: 1_000_000, guess: 99, build: s.build });
    expect(r.k).toBe(2);
    expect(s.calls.every(([from, k]) => from + k <= 5)).toBe(true);
  });
});

function sharedFontDoc(pages: number): Uint8Array {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Times-Roman'));
  const fonts = pdf.newDictionary();
  fonts.put('F1', font);
  const res = pdf.addObject(pdf.newDictionary());
  res.put('Font', fonts);
  for (let i = 0; i < pages; i++) {
    // Each page carries 5 KB of its own drawing data, and the font is shared.
    const junk = crypto.randomBytes(2_500).toString('hex');
    pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, res, `BT /F1 12 Tf 72 700 Td (Page ${i + 1}) Tj ET\n% ${junk}`));
  }
  return pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
}

function oversizePageDoc(): Uint8Array {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('F1', font);
  const res = pdf.addObject(pdf.newDictionary());
  res.put('Font', fonts);
  for (let i = 0; i < 6; i++) {
    const heavy = i === 2 ? crypto.randomBytes(90_000).toString('hex') : '';
    pdf.insertPage(-1, pdf.addPage([0, 0, 300, 400], 0, res, `BT /F1 12 Tf 20 300 Td (Page ${i + 1}) Tj ET\n% ${heavy}`));
  }
  return pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
}

async function splitBySize(bytes: Uint8Array, maxBytes: number, password?: string) {
  const h = new JobHarness();
  await h.probe(bytes, password);
  const out = await h.split({ kind: 'split', baseName: 'T', plan: { by: 'size', maxBytes }, ...(password !== undefined ? { password } : {}) });
  return out;
}

const corpus = (name: string) => new URL(`../../../tests/engine/corpus/${name}`, import.meta.url);
const have = (name: string) => fs.existsSync(corpus(name));
const load = (name: string) => new Uint8Array(fs.readFileSync(corpus(name)));

describe('ReachSet: the estimate counts shared objects once', () => {
  it('adding a page that shares the font and its resources adds only its own stream', () => {
    const pdf = mu.Document.openDocument(sharedFontDoc(4), 'application/pdf').asPDF()!;
    const reach = new ReachSet(pdf);
    const first = reach.add(0);
    const second = reach.add(1);
    expect(first).toBeGreaterThan(5_000);
    // The second page adds its 5 KB stream; the font and Resources were counted with the first page.
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(5_000);
    expect(guessPageCount(new ReachSet(pdf), 0, 4, 15_000)).toBeGreaterThanOrEqual(1);
    expect(guessPageCount(new ReachSet(pdf), 0, 4, 10)).toBe(1);
  });
});

describe('every part is at most the limit, measured on the saved bytes', () => {
  it('shared fonts: a 40-page file in 100 KB parts, each part reopened by pdf.js with the right pages', async () => {
    const src = sharedFontDoc(40);
    const out = await splitBySize(src, 100_000);
    expect(out.error).toBeUndefined();
    const sizes = out.files.map((f) => f.bytes.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100_000);
    expect(out.files.reduce((n, f) => n + f.pages, 0)).toBe(40);
    // Typical fill: every part but the last holds at least 90% of the limit.
    for (const size of sizes.slice(0, -1)) expect(size).toBeGreaterThanOrEqual(90_000);
    expect(sizes.length).toBeLessThanOrEqual(3);
    expect(out.files.map((f) => f.leafName)).toEqual(sizes.map((_s, i) => `T - part ${String(i + 1).padStart(2, '0')}.pdf`));
    let page = 1;
    for (const file of out.files) {
      const r = await reread(file.bytes);
      expect(r.pages).toBe(file.pages);
      expect(r.text[0]).toBe(`Page ${page}`);
      page += r.pages;
    }
  });

  it('one oversize page is saved alone and reported; every other part is under the limit', async () => {
    const out = await splitBySize(oversizePageDoc(), 20_000);
    expect(out.error).toBeUndefined();
    const over = out.files.filter((f) => f.bytes.length > 20_000);
    expect(over).toHaveLength(1);
    expect(over[0]!.pages).toBe(1);
    expect(out.done?.notes).toEqual([{ kind: 'oversizePage', file: out.files.indexOf(over[0]!) + 1, page: 3, limitBytes: 20_000 }]);
    expect(out.files.reduce((n, f) => n + f.pages, 0)).toBe(6);
    const r = await reread(over[0]!.bytes);
    expect(r.text[0]).toBe('Page 3');
  });

  const files: Array<[string, string, number]> = [
    ['the arXiv paper (fonts shared by every page)', 'arxiv-attention/1706.03762.pdf', 400_000],
    ['the picture-heavy file', 'images-misc/images.pdf', 300_000],
    ['the scanned gray file', 'scanned-gray/perf_images_scan_gray.pdf', 500_000],
    ['the IRS form (flattened)', 'irs-fw9/fw9.pdf', 40_000],
    ['the nested-outline file', 'outlines/nested_outline.pdf', 2_500],
  ];
  for (const [label, name, limit] of files) {
    it.skipIf(!have(name))(`${label}: no part is over ${limit} bytes`, async () => {
      const src = load(name);
      const out = await splitBySize(src, limit);
      expect(out.error).toBeUndefined();
      expect(out.done).toBeDefined();
      const pages = mu.Document.openDocument(src, 'application/pdf').countPages();
      expect(out.files.reduce((n, f) => n + f.pages, 0)).toBe(pages);
      const reported = new Set((out.done?.notes ?? []).map((n) => n.file));
      out.files.forEach((file, i) => {
        if (reported.has(i + 1)) {
          expect(file.pages).toBe(1);
        } else {
          expect(file.bytes.length, `${name} part ${i + 1}`).toBeLessThanOrEqual(limit);
        }
      });
      console.log(`${name}: ${out.files.length} parts, sizes ${out.files.map((f) => f.bytes.length).join(', ')}, limit ${limit}`);
    });
  }

  it('a shared picture: 30 pages that use one 270 KB image in 400 KB parts, the picture is in each part once', async () => {
    const pdf = new mu.PDFDocument();
    const pix = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 300, 300], false);
    crypto.randomFillSync(pix.getPixels());
    const xo = pdf.newDictionary();
    xo.put('Im1', pdf.addImage(new mu.Image(pix)));
    const res = pdf.addObject(pdf.newDictionary());
    res.put('XObject', xo);
    for (let i = 0; i < 30; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, res, `q 300 0 0 300 100 300 cm /Im1 Do Q
% ${crypto.randomBytes(4_000).toString('hex')}`));
    const src = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
    const out = await splitBySize(src, 400_000);
    expect(out.error).toBeUndefined();
    expect(Math.max(...out.files.map((f) => f.bytes.length))).toBeLessThanOrEqual(400_000);
    expect(out.files.reduce((n, f) => n + f.pages, 0)).toBe(30);
    // The image is shared by every page, so a part holds it once: far fewer parts than 30 x 270 KB / 400 KB.
    expect(out.files.length).toBeLessThanOrEqual(3);
  });

  it('a file smaller than the limit comes out as one part', async () => {
    const out = await splitBySize(makeDoc({ pages: 5 }), 10_000_000);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.pages).toBe(5);
  });
});
