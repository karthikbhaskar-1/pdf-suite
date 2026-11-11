// @vitest-environment node
// 1.3.1 Slice ("Cut Pages in Half"): the geometry and page-order maths for every option, the engine edit on real MuPDF
// documents (rotated, cropped and mixed-size pages, annotations), undo and redo, save and reopen, and recovery replay.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore, labelFor } from './editCore';
import { MupdfCore } from './core';
import {
  displayBounds,
  fineRotatePage,
  normalize,
  optionalEntry,
  readRect,
  sliceFits,
  sliceGeometry,
  sliceHalfOf,
  type Rect4,
  type SliceCut,
  type SliceFirst,
} from './pageOps';
import { pageFingerprints } from './pageFingerprint';
import type { PageEdit } from './protocol';
import { EditLog, parseEditLog, replayLog, type LogPort } from '../../features/recovery/editLog';

const env = { mu, sources: new Map<string, mu.PDFDocument>() };

function numbers(pdf: mu.PDFDocument, values: readonly number[]): mu.PDFObject {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}

/** Filled boxes in user space, spread over a 600 x 400 media box, none symmetric: a half that shows the wrong part differs. */
const BOXES = [
  [30, 40, 60, 30],
  [200, 300, 90, 40],
  [310, 100, 50, 120],
  [480, 20, 100, 60],
  [560, 330, 30, 50],
  [100, 150, 20, 20],
  [150, 200, 300, 6],
];
const CONTENT = `0 g\n${BOXES.map((b) => `${b.join(' ')} re\nf`).join('\n')}`;

interface PageSpec {
  media?: Rect4;
  rotate?: number;
  crop?: Rect4;
}

function addPage(pdf: mu.PDFDocument, spec: PageSpec = {}, content = CONTENT): void {
  const media = spec.media ?? [0, 0, 600, 400];
  // The boxes are drawn relative to the media box's corner, so every kind of page has ink in every part.
  const drawn = media[0] === 0 && media[1] === 0 ? content : `q 1 0 0 1 ${media[0]} ${media[1]} cm
${content}
Q`;
  const page = pdf.addPage(media, (spec.rotate ?? 0) as 0 | 90 | 180 | 270, {}, drawn);
  pdf.insertPage(pdf.countPages(), page);
  if (spec.crop) pdf.findPage(pdf.countPages() - 1).put('CropBox', numbers(pdf, spec.crop));
}

function makeDoc(specs: PageSpec[]): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  for (const spec of specs) addPage(pdf, spec);
  return pdf;
}

/** A page drawn in gray at one pixel per point, in display space, as width, height and rows of pixels. */
function render(pdf: mu.PDFDocument, index: number): { w: number; h: number; px: Uint8Array } {
  const b = displayBounds(pdf, index);
  const w = Math.round(b[2] - b[0]);
  const h = Math.round(b[3] - b[1]);
  const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, w, h], false);
  try {
    pixmap.clear(255);
    const loaded = pdf.loadPage(index);
    try {
      const device = new mu.DrawDevice([1, 0, 0, 1, -b[0], -b[1]], pixmap);
      try {
        loaded.run(device, mu.Matrix.identity);
      } finally {
        device.close();
        device.destroy();
      }
    } finally {
      loaded.destroy();
    }
    const stride = pixmap.getStride();
    const source = pixmap.getPixels();
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) px.set(source.subarray(y * stride, y * stride + w), y * w);
    return { w, h, px };
  } finally {
    pixmap.destroy();
  }
}

/** The part of a render inside `rect` (display points, whole numbers). */
function cropOf(image: { w: number; h: number; px: Uint8Array }, rect: Rect4): { w: number; h: number; px: Uint8Array } {
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(v)) as Rect4;
  const w = x1 - x0;
  const h = y1 - y0;
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = image.px[(y0 + y) * image.w + x0 + x]!;
  return { w, h, px };
}

function inkOf(image: { px: Uint8Array }): number {
  let n = 0;
  for (const v of image.px) if (v < 128) n++;
  return n;
}

function sameImage(a: { w: number; h: number; px: Uint8Array }, b: { w: number; h: number; px: Uint8Array }): boolean {
  return a.w === b.w && a.h === b.h && a.px.every((v, i) => v === b.px[i]);
}

const slice = (uids: string[], cut: SliceCut, at: number, first: SliceFirst): PageEdit => ({ op: 'slice', uids, cut, at, first });

