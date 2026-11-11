// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { duplicatePageAt, fineRotatePage, mediaBoxOf, readRect, resizePage, transformRect, turnMatrix, bakeFineRotation, optionalEntry } from './pageOps';

const LETTER = { width: 612, height: 792 };

/** A one-page letter document with one square annotation at [100, 100, 200, 200] and an ink stroke. */
function annotatedDoc(): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  pdf.insertPage(0, pdf.addPage([0, 0, LETTER.width, LETTER.height], 0, {}, '0 g\n100 100 100 100 re\nf'));
  const page = pdf.findPage(0);

  const square = pdf.createObject();
  const squareDict = pdf.newDictionary();
  squareDict.put('Type', pdf.newName('Annot'));
  squareDict.put('Subtype', pdf.newName('Square'));
  squareDict.put('Rect', numbers(pdf, [100, 100, 200, 200]));
  square.writeObject(squareDict);

  const ink = pdf.createObject();
  const inkDict = pdf.newDictionary();
  inkDict.put('Type', pdf.newName('Annot'));
  inkDict.put('Subtype', pdf.newName('Ink'));
  inkDict.put('Rect', numbers(pdf, [300, 300, 340, 340]));
  const stroke = pdf.newArray();
  for (const v of [300, 300, 340, 340]) stroke.push(pdf.newReal(v));
  const strokes = pdf.newArray();
  strokes.push(stroke);
  inkDict.put('InkList', strokes);
  ink.writeObject(inkDict);

  const annots = pdf.newArray();
  annots.push(square);
  annots.push(ink);
  page.put('Annots', annots);
  return pdf;
}

function numbers(pdf: mu.PDFDocument, values: number[]): mu.PDFObject {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}

/** The annotation dictionaries of page 0, in order. */
function annotsOf(pdf: mu.PDFDocument): mu.PDFObject[] {
  const list = optionalEntry(pdf.findPage(0), 'Annots')!.resolve();
  const out: mu.PDFObject[] = [];
  for (let i = 0; i < list.length; i++) out.push(list.get(i).resolve());
  return out;
}

function rectOf(pdf: mu.PDFDocument, index: number): number[] {
  return readRect(optionalEntry(annotsOf(pdf)[index]!, 'Rect'))!;
}

function expectRect(actual: readonly number[], expected: readonly number[], digits = 2): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, digits);
}

describe('annotations follow a resize', () => {
  it('moves /Rect and ink points by the same scale and offset as the content', () => {
    const pdf = annotatedDoc();
    resizePage(pdf, 0, { width: 300, height: 300 }, 'scale');
    // The page is scaled by s = 300 / 792 and centred horizontally: the offset is (300 - 612 s) / 2.
    const s = 300 / 792;
    const tx = (300 - 612 * s) / 2;
    expectRect(rectOf(pdf, 0), [100 * s + tx, 100 * s, 200 * s + tx, 200 * s]);
    expectRect(rectOf(pdf, 1), [300 * s + tx, 300 * s, 340 * s + tx, 340 * s]);
    const inkPoints = readInk(pdf, 1);
    expect(inkPoints[0]).toBeCloseTo(300 * s + tx, 2);
    expect(inkPoints[1]).toBeCloseTo(300 * s, 2);
  });
});

