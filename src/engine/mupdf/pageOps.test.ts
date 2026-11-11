// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from './editCore';
import { MupdfCore } from './core';
import {
  AUTO_CROP_MARGIN_PT,
  readRect,
  autoCropDisplay,
  contentBoundsDisplay,
  contentBytes,
  displayBounds,
  duplicatePageAt,
  fineRotatePage,
  mediaBoxOf,
  optionalEntry,
  parsePageRanges,
  resizePage,
  setCropBox,
} from './pageOps';
import { WorkerFault, type PageEdit } from './protocol';
import type { Rect4 } from './pageOps';

const BIG = new URL('../../../tests/fixtures/out/big-1000.pdf', import.meta.url);
const LETTER = { width: 612, height: 792 };

/** A letter page with one black box, in user space: x 100..300, y 200..400. */
const INK = { x0: 100, y0: 200, x1: 300, y1: 400 };
/** The same box in display space (y down) of an unrotated letter page. */
const INK_DISPLAY = [100, 392, 300, 592] as const;

/** A document of letter pages. Page `i` has a black box shifted by `i * 10` points, so pages are told apart. */
function makeDoc(pages: number, inkShift = (i: number) => i * 10): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < pages; i++) {
    const s = inkShift(i);
    const content = `0 g\n${INK.x0 + s} ${INK.y0} ${INK.x1 - INK.x0} ${INK.y1 - INK.y0} re\nf`;
    pdf.insertPage(pdf.countPages(), pdf.addPage([0, 0, LETTER.width, LETTER.height], 0, {}, content));
  }
  return pdf;
}

/** A document with one blank letter page. */
function blankDoc(): mu.PDFDocument {
  return makeDoc(1, () => 100_000);
}

const env = (sources?: Map<string, mu.PDFDocument>) => ({ mu, sources: sources ?? new Map<string, mu.PDFDocument>() });

/** The ink of a page, in display space at 72 dpi (one pixel per point). Null when the page is blank. */
function ink(pdf: mu.PDFDocument, index: number, threshold = 128): Rect4 | null {
  return contentBoundsDisplay(mu, pdf, index, 72, threshold);
}

function expectNear(actual: readonly number[] | null, expected: readonly number[], tolerance: number): void {
  expect(actual).not.toBeNull();
  actual!.forEach((value, i) => expect(Math.abs(value - expected[i]!), `value ${i}: ${value} vs ${expected[i]}`).toBeLessThanOrEqual(tolerance));
}

/** The page's Contents as text, so two pages can be compared byte for byte. */
function contentsOf(pdf: mu.PDFDocument, index: number): string {
  return Buffer.from(contentBytes(pdf.findPage(index))).toString('latin1');
}

describe('page ranges', () => {
  it('parses "1-5, 8" into 0-based indices, in order, without repeats', async () => {
    expect(parsePageRanges('1-5, 8', 10)).toEqual([0, 1, 2, 3, 4, 7]);
    expect(parsePageRanges('8, 2-3, 3', 10)).toEqual([1, 2, 7]);
    expect(parsePageRanges(' 10 ', 10)).toEqual([9]);
  });

  it('refuses an empty range, a malformed one, and a page outside the document', async () => {
    expect(() => parsePageRanges('', 10)).toThrow(WorkerFault);
    expect(() => parsePageRanges('1-x', 10)).toThrow(WorkerFault);
    expect(() => parsePageRanges('5-3', 10)).toThrow(WorkerFault);
    expect(() => parsePageRanges('0', 10)).toThrow(WorkerFault);
    expect(() => parsePageRanges('9-11', 10)).toThrow(/outside 1-10/);
  });
});