describe('slice geometry: where the cut falls and which half comes first', () => {
  const BOUNDS: Rect4 = [0, 0, 600, 400];

  it('a vertical cut puts the left half first, and "right page first" reverses the pair', () => {
    const left = sliceGeometry(BOUNDS, 'vertical', 0.5, 'left');
    expect(left.first).toEqual([0, 0, 300, 400]);
    expect(left.second).toEqual([300, 0, 600, 400]);
    const right = sliceGeometry(BOUNDS, 'vertical', 0.5, 'right');
    expect(right.first).toEqual([300, 0, 600, 400]);
    expect(right.second).toEqual([0, 0, 300, 400]);
  });

  it('a horizontal cut is always top first, whatever the page order says', () => {
    for (const first of ['left', 'right'] as const) {
      const g = sliceGeometry(BOUNDS, 'horizontal', 0.5, first);
      expect(g.first).toEqual([0, 0, 600, 200]);
      expect(g.second).toEqual([0, 200, 600, 400]);
    }
  });

  it('the cut position is a share of the width (vertical) or the height (horizontal), from 30% to 70%', () => {
    expect(sliceGeometry(BOUNDS, 'vertical', 0.3, 'left').line).toBeCloseTo(180);
    expect(sliceGeometry(BOUNDS, 'vertical', 0.7, 'left').line).toBeCloseTo(420);
    expect(sliceGeometry(BOUNDS, 'horizontal', 0.3, 'left').line).toBeCloseTo(120);
    expect(sliceGeometry(BOUNDS, 'horizontal', 0.7, 'left').line).toBeCloseTo(280);
    expect(sliceGeometry(BOUNDS, 'vertical', 0.45, 'left').first).toEqual([0, 0, 270, 400]);
  });

  it('bounds that do not start at the origin (a cropped page) are cut inside themselves', () => {
    const g = sliceGeometry([50, 50, 550, 350], 'vertical', 0.4, 'left');
    expect(g.first).toEqual([50, 50, 250, 350]);
    expect(g.second).toEqual([250, 50, 550, 350]);
  });

  it('the two halves always cover the page exactly, without overlap', () => {
    for (const cut of ['vertical', 'horizontal'] as const) {
      for (const first of ['left', 'right'] as const) {
        for (const at of [0.3, 0.37, 0.5, 0.66, 0.7]) {
          const g = sliceGeometry([10, 20, 410, 320], cut, at, first);
          const [a, b] = [normalize(g.first), normalize(g.second)];
          const area = (r: Rect4) => (r[2] - r[0]) * (r[3] - r[1]);
          expect(area(a) + area(b)).toBeCloseTo(400 * 300, 6);
        }
      }
    }
  });

  it('a point goes to the half that holds it, and a point on the line goes to the half after the line', () => {
    const g = sliceGeometry(BOUNDS, 'vertical', 0.5, 'left');
    expect(sliceHalfOf(g, 'vertical', [299, 10])).toBe('first');
    expect(sliceHalfOf(g, 'vertical', [300, 10])).toBe('second');
    const r = sliceGeometry(BOUNDS, 'vertical', 0.5, 'right');
    expect(sliceHalfOf(r, 'vertical', [100, 10])).toBe('second');
    expect(sliceHalfOf(r, 'vertical', [400, 10])).toBe('first');
    const h = sliceGeometry(BOUNDS, 'horizontal', 0.5, 'left');
    expect(sliceHalfOf(h, 'horizontal', [500, 100])).toBe('first');
    expect(sliceHalfOf(h, 'horizontal', [10, 300])).toBe('second');
  });

  it('wide pages are cut left and right, tall pages top and bottom, and a square page is neither', () => {
    expect(sliceFits({ width: 800, height: 600 }, 'vertical')).toBe(true);
    expect(sliceFits({ width: 600, height: 800 }, 'vertical')).toBe(false);
    expect(sliceFits({ width: 600, height: 800 }, 'horizontal')).toBe(true);
    expect(sliceFits({ width: 800, height: 600 }, 'horizontal')).toBe(false);
    expect(sliceFits({ width: 500, height: 500 }, 'vertical')).toBe(false);
    expect(sliceFits({ width: 500, height: 500 }, 'horizontal')).toBe(false);
  });

  it('the undo label says how many pages were cut', () => {
    expect(labelFor([slice(['0'], 'vertical', 0.5, 'left')])).toBe('Cut 1 page in half');
    expect(labelFor([slice(['0', '1', '2'], 'horizontal', 0.5, 'left')])).toBe('Cut 3 pages in half');
  });
});

