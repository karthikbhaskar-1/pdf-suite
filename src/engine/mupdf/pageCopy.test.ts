// @vitest-environment node
// 1.3.2: (1) one graft map copies shared resources once (the Extract size bug), (2) Insert from a PDF, Replace and Insert blank
// must not pick up the Rotate, CropBox, MediaBox or Resources of the /Pages node they land in (two-node page tree).
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EditCore } from './editCore';
import { MupdfCore } from './core';
import { displayBounds, optionalEntry } from './pageOps';
import { graftPages } from './pageCopy';

const env = { mu, sources: new Map<string, mu.PDFDocument>() };

const open = (bytes: Uint8Array) => mu.Document.openDocument(bytes, 'application/pdf').asPDF()!;

function box(pdf: mu.PDFDocument, values: readonly number[]): mu.PDFObject {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}

/** A document whose pages all use one incompressible image and one font. */
function sharedResources(pages: number): Uint8Array {
  const doc = new mu.PDFDocument();
  const pix = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 300, 300], false);
  crypto.randomFillSync(pix.getPixels());
  const image = doc.addImage(new mu.Image(pix));
  const font = doc.addSimpleFont(new mu.Font('Times-Roman'));
  const res = doc.addObject(doc.newDictionary());
  const fonts = doc.newDictionary();
  fonts.put('F1', font);
  res.put('Font', fonts);
  const xo = doc.newDictionary();
  xo.put('Im1', image);
  res.put('XObject', xo);
  for (let i = 0; i < pages; i++) {
    const content = `q 300 0 0 300 100 300 cm /Im1 Do Q BT /F1 24 Tf 100 200 Td (Page ${i + 1}) Tj ET`;
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, content));
  }
  return doc.saveToBuffer('garbage=compact').asUint8Array().slice();
}

function count(bytes: Uint8Array): { images: number; fonts: number } {
  const pdf = open(bytes);
  let images = 0;
  let fonts = 0;
  for (let i = 1; i < pdf.countObjects(); i++) {
    const ref = pdf.newIndirect(i);
    const obj = ref.resolve();
    const type = obj.get('Type');
    const sub = obj.get('Subtype');
    if (type.isName() && type.asName() === 'Font') fonts++;
    if (ref.isStream() && sub.isName() && sub.asName() === 'Image') images++;
  }
  return { images, fonts };
}