describe('crop', () => {
  it('sets the CropBox to a display rectangle and clips it to the MediaBox', async () => {
    const pdf = makeDoc(1);
    setCropBox(mu, pdf, 0, [50, 50, 400, 500]);
    expect(mediaBoxOf(pdf.findPage(0))).toEqual([0, 0, 612, 792]);
    // The crop in user space is the display rectangle flipped vertically (y is 792 minus display y).
    expectNear(readRect(optionalEntry(pdf.findPage(0), 'CropBox')), [50, 292, 400, 742], 0.01);
    // Display space starts at the top-left of the visible page, so the cropped page is 350 by 450 at the origin.
    expectNear(displayBounds(pdf, 0), [0, 0, 350, 450], 0.01);
  });

  it('removes the crop with null', async () => {
    const pdf = makeDoc(1);
    setCropBox(mu, pdf, 0, [50, 50, 400, 500]);
    setCropBox(mu, pdf, 0, null);
    expectNear(displayBounds(pdf, 0), [0, 0, 612, 792], 0.01);
  });

  it('auto-crop keeps the content with a small margin (100 dpi scan, known margins)', async () => {
    const pdf = makeDoc(1);
    const found = autoCropDisplay(mu, pdf, 0);
    // The box is 1.39 px per point at 100 dpi, so the edges are within about one pixel of the truth.
    expectNear(found, [INK_DISPLAY[0] - AUTO_CROP_MARGIN_PT, INK_DISPLAY[1] - AUTO_CROP_MARGIN_PT, INK_DISPLAY[2] + AUTO_CROP_MARGIN_PT, INK_DISPLAY[3] + AUTO_CROP_MARGIN_PT], 1.5);
    setCropBox(mu, pdf, 0, found);
    expectNear(readRect(optionalEntry(pdf.findPage(0), 'CropBox')), [98, 198, 302, 402], 1.5);
  });

  it('auto-crop leaves a blank page alone', async () => {
    expect(autoCropDisplay(mu, blankDoc(), 0)).toBeNull();
  });

  it('auto-crop respects the page rotation (the crop is in display space)', async () => {
    const pdf = makeDoc(1);
    pdf.findPage(0).put('Rotate', 90);
    const found = autoCropDisplay(mu, pdf, 0);
    // Turned 90 degrees, the page is 792 wide and 612 high on the screen.
    expect(displayBounds(pdf, 0)[2]).toBeCloseTo(792, 0);
    expect(found).not.toBeNull();
    setCropBox(mu, pdf, 0, found);
    const crop = displayBounds(pdf, 0);
    expect(crop[2] - crop[0]).toBeLessThan(792);
    expect(crop[2] - crop[0]).toBeGreaterThan(200);
  });
});

describe('fine-angle rotation', () => {
  it('makes the MediaBox the bounding box of the turned page', async () => {
    const pdf = makeDoc(1);
    fineRotatePage(pdf, 0, 30);
    const [x0, y0, x1, y1] = mediaBoxOf(pdf.findPage(0));
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    expect(x1 - x0).toBeCloseTo(612 * cos + 792 * sin, 1);
    expect(y1 - y0).toBeCloseTo(612 * sin + 792 * cos, 1);
    // The box stays centred on the old centre.
    expect((x0 + x1) / 2).toBeCloseTo(306, 1);
    expect((y0 + y1) / 2).toBeCloseTo(396, 1);
  });

  it('stacks with a quarter turn, which stays in /Rotate', async () => {
    const pdf = makeDoc(1);
    pdf.findPage(0).put('Rotate', 90);
    fineRotatePage(pdf, 0, 10);
    expect(pdf.findPage(0).getInheritable('Rotate').asNumber()).toBe(90);
  });

  it('a round trip (+θ then -θ) puts the content back where it was', async () => {
    const pdf = makeDoc(1);
    const before = ink(pdf, 0);
    const pageCentreBefore = centreOf(pdf, 0);
    fineRotatePage(pdf, 0, 17);
    fineRotatePage(pdf, 0, -17);
    const after = ink(pdf, 0);
    const pageCentreAfter = centreOf(pdf, 0);
    // The page grew with the first turn, so compare the content's position to the page centre, and its size.
    const [b0, b1, b2, b3] = before as Rect4;
    const [a0, a1, a2, a3] = after as Rect4;
    const offsetBefore: [number, number] = [(b0 + b2) / 2 - pageCentreBefore[0], (b1 + b3) / 2 - pageCentreBefore[1]];
    const offsetAfter: [number, number] = [(a0 + a2) / 2 - pageCentreAfter[0], (a1 + a3) / 2 - pageCentreAfter[1]];
    expect(a2 - a0).toBeCloseTo(b2 - b0, 0);
    expect(a3 - a1).toBeCloseTo(b3 - b1, 0);
    expect(offsetAfter[0]).toBeCloseTo(offsetBefore[0], 0);
    expect(offsetAfter[1]).toBeCloseTo(offsetBefore[1], 0);
  });

  it('a turned page shows its content at the turned position (pixel probe)', async () => {
    const pdf = makeDoc(1);
    const flat = ink(pdf, 0)!;
    fineRotatePage(pdf, 0, 90);
    // A quarter turn with a fine angle: the 200 by 200 box is now at the top, right way round in the new box.
    const turned = ink(pdf, 0)!;
    expect(turned[2] - turned[0]).toBeCloseTo(flat[3] - flat[1], 0);
  });
});