describe('slice on real pages: each half shows exactly its part of the page', () => {
  const KINDS: Array<[string, PageSpec]> = [
    ['plain', {}],
    ['turned 90', { rotate: 90 }],
    ['turned 180', { rotate: 180 }],
    ['turned 270', { rotate: 270 }],
    ['cropped', { crop: [50, 50, 550, 350] }],
    ['cropped and turned 90', { rotate: 90, crop: [50, 50, 550, 350] }],
    ['cropped off-centre and turned 270', { rotate: 270, crop: [100, 0, 600, 300] }],
    ['media box not at the origin', { media: [100, 100, 700, 500] }],
  ];

  for (const [name, spec] of KINDS) {
    for (const cut of ['vertical', 'horizontal'] as const) {
      for (const first of ['left', 'right'] as const) {
        for (const at of [0.3, 0.5, 0.7]) {
          it(`${name}, ${cut} cut at ${at * 100}%, ${first} first: both halves are the right pixels`, async () => {
            const pdf = makeDoc([spec]);
            const original = render(pdf, 0);
            const bounds = displayBounds(pdf, 0);
            const g = sliceGeometry(bounds, cut, at, first);
            const core = new EditCore(pdf, 1, true, env);
            await core.apply([slice(['0'], cut, at, first)]);

            expect(pdf.countPages()).toBe(2);
            expect(core.pages().uids).toEqual(['0', 'n1']);
            const origin: Rect4 = [bounds[0], bounds[1], bounds[0], bounds[1]];
            const sub = (r: Rect4): Rect4 => [r[0] - origin[0], r[1] - origin[1], r[2] - origin[2], r[3] - origin[3]];
            const firstHalf = render(pdf, 0);
            const secondHalf = render(pdf, 1);
            expect(sameImage(firstHalf, cropOf(original, sub(g.first)))).toBe(true);
            expect(sameImage(secondHalf, cropOf(original, sub(g.second)))).toBe(true);
            // Not a vacuous pass: the halves hold different ink, and together they hold all of it.
            expect(inkOf(firstHalf)).toBeGreaterThan(0);
            expect(inkOf(secondHalf)).toBeGreaterThan(0);
            expect(inkOf(firstHalf) + inkOf(secondHalf)).toBe(inkOf(original));
            // The halves have the sizes the geometry gave.
            const size = (r: Rect4) => [Math.round(r[2] - r[0]), Math.round(r[3] - r[1])];
            expect([firstHalf.w, firstHalf.h]).toEqual(size(g.first));
            expect([secondHalf.w, secondHalf.h]).toEqual(size(g.second));
          });
        }
      }
    }
  }

  it('the page keeps its uid as the first half (with a new rev) and the second half is a new page after it', async () => {
    const pdf = makeDoc([{}, {}, {}]);
    const core = new EditCore(pdf, 3, true, env);
    const before = core.pages();
    await core.apply([slice(['1'], 'vertical', 0.5, 'left')]);
    const after = core.pages();
    expect(after.uids).toEqual(['0', '1', 'n1', '2']);
    expect(after.revs[0]).toBe(before.revs[0]);
    expect(after.revs[3]).toBe(before.revs[2]);
    // The first half has new content (a rev never used before); the second half has another new rev.
    expect(after.revs[1]).not.toBe(before.revs[1]);
    expect(after.revs[2]).not.toBe(after.revs[1]);
    expect(new Set([after.revs[1], after.revs[2]]).size).toBe(2);
    expect(Math.min(after.revs[1]!, after.revs[2]!)).toBeGreaterThan(Math.max(...before.revs));
  });

  it('pages are cut last to first, so the new uids count up from the last page and the order stays right', async () => {
    const pdf = makeDoc([{}, {}, {}, {}]);
    const core = new EditCore(pdf, 4, true, env);
    await core.apply([slice(['0', '1', '2', '3'], 'vertical', 0.5, 'left')]);
    expect(core.pages().uids).toEqual(['0', 'n4', '1', 'n3', '2', 'n2', '3', 'n1']);
    expect(pdf.countPages()).toBe(8);
  });

  it('a range of pages: only the named pages are cut, the others are untouched and keep their order', async () => {
    const specs: PageSpec[] = [
      { media: [0, 0, 600, 400] },
      { media: [0, 0, 800, 500], rotate: 90 },
      { media: [0, 0, 300, 700] },
      { media: [0, 0, 500, 300], crop: [10, 10, 490, 290] },
      { media: [0, 0, 612, 792] },
    ];
    const pdf = makeDoc(specs);
    const core = new EditCore(pdf, 5, true, env);
    const prints = pageFingerprints(pdf);
    await core.apply([slice(['1', '3'], 'vertical', 0.4, 'right')]);
    // Last page first: the later page (3) gets n1 and the earlier one (1) gets n2, as Duplicate does.
    expect(core.pages().uids).toEqual(['0', '1', 'n2', '2', '3', 'n1', '4']);
    const after = pageFingerprints(pdf);
    // Pages 0, 2 and 4 are byte for byte what they were.
    expect([after[0], after[3], after[6]]).toEqual([prints[0], prints[2], prints[4]]);
    // The cut pages' halves have the sizes of the mixed originals: 500 x 800 turned, then 480 x 280 cropped.
    const sizes = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const b = displayBounds(pdf, i);
      return [Math.round((b[2] - b[0]) * 10) / 10, Math.round((b[3] - b[1]) * 10) / 10];
    });
    expect(sizes[0]).toEqual([600, 400]);
    // Page 1 is 800 x 500 turned 90: shown 500 wide and 800 tall. Cut at 40%, right first: the right 300 comes first.
    expect(sizes[1]).toEqual([300, 800]);
    expect(sizes[2]).toEqual([200, 800]);
    expect(sizes[3]).toEqual([300, 700]);
    expect(sizes[4]![1]).toBe(280);
    expect(sizes[6]).toEqual([612, 792]);
  });

  it('a page cut again (a half cut again) gives quarters that match the original', async () => {
    const pdf = makeDoc([{}]);
    const original = render(pdf, 0);
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    await core.apply([slice(['0', 'n1'], 'horizontal', 0.5, 'left')]);
    expect(pdf.countPages()).toBe(4);
    // Order after the second cut: left top, left bottom, right top, right bottom.
    const quarter = (i: number) => render(pdf, i);
    expect(sameImage(quarter(0), cropOf(original, [0, 0, 300, 200]))).toBe(true);
    expect(sameImage(quarter(1), cropOf(original, [0, 200, 300, 400]))).toBe(true);
    expect(sameImage(quarter(2), cropOf(original, [300, 0, 600, 200]))).toBe(true);
    expect(sameImage(quarter(3), cropOf(original, [300, 200, 600, 400]))).toBe(true);
  });

  it('a page turned by a fine angle is cut as it is shown, and the halves carry no private rotation state', async () => {
    const pdf = makeDoc([{}]);
    fineRotatePage(pdf, 0, 10);
    const bounds = displayBounds(pdf, 0);
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    expect(pdf.countPages()).toBe(2);
    for (const i of [0, 1]) {
      const page = pdf.findPage(i);
      expect(optionalEntry(page, 'PDFSuiteAngle')).toBeUndefined();
      expect(optionalEntry(page, 'PDFSuiteOrigBox')).toBeUndefined();
      const b = displayBounds(pdf, i);
      expect(b[2] - b[0]).toBeCloseTo((bounds[2] - bounds[0]) / 2, 1);
    }
  });

  it('refuses a cut position outside 30% to 70%, and leaves the document as it was', async () => {
    const pdf = makeDoc([{}]);
    const core = new EditCore(pdf, 1, true, env);
    for (const at of [0.29, 0.71, 0, 1, Number.NaN]) {
      await expect(core.apply([slice(['0'], 'vertical', at, 'left')])).rejects.toMatchObject({ kind: 'Unsupported' });
    }
    expect(pdf.countPages()).toBe(1);
    expect(core.history.canUndo).toBe(false);
    expect(core.pages().uids).toEqual(['0']);
  });

  it('refuses a page that is not in the document (a stale uid) without changing anything', async () => {
    const pdf = makeDoc([{}, {}]);
    const core = new EditCore(pdf, 2, true, env);
    await expect(core.apply([slice(['0', 'gone'], 'vertical', 0.5, 'left')])).rejects.toMatchObject({ kind: 'Conflict' });
    expect(pdf.countPages()).toBe(2);
    expect(core.history.dirty).toBe(false);
  });
});

