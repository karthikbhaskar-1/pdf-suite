// @vitest-environment node
// 1.3.4 Compare overlay, on real MuPDF: (1) the live view puts the overlay where the placement says, in each look; (2) the view
// and the applied result agree (the view against applied-then-rendered: at most 1 % of the pixels differ), on plain, turned and
// cropped pages, at several sizes of bitmap; (3) the view does not change the document, and the overlay's comments are not drawn.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { fitToPage, type AppliedMode, type OverlayMode } from '../overlayPlacement';
import type { OverlayArgs, PageEdit } from './protocol';

interface Box {
  rect: [number, number, number, number];
  /** Gray fill, 0 black to 1 white. */
  gray?: number;
}

interface PageSpec {
  media: [number, number, number, number];
  rotate?: 0 | 90 | 180 | 270;
  crop?: [number, number, number, number];
  boxes: Box[];
  /** A text annotation, to see that the overlay's comments are not drawn. */
  note?: [number, number, number, number];
}

function numbers(pdf: mu.PDFDocument, values: readonly number[]): mu.PDFObject {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}

function build(specs: PageSpec[]): Uint8Array {
  const pdf = new mu.PDFDocument();
  specs.forEach((spec, i) => {
    const content = spec.boxes.map((b) => `${b.gray ?? 0} g ${b.rect[0]} ${b.rect[1]} ${b.rect[2] - b.rect[0]} ${b.rect[3] - b.rect[1]} re f`).join('\n');
    pdf.insertPage(i, pdf.addPage(spec.media, spec.rotate ?? 0, {}, content));
    const page = pdf.findPage(i);
    if (spec.crop) page.put('CropBox', numbers(pdf, spec.crop));
    if (spec.note) {
      const note = pdf.addObject(pdf.newDictionary());
      note.put('Type', pdf.newName('Annot'));
      note.put('Subtype', pdf.newName('Square'));
      note.put('Rect', numbers(pdf, spec.note));
      note.put('C', numbers(pdf, [1, 0, 0]));
      note.put('IC', numbers(pdf, [1, 0, 0]));
      const annots = pdf.newArray();
      annots.push(note);
      page.put('Annots', annots);
    }
  });
  return pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
}

interface Rig {
  core: MupdfCore;
  sourceDocId: string;
  uid: (index: number) => string;
}

function rig(base: PageSpec[], overlay: PageSpec[]): Rig {
  const core = new MupdfCore(mu as never, {});
  core.open(build(base), undefined);
  const attached = core.attachSource(build(overlay), undefined);
  return { core, sourceDocId: attached.sourceDocId, uid: (i) => core.editState!.pages().uids[i]! };
}

interface Image {
  w: number;
  h: number;
  /** Tight RGBA. */
  px: Uint8Array;
}

function pixels(core: MupdfCore, args: Parameters<MupdfCore['renderPixmap']>[0]): Image {
  const { pixmap, w, h } = core.renderPixmap(args);
  try {
    const stride = pixmap.getStride();
    const src = pixmap.getPixels();
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w * 4), y * w * 4);
    return { w, h, px };
  } finally {
    pixmap.destroy();
  }
}

const at = (img: Image, x: number, y: number): [number, number, number] => {
  const i = (y * img.w + x) * 4;
  return [img.px[i]!, img.px[i + 1]!, img.px[i + 2]!];
};
const dark = (c: [number, number, number]): boolean => c[0] < 60 && c[1] < 60 && c[2] < 60;
const white = (c: [number, number, number]): boolean => c[0] > 240 && c[1] > 240 && c[2] > 240;

/** The share of pixels whose channels differ by more than `tolerance`. */
function differing(a: Image, b: Image, tolerance = 12): number {
  expect([a.w, a.h]).toEqual([b.w, b.h]);
  let bad = 0;
  for (let i = 0; i < a.w * a.h; i++) {
    const j = i * 4;
    if (Math.abs(a.px[j]! - b.px[j]!) > tolerance || Math.abs(a.px[j + 1]! - b.px[j + 1]!) > tolerance || Math.abs(a.px[j + 2]! - b.px[j + 2]!) > tolerance) bad++;
  }
  return bad / (a.w * a.h);
}

const overlayArgs = (r: Rig, extra: Partial<OverlayArgs> = {}): OverlayArgs => ({
  sourceDocId: r.sourceDocId,
  sourcePage: 0,
  dx: 0,
  dy: 0,
  scale: 1,
  mode: 'multiply',
  opacity: 0.5,
  ...extra,
});

