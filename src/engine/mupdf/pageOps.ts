/**
 * The page operations of the page organizer, on a MuPDF document. Every function here changes the document, so it
 * must run inside one journal operation (editCore.ts opens it). Indices are positions in the page tree before the call.
 *
 * Order arithmetic (moveOrder, reverseOrder) and the page-range parser are pure and are kept apart from the document
 * work, so they can be tested without MuPDF.
 *
 * Copy-on-write: a duplicated page shares its content streams and resources with the original. No operation here edits
 * a stream or a shared dictionary in place. Content is changed by pointing the page at a new stream, and resources by
 * giving the page its own copy of the dictionary. So editing one duplicate never changes the other.
 */
import type * as Mu from 'mupdf';
import type { PageDims, PageTemplate } from './protocol';
import { WorkerFault, sliceFits } from './protocol';
import { pruneAfterPageReplace, rearrangeKeepingCatalog, snapshotReplacedPage } from './catalogGuard';
import { PageCarrier } from './annotCarry';

/** The page sizes the blank-page dialog offers, in points. */
export const PAGE_SIZES = {
  letter: { width: 612, height: 792 },
  a4: { width: 595, height: 842 },
  legal: { width: 612, height: 1008 },
} as const satisfies Record<string, PageDims>;

/** Spacing of the ruled lines and grid, in points, and the margin they stop short of. */
export const RULE_SPACING = 24;
export const TEMPLATE_MARGIN = 72;

/** A rectangle [x0, y0, x1, y1] in PDF points. */
export type Rect4 = [number, number, number, number];
/** A matrix [a, b, c, d, e, f] in PDF order. */
export type Matrix6 = [number, number, number, number, number, number];

/** The default page box when a page has none. US Letter. */
const DEFAULT_BOX: Rect4 = [0, 0, 612, 792];
/** Pixels darker than this (0 = black, 255 = white) count as page content in the auto-crop scan. */
export const INK_THRESHOLD = 200;
/** The auto-crop scan's resolution, in dots per inch. */
export const AUTO_CROP_DPI = 100;
/** The safety margin added around detected content, in points, when none is given. */
export const AUTO_CROP_MARGIN_PT = 2;

/**
 * The new order after moving the pages at `moving` (positions, ascending) before position `before` in the original
 * numbering (null moves them to the end). The moved pages keep their relative order. Returns the full order as old
 * positions. Moving a page before itself is refused.
 */
export function moveOrder(total: number, moving: readonly number[], before: number | null): number[] {
  const movingSet = new Set(moving);
  if (before !== null && movingSet.has(before)) throw new WorkerFault('Unsupported', 'Pages cannot be moved before themselves.');
  const rest: number[] = [];
  for (let i = 0; i < total; i++) if (!movingSet.has(i)) rest.push(i);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at < 0) throw new WorkerFault('Conflict', 'The page to move before is not in the document');
  const sorted = [...moving].sort((a, b) => a - b);
  return [...rest.slice(0, at), ...sorted, ...rest.slice(at)];
}

/**
 * The new order when the pages at `positions` swap places in reverse: the first selected position takes the last
 * selected page, and so on. Every other page stays where it is. Reversing all positions reverses the document.
 */
export function reverseOrder(total: number, positions: readonly number[]): number[] {
  const order = Array.from({ length: total }, (_unused, i) => i);
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const values = sorted.map((p) => order[p]!);
  values.reverse();
  sorted.forEach((p, i) => {
    order[p] = values[i]!;
  });
  return order;
}

/**
 * Parses a page range such as "1-5, 8" (1-based, inclusive) into page indices (0-based), ascending and without
 * repeats. Throws Unsupported for an empty or malformed range, and for a page outside 1..pageCount.
 */
export function parsePageRanges(text: string, pageCount: number): number[] {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new WorkerFault('Unsupported', 'Enter a page range, such as 1-5, 8.');
  const found = new Set<number>();
  for (const part of parts) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new WorkerFault('Unsupported', `"${part}" is not a page or a page range.`);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > pageCount || from > to) {
      throw new WorkerFault('Unsupported', `${part} is outside 1-${pageCount}.`);
    }
    for (let page = from; page <= to; page++) found.add(page - 1);
  }
  return [...found].sort((a, b) => a - b);
}

/** The content stream of a template page: nothing for blank, ruled lines for lined, lines both ways for grid. */
export function templateContent(template: PageTemplate, size: PageDims): string {
  if (template === 'blank') return '';
  const lines: string[] = ['0.72 G', '0.5 w'];
  const left = TEMPLATE_MARGIN;
  const right = size.width - TEMPLATE_MARGIN;
  const top = size.height - TEMPLATE_MARGIN;
  const bottom = TEMPLATE_MARGIN;
  for (let y = top; y >= bottom; y -= RULE_SPACING) {
    lines.push(`${left} ${y} m ${right} ${y} l S`);
  }
  if (template === 'grid') {
    for (let x = left; x <= right; x += RULE_SPACING) {
      lines.push(`${x} ${bottom} m ${x} ${top} l S`);
    }
  }
  return lines.join('\n');
}

/** Inserts one blank page of the given size and template at position `at`. */
export function insertBlankPage(pdf: Mu.PDFDocument, at: number, size: PageDims, template: PageTemplate): void {
  const page = pdf.addPage([0, 0, size.width, size.height], 0, {}, templateContent(template, size));
  pdf.insertPage(at, page);
  // The page has its own MediaBox, Rotate and Resources. A CropBox of the /Pages node it landed in would still apply.
  pinInheritedAttributes(pdf.findPage(at));
}