describe('slice: edit, undo and redo are one step each', () => {
  it('one apply is one undo step; undo restores every page exactly, redo brings the cut back', async () => {
    const pdf = makeDoc([{}, { rotate: 90 }, { crop: [50, 50, 550, 350] }]);
    const core = new EditCore(pdf, 3, true, env);
    const prints = pageFingerprints(pdf);
    const uids = core.pages().uids;
    await core.apply([slice(core.pages().uids, 'vertical', 0.45, 'right')]);
    const cutPrints = pageFingerprints(pdf);
    const cutPages = core.pages();
    expect(pdf.countPages()).toBe(6);
    expect(core.history.undoLabel).toBe('Cut 3 pages in half');

    core.undo();
    expect(pdf.countPages()).toBe(3);
    expect(pageFingerprints(pdf)).toEqual(prints);
    expect(core.pages().uids).toEqual(uids);
    expect(core.history.canUndo).toBe(false);
    expect(core.history.redoLabel).toBe('Cut 3 pages in half');

    core.redo();
    expect(pdf.countPages()).toBe(6);
    expect(pageFingerprints(pdf)).toEqual(cutPrints);
    expect(core.pages()).toEqual(cutPages);
    core.undo();
    core.redo();
    expect(pageFingerprints(pdf)).toEqual(cutPrints);
  });

  it('a slice after other edits undoes on its own, and the edits before it stay', async () => {
    const pdf = makeDoc([{}, {}]);
    const core = new EditCore(pdf, 2, true, env);
    await core.apply([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    const afterRotate = pageFingerprints(pdf);
    await core.apply([slice(['0', '1'], 'horizontal', 0.5, 'left')]);
    expect(pdf.countPages()).toBe(4);
    core.undo();
    expect(pageFingerprints(pdf)).toEqual(afterRotate);
    expect(core.history.undoLabel).toBe('Rotate 1 page');
  });

  it('a cancelled slice (a throw part way) leaves no page, no step and no uid used', async () => {
    const pdf = makeDoc([{}, {}, {}, {}]);
    const core = new EditCore(pdf, 4, true, env);
    const prints = pageFingerprints(pdf);
    await expect(
      core.apply([slice(core.pages().uids, 'vertical', 0.5, 'left')], async (done) => {
        if (done === 2) throw new Error('Cancelled');
      }),
    ).rejects.toThrow();
    expect(pdf.countPages()).toBe(4);
    expect(pageFingerprints(pdf)).toEqual(prints);
    expect(core.pages().uids).toEqual(['0', '1', '2', '3']);
    expect(core.history.canUndo).toBe(false);
    await core.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    expect(core.pages().uids).toEqual(['0', 'n1', '1', '2', '3']);
  });
});

describe('slice and save: the written file holds the halves', () => {
  it('saves and reopens with the pages, sizes, crop boxes and content of the cut document', async () => {
    const pdf = makeDoc([{}, { rotate: 90 }, { crop: [50, 50, 550, 350] }]);
    const core = new EditCore(pdf, 3, true, env);
    await core.apply([slice(core.pages().uids, 'vertical', 0.5, 'right')]);
    const expected = pageFingerprints(pdf);
    const renders = [0, 1, 2, 3, 4, 5].map((i) => render(pdf, i));
    const bytes = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
    const reopened = mu.Document.openDocument(bytes, 'application/pdf').asPDF()!;
    expect(reopened.countPages()).toBe(6);
    expect(pageFingerprints(reopened)).toEqual(expected);
    renders.forEach((image, i) => expect(sameImage(render(reopened, i), image)).toBe(true));
    // The shared content streams are not doubled: three pages of content, not six. The streams are large (about 60 KB each,
    // written uncompressed), so a copied stream would add about 180 KB; the cut itself adds only three small page objects.
    const filler = Array.from({ length: 4000 }, (_, i) => `${i % 500} ${i % 300} 2 2 re\nf`).join('\n');
    const largeDoc = new mu.PDFDocument();
    for (let i = 0; i < 3; i++) largeDoc.insertPage(i, largeDoc.addPage([0, 0, 600, 400], 0, {}, `${CONTENT}\n${filler}`));
    const largePlain = largeDoc.saveToBuffer('garbage=compact').asUint8Array().length;
    expect(largePlain).toBeGreaterThan(150_000);
    const largeCore = new EditCore(largeDoc, 3, true, env);
    await largeCore.apply([slice(largeCore.pages().uids, 'vertical', 0.5, 'right')]);
    expect(largeDoc.countPages()).toBe(6);
    const largeCut = largeDoc.saveToBuffer('garbage=compact').asUint8Array().length;
    expect(largeCut).toBeLessThan(largePlain + 3000);
  });

  it('cut, save, reopen, cut one half again, save, reopen: quarters match the original', async () => {
    const first = makeDoc([{}]);
    const original = render(first, 0);
    const core1 = new EditCore(first, 1, true, env);
    await core1.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    const saved1 = first.saveToBuffer('garbage=compact').asUint8Array().slice();
    const second = mu.Document.openDocument(saved1, 'application/pdf').asPDF()!;
    const core2 = new EditCore(second, 2, true, env);
    // After a save the uids start again at 0: cut the second half (the right one).
    await core2.apply([slice(['1'], 'horizontal', 0.5, 'left')]);
    const saved2 = second.saveToBuffer('garbage=compact').asUint8Array().slice();
    const third = mu.Document.openDocument(saved2, 'application/pdf').asPDF()!;
    expect(third.countPages()).toBe(3);
    expect(sameImage(render(third, 0), cropOf(original, [0, 0, 300, 400]))).toBe(true);
    expect(sameImage(render(third, 1), cropOf(original, [300, 0, 600, 200]))).toBe(true);
    expect(sameImage(render(third, 2), cropOf(original, [300, 200, 600, 400]))).toBe(true);
  });
});

describe('slice and annotations: each goes to the half that holds its centre', () => {
  /** A one-page 600 x 400 document with a link on each side, a note with a popup, a note whose popup lies in the other half, and a widget. */
  function annotated(): { pdf: mu.PDFDocument; keys: Record<string, mu.PDFObject> } {
    const pdf = makeDoc([{}]);
    const page = pdf.findPage(0);
    const make = (entries: Record<string, mu.PDFObject>): mu.PDFObject => {
      const ref = pdf.createObject();
      const dict = pdf.newDictionary();
      dict.put('Type', pdf.newName('Annot'));
      for (const [k, v] of Object.entries(entries)) dict.put(k, v);
      ref.writeObject(dict);
      return ref;
    };
    const rect = (r: number[]) => numbers(pdf, r);
    const name = (n: string) => pdf.newName(n);
    const keys: Record<string, mu.PDFObject> = {};
    keys.linkLeft = make({ Subtype: name('Link'), Rect: rect([20, 20, 100, 60]) });
    keys.linkRight = make({ Subtype: name('Link'), Rect: rect([400, 20, 500, 60]) });
    keys.noteLeft = make({ Subtype: name('Text'), Rect: rect([50, 300, 70, 320]), Contents: pdf.newString('left note') });
    // The popup of the left note sits far to the right, in the right half: it must still follow its parent.
    keys.popupLeft = make({ Subtype: name('Popup'), Rect: rect([450, 200, 580, 280]), Parent: keys.noteLeft! });
    keys.noteLeft.resolve().put('Popup', keys.popupLeft);
    keys.noteRight = make({ Subtype: name('Text'), Rect: rect([520, 300, 540, 320]), Contents: pdf.newString('right note') });
    keys.popupRight = make({ Subtype: name('Popup'), Rect: rect([10, 10, 100, 80]), Parent: keys.noteRight! });
    keys.noteRight.resolve().put('Popup', keys.popupRight);
    // A widget whose rectangle straddles the cut: its centre is at x = 310, so it goes right.
    keys.widget = make({ Subtype: name('Widget'), Rect: rect([280, 100, 340, 130]), FT: name('Tx'), T: pdf.newString('f1') });
    const list = pdf.newArray();
    for (const k of ['linkLeft', 'linkRight', 'noteLeft', 'popupLeft', 'noteRight', 'popupRight', 'widget']) {
      const ref = keys[k]!;
      list.push(ref);
    }
    page.put('Annots', list);
    // P on the notes points at the page.
    return { pdf, keys };
  }

  const annotsOf = (pdf: mu.PDFDocument, index: number) => {
    const list = optionalEntry(pdf.findPage(index), 'Annots')?.resolve();
    const out: mu.PDFObject[] = [];
    if (list && list.isArray()) for (let i = 0; i < list.length; i++) out.push(list.get(i).resolve());
    return out;
  };
  const subtypes = (dicts: mu.PDFObject[]) => dicts.map((d) => `${optionalEntry(d, 'Subtype')!.asName()}${optionalEntry(d, 'T') ? ':' + optionalEntry(d, 'T')!.asString() : ''}`);

  it('partitions by the centre of /Rect: links, notes with their popups, and a widget on the line', async () => {
    const { pdf } = annotated();
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    expect(subtypes(annotsOf(pdf, 0))).toEqual(['Link', 'Text', 'Popup']);
    expect(subtypes(annotsOf(pdf, 1))).toEqual(['Link', 'Text', 'Popup', 'Widget:f1']);
    // Nothing is copied: no annotation is on both pages.
    expect(annotsOf(pdf, 0).length + annotsOf(pdf, 1).length).toBe(7);
  });

  it('a popup follows its parent into the other half, and the popup stays the one its parent points at', async () => {
    const { pdf } = annotated();
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    const left = annotsOf(pdf, 0);
    const note = left.find((d) => optionalEntry(d, 'Subtype')!.asName() === 'Text')!;
    const popup = left.find((d) => optionalEntry(d, 'Subtype')!.asName() === 'Popup')!;
    expect(readRect(optionalEntry(popup, 'Rect'))).toEqual([450, 200, 580, 280]);
    // The note still points at that popup, and the popup at the note.
    const pointedAt = optionalEntry(note, 'Popup')!.resolve();
    expect(readRect(optionalEntry(pointedAt, 'Rect'))).toEqual([450, 200, 580, 280]);
    expect(optionalEntry(popup, 'Parent')!.asIndirect()).toBeGreaterThan(0);
  });

  it('with the right page first, the same annotations go with the same content', async () => {
    const { pdf } = annotated();
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'vertical', 0.5, 'right')]);
    // The first page is now the right half.
    expect(subtypes(annotsOf(pdf, 0))).toEqual(['Link', 'Text', 'Popup', 'Widget:f1']);
    expect(subtypes(annotsOf(pdf, 1))).toEqual(['Link', 'Text', 'Popup']);
  });

  it('a horizontal cut partitions by the vertical centre (top first)', async () => {
    const { pdf } = annotated();
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'horizontal', 0.5, 'left')]);
    // User y 300-320 is near the top of the page; links at y 20-60 are near the bottom.
    const top = subtypes(annotsOf(pdf, 0));
    const bottom = subtypes(annotsOf(pdf, 1));
    expect(top).toEqual(['Text', 'Popup', 'Text', 'Popup']);
    expect(bottom).toEqual(['Link', 'Link', 'Widget:f1']);
  });

  it('/P is pointed at the page the annotation is on now', async () => {
    const pdf = makeDoc([{}]);
    const page = pdf.findPage(0);
    const annot = pdf.createObject();
    const dict = pdf.newDictionary();
    dict.put('Type', pdf.newName('Annot'));
    dict.put('Subtype', pdf.newName('Link'));
    dict.put('Rect', numbers(pdf, [400, 20, 500, 60]));
    dict.put('P', page);
    annot.writeObject(dict);
    const list = pdf.newArray();
    list.push(annot);
    page.put('Annots', list);
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    const second = pdf.findPage(1);
    const moved = annotsOf(pdf, 1)[0]!;
    expect(optionalEntry(moved, 'P')!.asIndirect()).toBe(second.asIndirect());
    expect(optionalEntry(moved, 'P')!.asIndirect()).not.toBe(page.asIndirect());
    // The first page has no annotations left, and its list is empty or absent.
    expect(annotsOf(pdf, 0)).toEqual([]);
  });

  it('undo puts every annotation back on the one page', async () => {
    const { pdf } = annotated();
    const core = new EditCore(pdf, 1, true, env);
    await core.apply([slice(['0'], 'vertical', 0.5, 'left')]);
    core.undo();
    expect(pdf.countPages()).toBe(1);
    expect(subtypes(annotsOf(pdf, 0))).toEqual(['Link', 'Link', 'Text', 'Popup', 'Text', 'Popup', 'Widget:f1']);
  });
});