describe('one graft map: the saved bytes of an Extract', () => {
  const PAGES = 30;

  it('graftPages copies a shared image and font once; the old per-page call copies them once per page', () => {
    const src = open(sharedResources(PAGES));
    const perPage = new mu.PDFDocument();
    for (let i = 0; i < PAGES; i++) perPage.graftPage(perPage.countPages(), src, i);
    const oldBytes = perPage.saveToBuffer('garbage=compact').asUint8Array().slice();

    const shared = new mu.PDFDocument();
    graftPages(shared, src, Array.from({ length: PAGES }, (_unused, i) => i));
    const newBytes = shared.saveToBuffer('garbage=compact').asUint8Array().slice();

    expect(count(newBytes)).toEqual({ images: 1, fonts: 1 });
    expect(count(oldBytes).images).toBe(PAGES);
    expect(newBytes.length).toBeLessThan(oldBytes.length / (PAGES / 2));
    console.log(`graft bytes, ${PAGES} pages sharing one 270 KB image: per-page maps ${oldBytes.length}, one map ${newBytes.length}`);
  });

  it('MupdfCore.extract: the output holds the shared image once and is not larger than 1.5 x the source', () => {
    const bytes = sharedResources(PAGES);
    const core = new MupdfCore(mu, {});
    core.open(bytes, undefined);
    const uids = Array.from({ length: PAGES }, (_unused, i) => String(i));
    const out = new Uint8Array(core.extract(uids).bytes);
    expect(count(out)).toEqual({ images: 1, fonts: 1 });
    expect(out.length).toBeLessThan(bytes.length * 1.5);
    const half = new Uint8Array(core.extract(uids.slice(0, 15)).bytes);
    expect(count(half).images).toBe(1);
    expect(open(half).countPages()).toBe(15);
  });

  const arxiv = new URL('../../../tests/engine/corpus/arxiv-attention/1706.03762.pdf', import.meta.url);
  it.skipIf(!fs.existsSync(arxiv))('the corpus paper: extracting every page is smaller than with one map per page, and under 1.5 x its source', () => {
    const bytes = new Uint8Array(fs.readFileSync(arxiv));
    const core = new MupdfCore(mu, {});
    const { pages } = core.open(bytes, undefined);
    const out = new Uint8Array(core.extract(Array.from({ length: pages }, (_unused, i) => String(i))).bytes);
    const src = open(bytes);
    const old = new mu.PDFDocument();
    for (let i = 0; i < pages; i++) old.graftPage(old.countPages(), src, i);
    const oldSize = old.saveToBuffer('garbage=compact').asUint8Array().length;
    console.log(`arxiv ${pages} pages: source ${bytes.length}, extract with one map per page ${oldSize}, with one map ${out.length}`);
    expect(out.length).toBeLessThan(oldSize * 0.8);
    expect(out.length).toBeLessThan(bytes.length * 1.5);
  });

  it('insertFrom uses one map per edit: a shared image is copied once, undo removes it, redo puts it back, a later edit works', async () => {
    const target = open(sharedResources(1));
    const src = open(sharedResources(8));
    const core = new EditCore(target, 1, true, { mu, sources: new Map([['s', src]]) });
    await core.apply([{ op: 'insertFrom', afterUid: '0', sourceDocId: 's', sourceUids: ['0', '1', '2', '3', '4', '5', '6', '7'] }]);
    expect(target.countPages()).toBe(9);
    core.undo();
    expect(target.countPages()).toBe(1);
    core.redo();
    expect(target.countPages()).toBe(9);
    // A second edit starts a new map (a map is never kept across edits), so it copies the image once more.
    await core.apply([{ op: 'insertFrom', afterUid: '0', sourceDocId: 's', sourceUids: ['3'] }]);
    expect(target.countPages()).toBe(10);
    core.undo();
    expect(target.countPages()).toBe(9);
    // Saving ends the undo, so the bytes are measured last: the target's own image plus one copy for the 8 pages.
    expect(count(target.saveToBuffer('garbage=compact').asUint8Array().slice()).images).toBe(2);
  });
});

/**
 * A page tree of two /Pages nodes. Node A: MediaBox 600x400, nothing else. Node B: Rotate 90, CropBox 10..110, Resources with
 * font FB. Page 0 is on A and page 1 on B. A page inserted anywhere lands under one of them.
 */
