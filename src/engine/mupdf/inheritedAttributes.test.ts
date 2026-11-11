// @vitest-environment node
// A page copy (duplicate, slice) must carry the page attributes its source only inherits from a /Pages node. MuPDF inserts the
// copy under the parent of the page that comes next, which can be another node with other values.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from './editCore';
import { displayBounds } from './pageOps';

const env = { mu, sources: new Map<string, mu.PDFDocument>() };

function box(pdf: mu.PDFDocument, values: readonly number[]): mu.PDFObject {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}

/** Node A {Rotate 90, MediaBox 600x400, Resources with font F1} holds p0 and p1; node B {MediaBox 612x792} holds p2. */
function twoNodeTree(): Uint8Array {
  const pdf = new mu.PDFDocument();
  const font = pdf.newDictionary();
  font.put('Type', pdf.newName('Font'));
  font.put('Subtype', pdf.newName('Type1'));
  font.put('BaseFont', pdf.newName('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('F1', pdf.addObject(font));
  const resourcesA = pdf.newDictionary();
  resourcesA.put('Font', fonts);

  const root = pdf.getTrailer().get('Root').get('Pages');
  const nodeA = pdf.addObject(pdf.newDictionary());
  const nodeB = pdf.addObject(pdf.newDictionary());
  const make = (parent: mu.PDFObject, name: string) => {
    const dict = pdf.newDictionary();
    dict.put('Type', pdf.newName('Page'));
    dict.put('Parent', parent);
    // Two words, one low (y 100) and one high (y 300) on the page: a rotated vertical cut separates them.
    dict.put('Contents', pdf.addStream(`BT /F1 24 Tf 50 100 Td (${name}LOW) Tj ET BT /F1 24 Tf 50 300 Td (${name}HIGH) Tj ET`, pdf.newDictionary()));
    return pdf.addObject(dict);
  };
  const p0 = make(nodeA, 'ZERO');
  const p1 = make(nodeA, 'ONE');
  const p2 = make(nodeB, 'TWO');
  const a = nodeA.resolve();
  a.put('Type', pdf.newName('Pages'));
  a.put('Parent', root);
  const kidsA = pdf.newArray();
  kidsA.push(p0);
  kidsA.push(p1);
  a.put('Kids', kidsA);
  a.put('Count', 2);
  a.put('MediaBox', box(pdf, [0, 0, 600, 400]));
  a.put('Rotate', 90);
  a.put('Resources', resourcesA);
  const b = nodeB.resolve();
  b.put('Type', pdf.newName('Pages'));
  b.put('Parent', root);
  const kidsB = pdf.newArray();
  kidsB.push(p2);
  b.put('Kids', kidsB);
  b.put('Count', 1);
  b.put('MediaBox', box(pdf, [0, 0, 612, 792]));
  const top = root.resolve();
  const kids = pdf.newArray();
  kids.push(nodeA);
  kids.push(nodeB);
  top.put('Kids', kids);
  top.put('Count', 3);
  return pdf.saveToBuffer('').asUint8Array().slice();
}

const open = (bytes: Uint8Array) => mu.Document.openDocument(bytes, 'application/pdf').asPDF()!;

interface Seen {
  bounds: number[];
  media: number[];
  rotate: number | null;
  hasResources: boolean;
  text: string;
}

function snapshot(pdf: mu.PDFDocument): Seen[] {
  const out: Seen[] = [];
  for (let i = 0; i < pdf.countPages(); i++) {
    const page = pdf.findPage(i);
    const media = page.getInheritable('MediaBox').resolve();
    const rotate = page.getInheritable('Rotate');
    const loaded = pdf.loadPage(i);
    let text: string;
    try {
      text = loaded.toStructuredText('').asText().replace(/\s+/g, ' ').trim();
    } finally {
      loaded.destroy();
    }
    out.push({
      bounds: displayBounds(pdf, i).map(Math.round),
      media: [0, 1, 2, 3].map((k) => Math.round(media.get(k).asNumber())),
      rotate: rotate.isNull() ? null : rotate.asNumber(),
      hasResources: !page.getInheritable('Resources').isNull(),
      text,
    });
  }
  return out;
}

const roundTrip = (pdf: mu.PDFDocument) => open(pdf.saveToBuffer('garbage=compact').asUint8Array().slice());

describe('page copies keep the attributes their source inherits from a /Pages node', () => {
  it('the fixture starts as built: page 1 is turned and 600 x 400, page 2 is on the other node', () => {
    const seen = snapshot(open(twoNodeTree()));
    expect(seen.map((s) => s.bounds)).toEqual([[0, 0, 400, 600], [0, 0, 400, 600], [0, 0, 612, 792]]);
    expect(seen[1]!.text).toBe('ONELOW ONEHIGH');
  });

  it('slice of the last page of a node: the new half is turned, has the boxes, the resources and its text', async () => {
    const pdf = open(twoNodeTree());
    const core = new EditCore(pdf, 3, true, env);
    const before = snapshot(pdf);
    await core.apply([{ op: 'slice', uids: ['1'], cut: 'vertical', at: 0.5, first: 'left' }]);
    const after = snapshot(pdf);
    expect(after).toHaveLength(4);
    // Display is 400 wide and 600 tall; the cut at 200 falls between the two words (each half's display bounds start at 0) (display x is the user's y when turned).
    expect(after[1]).toEqual({ bounds: [0, 0, 200, 600], media: [0, 0, 600, 400], rotate: 90, hasResources: true, text: 'ONELOW' });
    expect(after[2]).toEqual({ bounds: [0, 0, 200, 600], media: [0, 0, 600, 400], rotate: 90, hasResources: true, text: 'ONEHIGH' });
    // The pages around the cut are untouched, including the one on the other node.
    expect(after[0]).toEqual(before[0]);
    expect(after[3]).toEqual(before[2]);

    core.undo();
    expect(snapshot(pdf)).toEqual(before);
    core.redo();
    expect(snapshot(pdf)).toEqual(after);
    expect(snapshot(roundTrip(pdf))).toEqual(after);
  });

  it('duplicate of the last page of a node: the copy is turned, has the boxes, the resources and all its text', async () => {
    const pdf = open(twoNodeTree());
    const core = new EditCore(pdf, 3, true, env);
    const before = snapshot(pdf);
    await core.apply([{ op: 'duplicate', uids: ['1'] }]);
    const after = snapshot(pdf);
    expect(after).toHaveLength(4);
    expect(after[2]).toEqual(after[1]);
    expect(after[2]).toEqual({ bounds: [0, 0, 400, 600], media: [0, 0, 600, 400], rotate: 90, hasResources: true, text: 'ONELOW ONEHIGH' });
    expect(after[3]).toEqual(before[2]);

    core.undo();
    expect(snapshot(pdf)).toEqual(before);
    core.redo();
    expect(snapshot(pdf)).toEqual(after);
    expect(snapshot(roundTrip(pdf))).toEqual(after);
  });

  it('a copy keeps its own boxes, rotation and resources when the source has them (nothing is overwritten)', async () => {
    const pdf = open(twoNodeTree());
    pdf.findPage(0).put('Rotate', 180);
    pdf.findPage(0).put('MediaBox', box(pdf, [0, 0, 300, 200]));
    const core = new EditCore(pdf, 3, true, env);
    await core.apply([{ op: 'duplicate', uids: ['0'] }]);
    const seen = snapshot(pdf);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1]!.rotate).toBe(180);
    expect(seen[1]!.media).toEqual([0, 0, 300, 200]);
  });
});