describe('slice and links on turned and cropped pages: each link is shown on the half that holds it', () => {
  /** A page with a web link at each of five places, in user space. The links are read back through MuPDF's own link list, in display space. */
  function linkedDoc(spec: PageSpec): mu.PDFDocument {
    const pdf = makeDoc([spec]);
    const page = pdf.findPage(0);
    const list = pdf.newArray();
    const places: Rect4[] = [
      [30, 40, 90, 70],
      [200, 300, 290, 340],
      [460, 100, 520, 220],
      [480, 20, 580, 80],
      [560, 330, 590, 380],
    ];
    places.forEach((rect, i) => {
      const annot = pdf.createObject();
      const dict = pdf.newDictionary();
      dict.put('Type', pdf.newName('Annot'));
      dict.put('Subtype', pdf.newName('Link'));
      dict.put('Rect', numbers(pdf, rect));
      const action = pdf.newDictionary();
      action.put('S', pdf.newName('URI'));
      action.put('URI', pdf.newString(`https://example.com/${i}`));
      dict.put('A', action);
      annot.writeObject(dict);
      list.push(annot);
    });
    page.put('Annots', list);
    return pdf;
  }

  /** The display-space centre of each link of each page, with its address. */
  function linksOf(pdf: mu.PDFDocument): Array<Array<{ x: number; y: number; uri: string }>> {
    const out: Array<Array<{ x: number; y: number; uri: string }>> = [];
    for (let i = 0; i < pdf.countPages(); i++) {
      const loaded = pdf.loadPage(i);
      try {
        out.push(loaded.getLinks().map((link) => {
          const b = link.getBounds();
          return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, uri: link.getURI() };
        }));
      } finally {
        loaded.destroy();
      }
    }
    return out;
  }

  for (const [name, spec] of [
    ['plain', {}],
    ['turned 90', { rotate: 90 }],
    ['turned 180', { rotate: 180 }],
    ['turned 270', { rotate: 270 }],
    ['cropped and turned 270', { rotate: 270, crop: [50, 20, 550, 380] as Rect4 }],
  ] as Array<[string, PageSpec]>) {
    for (const cut of ['vertical', 'horizontal'] as const) {
      it(`${name}, ${cut} cut: every link keeps its address and is on the half it is drawn in`, async () => {
        const pdf = linkedDoc(spec);
        const before = linksOf(pdf)[0]!;
        const bounds = displayBounds(pdf, 0);
        const core = new EditCore(pdf, 1, true, env);
        await core.apply([slice(['0'], cut, 0.5, 'left')]);
        const [first, second] = linksOf(pdf);
        const [w, h] = [bounds[2] - bounds[0], bounds[3] - bounds[1]];
        // The halves in display space, as the page shows them: a link's centre before the cut tells which half it is in.
        const inFirst = (p: { x: number; y: number }) => (cut === 'vertical' ? p.x < w / 2 : p.y < h / 2);
        const want1 = before.filter(inFirst).map((l) => l.uri).sort();
        const want2 = before.filter((l) => !inFirst(l)).map((l) => l.uri).sort();
        expect(first!.map((l) => l.uri).sort()).toEqual(want1);
        expect(second!.map((l) => l.uri).sort()).toEqual(want2);
        expect(want1.length + want2.length).toBe(5);
        expect(want1.length).toBeGreaterThan(0);
        expect(want2.length).toBeGreaterThan(0);
        // A link that was drawn on the page (not in a cropped-away margin) sits inside the area of its own half.
        const drawn = new Set(before.filter((l) => l.x >= 0 && l.x <= w && l.y >= 0 && l.y <= h).map((l) => l.uri));
        for (const [i, links] of [[0, first!], [1, second!]] as const) {
          const b = displayBounds(pdf, i);
          for (const link of links.filter((l) => drawn.has(l.uri))) {
            expect(link.x).toBeGreaterThanOrEqual(-0.01);
            expect(link.x).toBeLessThanOrEqual(b[2] - b[0] + 0.01);
            expect(link.y).toBeGreaterThanOrEqual(-0.01);
            expect(link.y).toBeLessThanOrEqual(b[3] - b[1] + 0.01);
          }
        }
      });
    }
  }
});