/** Keeps only the pages at `keep` (positions, in the order they should end up). Every other page is deleted. */
export function keepPages(pdf: Mu.PDFDocument, keep: readonly number[]): void {
  if (keep.length === 0) throw new WorkerFault('Unsupported', 'A PDF needs at least one page.');
  rearrangeKeepingCatalog(pdf, keep, true);
}

/** Puts the pages in the order given by `order` (a full permutation of positions). */
export function applyOrder(pdf: Mu.PDFDocument, order: readonly number[]): void {
  rearrangeKeepingCatalog(pdf, order, false);
}

/** Sets the page's own /Rotate to `degrees` turned clockwise from its current rotation. Only quarter turns. */
export function rotatePage(pdf: Mu.PDFDocument, index: number, degrees: number): void {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) throw new WorkerFault('Unsupported', 'Only quarter turns are applied here.');
  const page = pdf.findPage(index);
  const current = page.getInheritable('Rotate');
  const base = current.isNull() ? 0 : current.asNumber();
  const next = (((base + degrees) % 360) + 360) % 360;
  page.put('Rotate', next);
}

// ---- Reading boxes and content -------------------------------------------------------------------------------------

export function normalize(r: Rect4): Rect4 {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/** A rectangle from a PDF array, normalised. Null when the object is not an array of four numbers. */
export function readRect(obj: Mu.PDFObject | undefined): Rect4 | null {
  if (!obj) return null;
  const list = obj.resolve();
  if (!list.isArray() || list.length < 4) return null;
  const v = [0, 1, 2, 3].map((i) => list.get(i).resolve().asNumber());
  return normalize([v[0]!, v[1]!, v[2]!, v[3]!]);
}

/** The page's MediaBox, inherited when the page has none of its own. */
export function mediaBoxOf(page: Mu.PDFObject): Rect4 {
  return readRect(page.getInheritable('MediaBox')) ?? DEFAULT_BOX;
}

/** The page's own /Rotate, normalised to 0, 90, 180 or 270. */
export function rotationOfPage(page: Mu.PDFObject): number {
  const rotate = page.getInheritable('Rotate');
  if (rotate.isNull()) return 0;
  return (((Math.round(rotate.asNumber() / 90) * 90) % 360) + 360) % 360;
}

/** The page's display bounds (its CropBox, turned by /Rotate), which is the space the viewer shows. */
export function displayBounds(pdf: Mu.PDFDocument, index: number): Rect4 {
  const loaded = pdf.loadPage(index);
  try {
    return normalize(loaded.getBounds() as Rect4);
  } finally {
    loaded.destroy();
  }
}

/** The page's content streams as one byte string (Contents may be a stream or an array of streams). */
export function contentBytes(page: Mu.PDFObject): Uint8Array {
  // Not resolved: MuPDF's resolve() of a stream gives an object that isStream() rejects, so the reference is used as it is.
  const entry = optionalEntry(page, 'Contents');
  if (!entry || entry.isNull()) return new Uint8Array(0);
  const streams: Mu.PDFObject[] = [];
  if (entry.isArray()) {
    for (let i = 0; i < entry.length; i++) streams.push(entry.get(i));
  } else {
    streams.push(entry);
  }
  const parts = streams.filter((stream) => stream.isStream()).map((stream) => copyBytes(stream.readStream()));
  const total = parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1);
  const out = new Uint8Array(total);
  let at = 0;
  parts.forEach((part, i) => {
    if (i > 0) out[at++] = 10;
    out.set(part, at);
    at += part.length;
  });
  return out;
}