const view = (r: Rig, index: number, overlay: OverlayArgs | undefined, scale = 1, rotation = 0): Image =>
  pixels(r.core, { page: index, expect: `${r.uid(index)}@${r.core.editState!.pages().revs[index]}`, scale, rotation, overlay });

async function applyOverlay(r: Rig, index: number, sourceIndex: number, p: { dx: number; dy: number; scale: number; mode: AppliedMode; opacity: number }): Promise<void> {
  const edit: PageEdit = { op: 'overlay', uids: [r.uid(index)], sourceDocId: r.sourceDocId, sourceUids: [String(sourceIndex)], ...p };
  await r.core.applyEdits([edit]);
}

// Base: 400 x 300 with a black box top-left. Overlay: 200 x 100 with a black box. In display space (y down) the overlay's
// box is at x 10..60, y 10..40 from its top-left corner (user y 60..90 on a 100-high page).
const BASE: PageSpec = { media: [0, 0, 400, 300], boxes: [{ rect: [20, 220, 120, 280] }] };
const OVER: PageSpec = { media: [0, 0, 200, 100], boxes: [{ rect: [10, 60, 60, 90] }] };
// The same page with its one box far from the top-left corner, so the overlay's box lands on white paper (x 300..380, y 250..290).
const BASE_FAR: PageSpec = { media: [0, 0, 400, 300], boxes: [{ rect: [300, 10, 380, 50] }] };

describe('the view puts the overlay where the placement says', () => {
  it('Multiply at 100 %, no offset: the overlay box is at its own spot, the base box stays', () => {
    const r = rig([BASE_FAR], [OVER]);
    const img = view(r, 0, overlayArgs(r));
    expect(dark(at(img, 30, 20))).toBe(true); // the overlay's box (10..60, 10..40 from the top-left)
    expect(dark(at(img, 340, 270))).toBe(true); // the base box (300..380, 250..290)
    expect(white(at(img, 200, 150))).toBe(true);
    expect(white(at(img, 100, 25))).toBe(true); // right of the overlay's box
    r.core.close();
  });

  it('Across, Down and Size move and scale it: dx 50, dy 20, 200 % puts the box at x 70..170, y 40..100', () => {
    const r = rig([BASE_FAR], [OVER]);
    const img = view(r, 0, overlayArgs(r, { dx: 50, dy: 20, scale: 2 }));
    expect(dark(at(img, 120, 70))).toBe(true);
    expect(white(at(img, 30, 20))).toBe(true); // where it was
    expect(white(at(img, 180, 70))).toBe(true);
    expect(white(at(img, 120, 110))).toBe(true);
    r.core.close();
  });

  it('is exact at other bitmap scales (the bitmap is bigger, the placement the same)', () => {
    const r = rig([BASE_FAR], [OVER]);
    const img = view(r, 0, overlayArgs(r, { dx: 50, dy: 20, scale: 2 }), 2);
    expect(img.w).toBe(800);
    expect(dark(at(img, 240, 140))).toBe(true);
    expect(white(at(img, 60, 40))).toBe(true);
    r.core.close();
  });

  it('is exact on a base page the viewer shows turned', () => {
    const r = rig([BASE], [OVER]);
    // Turned a quarter clockwise, the 400 x 300 page is 300 x 400 and the overlay turns with it: the box that was top-left
    // (10..60, 10..40) is now at x 260..290, y 10..60.
    const img = view(r, 0, overlayArgs(r), 1, 90);
    expect([img.w, img.h]).toEqual([300, 400]);
    expect(dark(at(img, 275, 30))).toBe(true);
    expect(white(at(img, 30, 30))).toBe(true);
    r.core.close();
  });

  it('is exact on a page with its own /Rotate and a CropBox (the placement is in the page as shown)', () => {
    const r = rig([{ media: [0, 0, 600, 400], rotate: 90, crop: [100, 50, 500, 350], boxes: [{ rect: [100, 50, 140, 90] }] }], [OVER]);
    // The page shows 300 x 400 (crop 400 x 300, turned). Its top-left corner is the crop's bottom-left corner turned.
    const plain = view(r, 0, undefined);
    expect([plain.w, plain.h]).toEqual([300, 400]);
    const img = view(r, 0, overlayArgs(r));
    expect(dark(at(img, 30, 20))).toBe(true);
    r.core.close();
  });

  it('draws nothing outside the page, and nothing at all when the overlay lies wholly off it', () => {
    const r = rig([BASE], [OVER]);
    const plain = view(r, 0, undefined);
    const off = view(r, 0, overlayArgs(r, { dx: 900, dy: 0 }));
    expect(differing(plain, off)).toBe(0);
    r.core.close();
  });

  it('Fit to page uses the whole page: the overlay page fitted and centred', () => {
    const r = rig([BASE], [OVER]);
    const fit = fitToPage({ width: 400, height: 300 }, { width: 200, height: 100 });
    expect(fit.scale).toBe(2);
    const img = view(r, 0, overlayArgs(r, fit));
    // Scale 2, the box at 20..120 x 20..80, centred vertically: dy = (300 - 200) / 2 = 50, so y 70..130.
    expect(dark(at(img, 60, 100))).toBe(true);
    expect(white(at(img, 200, 40))).toBe(true);
    r.core.close();
  });
});