// The auditor's E1b shape: pages that have no Rotate, CropBox or Resources of their own, and none to inherit, sit right before a
// node that has one. The copy must not pick the node's value up (MuPDF inserts it under the next page's parent).
interface Px {
  w: number;
  h: number;
  data: Uint8Array;
}

/** root {MediaBox 800 x 500}: p0 p1 p2, node R {Rotate 90, Resources} [p3], p4, node C {CropBox, Resources} [p5], p6. */
function beforeNodesTree(): Uint8Array {
  const pdf = new mu.PDFDocument();
  const root = pdf.getTrailer().get('Root').get('Pages');
  const nodeR = pdf.addObject(pdf.newDictionary());
  const nodeC = pdf.addObject(pdf.newDictionary());
  const colours = ['1 0 0', '0 0.6 0', '0 0 1', '0.8 0.6 0', '0.6 0 0.6', '0 0.6 0.6', '0.3 0.3 0.3'];
  const make = (parent: mu.PDFObject, n: number) => {
    const dict = pdf.newDictionary();
    dict.put('Type', pdf.newName('Page'));
    dict.put('Parent', parent);
    // Blocks all over the 800 x 500 page, different on every page: left/right and top/bottom halves differ, and so do pages.
    const c = colours[n]!;
    const body = `${c} rg 20 20 300 100 re f 0 0 0 rg 420 ${60 + n * 40} 330 60 re f ${c} rg 120 300 200 150 re f 0.5 0.5 0.5 rg 500 400 ${30 + n * 10} 80 re f`;
    dict.put('Contents', pdf.addStream(body, pdf.newDictionary()));
    return pdf.addObject(dict);
  };
  const p = [make(root, 0), make(root, 1), make(root, 2), make(nodeR, 3), make(root, 4), make(nodeC, 5), make(root, 6)];
  const node = (ref: mu.PDFObject, kids: mu.PDFObject[]) => {
    const d = ref.resolve();
    d.put('Type', pdf.newName('Pages'));
    d.put('Parent', root);
    const list = pdf.newArray();
    kids.forEach((k) => list.push(k));
    d.put('Kids', list);
    d.put('Count', kids.length);
    return d;
  };
  const r = node(nodeR, [p[3]!]);
  r.put('Rotate', 90);
  r.put('Resources', pdf.newDictionary());
  const c = node(nodeC, [p[5]!]);
  c.put('CropBox', box(pdf, [100, 50, 700, 450]));
  c.put('Resources', pdf.newDictionary());
  const top = root.resolve();
  top.put('MediaBox', box(pdf, [0, 0, 800, 500]));
  const kids = pdf.newArray();
  for (const ref of [p[0]!, p[1]!, p[2]!, nodeR, p[4]!, nodeC, p[6]!]) kids.push(ref);
  top.put('Kids', kids);
  top.put('Count', 7);
  return pdf.saveToBuffer('').asUint8Array().slice();
}