/** A copy of a MuPDF buffer's bytes as a plain Uint8Array. The view of the buffer lives in WASM memory, so it is copied. */
function copyBytes(buffer: Mu.Buffer): Uint8Array {
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

/** A number as a PDF content stream reads it: fixed notation, no exponent (1e-17 is not valid in a content stream). */
export function pdfNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** A PDF array of reals. */
function numbers(pdf: Mu.PDFDocument, values: readonly number[]): Mu.PDFObject {
  const list = pdf.newArray();
  for (const value of values) list.push(pdf.newReal(value));
  return list;
}

// ---- Content wrapping (fine rotation, resize) -----------------------------------------------------------------------

/**
 * Private page keys (not in the PDF spec, so viewers ignore them). They hold the state of a fine-angle rotation: the
 * box and content the page had before the first fine turn, and the total angle turned so far. Repeated turns start
 * from that state, so the box never grows and a total of 0 restores the page as it was.
 */
export const KEY_ORIG_BOX = 'PDFSuiteOrigBox';
export const KEY_ANGLE = 'PDFSuiteAngle';
const KEY_ORIG_CONTENTS = 'PDFSuiteOrigContents';
const KEY_ORIG_CROP = 'PDFSuiteOrigCrop';
const KEY_FORM = 'PDFSuiteForm';
const KEY_FORM_NAME = 'PDFSuiteFormName';
const PRIVATE_KEYS = [KEY_ORIG_BOX, KEY_ANGLE, KEY_ORIG_CONTENTS, KEY_ORIG_CROP, KEY_FORM, KEY_FORM_NAME] as const;

/** The matrix of a clockwise turn of `degrees` about (cx, cy), in PDF user space (y up). */
export function turnMatrix(degrees: number, cx: number, cy: number): Matrix6 {
  const theta = (-degrees * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

/** A point through a matrix, in the PDF convention (row vectors: x' = a*x + c*y + e). */
export function applyMatrix(m: Matrix6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The bounding box of a rectangle after a matrix. */
export function transformRect(rect: Rect4, m: Matrix6): Rect4 {
  const corners = [
    applyMatrix(m, rect[0], rect[1]),
    applyMatrix(m, rect[2], rect[1]),
    applyMatrix(m, rect[2], rect[3]),
    applyMatrix(m, rect[0], rect[3]),
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A flat list of x, y pairs through a matrix. */
export function transformPairs(values: readonly number[], m: Matrix6): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const [x, y] = applyMatrix(m, values[i]!, values[i + 1]!);
    out.push(x, y);
  }
  return out;
}

/** A name in a resource dictionary that the dictionary does not use yet. */
function freshName(dict: Mu.PDFObject): string {
  for (let k = 1; ; k++) {
    const name = `PSFm${k}`;
    if (optionalEntry(dict, name) === undefined) return name;
  }
}

/**
 * Puts the page's current content inside a new Form XObject whose box is `bbox`, and gives the page its own resources
 * that name the form. The page's Contents is not changed here. The old content streams become the form's content and
 * are never edited, so a duplicate that shares them is safe (copy-on-write).
 */
function wrapForm(pdf: Mu.PDFDocument, page: Mu.PDFObject, bbox: Rect4): { form: Mu.PDFObject; name: string } {
  const bytes = contentBytes(page);
  const inherited = page.getInheritable('Resources');
  const resources = inherited.isNull() ? pdf.newDictionary() : inherited.resolve();

  const formDict = pdf.newDictionary();
  formDict.put('Type', pdf.newName('XObject'));
  formDict.put('Subtype', pdf.newName('Form'));
  formDict.put('BBox', numbers(pdf, bbox));
  formDict.put('Resources', resources);
  const form = pdf.addStream(bytes, formDict);

  // The page gets its own resources, so the dictionary a duplicate shares is not changed.
  const ownResources = shallowCopy(pdf, resources, new Set<string>());
  const xobjects = optionalEntry(resources, 'XObject')?.resolve();
  const ownXObjects = xobjects && xobjects.isDictionary() ? shallowCopy(pdf, xobjects, new Set<string>()) : pdf.newDictionary();
  const name = freshName(ownXObjects);
  ownXObjects.put(name, form);
  ownResources.put('XObject', ownXObjects);
  page.put('Resources', ownResources);
  return { form, name };
}

/** Sets the page's Contents to a stream that draws the named form through `matrix`. */
function drawThrough(pdf: Mu.PDFDocument, page: Mu.PDFObject, name: string, matrix: Matrix6): void {
  const draw = `q ${matrix.map(pdfNumber).join(' ')} cm /${name} Do Q`;
  page.put('Contents', pdf.addStream(draw, pdf.newDictionary()));
}

/** Wraps the page content and draws it through `matrix` (resize). The MediaBox is left to the caller. */
function wrapContent(pdf: Mu.PDFDocument, page: Mu.PDFObject, matrix: Matrix6): void {
  const { name } = wrapForm(pdf, page, mediaBoxOf(page));
  drawThrough(pdf, page, name, matrix);
}

/**
 * Removes the private state of a fine-angle rotation. The content stays as it is, so the page keeps its current box and
 * angle as its new starting point. Called before an operation that changes the box in another way (resize, crop).
 */
export function bakeFineRotation(page: Mu.PDFObject): void {
  for (const key of PRIVATE_KEYS) page.delete(key);
}

/** The annotation geometry keys and how their values are laid out. */
const POINT_KEYS = ['QuadPoints', 'Vertices', 'L'] as const;

/**
 * Moves one annotation dictionary, and the popup linked from it, through `m`: /Rect, /QuadPoints, /Vertices, /L,
 * /InkList and the popup's /Rect. New arrays are written, never edited in place, because an array can be shared with
 * another page. `done` holds the object numbers already moved, so an object that is both an annotation and a popup
 * moves once.
 */
function transformAnnotation(pdf: Mu.PDFDocument, dict: Mu.PDFObject, m: Matrix6, done: Set<number>): void {
  const rect = readRect(optionalEntry(dict, 'Rect'));
  if (rect) dict.put('Rect', numbers(pdf, transformRect(rect, m)));
  for (const key of POINT_KEYS) {
    const values = numbersOf(optionalEntry(dict, key));
    if (values) dict.put(key, numbers(pdf, transformPairs(values, m)));
  }
  const ink = optionalEntry(dict, 'InkList')?.resolve();
  if (ink && ink.isArray()) {
    const strokes = pdf.newArray();
    for (let i = 0; i < ink.length; i++) {
      const stroke = pdf.newArray();
      for (const value of transformPairs(numbersOf(ink.get(i)) ?? [], m)) stroke.push(pdf.newReal(value));
      strokes.push(stroke);
    }
    dict.put('InkList', strokes);
  }
  const popupEntry = optionalEntry(dict, 'Popup');
  if (!popupEntry) return;
  if (popupEntry.isIndirect()) {
    const number = popupEntry.asIndirect();
    if (done.has(number)) return;
    done.add(number);
  }
  const popup = popupEntry.resolve();
  const popupRect = popup.isDictionary() ? readRect(optionalEntry(popup, 'Rect')) : null;
  if (popupRect) popup.put('Rect', numbers(pdf, transformRect(popupRect, m)));
}

/** Moves every annotation of the page through `m`. See transformAnnotation. */
function transformAnnotations(pdf: Mu.PDFDocument, page: Mu.PDFObject, m: Matrix6): void {
  const done = new Set<number>();
  for (const annot of annotationsOf(page)) {
    if (annot.key !== null) {
      if (done.has(annot.key)) continue;
      done.add(annot.key);
    }
    transformAnnotation(pdf, annot.dict, m, done);
  }
}

/** The numbers of a PDF array, or null when the object is not an array. */
function numbersOf(obj: Mu.PDFObject | undefined): number[] | null {
  if (!obj) return null;
  const list = obj.resolve();
  if (!list.isArray()) return null;
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) out.push(list.get(i).resolve().asNumber());
  return out;
}

/** True when a total angle is a whole turn, so the page needs no wrapper. */
function isWholeTurn(degrees: number): boolean {
  const mod = ((degrees % 360) + 360) % 360;
  return Math.abs(mod) < 1e-9 || Math.abs(mod - 360) < 1e-9;
}

/**
 * Turns the page by `degrees` (positive is clockwise, as the viewer turns). The first fine turn wraps the content and
 * records the original box, the original content and the original crop. Each later turn redraws the same wrapper at the
 * total angle, so the MediaBox is the bounding box of the original box turned by the total, and does not grow. A total
 * of a whole turn restores the original box and content. Annotations move with the page. The page's own /Rotate is
 * untouched, so a fine angle stacks with a quarter turn.
 */
export function fineRotatePage(pdf: Mu.PDFDocument, index: number, degrees: number): void {
  if (!Number.isFinite(degrees)) throw new WorkerFault('Unsupported', 'The angle must be a number.');
  const page = pdf.findPage(index);
  const media = mediaBoxOf(page);
  const cx = (media[0] + media[2]) / 2;
  const cy = (media[1] + media[3]) / 2;

  let origBox: Rect4;
  let total: number;
  let formName: string;
  const stated = optionalEntry(page, KEY_ORIG_BOX) !== undefined;
  if (!stated) {
    // The first fine turn: keep what the page had, so every later turn starts from it.
    origBox = media;
    total = 0;
    const crop = readRect(optionalEntry(page, 'CropBox'));
    const contents = optionalEntry(page, 'Contents');
    const { form, name } = wrapForm(pdf, page, media);
    formName = name;
    page.put(KEY_ORIG_BOX, numbers(pdf, media));
    page.put(KEY_FORM, form);
    page.put(KEY_FORM_NAME, pdf.newName(name));
    if (contents) page.put(KEY_ORIG_CONTENTS, contents);
    if (crop) page.put(KEY_ORIG_CROP, numbers(pdf, crop));
  } else {
    origBox = readRect(optionalEntry(page, KEY_ORIG_BOX)) ?? media;
    total = optionalEntry(page, KEY_ANGLE)?.asNumber() ?? 0;
    formName = String(optionalEntry(page, KEY_FORM_NAME)?.asName() ?? 'PSFm1');
  }

  // The annotations turn by this step, about the centre the page has now (the centre of the original box too).
  transformAnnotations(pdf, page, turnMatrix(degrees, cx, cy));

  const next = total + degrees;
  if (isWholeTurn(next)) {
    const contents = optionalEntry(page, KEY_ORIG_CONTENTS);
    if (contents) page.put('Contents', contents);
    else page.delete('Contents');
    page.put('MediaBox', numbers(pdf, origBox));
    const crop = readRect(optionalEntry(page, KEY_ORIG_CROP));
    if (crop) page.put('CropBox', numbers(pdf, crop));
    else clearCrop(pdf, page);
    bakeFineRotation(page);
    return;
  }

  const origCentre = [(origBox[0] + origBox[2]) / 2, (origBox[1] + origBox[3]) / 2];
  const matrix = turnMatrix(next, origCentre[0]!, origCentre[1]!);
  drawThrough(pdf, page, formName, matrix);
  page.put('MediaBox', numbers(pdf, transformRect(origBox, matrix)));
  const crop = readRect(optionalEntry(page, KEY_ORIG_CROP));
  if (crop) page.put('CropBox', numbers(pdf, transformRect(crop, matrix)));
  page.put(KEY_ANGLE, pdf.newReal(next));
}

/**
 * Sets the page size to `size` (display size, so a page turned by 90 or 270 takes the sides the other way round). With
 * `fit` 'scale' the content is scaled to fit and centred; with 'center' it keeps its size and is centred. The
 * MediaBox becomes the new size, and any CropBox is removed. Annotations move with the content.
 */
export function resizePage(pdf: Mu.PDFDocument, index: number, size: PageDims, fit: 'scale' | 'center'): void {
  if (!(size.width > 0 && size.height > 0)) throw new WorkerFault('Unsupported', 'The page size must be positive.');
  const page = pdf.findPage(index);
  bakeFineRotation(page);
  const [x0, y0, x1, y1] = mediaBoxOf(page);
  const w = x1 - x0;
  const h = y1 - y0;
  const sideways = rotationOfPage(page) % 180 !== 0;
  const displayW = sideways ? h : w;
  const displayH = sideways ? w : h;
  const s = fit === 'scale' ? Math.min(size.width / displayW, size.height / displayH) : 1;
  const boxW = sideways ? size.height : size.width;
  const boxH = sideways ? size.width : size.height;
  const tx = (boxW - w * s) / 2 - x0 * s;
  const ty = (boxH - h * s) / 2 - y0 * s;
  const matrix: Matrix6 = [s, 0, 0, s, tx, ty];
  wrapContent(pdf, page, matrix);
  transformAnnotations(pdf, page, matrix);
  page.put('MediaBox', numbers(pdf, [0, 0, boxW, boxH]));
  clearCrop(pdf, page);
}

/**
 * "No crop" for a page: its CropBox is written as its own MediaBox. The entry is not deleted, because a page without a CropBox
 * takes the one of the /Pages node above it, so a tree whose node carries a CropBox would crop the page again.
 */
export function clearCrop(pdf: Mu.PDFDocument, page: Mu.PDFObject): void {
  page.put('CropBox', numbers(pdf, mediaBoxOf(page)));
}

// ---- Crop -----------------------------------------------------------------------------------------------------------

/**
 * Sets the CropBox to `display`, a rectangle in the page's display space (the space of displayBounds). Null removes the
 * crop. The rectangle is turned into user space and clipped to the MediaBox.
 */
export function setCropBox(mu: Pick<typeof Mu, 'Matrix' | 'Rect'>, pdf: Mu.PDFDocument, index: number, display: Rect4 | null): void {
  const page = pdf.findPage(index);
  bakeFineRotation(page);
  if (display === null) {
    clearCrop(pdf, page);
    return;
  }
  const loaded = pdf.loadPage(index);
  let user: Rect4;
  try {
    user = normalize(mu.Rect.transform(normalize(display), mu.Matrix.invert(loaded.getTransform())) as Rect4);
  } finally {
    loaded.destroy();
  }
  const media = mediaBoxOf(page);
  const clipped: Rect4 = [Math.max(user[0], media[0]), Math.max(user[1], media[1]), Math.min(user[2], media[2]), Math.min(user[3], media[3])];
  if (clipped[2] - clipped[0] <= 0 || clipped[3] - clipped[1] <= 0) {
    throw new WorkerFault('Unsupported', 'The crop lies outside the page.');
  }
  page.put('CropBox', numbers(pdf, clipped));
}

type RenderKit = Pick<typeof Mu, 'Matrix' | 'Pixmap' | 'ColorSpace' | 'DrawDevice'>;

/**
 * The bounding box, in display space, of the pixels that are not blank. The page is drawn at `dpi` in gray, and a pixel
 * darker than `threshold` counts as content. Null when the page is blank.
 */
export function contentBoundsDisplay(mu: RenderKit, pdf: Mu.PDFDocument, index: number, dpi = AUTO_CROP_DPI, threshold = INK_THRESHOLD): Rect4 | null {
  const bounds = displayBounds(pdf, index);
  const scale = dpi / 72;
  const width = Math.max(1, Math.ceil((bounds[2] - bounds[0]) * scale));
  const height = Math.max(1, Math.ceil((bounds[3] - bounds[1]) * scale));
  const loaded = pdf.loadPage(index);
  try {
    const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, width, height], false);
    try {
      pixmap.clear(255);
      const matrix: Mu.Matrix = [scale, 0, 0, scale, -bounds[0] * scale, -bounds[1] * scale];
      const device = new mu.DrawDevice(matrix, pixmap);
      try {
        loaded.run(device, mu.Matrix.identity);
      } finally {
        device.close();
        device.destroy();
      }
      const pixels = pixmap.getPixels();
      const stride = pixmap.getStride();
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        const row = y * stride;
        for (let x = 0; x < width; x++) {
          if (pixels[row + x]! < threshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      return [bounds[0] + minX / scale, bounds[1] + minY / scale, bounds[0] + (maxX + 1) / scale, bounds[1] + (maxY + 1) / scale];
    } finally {
      pixmap.destroy();
    }
  } finally {
    loaded.destroy();
  }
}

/**
 * The display-space crop that keeps the content of a page with `margin` points around it, clamped to the page. Null
 * when the page is blank.
 */
export function autoCropDisplay(mu: RenderKit, pdf: Mu.PDFDocument, index: number, margin = AUTO_CROP_MARGIN_PT): Rect4 | null {
  const found = contentBoundsDisplay(mu, pdf, index);
  if (!found) return null;
  const bounds = displayBounds(pdf, index);
  return [
    Math.max(bounds[0], found[0] - margin),
    Math.max(bounds[1], found[1] - margin),
    Math.min(bounds[2], found[2] + margin),
    Math.min(bounds[3], found[3] + margin),
  ];
}

// ---- Insert, replace, extract ---------------------------------------------------------------------------------------

/**
 * Copies page `srcIndex` of `src` into `pdf` at position `at`. The page keeps its content, resources and annotations.
 * Both documents must be open in the same worker.
 */
export function graftPageAt(pdf: Mu.PDFDocument, at: number, src: Mu.PDFDocument, srcIndex: number, map?: Mu.PDFGraftMap): void {
  // One map per edit (made by the caller, dropped with the edit) copies a resource that several pages share only once.
  (map ?? pdf).graftPage(at, src, srcIndex);
  pinInheritedAttributes(pdf.findPage(at));
}

/**
 * Overwrites the page dictionary at `index` with page `srcIndex` of `src`. The target keeps its own object, so the
 * outline destinations, links and other references that point at it still work. Its old content, resources and
 * annotations are replaced.
 */
export function replacePageFrom(pdf: Mu.PDFDocument, index: number, src: Mu.PDFDocument, srcIndex: number): void {
  const at = pdf.countPages();
  const map = pdf.newGraftMap();
  try {
    map.graftPage(at, src, srcIndex);
    // The replacement keeps its comments, form fields and links (graftPage leaves them behind). Internal links go: the other pages are not here.
    const carrier = new PageCarrier(pdf, src, map);
    carrier.carry(srcIndex, at);
    carrier.carryLinks(srcIndex, at, () => null);
  } finally {
    map.destroy();
  }
  const incoming = pdf.findPage(at);
  const target = pdf.findPage(index);
  // The target's own annotations and tags leave with its old content: the form's field tree and the structure tree must lose them too.
  const old = snapshotReplacedPage(target);
  const incomingKeys = new Set<string>();
  incoming.forEach((_value, key) => {
    incomingKeys.add(String(key));
  });
  const targetKeys: string[] = [];
  target.forEach((_value, key) => {
    targetKeys.push(String(key));
  });
  for (const key of targetKeys) {
    if (key !== 'Parent' && !incomingKeys.has(key)) target.delete(key);
  }
  incoming.forEach((value, key) => {
    const name = String(key);
    if (name !== 'Parent') target.put(name, value);
  });
  // A key the target lost (its own CropBox, Rotate or Resources) must not be replaced by the value of its /Pages node.
  pinInheritedAttributes(target);
  // The incoming annotations point at the page they came with. They now belong to the target page.
  const annots = optionalEntry(target, 'Annots')?.resolve();
  if (annots && annots.isArray()) {
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i).resolve();
      if (annot.isDictionary()) annot.put('P', target);
    }
  }
  pdf.deletePage(at);
  pruneAfterPageReplace(pdf, old);
}

/** Keys of a page dictionary that a copy must not carry over as they are. */
const PAGE_SKIP = new Set(['Parent', 'Annots', 'StructParents']);
/** Keys of an annotation that are rebuilt for a copy: the page link, and the popup and reply links, which are mapped. */
const ANNOT_SKIP = new Set(['P', 'Popup', 'Parent', 'StructParent']);

/** A new direct dictionary with the entries of `src`, except the skipped keys. Values are shared, not copied. */
export function shallowCopy(pdf: Mu.PDFDocument, src: Mu.PDFObject, skip: ReadonlySet<string>): Mu.PDFObject {
  const dict = pdf.newDictionary();
  src.forEach((value, key) => {
    const name = String(key);
    if (!skip.has(name)) dict.put(name, value);
  });
  return dict;
}

/** Page attributes a page may inherit from a /Pages node above it (PDF 32000-1, table 30). UserUnit is not one of them. */
const INHERITABLE_PAGE_KEYS = ['MediaBox', 'CropBox', 'Rotate', 'Resources'] as const;

/**
 * The PDF default of an inheritable page attribute, written explicitly where a /Pages node must not be allowed to supply a value:
 * Rotate 0, a CropBox equal to the MediaBox, empty Resources. Undefined for MediaBox, which has none.
 */
function pdfDefaultFor(pdf: Mu.PDFDocument, key: (typeof INHERITABLE_PAGE_KEYS)[number], mediaBox: Mu.PDFObject | undefined): Mu.PDFObject | undefined {
  if (key === 'Rotate') return pdf.newInteger(0);
  if (key === 'CropBox') return mediaBox;
  if (key === 'Resources') return pdf.newDictionary();
  return undefined;
}

/**
 * Gives a page that has no value of its own for an inheritable attribute a neutral explicit one, when the /Pages node above
 * it would otherwise supply a value: Rotate 0, a CropBox equal to the MediaBox, empty Resources. Call it on a page that
 * now holds exactly what its source held, so landing under another node cannot change how it looks. A page that already
 * has its own value keeps it. The grafted attributes of a source that did have a value are already explicit.
 */
export function pinInheritedAttributes(page: Mu.PDFObject): void {
  const pdf = page._doc;
  for (const key of INHERITABLE_PAGE_KEYS) {
    if (optionalEntry(page, key) !== undefined) continue;
    const inherited = page.getInheritable(key);
    if (inherited.isNull()) continue;
    // MediaBox has no default: a page without one has no size of its own to pin, and its source had none either.
    const neutral = pdfDefaultFor(pdf, key, page.getInheritable('MediaBox'));
    if (neutral) page.put(key, neutral);
  }
}

/**
 * A new page dictionary from `page` (the page at `index`, without its Parent and Annots) for a copy. MuPDF inserts the copy
 * under the parent of the page that comes next, which can be another /Pages node with other values. So every inheritable
 * attribute is written on the copy itself: the source's own or inherited value, and when the source has none at all, the PDF
 * default (Rotate 0, CropBox = the effective MediaBox, Resources = an empty dictionary), so the copy cannot pick one up from
 * that other node. A MediaBox that is absent everywhere (required, so the file is damaged) becomes the page bounds MuPDF reports.
 */
function pageCopyDict(pdf: Mu.PDFDocument, page: Mu.PDFObject, index: number): Mu.PDFObject {
  const copy = shallowCopy(pdf, page, PAGE_SKIP);
  const effective = new Map<string, Mu.PDFObject>();
  for (const key of INHERITABLE_PAGE_KEYS) {
    if (optionalEntry(page, key) !== undefined) {
      effective.set(key, page.get(key));
      continue;
    }
    const inherited = page.getInheritable(key);
    if (!inherited.isNull()) {
      copy.put(key, inherited);
      effective.set(key, inherited);
    }
  }
  if (!effective.has('MediaBox')) {
    const loaded = pdf.loadPage(index);
    try {
      const mediaBox = pdf.newArray();
      for (const v of normalize(loaded.getBounds() as Rect4)) mediaBox.push(pdf.newReal(v));
      copy.put('MediaBox', mediaBox);
      effective.set('MediaBox', mediaBox);
    } finally {
      loaded.destroy();
    }
  }
  for (const key of INHERITABLE_PAGE_KEYS) {
    if (effective.has(key)) continue;
    const neutral = pdfDefaultFor(pdf, key, effective.get('MediaBox'));
    if (neutral) copy.put(key, neutral);
  }
  return copy;
}

/**
 * The entry under `key` of a dictionary, or undefined when the dictionary has no such key. A lookup of a missing key
 * does not return a clean null in MuPDF (it returns an object over a null pointer), so the keys are listed instead.
 */
export function optionalEntry(dict: Mu.PDFObject, key: string): Mu.PDFObject | undefined {
  let present = false;
  dict.forEach((_value, name) => {
    if (String(name) === key) present = true;
  });
  return present ? dict.get(key) : undefined;
}

/** The annotations of a page: each one's object number when it is indirect, and its dictionary. */
export function annotationsOf(page: Mu.PDFObject): Array<{ key: number | null; dict: Mu.PDFObject }> {
  const entry = optionalEntry(page, 'Annots');
  const list = entry?.resolve();
  if (!list || !list.isArray()) return [];
  const out: Array<{ key: number | null; dict: Mu.PDFObject }> = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list.get(i);
    const dict = raw.resolve();
    if (!dict.isDictionary()) continue;
    out.push({ key: raw.isIndirect() ? raw.asIndirect() : null, dict });
  }
  return out;
}