describe('the three looks', () => {
  const overRed: PageSpec = { media: [0, 0, 200, 100], boxes: [{ rect: [10, 60, 60, 90], gray: 0 }] };

  it('Multiply: ink from both shows, and overlapping ink is as dark as the darker', () => {
    const r = rig([{ media: [0, 0, 200, 100], boxes: [{ rect: [10, 60, 110, 90], gray: 0.5 }] }], [overRed]);
    const img = view(r, 0, overlayArgs(r));
    const both = at(img, 30, 25); // inside both boxes
    const baseOnly = at(img, 90, 25);
    expect(both[0]).toBeLessThan(40);
    expect(Math.abs(baseOnly[0] - 128)).toBeLessThan(6);
    r.core.close();
  });

  it('See-through: a black overlay mark at 50 % over white paper is mid gray, and at 0 % it is not there', () => {
    const r = rig([{ media: [0, 0, 200, 100], boxes: [] }], [overRed]);
    const half = at(view(r, 0, overlayArgs(r, { mode: 'blend', opacity: 0.5 })), 30, 25);
    expect(Math.abs(half[0] - 128)).toBeLessThan(6);
    const none = at(view(r, 0, overlayArgs(r, { mode: 'blend', opacity: 0 })), 30, 25);
    expect(none[0]).toBeGreaterThan(250);
    const full = at(view(r, 0, overlayArgs(r, { mode: 'blend', opacity: 1 })), 30, 25);
    expect(full[0]).toBeLessThan(5);
    r.core.close();
  });

  it('Differences: base only is red, overlay only is cyan, both is black, neither is white', () => {
    // Base box x 10..110 from the top-left (y 10..40); overlay box x 10..60 (y 10..40): the left half is in both.
    const r = rig([{ media: [0, 0, 200, 100], boxes: [{ rect: [10, 60, 110, 90] }] }], [{ media: [0, 0, 200, 100], boxes: [{ rect: [60, 60, 160, 90] }] }]);
    const img = view(r, 0, overlayArgs(r, { mode: 'difference' }));
    const baseOnly = at(img, 30, 25);
    const common = at(img, 80, 25);
    const overlayOnly = at(img, 140, 25);
    const neither = at(img, 100, 70);
    expect(baseOnly[0]).toBeGreaterThan(240);
    expect(baseOnly[1]).toBeLessThan(20);
    expect(baseOnly[2]).toBeLessThan(20);
    expect(dark(common)).toBe(true);
    expect(overlayOnly[0]).toBeLessThan(20);
    expect(overlayOnly[1]).toBeGreaterThan(240);
    expect(overlayOnly[2]).toBeGreaterThan(240);
    expect(white(neither)).toBe(true);
    r.core.close();
  });
});

