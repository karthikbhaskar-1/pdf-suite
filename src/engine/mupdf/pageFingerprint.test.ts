// @vitest-environment node
// The pre-save check (ticket 1.5.1, from measurement L8 / design register C5). The damage cases are those of
// tests/perf/save-check-damage.probe.mjs: a 5-page document is damaged one way at a time, and the fingerprints of the damaged
// document are compared with the clean ones the way a save compares them (firstMismatch). "Caught" means at least one page
// differs, so the save writes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { firstMismatch, pageFingerprints } from './pageFingerprint';

function longContent(bytes: number): string {
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; n < bytes; i++) {
    const line = `${(i * 7) % 600} ${(i * 13) % 780} 3 2 re f\n`;
    lines.push(line);
    n += line.length;
  }
  return lines.join('');
}

/** The probe's base document: fonts, an image, a 600 KB content stream, two annotations, a Contents array, a TrimBox, a form XObject, an ExtGState. */
function buildBase(): Uint8Array {
  const doc = new mu.PDFDocument();
  const helv = doc.addSimpleFont(new mu.Font('Helvetica'));
  const times = doc.addSimpleFont(new mu.Font('Times-Roman'));
  const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 64, 64], false);
  pixmap.clear(200);
  const image = doc.addImage(new mu.Image(pixmap));
  const resources = { Font: { F1: helv, F2: times }, XObject: { Im1: image } };
  const text = (n: number) => `BT /F1 14 Tf 72 700 Td (Page ${n} Helvetica) Tj ET BT /F2 12 Tf 72 680 Td (Times line) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q`;
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, text(1)));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, longContent(600 * 1024)));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, text(3)));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, text(4)));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, text(5)));
  const p3 = doc.findPage(2);
  const link = doc.addObject(doc.newDictionary());
  link.put('Type', doc.newName('Annot'));
  link.put('Subtype', doc.newName('Link'));
  link.put('Rect', [72, 600, 200, 620]);
  const note = doc.addObject(doc.newDictionary());
  note.put('Type', doc.newName('Annot'));
  note.put('Subtype', doc.newName('Text'));
  note.put('Rect', [300, 600, 320, 620]);
  note.put('Contents', doc.newString('a note'));
  const annots = doc.newArray();
  annots.push(link);
  annots.push(note);
  p3.put('Annots', annots);
  const p4 = doc.findPage(3);
  const first = doc.addStream(longContent(300 * 1024), {});
  const second = doc.addStream(longContent(300 * 1024) + '\n', {});
  const contents = doc.newArray();
  contents.push(first);
  contents.push(second);
  p4.put('Contents', contents);
  const p5 = doc.findPage(4);
  p5.put('TrimBox', [10, 10, 600, 780]);
  const form = doc.addStream('0 0 50 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50] });
  const res5 = p5.get('Resources');
  res5.get('XObject').put('Fm1', form);
  const gs = doc.addObject(doc.newDictionary());
  gs.put('CA', 0.5);
  res5.put('ExtGState', doc.newDictionary());
  res5.get('ExtGState').put('GS1', gs);
  return doc.saveToBuffer('garbage=compact,compress=no').asUint8Array().slice();
}

const BASE = buildBase();
const open = (): mu.PDFDocument => mu.Document.openDocument(BASE.slice(), 'application/pdf').asPDF()!;
const page = (pdf: mu.PDFDocument, index: number) => pdf.findPage(index);
const rawOf = (stream: mu.PDFObject): Uint8Array => stream.readRawStream().asUint8Array().slice();
const flip = (stream: mu.PDFObject, at: number): void => {
  const bytes = rawOf(stream);
  bytes[at] = bytes[at] === 0x31 ? 0x32 : 0x31;
  stream.writeRawStream(bytes);
};

type Damage = [name: string, apply: (pdf: mu.PDFDocument) => void];

/** The 12 damages L8 asked for, less the one the check is documented to miss (pixels of an image, same length). */
const CAUGHT: Damage[] = [
  ['drop an image (remove it from the page resources)', (pdf) => page(pdf, 0).get('Resources').get('XObject').delete('Im1')],
  ['swap a font (BaseFont renamed, same length)', (pdf) => page(pdf, 0).get('Resources').get('Font').get('F1').put('BaseFont', pdf.newName('Helvetice'))],
  ['swap a font (the page uses the other font object)', (pdf) => {
    const fonts = page(pdf, 0).get('Resources').get('Font');
    fonts.put('F1', fonts.get('F2'));
  }],
  ['remove one of two annotations', (pdf) => page(pdf, 2).get('Annots').delete(1)],
  ['remove all annotations of a page', (pdf) => page(pdf, 2).delete('Annots')],
  ['move an annotation Rect', (pdf) => page(pdf, 2).get('Annots').get(1).put('Rect', [301, 600, 321, 620])],
  ['change a note text, same length', (pdf) => page(pdf, 2).get('Annots').get(1).put('Contents', pdf.newString('a nota'))],
  ['change the middle of a 600 KB content stream (byte at 300 KB)', (pdf) => flip(page(pdf, 1).get('Contents'), 300 * 1024)],
  ['change a content stream just after the old 64 KB head (byte at 70 KB)', (pdf) => flip(page(pdf, 1).get('Contents'), 70 * 1024)],
  ['change the middle of the 2nd stream of a Contents array', (pdf) => flip(page(pdf, 3).get('Contents').get(1), 150 * 1024)],
  ['change TrimBox', (pdf) => page(pdf, 4).put('TrimBox', [20, 20, 590, 770])],
  ['add an ArtBox', (pdf) => page(pdf, 4).put('ArtBox', [30, 30, 580, 760])],
];