/**
 * Copies the page at `index` and inserts the copy right after it. The copy has its own page dictionary and its own
 * annotation objects. Each copied annotation points at the copied page, and its popup and reply links point at the
 * copies of their targets. A widget keeps its link to its form field, and the copy joins the field's Kids, so the
 * field's value is shared by both pages. The content streams and resources are shared, which is safe because nothing
 * here edits them (copy-on-write).
 */
export function duplicatePageAt(pdf: Mu.PDFDocument, index: number): void {
  const source = pdf.findPage(index);
  const copyRef = pdf.createObject();
  const annots = annotationsOf(source);
  const refs = annots.map(() => pdf.createObject());
  const copyOf = new Map<number, Mu.PDFObject>();
  annots.forEach((annot, i) => {
    if (annot.key !== null) copyOf.set(annot.key, refs[i]!);
  });

  annots.forEach((annot, i) => {
    const dict = shallowCopy(pdf, annot.dict, ANNOT_SKIP);
    dict.put('P', copyRef);
    const popup = optionalEntry(annot.dict, 'Popup');
    if (popup) {
      const mapped = popup.isIndirect() ? copyOf.get(popup.asIndirect()) : undefined;
      if (mapped) {
        dict.put('Popup', mapped);
      } else if (popup.resolve().isDictionary()) {
        // A popup that is not one of the page's annotations is copied too, and linked back to this copy.
        const popupRef = pdf.createObject();
        const popupDict = shallowCopy(pdf, popup.resolve(), ANNOT_SKIP);
        popupDict.put('P', copyRef);
        popupDict.put('Parent', refs[i]!);
        popupRef.writeObject(popupDict);
        dict.put('Popup', popupRef);
      }
    }
    const parent = optionalEntry(annot.dict, 'Parent');
    if (parent) {
      const mapped = parent.isIndirect() ? copyOf.get(parent.asIndirect()) : undefined;
      if (mapped) {
        dict.put('Parent', mapped);
      } else {
        // A form field is shared: the copy keeps the field, and joins its Kids so it takes part in the field's value.
        dict.put('Parent', parent);
        const field = parent.resolve();
        const kids = optionalEntry(field, 'Kids')?.resolve();
        if (field.isDictionary() && kids && kids.isArray()) kids.push(refs[i]!);
      }
    }
    refs[i]!.writeObject(dict);
  });

  const copy = pageCopyDict(pdf, source, index);
  if (annots.length > 0) {
    const list = pdf.newArray();
    for (const ref of refs) list.push(ref);
    copy.put('Annots', list);
  }
  copyRef.writeObject(copy);
  pdf.insertPage(index + 1, copyRef);
}