describe('slice: the text of the hidden half is not found', () => {
  /** Two words on one line, one in each half of a 600 x 400 page, as a document the worker core opens. */
  function twoWords(): Uint8Array {
    const pdf = new mu.PDFDocument();
    const font = pdf.newDictionary();
    font.put('Type', pdf.newName('Font'));
    font.put('Subtype', pdf.newName('Type1'));
    font.put('BaseFont', pdf.newName('Helvetica'));
    const resources = pdf.newDictionary();
    const fonts = pdf.newDictionary();
    fonts.put('F1', pdf.addObject(font));
    resources.put('Font', fonts);
    const page = pdf.addPage([0, 0, 600, 400], 0, resources, 'BT /F1 24 Tf 60 200 Td (LEFTWORD) Tj ET\nBT /F1 24 Tf 400 200 Td (RIGHTWORD) Tj ET');
    pdf.insertPage(0, page);
    return pdf.saveToBuffer('').asUint8Array().slice();
  }
  const words = (core: MupdfCore, index: number) => core.textPage(index).runs.map((r) => r.text);

  it('before the cut a page has both words; after it each half has only its own', async () => {
    const core = new MupdfCore(mu, null);
    core.open(twoWords(), undefined);
    expect(words(core, 0).join(' ')).toContain('LEFTWORD');
    expect(words(core, 0).join(' ')).toContain('RIGHTWORD');
    await core.applyEdits([slice(['0'], 'vertical', 0.5, 'left')]);
    expect(core.pageCount).toBe(2);
    expect(words(core, 0)).toEqual(['LEFTWORD']);
    expect(words(core, 1)).toEqual(['RIGHTWORD']);
    core.undo();
    expect(words(core, 0).join(' ')).toContain('RIGHTWORD');
  });

  it('a line that crosses the cut is split: each half reads only the letters inside it', async () => {
    const core = new MupdfCore(mu, null);
    const pdf = new mu.PDFDocument();
    const font = pdf.newDictionary();
    font.put('Type', pdf.newName('Font'));
    font.put('Subtype', pdf.newName('Type1'));
    font.put('BaseFont', pdf.newName('Helvetica'));
    const resources = pdf.newDictionary();
    const fonts = pdf.newDictionary();
    fonts.put('F1', pdf.addObject(font));
    resources.put('Font', fonts);
    pdf.insertPage(0, pdf.addPage([0, 0, 600, 400], 0, resources, 'BT /F1 30 Tf 20 200 Td (AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Tj ET'));
    core.open(pdf.saveToBuffer('').asUint8Array().slice(), undefined);
    const whole = words(core, 0)[0]!.length;
    await core.applyEdits([slice(['0'], 'vertical', 0.5, 'left')]);
    const a = words(core, 0)[0]!.length;
    const b = words(core, 1)[0]!.length;
    expect(a + b).toBe(whole);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it('a page cropped by hand (no slice) does not report the text of its margins either', () => {
    const pdf = new mu.PDFDocument();
    const font = pdf.newDictionary();
    font.put('Type', pdf.newName('Font'));
    font.put('Subtype', pdf.newName('Type1'));
    font.put('BaseFont', pdf.newName('Helvetica'));
    const resources = pdf.newDictionary();
    const fonts = pdf.newDictionary();
    fonts.put('F1', pdf.addObject(font));
    resources.put('Font', fonts);
    pdf.insertPage(0, pdf.addPage([0, 0, 600, 400], 0, resources, 'BT /F1 24 Tf 10 20 Td (MARGIN) Tj ET\nBT /F1 24 Tf 200 200 Td (INSIDE) Tj ET'));
    pdf.findPage(0).put('CropBox', numbers(pdf, [100, 100, 500, 300]));
    const core = new MupdfCore(mu, null);
    core.open(pdf.saveToBuffer('').asUint8Array().slice(), undefined);
    expect(words(core, 0)).toEqual(['INSIDE']);
  });

  it('a page with no CropBox keeps its text', () => {
    const pdf = new mu.PDFDocument();
    const font = pdf.newDictionary();
    font.put('Type', pdf.newName('Font'));
    font.put('Subtype', pdf.newName('Type1'));
    font.put('BaseFont', pdf.newName('Helvetica'));
    const resources = pdf.newDictionary();
    const fonts = pdf.newDictionary();
    fonts.put('F1', pdf.addObject(font));
    resources.put('Font', fonts);
    pdf.insertPage(0, pdf.addPage([0, 0, 600, 400], 0, resources, 'BT /F1 24 Tf 10 20 Td (CORNER) Tj ET'));
    const core = new MupdfCore(mu, null);
    core.open(pdf.saveToBuffer('').asUint8Array().slice(), undefined);
    expect(words(core, 0)).toEqual(['CORNER']);
  });
});

describe('slice and recovery: a logged slice replays to the same pages and uids', () => {
  const KEY = 'b'.repeat(64);
  const memory = () => {
    const logs = new Map<string, string>();
    const port: LogPort = {
      write: async (key, text) => void logs.set(key, text),
      writeStash: async () => undefined,
      clear: async (key) => void logs.delete(key),
    };
    return { logs, port };
  };
  const baseBytes = () => makeDoc([{}, { rotate: 90 }, { crop: [50, 50, 550, 350] }, {}]).saveToBuffer('garbage=compact').asUint8Array().slice().buffer as ArrayBuffer;
  const open = (bytes: ArrayBuffer) => mu.Document.openDocument(new Uint8Array(bytes), 'application/pdf').asPDF()!;

  it('a slice, a rotate, and a second slice of one half replay onto the base file with the same uids, revs-free content and undo steps', async () => {
    const base = baseBytes();
    const { logs, port } = memory();
    const live = open(base);
    const liveCore = new EditCore(live, 4, true, env);
    const log = new EditLog(KEY, 'C:\\docs\\x.pdf', { size: 1, modified: 2 }, port);
    const steps: PageEdit[][] = [
      [slice(['1', '2'], 'vertical', 0.4, 'right')],
      [{ op: 'rotate', uids: ['0'], degrees: 90 }],
      [slice(['n1'], 'horizontal', 0.6, 'left')],
    ];
    for (const step of steps) log.record(step, (await liveCore.apply(step)).uidSeed);
    await log.flush();
    const expectedUids = liveCore.pages().uids;
    const expectedPrints = pageFingerprints(live);
    // 4 pages: slice 2 (6), rotate (6), slice 1 half again (7).
    expect(expectedUids.length).toBe(7);

    const file = parseEditLog(logs.get(KEY)!)!;
    expect(file.steps.length).toBe(3);
    const replayed = open(base);
    const replayCore = new EditCore(replayed, 4, true, env);
    const result = await replayLog(file, async () => null, {
      attachSource: async () => 'unused',
      applyStep: async (edits, seed) => void (await replayCore.apply(edits, undefined, seed)),
      undoStep: async () => replayCore.undo(),
    });
    expect(result.applied).toBe(3);
    expect(replayCore.pages().uids).toEqual(expectedUids);
    expect(pageFingerprints(replayed)).toEqual(expectedPrints);
    // Each replayed step is its own undo step.
    replayCore.undo();
    expect(replayed.countPages()).toBe(6);
    replayCore.undo();
    replayCore.undo();
    expect(replayed.countPages()).toBe(4);
    expect(replayCore.history.canUndo).toBe(false);
  });

  it('the log stores a slice as plain data, so it survives a round trip through the file', async () => {
    const edit = slice(['3', 'n2'], 'vertical', 0.55, 'right');
    const { logs, port } = memory();
    const log = new EditLog(KEY, 'C:\\docs\\x.pdf', { size: 1, modified: 2 }, port);
    log.record([edit], 7);
    await log.flush();
    const file = parseEditLog(logs.get(KEY)!)!;
    expect(file.steps[0]).toEqual([edit]);
    expect(file.seeds).toEqual([7]);
  });
});

describe('slice on a large document stays quick', () => {
  it('cuts 500 pages in one step in well under a few seconds, and undoes them just as fast', async () => {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 500; i++) addPage(pdf, {}, `0 g\n${10 + (i % 50)} 10 60 30 re\nf`);
    const core = new EditCore(pdf, 500, true, env);
    const started = performance.now();
    await core.apply([slice(core.pages().uids, 'vertical', 0.5, 'left')]);
    const cutMs = performance.now() - started;
    expect(pdf.countPages()).toBe(1000);
    const undoStarted = performance.now();
    core.undo();
    const undoMs = performance.now() - undoStarted;
    expect(pdf.countPages()).toBe(500);
    // Not a timing gate (the protected results are measured in the app); this only catches a quadratic slowdown.
    expect(cutMs).toBeLessThan(15000);
    expect(undoMs).toBeLessThan(5000);
    console.info(`[slice 500 pages] cut ${Math.round(cutMs)} ms, undo ${Math.round(undoMs)} ms`);
  });
});

