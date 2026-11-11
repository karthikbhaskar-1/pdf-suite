// Shared helpers for the engine-level sign-off probes (real MuPDF, the app's own MupdfCore).
import * as mu from 'mupdf';
import { MupdfCore } from '../../src/engine/mupdf/core';

export { mu, MupdfCore };

export interface Attrs {
  MediaBox?: number[];
  CropBox?: number[];
  Rotate?: number;
  font?: string; // gives the node or page its own /Resources with /F1 = this base font
  UserUnit?: number;
}
export interface Leaf {
  name: string;
  attrs?: Attrs;
}
export interface TreeNode {
  attrs?: Attrs;
  kids: Array<TreeNode | Leaf>;
}
const isLeaf = (x: TreeNode | Leaf): x is Leaf => (x as Leaf).name !== undefined;

function box(pdf: mu.PDFDocument, values: readonly number[]): mu.PDFObject {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}
function resources(pdf: mu.PDFDocument, base: string): mu.PDFObject {
  const font = pdf.newDictionary();
  font.put('Type', pdf.newName('Font'));
  font.put('Subtype', pdf.newName('Type1'));
  font.put('BaseFont', pdf.newName(base));
  const fonts = pdf.newDictionary();
  fonts.put('F1', pdf.addObject(font));
  const res = pdf.newDictionary();
  res.put('Font', fonts);
  return res;
}
function putAttrs(pdf: mu.PDFDocument, dict: mu.PDFObject, attrs: Attrs | undefined): void {
  if (!attrs) return;
  if (attrs.MediaBox) dict.put('MediaBox', box(pdf, attrs.MediaBox));
  if (attrs.CropBox) dict.put('CropBox', box(pdf, attrs.CropBox));
  if (attrs.Rotate !== undefined) dict.put('Rotate', attrs.Rotate);
  if (attrs.font) dict.put('Resources', resources(pdf, attrs.font));
  if (attrs.UserUnit !== undefined) dict.put('UserUnit', pdf.newReal(attrs.UserUnit));
}
/** Four coloured quadrants, a diagonal, and a word per quadrant in /F1 (so the wrong Resources or box shows in pixels). */
export function content(name: string, media: number[], extra = ''): string {
  const [x0, y0, x1, y1] = media as [number, number, number, number];
  const w = x1 - x0;
  const h = y1 - y0;
  const q = (cx: number, cy: number, colour: string, tag: string) =>
    `${colour} rg ${x0 + cx + 10} ${y0 + cy + 10} ${w / 2 - 20} ${h / 2 - 20} re f 0 g BT /F1 36 Tf ${x0 + cx + 20} ${y0 + cy + h / 4} Td (${name}${tag}) Tj ET`;
  return [
    q(0, 0, '1 0.7 0.7', 'bl'),
    q(w / 2, 0, '0.7 1 0.7', 'br'),
    q(0, h / 2, '0.7 0.7 1', 'tl'),
    q(w / 2, h / 2, '1 1 0.6', 'tr'),
    `0 G 3 w ${x0} ${y0} m ${x1} ${y1} l S`,
    extra,
  ].join('\n');
}
export function buildTree(spec: TreeNode, big = 0): { bytes: Uint8Array; pdf: mu.PDFDocument; pages: mu.PDFObject[] } {
  const pdf = new mu.PDFDocument();
  const rootRef = pdf.getTrailer().get('Root').get('Pages');
  const pages: mu.PDFObject[] = [];
  const fill = (ref: mu.PDFObject, node: TreeNode, parent: mu.PDFObject | null, media: number[]): number => {
    const d = ref.resolve();
    d.put('Type', pdf.newName('Pages'));
    if (parent) d.put('Parent', parent);
    putAttrs(pdf, d, node.attrs);
    const here = node.attrs?.MediaBox ?? media;
    const kids = pdf.newArray();
    let count = 0;
    for (const kid of node.kids) {
      if (isLeaf(kid)) {
        const page = pdf.newDictionary();
        page.put('Type', pdf.newName('Page'));
        page.put('Parent', ref);
        putAttrs(pdf, page, kid.attrs);
        const filler = big > 0 ? `\n% ${Array.from({ length: big }, () => Math.random().toString(36).slice(2)).join('')}` : '';
        page.put('Contents', pdf.addStream(content(kid.name, kid.attrs?.MediaBox ?? here) + filler, pdf.newDictionary()));
        const pref = pdf.addObject(page);
        pages.push(pref);
        kids.push(pref);
        count += 1;
      } else {
        const kref = pdf.addObject(pdf.newDictionary());
        count += fill(kref, kid, ref, here);
        kids.push(kref);
      }
    }
    d.put('Kids', kids);
    d.put('Count', count);
    return count;
  };
  fill(rootRef, spec, null, [0, 0, 612, 792]);
  return { bytes: pdf.saveToBuffer('').asUint8Array().slice(), pdf, pages };
}