// ---- Slice (Cut pages in half) ---------------------------------------------------------------------------------------

/** The cut line of a slice: 'vertical' makes a left and a right page, 'horizontal' a top and a bottom page. */
export type SliceCut = 'vertical' | 'horizontal';
/** Which half comes first in the document. A horizontal cut is always top first, whatever this says. */
export type SliceFirst = 'left' | 'right';

/** The cut position the UI offers (a share of the page width or height), and the engine accepts: 30% to 70%. */
export const SLICE_AT_MIN = 0.3;
export const SLICE_AT_MAX = 0.7;

/** The two halves of a page in display space, and where the cut falls. */
export interface SliceGeometry {
  /** The half that keeps the page's own object and uid. */
  first: Rect4;
  /** The half that becomes a new page, right after the first. */
  second: Rect4;
  /** The cut's coordinate in display space: x for a vertical cut, y (down) for a horizontal one. */
  line: number;
  /** True when the first half is the one with the smaller coordinate (left, or top). */
  lowFirst: boolean;
}

/**
 * The halves of a page whose display bounds are `bounds` (its CropBox with /Rotate applied, y down). The cut is at the
 * share `at` of the width (vertical) or of the height (horizontal). A vertical cut puts the left half first, unless `first`
 * is 'right' (books read right to left); a horizontal cut always puts the top first.
 */