function centreOf(pdf: mu.PDFDocument, index: number): [number, number] {
  const b = displayBounds(pdf, index);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

describe('resize (standardize)', () => {
  it('scale to fit: the content is scaled uniformly and centred on the new page', async () => {
    const pdf = makeDoc(1);
    resizePage(pdf, 0, { width: 300, height: 300 }, 'scale');
    expect(mediaBoxOf(pdf.findPage(0))).toEqual([0, 0, 300, 300]);
    // Scale = min(300/612, 300/792) = 300/792. The scaled page is 232 by 300, centred horizontally.
    const s = 300 / 792;
    const tx = (300 - 612 * s) / 2;
    expectNear(ink(pdf, 0), [100 * s + tx, 300 - 400 * s, 300 * s + tx, 300 - 200 * s], 1.5);
  });

  it('center: the content keeps its size and is centred on a larger page', async () => {
    const pdf = makeDoc(1);
    resizePage(pdf, 0, { width: 1000, height: 1000 }, 'center');
    expect(mediaBoxOf(pdf.findPage(0))).toEqual([0, 0, 1000, 1000]);
    const tx = (1000 - 612) / 2;
    const ty = (1000 - 792) / 2;
    expectNear(ink(pdf, 0), [100 + tx, 1000 - (400 + ty), 300 + tx, 1000 - (200 + ty)], 1.5);
  });

  it('a resize is a content wrapper: the old stream is kept as the form, and the duplicate is untouched', async () => {
    const pdf = makeDoc(1);
    duplicatePageAt(pdf, 0);
    const untouchedBefore = contentsOf(pdf, 0);
    const untouchedInk = ink(pdf, 0);
    resizePage(pdf, 1, { width: 300, height: 300 }, 'scale');
    expect(contentsOf(pdf, 0)).toBe(untouchedBefore);
    expect(mediaBoxOf(pdf.findPage(0))).toEqual([0, 0, 612, 792]);
    expectNear(ink(pdf, 0), untouchedInk!, 0.01);
    expect(mediaBoxOf(pdf.findPage(1))).toEqual([0, 0, 300, 300]);
  });
});

describe('copy-on-write for duplicated pages', () => {
  it('editing one duplicate leaves the other unchanged (content, resources, and rotation)', async () => {
    const pdf = makeDoc(1);
    duplicatePageAt(pdf, 0);
    const before = contentsOf(pdf, 0);
    const inkBefore = ink(pdf, 0);
    fineRotatePage(pdf, 1, 25);
    pdf.findPage(1).put('Rotate', 90);
    expect(contentsOf(pdf, 0)).toBe(before);
    expect(pdf.findPage(0).getInheritable('Rotate').asNumber()).toBe(0);
    expect(mediaBoxOf(pdf.findPage(0))).toEqual([0, 0, 612, 792]);
    expectNear(ink(pdf, 0), inkBefore!, 0.01);
  });

  it('through the edit core: deleting or cropping one duplicate does not change the other', async () => {
    const pdf = makeDoc(1);
    const core = new EditCore(pdf, 1, true, env());
    await core.apply([{ op: 'duplicate', uids: ['0'] }]);
    const copy = core.pages().uids[1]!;
    const before = ink(pdf, 0);
    await core.apply([{ op: 'crop', uids: [copy], box: { x: 0, y: 0, width: 100, height: 100 } }]);
    expectNear(ink(pdf, 0), before!, 0.01);
    expect(core.pages().revs[0]).toBe(0);
  });

  it('copies the popup and the reply links of an annotation, pointing at the copies', async () => {
    const pdf = makeDoc(1);
    const page = pdf.findPage(0);
    const popupDict = pdf.newDictionary();
    popupDict.put('Subtype', pdf.newName('Popup'));
    popupDict.put('Rect', [0, 0, 50, 50]);
    const popupRef = pdf.addObject(popupDict);
    const annotDict = pdf.newDictionary();
    annotDict.put('Type', pdf.newName('Annot'));
    annotDict.put('Subtype', pdf.newName('Text'));
    annotDict.put('Rect', [10, 10, 30, 30]);
    annotDict.put('Popup', popupRef);
    const annotRef = pdf.addObject(annotDict);
    popupRef.resolve().put('Parent', annotRef);
    const annots = pdf.newArray();
    annots.push(annotRef);
    page.put('Annots', annots);

    duplicatePageAt(pdf, 0);
    const copyAnnots = pdf.findPage(1).get('Annots');
    const copy = copyAnnots.get(0);
    expect(copy.asIndirect()).not.toBe(annotRef.asIndirect());
    // The copy's popup is a new object, and it points back at the copy, not at the original annotation.
    const copyPopup = copy.get('Popup');
    expect(copyPopup.asIndirect()).not.toBe(popupRef.asIndirect());
    expect(copyPopup.get('Parent').asIndirect()).toBe(copy.asIndirect());
    // The annotation's page link is the copied page, not the original.
    expect(copy.get('P').asIndirect()).toBe(pdf.findPage(1).asIndirect());
    // The original annotation is untouched.
    expect(annotRef.get('Popup').asIndirect()).toBe(popupRef.asIndirect());
  });
});

describe('replace keeps references to the page', () => {
  it('overwrites the page dictionary in place, so a reference to the page still reaches it', async () => {
    const dest = makeDoc(2, () => 0);
    const source = makeDoc(1, () => 150);
    const target = dest.findPage(1);
    const targetNumber = target.asIndirect();
    const arr = dest.newArray();
    arr.push(target);
    const destRef = dest.addObject(arr);
    const core = new EditCore(dest, 2, true, env(new Map([['s1', source]])));
    const uid = core.pages().uids[1]!;
    await core.apply([{ op: 'replace', uid, sourceDocId: 's1', sourceUid: '0' }]);
    expect(dest.findPage(1).asIndirect()).toBe(targetNumber);
    expect(destRef.get(0).asIndirect()).toBe(targetNumber);
    // The shown content is the source page's: its box is 150 points to the right of the original.
    expectNear(ink(dest, 1), [250, 392, 450, 592], 1.5);
    expect(core.pages().revs[1]).toBeGreaterThan(0);
  });
});

describe('insert from another PDF', () => {
  it('grafts the chosen pages after a position, and undo removes them', async () => {
    const dest = makeDoc(2, () => 0);
    const source = makeDoc(3, (i) => 150 + i * 5);
    const core = new EditCore(dest, 2, true, env(new Map([['s1', source]])));
    const first = core.pages().uids[0]!;
    await core.apply([{ op: 'insertFrom', afterUid: first, sourceDocId: 's1', sourceUids: ['2', '0'] }]);
    expect(core.pageCount).toBe(4);
    expect(dest.countPages()).toBe(4);
    // Source page 2 sits at position 1, and its box is shifted by 160 on the page.
    expectNear(ink(dest, 1), [260, 392, 460, 592], 1.5);
    expectNear(ink(dest, 2), [250, 392, 450, 592], 1.5);
    expect(core.history.undoLabel).toBe('Insert 2 pages from PDF');
    core.undo();
    expect(dest.countPages()).toBe(2);
  });

  it('refuses a source page that is not in the source document', async () => {
    const dest = makeDoc(1, () => 0);
    const source = makeDoc(1, () => 0);
    const core = new EditCore(dest, 1, true, env(new Map([['s1', source]])));
    await expect(core.apply([{ op: 'insertFrom', afterUid: null, sourceDocId: 's1', sourceUids: ['5'] }])).rejects.toThrow(WorkerFault);
    expect(core.pageCount).toBe(1);
  });
});

describe('extract', () => {
  it('copies the chosen pages, in document order, into a new file', async () => {
    const pdf = makeDoc(4, (i) => i * 20);
    const bytes = new Uint8Array(pdf.saveToBuffer('').asUint8Array().slice());
    const core = new MupdfCore(mu, null);
    core.open(bytes, undefined);
    const out = core.extract(['3', '1']);
    const reopened = mu.Document.openDocument(new Uint8Array(out.bytes), 'application/pdf');
    expect(reopened.countPages()).toBe(2);
    const copy = reopened.asPDF()!;
    expectNear(ink(copy, 0), [120, 392, 320, 592], 1.5);
    expectNear(ink(copy, 1), [160, 392, 360, 592], 1.5);
  });
});

describe('extract from an encrypted source (ticket 1.2.1 review, item 9)', () => {
  function encryptedSource(password: string): Uint8Array {
    const pdf = makeDoc(3, (i) => i * 20);
    return new Uint8Array(pdf.saveToBuffer(`encrypt=aes-256,owner-password=${password},user-password=${password}`).asUint8Array().slice());
  }
  const open = (bytes: Uint8Array, password: string): MupdfCore => {
    const core = new MupdfCore(mu, null);
    core.open(bytes, password);
    return core;
  };

  it('keeps the password: the extract is encrypted and opens only with the same password', () => {
    const out = open(encryptedSource('secret'), 'secret').extract(['2', '0'], { password: 'secret' });
    const doc = mu.Document.openDocument(new Uint8Array(out.bytes), 'application/pdf');
    expect(doc.needsPassword()).toBe(true);
    expect(doc.authenticatePassword('wrong')).toBe(0);
    expect(doc.authenticatePassword('secret')).toBeGreaterThan(0);
    expect(doc.countPages()).toBe(2);
  });

  it('asks instead of writing an unencrypted file when the password cannot be kept', () => {
    // MuPDF's option text cannot hold a comma, so such a password cannot be written into the extract.
    const core = open(encryptedSource('secret'), 'secret');
    expect(() => core.extract(['0'], { password: 'a,b' })).toThrow(expect.objectContaining({ kind: 'NeedsEncryptionChoice' }));
  });

  it('writes an unencrypted file only when the user chose that', () => {
    const out = open(encryptedSource('secret'), 'secret').extract(['0'], { password: 'secret', dropEncryption: true });
    const doc = mu.Document.openDocument(new Uint8Array(out.bytes), 'application/pdf');
    expect(doc.needsPassword()).toBe(false);
    expect(doc.countPages()).toBe(1);
  });

  it('an unencrypted source still extracts unencrypted', () => {
    const bytes = new Uint8Array(makeDoc(2, () => 0).saveToBuffer('').asUint8Array().slice());
    const out = open(bytes, '').extract(['1']);
    expect(mu.Document.openDocument(new Uint8Array(out.bytes), 'application/pdf').needsPassword()).toBe(false);
  });
});

describe('recorded page identities', () => {
  it('a rotate, crop or resize bumps the rev of the page it changed, and nothing else', async () => {
    const pdf = makeDoc(3);
    const core = new EditCore(pdf, 3, true, env());
    await core.apply([{ op: 'rotate', uids: ['1'], degrees: 90 }]);
    expect(core.pages().revs).toEqual([0, 1, 0]);
    await core.apply([{ op: 'resize', uids: ['2'], size: { width: 300, height: 300 }, fit: 'scale' }]);
    expect(core.pages().revs).toEqual([0, 1, 2]);
    await core.apply([{ op: 'rotate', uids: ['0'], degrees: 17 }]);
    expect(core.pages().revs[0]).toBe(3);
  });

  it('an undo brings back the old list, and a new rev is never reused', async () => {
    const pdf = makeDoc(2);
    const core = new EditCore(pdf, 2, true, env());
    await core.apply([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    core.undo();
    expect(core.pages().revs).toEqual([0, 0]);
    await core.apply([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    // The redo-free edit gets a fresh rev, so a bitmap cached for the undone state is never reused.
    expect(core.pages().revs[0]).toBeGreaterThan(1);
  });

  it('rejects a crop the page would not contain', async () => {
    const pdf = makeDoc(1);
    expect(() => setCropBox(mu, pdf, 0, [700, 700, 800, 800])).toThrow(WorkerFault);
  });
});

describe('long operations on the 1,000-page file', () => {
  it('auto-crops 100 pages and resizes 1,000 pages, reporting the times', async () => {
    const pdf = mu.Document.openDocument(new Uint8Array(readFileSync(BIG)), 'application/pdf').asPDF()!;
    const core = new EditCore(pdf, pdf.countPages(), true, env());
    const all = core.pages().uids;

    const cropStart = performance.now();
    await core.apply([{ op: 'crop', uids: all.slice(0, 100), box: 'auto' }]);
    const cropMs = performance.now() - cropStart;

    const resizeStart = performance.now();
    await core.apply([{ op: 'resize', uids: all, size: { width: 612, height: 792 }, fit: 'scale' }]);
    const resizeMs = performance.now() - resizeStart;

    console.log(`auto-crop of 100 pages: ${cropMs.toFixed(0)} ms; resize of 1000 pages: ${resizeMs.toFixed(0)} ms`);
    expect(core.pageCount).toBe(1000);
    expect(cropMs).toBeLessThan(60_000);
    expect(resizeMs).toBeLessThan(60_000);
  }, 180_000);
});

describe('edit requests', () => {
  it('a fine-angle rotate is one edit in the journal, and undoes in one step', async () => {
    const pdf = makeDoc(2);
    const core = new EditCore(pdf, 2, true, env());
    const edits: PageEdit[] = [{ op: 'rotate', uids: ['0', '1'], degrees: 12.5 }];
    await core.apply(edits);
    expect(pdf.getJournal().position).toBe(1);
    expect(core.history.undoLabel).toBe('Rotate 2 pages');
    core.undo();
    expect(mediaBoxOf(pdf.findPage(0))).toEqual([0, 0, 612, 792]);
  });
});