export interface Shot {
  w: number;
  h: number;
  n: number;
  px: Uint8Array;
}
export function shot(doc: mu.Document, index: number): Shot {
  const page = doc.loadPage(index);
  try {
    const pix = page.toPixmap(mu.Matrix.identity, mu.ColorSpace.DeviceRGB, false, true);
    try {
      const w = pix.getWidth();
      const h = pix.getHeight();
      const n = pix.getNumberOfComponents();
      const stride = pix.getStride();
      const src = pix.getPixels();
      const px = new Uint8Array(w * h * n);
      for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w * n), y * w * n);
      return { w, h, n, px };
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}
export function shots(doc: mu.Document): Shot[] {
  return Array.from({ length: doc.countPages() }, (_, i) => shot(doc, i));
}
/** Pixels of `part` that differ from `whole` at offset (ox, oy). -1 when the part does not fit. */
export function diffAt(whole: Shot, part: Shot, ox: number, oy: number, seamX = -99, seamY = -99): number {
  if (ox < 0 || oy < 0 || ox + part.w > whole.w || oy + part.h > whole.h) return -1;
  let bad = 0;
  for (let y = 0; y < part.h; y++) {
    for (let x = 0; x < part.w; x++) {
      if (Math.abs(x + ox - seamX) <= 2 || Math.abs(x + ox - seamX + 1) <= 2 || Math.abs(y + oy - seamY) <= 2 || Math.abs(y + oy - seamY + 1) <= 2) continue;
      const a = (y * part.w + x) * part.n;
      const b = ((y + oy) * whole.w + (x + ox)) * whole.n;
      if (Math.abs(part.px[a]! - whole.px[b]!) > 48 || Math.abs(part.px[a + 1]! - whole.px[b + 1]!) > 48 || Math.abs(part.px[a + 2]! - whole.px[b + 2]!) > 48) bad += 1;
    }
  }
  return bad;
}
export const same = (a: Shot, b: Shot): boolean => a.w === b.w && a.h === b.h && diffAt(a, b, 0, 0) === 0;
/** True when the picture has ink (is not one flat colour). */
export function hasInk(s: Shot): boolean {
  for (let i = s.n; i < s.px.length; i++) if (s.px[i] !== s.px[i % s.n]) return true;
  return false;
}

export type Cut = 'vertical' | 'horizontal';
/** Checks that `first` and `second` are the two halves of `whole`. Returns '' when right, else what is wrong. */
export function halvesProblem(whole: Shot, first: Shot, second: Shot, cut: Cut, at: number, firstSide: 'left' | 'right'): string {
  const line = Math.round((cut === 'vertical' ? whole.w : whole.h) * at);
  const low = cut === 'horizontal' || firstSide === 'left' ? first : second;
  const high = low === first ? second : first;
  if (cut === 'vertical') {
    if (low.w !== line || high.w !== whole.w - line || low.h !== whole.h || high.h !== whole.h) {
      return `sizes ${low.w}x${low.h} + ${high.w}x${high.h} of ${whole.w}x${whole.h} line ${line}`;
    }
    const a = diffAt(whole, low, 0, 0, line);
    const b = diffAt(whole, high, line, 0, line);
    return a === 0 && b === 0 ? '' : `pixels differ low ${a} high ${b}`;
  }
  if (low.h !== line || high.h !== whole.h - line || low.w !== whole.w || high.w !== whole.w) {
    return `sizes ${low.w}x${low.h} + ${high.w}x${high.h} of ${whole.w}x${whole.h} line ${line}`;
  }
  const a = diffAt(whole, low, 0, 0, -99, line);
  const b = diffAt(whole, high, 0, line, -99, line);
  return a === 0 && b === 0 ? '' : `pixels differ low ${a} high ${b}`;
}

export function openCore(bytes: Uint8Array): MupdfCore {
  const core = new MupdfCore(mu as never, {});
  core.open(bytes.slice(), undefined);
  return core;
}
export const reopen = (bytes: ArrayBuffer | Uint8Array): mu.Document =>
  mu.Document.openDocument(bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : bytes.slice(), 'application/pdf');
export const uids = (core: MupdfCore): string[] => core.editState!.pages().uids;