export function sliceGeometry(bounds: Rect4, cut: SliceCut, at: number, first: SliceFirst): SliceGeometry {
  const [x0, y0, x1, y1] = bounds;
  if (cut === 'horizontal') {
    const y = y0 + (y1 - y0) * at;
    return { first: [x0, y0, x1, y], second: [x0, y, x1, y1], line: y, lowFirst: true };
  }
  const x = x0 + (x1 - x0) * at;
  const left: Rect4 = [x0, y0, x, y1];
  const right: Rect4 = [x, y0, x1, y1];
  return first === 'left' ? { first: left, second: right, line: x, lowFirst: true } : { first: right, second: left, line: x, lowFirst: false };
}

/** Which half holds a point of display space: 'first' or 'second'. On the line itself it is the half after the line. */
export function sliceHalfOf(geometry: SliceGeometry, cut: SliceCut, point: readonly [number, number]): 'first' | 'second' {
  const coordinate = cut === 'horizontal' ? point[1] : point[0];
  const low = coordinate < geometry.line;
  return low === geometry.lowFirst ? 'first' : 'second';
}

export { sliceFits };

/** The object number a reference points at, or null when the object is direct. */
function keyOf(obj: Mu.PDFObject | undefined): number | null {
  return obj && obj.isIndirect() ? obj.asIndirect() : null;
}