describe('the overlay file is read, not changed, and its comments are not drawn', () => {
  it('a comment in the overlay file does not show in the view', () => {
    const noted = { media: [0, 0, 200, 100], boxes: [], note: [100, 20, 180, 80] } as PageSpec;
    const r = rig([{ media: [0, 0, 200, 100], boxes: [] }], [noted]);
    const img = view(r, 0, overlayArgs(r));
    expect(white(at(img, 140, 50))).toBe(true);
    r.core.close();
  });

  it('rendering with an overlay makes no undo step and leaves the page content as it was', () => {
    const r = rig([BASE], [OVER]);
    const before = r.core.fingerprints();
    view(r, 0, overlayArgs(r));
    view(r, 0, overlayArgs(r, { mode: 'difference' }));
    expect(r.core.fingerprints()).toEqual(before);
    expect(r.core.editState!.history.canUndo).toBe(false);
    r.core.close();
  });

  it('a source that is gone, or a page it does not have, is refused rather than drawn half', () => {
    const r = rig([BASE], [OVER]);
    expect(() => view(r, 0, overlayArgs(r, { sourceDocId: 'src99' }))).toThrow();
    expect(() => view(r, 0, overlayArgs(r, { sourcePage: 3 }))).toThrow();
    expect(() => view(r, 0, overlayArgs(r, { scale: 9 }))).toThrow();
    r.core.close();
  });
});

describe('the view against the applied result (at most 1 % of the pixels differ)', () => {
  const cases: Array<{ name: string; base: PageSpec; overlay: PageSpec; mode: AppliedMode; dx: number; dy: number; scale: number; opacity: number; rotation?: number; bitmap?: number }> = [
    { name: 'Multiply, 100 %', base: BASE, overlay: OVER, mode: 'multiply', dx: 0, dy: 0, scale: 1, opacity: 0.5 },
    { name: 'Multiply, moved and 150 %', base: BASE, overlay: OVER, mode: 'multiply', dx: 33, dy: 41.5, scale: 1.5, opacity: 0.5 },
    { name: 'See-through at 40 %', base: BASE, overlay: OVER, mode: 'blend', dx: 200, dy: 150, scale: 1, opacity: 0.4 },
    { name: 'See-through, overlay larger than the page, 25 %', base: BASE, overlay: { media: [0, 0, 1600, 1200], boxes: [{ rect: [100, 900, 700, 1100] }, { rect: [900, 100, 1500, 300] }] }, mode: 'blend', dx: 5, dy: 5, scale: 0.25, opacity: 0.7 },
    {
      name: 'Multiply on a turned and cropped base page',
      base: { media: [0, 0, 600, 400], rotate: 90, crop: [100, 50, 500, 350], boxes: [{ rect: [100, 50, 220, 110] }, { rect: [380, 290, 500, 350] }] },
      overlay: OVER,
      mode: 'multiply',
      dx: 20,
      dy: 60,
      scale: 1.25,
      opacity: 0.5,
    },
    {
      name: 'Multiply with a turned and cropped overlay page',
      base: BASE,
      overlay: { media: [0, 0, 300, 200], rotate: 270, crop: [20, 10, 280, 190], boxes: [{ rect: [20, 10, 100, 60] }, { rect: [200, 120, 280, 190] }] },
      mode: 'multiply',
      dx: 0,
      dy: 0,
      scale: 1,
      opacity: 0.5,
    },
    { name: 'Multiply at a bigger bitmap (2x)', base: BASE, overlay: OVER, mode: 'multiply', dx: 7, dy: 9, scale: 2, opacity: 0.5, bitmap: 2 },
    { name: 'See-through, bitmap turned a half', base: BASE, overlay: OVER, mode: 'blend', dx: 7, dy: 9, scale: 2, opacity: 0.6, rotation: 180 },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const r = rig([c.base], [c.overlay]);
      const args = overlayArgs(r, { dx: c.dx, dy: c.dy, scale: c.scale, mode: c.mode as OverlayMode, opacity: c.opacity });
      const live = view(r, 0, args, c.bitmap ?? 1, c.rotation ?? 0);
      await applyOverlay(r, 0, 0, { dx: c.dx, dy: c.dy, scale: c.scale, mode: c.mode, opacity: c.opacity });
      const applied = view(r, 0, undefined, c.bitmap ?? 1, c.rotation ?? 0);
      // The overlay really changed the page (the check is not "both plain").
      expect(differing(applied, pixels(rigPlain(c.base), { page: 0, scale: c.bitmap ?? 1, rotation: c.rotation ?? 0 }))).toBeGreaterThan(0);
      expect(differing(live, applied)).toBeLessThanOrEqual(0.01);
      r.core.close();
    });
  }
});

/** A plain core on the base page alone, for "the overlay changed something". */
function rigPlain(base: PageSpec): MupdfCore {
  const core = new MupdfCore(mu as never, {});
  core.open(build([base]), undefined);
  return core;
}
