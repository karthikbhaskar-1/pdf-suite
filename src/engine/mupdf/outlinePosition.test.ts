// @vitest-environment node
// Review fix (1.3.2): the position and zoom of a bookmark in a Split part. MuPDF reports a destination as `zoom=Z,X,Y` in its own
// page space (y down, after /Rotate and the crop origin, zoom in percent); /XYZ wants the page's user space and a zoom factor.
// The part's /Dest must read back as the source's did, on an upright page, a turned page and a cropped page, and on a real file.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import fs from 'node:fs';
import { buildPart, type SplitSource } from './splitCore';
import { readBookmarks } from './outlineCarry';

/** A document of pages made by `page(i)`, each with one bookmark that has an /XYZ destination (left, top, zoom) in user space. */
function withXyz(pages: Array<{ rotate?: number; crop?: number[] }>, dest: [number, number, number]): Uint8Array {
  const pdf = new mu.PDFDocument();
  pages.forEach((spec) => {
    pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], (spec.rotate ?? 0) as 0 | 90 | 180 | 270, {}, '0 g 10 10 50 50 re f'));
  });
  pages.forEach((spec, i) => {
    if (!spec.crop) return;
    const box = pdf.newArray();
    for (const v of spec.crop) box.push(pdf.newReal(v));
    pdf.findPage(i).put('CropBox', box);
  });
  const outlines = pdf.createObject();
  const refs = pages.map(() => pdf.createObject());
  pages.forEach((_spec, i) => {
    const item = pdf.newDictionary();
    item.put('Title', pdf.newString(`B${i + 1}`));
    item.put('Parent', outlines);
    if (i > 0) item.put('Prev', refs[i - 1]!);
    if (i < pages.length - 1) item.put('Next', refs[i + 1]!);
    const d = pdf.newArray();
    d.push(pdf.findPage(i));
    d.push(pdf.newName('XYZ'));
    d.push(pdf.newReal(dest[0]));
    d.push(pdf.newReal(dest[1]));
    d.push(pdf.newReal(dest[2]));
    item.put('Dest', d);
    refs[i]!.writeObject(item);
  });
  const top = pdf.newDictionary();
  top.put('Type', pdf.newName('Outlines'));
  top.put('First', refs[0]!);
  top.put('Last', refs[refs.length - 1]!);
  top.put('Count', pages.length);
  outlines.writeObject(top);
  pdf.getTrailer().get('Root').put('Outlines', outlines);
  return pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
}

function sourceOf(bytes: Uint8Array): SplitSource {
  const pdf = new mu.PDFDocument(bytes);
  return { doc: pdf, pdf, pages: pdf.countPages(), encrypted: false, bookmarks: readBookmarks(pdf, pdf.countPages()) };
}

/** The raw /Dest numbers of the bookmark with this title in a saved part: [page index, x, y, zoom]. */
function rawDest(bytes: Uint8Array, title: string): Array<number | null> {
  const pdf = new mu.PDFDocument(bytes);
  let item = pdf.getTrailer().get('Root').get('Outlines').get('First');
  while (!item.isNull()) {
    if (item.get('Title').asString() === title) {
      const dest = item.get('Dest');
      const num = (k: number) => (dest.get(k).isNull() ? null : dest.get(k).asNumber());
      let pageIndex = -1;
      for (let i = 0; i < pdf.countPages(); i++) if (pdf.findPage(i).asIndirect() === dest.get(0).asIndirect()) pageIndex = i;
      return [pageIndex, num(2), num(3), num(4)];
    }
    item = item.get('Next');
  }
  throw new Error(`no bookmark ${title}`);
}

const part = (source: SplitSource, from: number, to: number) => buildPart(mu, source, from, to, { encrypted: false, password: undefined, dropEncryption: false }).bytes;
const close = (got: Array<number | null>, want: Array<number | null>) => got.forEach((v, i) => (want[i] === null ? expect(v).toBeNull() : expect(v).toBeCloseTo(want[i]!, 1)));

describe('/XYZ of a bookmark in a part', () => {
  it('an upright page: /XYZ 50 700 2 stays /XYZ 50 700 2 (not 50 92 200)', () => {
    const source = sourceOf(withXyz([{}, {}], [50, 700, 2]));
    close(rawDest(part(source, 0, 1), 'B1'), [0, 50, 700, 2]);
    close(rawDest(part(source, 1, 1), 'B2'), [0, 50, 700, 2]);
  });

  it('a page turned 90 and one turned 270: the user-space point comes back whatever the turn', () => {
    for (const rotate of [90, 180, 270]) {
      const source = sourceOf(withXyz([{ rotate }], [100, 200, 1.5]));
      close(rawDest(part(source, 0, 0), 'B1'), [0, 100, 200, 1.5]);
    }
  });

  it('a cropped page: the crop origin does not move the point', () => {
    const source = sourceOf(withXyz([{ crop: [20, 30, 500, 700] }], [120, 400, 1]));
    close(rawDest(part(source, 0, 0), 'B1'), [0, 120, 400, 1]);
  });

  it('a zoom of 0, not a number or missing becomes "keep the zoom" (null), not 0', () => {
    for (const zoom of [0, -1]) {
      const source = sourceOf(withXyz([{}], [50, 700, zoom]));
      close(rawDest(part(source, 0, 0), 'B1'), [0, 50, 700, null]);
    }
  });

  it('the part, read by MuPDF again, reports the same destination text as the source did', () => {
    const source = sourceOf(withXyz([{ rotate: 90 }, {}], [50, 700, 2]));
    const bytes = part(source, 0, 1);
    const again = readBookmarks(mu.Document.openDocument(bytes, 'application/pdf'), 2);
    expect(again.map((n) => n.view)).toEqual(source.bookmarks.map((n) => n.view).map((v) => v && { x: expect.closeTo(v.x!, 1), y: expect.closeTo(v.y!, 1), zoom: expect.closeTo(v.zoom!, 1) }));
  });
});

const nestedUrl = new URL('../../../tests/engine/corpus/outlines/nested_outline.pdf', import.meta.url);
describe.skipIf(!fs.existsSync(nestedUrl))('nested_outline.pdf', () => {
  it('every bookmark in a part reports the position and zoom it had in the source', () => {
    const bytes = new Uint8Array(fs.readFileSync(nestedUrl));
    const source = sourceOf(bytes);
    const flat = (nodes: typeof source.bookmarks): typeof source.bookmarks => nodes.flatMap((n) => [n, ...flat(n.children)]);
    const original = flat(source.bookmarks);
    expect(original.length).toBeGreaterThan(3);
    const from = 0;
    const to = source.pages - 1;
    const whole = part(source, from, to);
    const doc = mu.Document.openDocument(whole, 'application/pdf');
    const back = flat(readBookmarks(doc, doc.countPages()));
    expect(back.map((n) => n.title)).toEqual(original.map((n) => n.title));
    back.forEach((node, i) => {
      const was = original[i]!;
      expect(node.page).toBe(was.page);
      if (was.view?.x == null) return;
      expect(node.view?.x).toBeCloseTo(was.view.x, 1);
      expect(node.view?.y).toBeCloseTo(was.view.y!, 1);
    });
  });
});