function pixels(pdf: mu.PDFDocument, i: number): Px {
  const loaded = pdf.loadPage(i);
  try {
    const pix = loaded.toPixmap(mu.Matrix.identity, mu.ColorSpace.DeviceRGB, false, true);
    try {
      return { w: pix.getWidth(), h: pix.getHeight(), data: pix.getPixels().slice() };
    } finally {
      pix.destroy();
    }
  } finally {
    loaded.destroy();
  }
}

interface Look {
  bounds: number[];
  media: number[];
  crop: number[];
  rotate: number;
  px: Px;
}

function look(pdf: mu.PDFDocument, i: number): Look {
  const page = pdf.findPage(i);
  const rect = (key: string): number[] | null => {
    const found = page.getInheritable(key);
    if (found.isNull()) return null;
    const v = found.resolve();
    return [0, 1, 2, 3].map((k) => Math.round(v.get(k).asNumber()));
  };
  const media = rect('MediaBox')!;
  const rotate = page.getInheritable('Rotate');
  return {
    bounds: displayBounds(pdf, i).map(Math.round),
    media,
    crop: rect('CropBox') ?? media,
    rotate: rotate.isNull() ? 0 : rotate.asNumber(),
    px: pixels(pdf, i),
  };
}

const looks = (pdf: mu.PDFDocument): Look[] => Array.from({ length: pdf.countPages() }, (_v, i) => look(pdf, i));

const samePx = (a: Px, b: Px) => a.w === b.w && a.h === b.h && a.data.every((v, k) => v === b.data[k]);
const boxesOf = (l: Look) => JSON.stringify([l.bounds, l.media, l.crop, l.rotate]);

/** All of `part` against the pixels of `whole` that start at column x0, row y0. */
function partMatches(whole: Px, part: Px, x0: number, y0: number): boolean {
  if (x0 + part.w > whole.w || y0 + part.h > whole.h) return false;
  for (let y = 0; y < part.h; y++) {
    for (let x = 0; x < part.w * 3; x++) {
      if (whole.data[((y0 + y) * whole.w + x0) * 3 + x] !== part.data[y * part.w * 3 + x]) return false;
    }
  }
  return true;
}

type Variant = { label: string; op: 'duplicate' } | { label: string; op: 'slice'; cut: 'vertical' | 'horizontal'; first: 'left' | 'right' };
const VARIANTS: Variant[] = [
  { label: 'dup', op: 'duplicate' },
  { label: 'v50 left first', op: 'slice', cut: 'vertical', first: 'left' },
  { label: 'v50 right first', op: 'slice', cut: 'vertical', first: 'right' },
  { label: 'h50', op: 'slice', cut: 'horizontal', first: 'left' },
];