/**
 * Cuts the page at `index` into two pages. The page keeps its own object and becomes the first half; a copy of its
 * dictionary, inserted right after it, becomes the second half. Both share the content streams and resources (nothing here
 * edits them), and both get a CropBox: the cut is made by the page boxes, so the file does not grow and an undo is cheap.
 * The cut follows what the viewer shows (display space), so it is right on rotated and cropped pages.
 *
 * Annotations (links and comments among them) are moved, not copied: each goes to the half that holds the centre of its
 * /Rect. A popup, and a reply, follow the annotation they belong to, and /P is pointed at the page the annotation is on now.
 * A form widget stays a kid of its field, so the field and its value are untouched. Outline destinations point at the page
 * object, so they land on the first half.
 */
export function slicePageAt(mu: Pick<typeof Mu, 'Matrix' | 'Rect'>, pdf: Mu.PDFDocument, index: number, cut: SliceCut, at: number, first: SliceFirst): void {
  if (!(at >= SLICE_AT_MIN && at <= SLICE_AT_MAX)) throw new WorkerFault('Unsupported', 'The cut must fall between 30% and 70% of the page.');
  const page = pdf.findPage(index);
  bakeFineRotation(page);

  let bounds: Rect4;
  let toDisplay: Matrix6;
  const loaded = pdf.loadPage(index);
  try {
    bounds = normalize(loaded.getBounds() as Rect4);
    toDisplay = loaded.getTransform() as Matrix6;
  } finally {
    loaded.destroy();
  }
  const geometry = sliceGeometry(bounds, cut, at, first);

  // Which half each annotation goes to, decided before anything changes. An annotation goes by the centre of its /Rect; a
  // popup follows its parent and a reply the annotation it answers (when that one is on this page), so they stay together.
  const annots = annotationsOf(page);
  const sideByKey = new Map<number, 'first' | 'second'>();
  const byCentre = (dict: Mu.PDFObject): 'first' | 'second' => {
    const rect = readRect(optionalEntry(dict, 'Rect'));
    if (!rect) return 'first';
    return sliceHalfOf(geometry, cut, applyMatrix(toDisplay, (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2));
  };
  const followsAnother = (dict: Mu.PDFObject): boolean => {
    const subtype = optionalEntry(dict, 'Subtype');
    return (subtype !== undefined && subtype.isName() && subtype.asName() === 'Popup') || optionalEntry(dict, 'IRT') !== undefined;
  };
  const sides: Array<'first' | 'second'> = [];
  annots.forEach((annot, i) => {
    if (followsAnother(annot.dict)) return;
    const side = byCentre(annot.dict);
    sides[i] = side;
    if (annot.key !== null) sideByKey.set(annot.key, side);
    // The popup a markup annotation points at goes with it, even when the popup's own /Rect lies in the other half.
    const popup = keyOf(optionalEntry(annot.dict, 'Popup'));
    if (popup !== null) sideByKey.set(popup, side);
  });
  annots.forEach((annot, i) => {
    if (sides[i] !== undefined) return;
    const own = annot.key === null ? undefined : sideByKey.get(annot.key);
    const leader = keyOf(optionalEntry(annot.dict, 'Parent')) ?? keyOf(optionalEntry(annot.dict, 'IRT'));
    const led = leader === null ? undefined : sideByKey.get(leader);
    sides[i] = own ?? led ?? byCentre(annot.dict);
  });

  // The second page: the first one's dictionary without its parent and annotations, inserted right after it.
  const copyRef = pdf.createObject();
  copyRef.writeObject(pageCopyDict(pdf, page, index));
  pdf.insertPage(index + 1, copyRef);

  const original = optionalEntry(page, 'Annots')?.resolve();
  if (original && original.isArray()) {
    const firstList = pdf.newArray();
    const secondList = pdf.newArray();
    let n = 0;
    for (let i = 0; i < original.length; i++) {
      const raw = original.get(i);
      if (!raw.resolve().isDictionary()) {
        firstList.push(raw);
        continue;
      }
      const side = sides[n++]!;
      (side === 'first' ? firstList : secondList).push(raw);
      if (side === 'second' && optionalEntry(raw.resolve(), 'P') !== undefined) raw.resolve().put('P', copyRef);
    }
    page.put('Annots', firstList);
    if (secondList.length > 0) pdf.findPage(index + 1).put('Annots', secondList);
  }

  setCropBox(mu, pdf, index, geometry.first);
  setCropBox(mu, pdf, index + 1, geometry.second);
}