function twoNodes(): Uint8Array {
  const pdf = new mu.PDFDocument();
  const font = pdf.newDictionary();
  font.put('Type', pdf.newName('Font'));
  font.put('Subtype', pdf.newName('Type1'));
  font.put('BaseFont', pdf.newName('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('FB', pdf.addObject(font));
  const resourcesB = pdf.newDictionary();
  resourcesB.put('Font', fonts);
  const root = pdf.getTrailer().get('Root').get('Pages');
  const nodeA = pdf.addObject(pdf.newDictionary());
  const nodeB = pdf.addObject(pdf.newDictionary());
  const page = (parent: mu.PDFObject) => {
    const dict = pdf.newDictionary();
    dict.put('Type', pdf.newName('Page'));
    dict.put('Parent', parent);
    dict.put('Contents', pdf.addStream('0 g 10 10 50 50 re f', pdf.newDictionary()));
    return pdf.addObject(dict);
  };
  const p0 = page(nodeA);
  const p1 = page(nodeB);
  const a = nodeA.resolve();
  a.put('Type', pdf.newName('Pages'));
  a.put('Parent', root);
  const ka = pdf.newArray();
  ka.push(p0);
  a.put('Kids', ka);
  a.put('Count', 1);
  a.put('MediaBox', box(pdf, [0, 0, 600, 400]));
  const b = nodeB.resolve();
  b.put('Type', pdf.newName('Pages'));
  b.put('Parent', root);
  const kb = pdf.newArray();
  kb.push(p1);
  b.put('Kids', kb);
  b.put('Count', 1);
  b.put('MediaBox', box(pdf, [0, 0, 600, 400]));
  b.put('Rotate', 90);
  b.put('CropBox', box(pdf, [10, 10, 110, 110]));
  b.put('Resources', resourcesB);
  const top = root.resolve();
  const kids = pdf.newArray();
  kids.push(nodeA);
  kids.push(nodeB);
  top.put('Kids', kids);
  top.put('Count', 2);
  return pdf.saveToBuffer('').asUint8Array().slice();
}

/** A one-page source with no Rotate and no CropBox: 300 x 200. */
function plainSource(): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  pdf.insertPage(-1, pdf.addPage([0, 0, 300, 200], 0, {}, '0 g 0 0 100 100 re f'));
  return open(pdf.saveToBuffer('').asUint8Array().slice());
}

interface Look {
  bounds: number[];
  rotate: number;
  crop: boolean;
  fonts: string[];
}

function look(pdf: mu.PDFDocument, index: number): Look {
  const page = pdf.findPage(index);
  const cropBox = page.getInheritable('CropBox');
  const media = page.getInheritable('MediaBox').resolve();
  // A CropBox equal to the MediaBox is the same page as none.
  const crop = !cropBox.isNull() && [0, 1, 2, 3].some((k) => cropBox.resolve().get(k).asNumber() !== media.get(k).asNumber());
  const rotate = page.getInheritable('Rotate');
  const res = page.getInheritable('Resources');
  const fonts: string[] = [];
  if (!res.isNull() && res.isDictionary()) {
    const f = optionalEntry(res, 'Font')?.resolve();
    if (f && f.isDictionary()) f.forEach((_v, k) => fonts.push(String(k)));
  }
  return {
    bounds: displayBounds(pdf, index).map(Math.round),
    rotate: rotate.isNull() ? 0 : rotate.asNumber(),
    crop,
    fonts,
  };
}

const PLAIN_300x200: Look = { bounds: [0, 0, 300, 200], rotate: 0, crop: false, fonts: [] };

describe('a page that lands in a /Pages node does not pick up that node\'s attributes', () => {
  it('the fixture starts as built', () => {
    const pdf = open(twoNodes());
    expect(look(pdf, 0)).toEqual({ bounds: [0, 0, 600, 400], rotate: 0, crop: false, fonts: [] });
    expect(look(pdf, 1)).toEqual({ bounds: [0, 0, 100, 100], rotate: 90, crop: true, fonts: ['FB'] });
  });

  for (const afterUid of [null, '0', '1'] as const) {
    const where = afterUid === null ? 'first' : `after page ${Number(afterUid) + 1}`;
    const at = afterUid === null ? 0 : Number(afterUid) + 1;

    it(`insert blank ${where}: the new page is 612 x 792, not turned, not cropped, no inherited resources`, async () => {
      const pdf = open(twoNodes());
      const core = new EditCore(pdf, 2, true, env);
      const before = [look(pdf, 0), look(pdf, 1)];
      await core.apply([{ op: 'insertBlank', afterUid, size: { width: 612, height: 792 }, template: 'blank' }]);
      expect(look(pdf, at)).toEqual({ bounds: [0, 0, 612, 792], rotate: 0, crop: false, fonts: [] });
      expect([0, 1, 2].filter((i) => i !== at).map((i) => look(pdf, i))).toEqual(before);
      core.undo();
      expect([look(pdf, 0), look(pdf, 1)]).toEqual(before);
    });

    it(`insert from a PDF ${where}: the new page is 300 x 200, not turned, not cropped`, async () => {
      const pdf = open(twoNodes());
      const core = new EditCore(pdf, 2, true, { mu, sources: new Map([['s', plainSource()]]) });
      const before = [look(pdf, 0), look(pdf, 1)];
      await core.apply([{ op: 'insertFrom', afterUid, sourceDocId: 's', sourceUids: ['0'] }]);
      expect(look(pdf, at)).toEqual(PLAIN_300x200);
      expect([0, 1, 2].filter((i) => i !== at).map((i) => look(pdf, i))).toEqual(before);
      expect(look(open(pdf.saveToBuffer('garbage=compact').asUint8Array().slice()), at)).toEqual(PLAIN_300x200);
    });
  }

  for (const index of [0, 1]) {
    it(`replace page ${index + 1}: the page takes the source's size and nothing from its node`, async () => {
      const pdf = open(twoNodes());
      const core = new EditCore(pdf, 2, true, { mu, sources: new Map([['s', plainSource()]]) });
      const other = look(pdf, 1 - index);
      await core.apply([{ op: 'replace', uid: String(index), sourceDocId: 's', sourceUid: '0' }]);
      expect(look(pdf, index)).toEqual(PLAIN_300x200);
      expect(look(pdf, 1 - index)).toEqual(other);
      expect(look(open(pdf.saveToBuffer('garbage=compact').asUint8Array().slice()), index)).toEqual(PLAIN_300x200);
    });
  }

  it('a source that has its own Rotate and CropBox keeps them (nothing is overwritten)', async () => {
    const pdf = open(twoNodes());
    const srcDoc = new mu.PDFDocument();
    srcDoc.insertPage(-1, srcDoc.addPage([0, 0, 300, 200], 180, {}, '0 g 0 0 100 100 re f'));
    srcDoc.findPage(0).put('CropBox', box(srcDoc, [20, 20, 120, 120]));
    const src = open(srcDoc.saveToBuffer('').asUint8Array().slice());
    const core = new EditCore(pdf, 2, true, { mu, sources: new Map([['s', src]]) });
    await core.apply([{ op: 'insertFrom', afterUid: '0', sourceDocId: 's', sourceUids: ['0'] }]);
    expect(look(pdf, 1)).toEqual({ bounds: [0, 0, 100, 100], rotate: 180, crop: true, fonts: [] });
  });
});

describe('Page size, Remove crop and fine rotate under a /Pages node that has a CropBox (1.3.1 Sign-Off)', () => {
  // twoNodes(): node B holds page 1 with Rotate 90 and CropBox [10, 10, 110, 110]. A page there must lose that crop when the
  // user asks for "no crop" or a new size, so the CropBox is written as the page's own MediaBox rather than deleted.
  const nodeBPage = 1;

  it('Page size 300 x 300 gives a 300 x 300 page, not the 100 x 100 crop of the node; it survives a save', async () => {
    const pdf = open(twoNodes());
    const core = new EditCore(pdf, 2, true, env);
    // The page is turned 90 by its node: asking for 300 x 300 (display) is square, so the turn does not matter.
    await core.apply([{ op: 'resize', uids: [String(nodeBPage)], size: { width: 300, height: 300 }, fit: 'scale' }]);
    expect(displayBounds(pdf, nodeBPage).map(Math.round)).toEqual([0, 0, 300, 300]);
    core.undo();
    expect(displayBounds(pdf, nodeBPage).map(Math.round)).toEqual([0, 0, 100, 100]);
    core.redo();
    // Saving ends the undo, so it comes last.
    expect(displayBounds(open(pdf.saveToBuffer('garbage=compact').asUint8Array().slice()), nodeBPage).map(Math.round)).toEqual([0, 0, 300, 300]);
  });

  it('Remove crop shows the whole page (the MediaBox), not the node\'s crop', async () => {
    const pdf = open(twoNodes());
    const core = new EditCore(pdf, 2, true, env);
    await core.apply([{ op: 'crop', uids: [String(nodeBPage)], box: null }]);
    // MediaBox 600 x 400, turned 90 by the node: 400 x 600 on screen.
    expect(displayBounds(pdf, nodeBPage).map(Math.round)).toEqual([0, 0, 400, 600]);
    expect(displayBounds(open(pdf.saveToBuffer('garbage=compact').asUint8Array().slice()), nodeBPage).map(Math.round)).toEqual([0, 0, 400, 600]);
  });

  it('a page without a crop of its own that is turned by a whole fine-rotate round trip does not take the node\'s crop', async () => {
    const pdf = open(twoNodes());
    const core = new EditCore(pdf, 2, true, env);
    // Give page 1 its own crop equal to the whole page first, so the round trip restores "its own", then remove the entry as a
    // page that had none would: the round trip must not fall back to the node's crop.
    await core.apply([{ op: 'crop', uids: [String(nodeBPage)], box: null }]);
    await core.apply([{ op: 'rotate', uids: [String(nodeBPage)], degrees: 10 }]);
    await core.apply([{ op: 'rotate', uids: [String(nodeBPage)], degrees: -10 }]);
    expect(displayBounds(pdf, nodeBPage).map(Math.round)).toEqual([0, 0, 400, 600]);
  });
});