/** Every problem of a document after the edit on page `i` of `base`. */
function problemsOf(pdf: mu.PDFDocument, base: Look[], i: number, v: Variant): string[] {
  const out: string[] = [];
  const now = looks(pdf);
  if (now.length !== base.length + 1) return [`${now.length} pages, expected ${base.length + 1}`];
  const whole = base[i]!;
  for (let k = 0; k < base.length; k++) {
    if (k === i) continue;
    const seen = now[k < i ? k : k + 1]!;
    if (boxesOf(seen) !== boxesOf(base[k]!) || !samePx(seen.px, base[k]!.px)) out.push(`page ${k} changed`);
  }
  const a = now[i]!;
  const b = now[i + 1]!;
  if (v.op === 'duplicate') {
    for (const [name, copy] of [['original', a], ['copy', b]] as const) {
      if (boxesOf(copy) !== boxesOf(whole)) out.push(`${name}: boxes ${boxesOf(copy)} not ${boxesOf(whole)}`);
      if (!samePx(copy.px, whole.px)) out.push(`${name}: pixels differ`);
    }
    return out;
  }
  const line = Math.round((v.cut === 'vertical' ? whole.px.w : whole.px.h) / 2);
  const low = v.cut === 'horizontal' || v.first === 'left' ? a : b;
  const high = low === a ? b : a;
  for (const half of [a, b]) {
    if (half.rotate !== whole.rotate) out.push(`a half has rotate ${half.rotate}, not ${whole.rotate}`);
    if (JSON.stringify(half.media) !== JSON.stringify(whole.media)) out.push(`a half has MediaBox ${half.media}`);
  }
  if (v.cut === 'vertical') {
    if (low.px.w !== line || high.px.w !== whole.px.w - line || low.px.h !== whole.px.h || high.px.h !== whole.px.h) {
      out.push(`sizes ${low.px.w}x${low.px.h} + ${high.px.w}x${high.px.h} of ${whole.px.w}x${whole.px.h}`);
    } else if (!partMatches(whole.px, low.px, 0, 0) || !partMatches(whole.px, high.px, line, 0)) out.push('halves are not the original page');
  } else if (low.px.h !== line || high.px.h !== whole.px.h - line || low.px.w !== whole.px.w || high.px.w !== whole.px.w) {
    out.push(`sizes ${low.px.w}x${low.px.h} + ${high.px.w}x${high.px.h} of ${whole.px.w}x${whole.px.h}`);
  } else if (!partMatches(whole.px, low.px, 0, 0) || !partMatches(whole.px, high.px, 0, line)) out.push('halves are not the original page');
  return out;
}

describe('pages without Rotate, CropBox or Resources next to a node that has them (E1b shape)', () => {
  const bytes = beforeNodesTree();

  it('the fixture starts as built', () => {
    const seen = looks(open(bytes));
    expect(seen.map((s) => s.bounds)).toEqual([[0, 0, 800, 500], [0, 0, 800, 500], [0, 0, 800, 500], [0, 0, 500, 800], [0, 0, 800, 500], [0, 0, 600, 400], [0, 0, 800, 500]]);
    expect(seen.map((s) => s.rotate)).toEqual([0, 0, 0, 90, 0, 0, 0]);
  });

  it('every page cut every way and duplicated: live, undo, redo and saved all show the right page', async () => {
    const bad: string[] = [];
    const base = looks(open(bytes));
    for (let i = 0; i < base.length; i++) {
      for (const v of VARIANTS) {
        const pdf = open(bytes);
        const core = new EditCore(pdf, base.length, true, env);
        const uid = String(i);
        await core.apply([v.op === 'duplicate' ? { op: 'duplicate', uids: [uid] } : { op: 'slice', uids: [uid], cut: v.cut, at: 0.5, first: v.first }]);
        const tag = `page ${i} ${v.label}`;
        bad.push(...problemsOf(pdf, base, i, v).map((p) => `${tag} live: ${p}`));
        core.undo();
        const back = looks(pdf);
        if (back.length !== base.length || back.some((s, k) => boxesOf(s) !== boxesOf(base[k]!) || !samePx(s.px, base[k]!.px))) bad.push(`${tag}: undo did not restore`);
        core.redo();
        bad.push(...problemsOf(pdf, base, i, v).map((p) => `${tag} redo: ${p}`));
        bad.push(...problemsOf(roundTrip(pdf), base, i, v).map((p) => `${tag} saved: ${p}`));
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);
});