/** What the check caught before and still catches. */
const CONTROLS: Damage[] = [
  ['change the first byte of a content stream', (pdf) => {
    const stream = page(pdf, 1).get('Contents');
    const bytes = rawOf(stream);
    bytes[0] = 0x58;
    stream.writeRawStream(bytes);
  }],
  ['change the last byte of a content stream', (pdf) => {
    const stream = page(pdf, 1).get('Contents');
    const bytes = rawOf(stream);
    bytes[bytes.length - 1] = 0x58;
    stream.writeRawStream(bytes);
  }],
  ['append a byte to a content stream', (pdf) => {
    const stream = page(pdf, 1).get('Contents');
    const bytes = rawOf(stream);
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    longer[bytes.length] = 0x20;
    stream.writeRawStream(longer);
  }],
  ['rotate a page', (pdf) => page(pdf, 0).put('Rotate', 90)],
  ['change MediaBox', (pdf) => page(pdf, 0).put('MediaBox', [0, 0, 595, 842])],
  ['add a CropBox', (pdf) => page(pdf, 0).put('CropBox', [10, 10, 500, 700])],
  ['delete a page', (pdf) => pdf.deletePage(2)],
  ['move a page', (pdf) => {
    const first = pdf.findPage(0);
    pdf.deletePage(0);
    pdf.insertPage(3, first);
  }],
];

const clean = pageFingerprints(open());
const caught = (apply: (pdf: mu.PDFDocument) => void): boolean => {
  const pdf = open();
  apply(pdf);
  return firstMismatch(clean, pageFingerprints(pdf)) !== -1;
};

describe('the pre-save check catches damage to the bytes about to be written (1.5.1, L8)', () => {
  it.each(CAUGHT)('catches: %s', (_name, apply) => {
    expect(caught(apply)).toBe(true);
  });

  it.each(CONTROLS)('still catches: %s', (_name, apply) => {
    expect(caught(apply)).toBe(true);
  });

  it('11 of the 12 kinds L8 asked for are caught (the twelfth is the documented miss below)', () => {
    // CAUGHT has the 11 plus the extra ArtBox case; the 12th asked-for case is the pixel change.
    expect(CAUGHT.filter(([name]) => name !== 'add an ArtBox')).toHaveLength(11);
  });

  it('KNOWN MISS: an image whose pixels change while its length stays the same (the image data is not hashed)', () => {
    const missed = !caught((pdf) => {
      const image = page(pdf, 0).get('Resources').get('XObject').get('Im1');
      const bytes = rawOf(image);
      for (let i = 0; i < bytes.length; i += 7) bytes[i] = bytes[i]! ^ 0x55;
      image.writeRawStream(bytes);
    });
    expect(missed).toBe(true);
  });

  it('KNOWN MISS: the content of a form XObject or an ExtGState the page uses (not hashed)', () => {
    expect(caught((pdf) => flip(page(pdf, 4).get('Resources').get('XObject').get('Fm1'), 0))).toBe(false);
    expect(caught((pdf) => page(pdf, 4).get('Resources').get('ExtGState').get('GS1').put('CA', 0.4))).toBe(false);
  });
});

describe('the check does not cry wolf: a correct save compares equal', () => {
  it('the clean base compares equal after a compacting save and reopen', () => {
    const resaved = mu.Document.openDocument(open().saveToBuffer('garbage=compact').asUint8Array().slice(), 'application/pdf').asPDF()!;
    expect(firstMismatch(clean, pageFingerprints(resaved))).toBe(-1);
  });

  const CORPUS = ['arxiv-attention/1706.03762.pdf', 'irs-fw9/fw9.pdf', 'images-misc/images.pdf', 'scanned-gray/perf_images_scan_gray.pdf', 'outlines/nested_outline.pdf', 'brochure-images/brochure.pdf'];
  it.each(CORPUS)('a real save of corpus file %s (through the core, as the app saves) reopens to the same fingerprints', (name) => {
    const path = new URL(`../../../tests/engine/corpus/${name}`, import.meta.url);
    if (!existsSync(path)) return;
    const core = new MupdfCore(mu as never, {});
    core.open(new Uint8Array(readFileSync(path)), undefined);
    const saved = core.save(false, false);
    const reopened = mu.Document.openDocument(new Uint8Array(saved.bytes), 'application/pdf').asPDF()!;
    expect(firstMismatch(saved.fingerprints, pageFingerprints(reopened))).toBe(-1);
  });
});

describe('time', () => {
  // Wall-clock bounds fail on a loaded machine (the full suite runs in parallel), so this asserts the complexity instead: the cost
  // per page at 1,000 pages is about the cost per page at 100 pages (a linear pass). Each size is timed several times and the
  // fastest run is used, because load only ever makes a run slower. A pass that grew faster than linearly would show as a ratio
  // far above 1 whatever the machine is doing.
  function build(pages: number): mu.PDFDocument {
    const doc = new mu.PDFDocument();
    const font = doc.addSimpleFont(new mu.Font('Helvetica'));
    const body = longContent(20 * 1024);
    for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { Font: { F1: font } }, `% ${i}
${body}`));
    return doc;
  }
  function fastestPerPage(doc: mu.PDFDocument, pages: number): number {
    pageFingerprints(doc); // warm up
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      pageFingerprints(doc);
      best = Math.min(best, performance.now() - start);
    }
    return best / pages;
  }

  it('one pass over 2,000 pages of 20 KB content costs the same per page as over 500 pages (linear, not worse)', () => {
    const small = fastestPerPage(build(500), 500);
    const large = fastestPerPage(build(2000), 2000);
    expect(large / small).toBeLessThan(2.5);
  }, 60_000);
});