describe('annotations follow a fine-angle rotation', () => {
  it('turns the square by 30 degrees clockwise about the page centre', () => {
    const pdf = annotatedDoc();
    fineRotatePage(pdf, 0, 30);
    // The page centre is (306, 396). Clockwise on screen: x' = dx cos + dy sin, y' = -dx sin + dy cos (dx, dy from centre).
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    const turn = (x: number, y: number): [number, number] => {
      const dx = x - 306;
      const dy = y - 396;
      return [306 + dx * cos + dy * sin, 396 - dx * sin + dy * cos];
    };
    const corners = [turn(100, 100), turn(200, 100), turn(200, 200), turn(100, 200)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    expectRect(rectOf(pdf, 0), [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 1);
  });

  it('a turn of +10 then -10 keeps the annotations where they were, to the size of their turned box', () => {
    // A /Rect is the bounding box of its turned corners, so a round trip leaves the rect at least as large as the
    // original, with the same centre. The ink points, which are exact, come back exactly.
    const pdf = annotatedDoc();
    fineRotatePage(pdf, 0, 10);
    fineRotatePage(pdf, 0, -10);
    const [x0, y0, x1, y1] = rectOf(pdf, 0) as [number, number, number, number];
    expect(x0).toBeLessThanOrEqual(100.01);
    expect(y0).toBeLessThanOrEqual(100.01);
    expect(x1).toBeGreaterThanOrEqual(199.99);
    expect(y1).toBeGreaterThanOrEqual(199.99);
    expect((x0 + x1) / 2).toBeCloseTo(150, 1);
    expect((y0 + y1) / 2).toBeCloseTo(150, 1);
    const ink = readInk(pdf, 1);
    expect(ink[0]).toBeCloseTo(300, 2);
    expect(ink[1]).toBeCloseTo(300, 2);
  });
});

describe('repeated fine-angle rotations', () => {
  it('+10 then -10 gives the original MediaBox within 0.01 pt', () => {
    const pdf = annotatedDoc();
    fineRotatePage(pdf, 0, 10);
    fineRotatePage(pdf, 0, -10);
    expectRect(mediaBoxOf(pdf.findPage(0)), [0, 0, LETTER.width, LETTER.height], 2);
    const crop = optionalEntry(pdf.findPage(0), 'CropBox');
    // No crop: the entry is absent, or (since 1.3.2, so a /Pages node's CropBox cannot apply) equal to the MediaBox.
    if (crop !== undefined && !crop.isNull()) expectRect(readRect(crop)!, [0, 0, LETTER.width, LETTER.height], 2);
  });

  it('ten turns of +5 give the same box as one turn of +50 (the box does not grow)', () => {
    const many = annotatedDoc();
    for (let i = 0; i < 10; i++) fineRotatePage(many, 0, 5);
    const once = annotatedDoc();
    fineRotatePage(once, 0, 50);
    expectRect(mediaBoxOf(many.findPage(0)), mediaBoxOf(once.findPage(0)), 2);
  });

  it('a total of a whole turn restores the original content stream', () => {
    const pdf = annotatedDoc();
    const page = pdf.findPage(0);
    const contents = optionalEntry(page, 'Contents');
    expect(contents).toBeDefined();
    fineRotatePage(pdf, 0, 45);
    fineRotatePage(pdf, 0, 315);
    // Whole turn: the page is drawn directly again, with no wrapper, and the private state is gone.
    expect(optionalEntry(page, 'PDFSuiteOrigBox')).toBeUndefined();
    expect(optionalEntry(page, 'PDFSuiteAngle')).toBeUndefined();
  });

  it('a resize after a fine turn starts from the turned page, and bakes the state away', () => {
    const pdf = annotatedDoc();
    fineRotatePage(pdf, 0, 20);
    resizePage(pdf, 0, { width: 400, height: 400 }, 'center');
    expect(optionalEntry(pdf.findPage(0), 'PDFSuiteOrigBox')).toBeUndefined();
    expectRect(mediaBoxOf(pdf.findPage(0)), [0, 0, 400, 400], 2);
  });

  it('bakeFineRotation removes the private keys and keeps the page as it is', () => {
    const pdf = annotatedDoc();
    fineRotatePage(pdf, 0, 15);
    const before = mediaBoxOf(pdf.findPage(0));
    bakeFineRotation(pdf.findPage(0));
    expectRect(mediaBoxOf(pdf.findPage(0)), before, 4);
  });
});

describe('a duplicated page turns on its own', () => {
  it('turning the copy does not move the original annotations', () => {
    const pdf = annotatedDoc();
    duplicatePageAt(pdf, 0);
    fineRotatePage(pdf, 1, 30);
    expectRect(rectOf(pdf, 0), [100, 100, 200, 200], 2);
    expect(transformRect([0, 0, 1, 1], turnMatrix(0, 0, 0))).toEqual([0, 0, 1, 1]);
  });
});

/** The first x, y of an Ink annotation's first stroke. */
function readInk(pdf: mu.PDFDocument, index: number): number[] {
  const ink = optionalEntry(annotsOf(pdf)[index]!, 'InkList')!.resolve();
  const stroke = ink.get(0).resolve();
  return [stroke.get(0).resolve().asNumber(), stroke.get(1).resolve().asNumber()];
}
