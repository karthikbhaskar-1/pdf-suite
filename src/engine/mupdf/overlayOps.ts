/**
 * Overlay, the result (1.3.4 "Add overlay to pages"): lays a page of another PDF over a page of the open document, for good.
 * It runs inside one journal operation (editCore.ts opens it), like every function in pageOps.ts.
 *
 * How: the overlay page is grafted into the document (as Insert from PDF does) only to bring its content and resources over;
 * its content is wrapped as a Form XObject (with a transparency group, so the whole overlay blends as one), the temporary
 * page is deleted again, and the base page's Contents becomes [q, original..., Q, draw]. The page gets its own Resources
 * (copy-on-write: a duplicate that shares the old dictionary is not changed) with the form and an ExtGState holding the blend
 * mode. The original content streams are never edited. The overlay file's annotations are not carried (graftPage leaves them
 * behind, see overlayProbe.test.ts), which is what the sheet says.
 *
 * The placement is `placementMatrix` of overlayPlacement.ts, the same function the live view uses.
 */
import type * as Mu from 'mupdf';
import { WorkerFault } from './protocol';
import { bakeFineRotation, contentBytes, normalize, optionalEntry, pdfNumber, shallowCopy, type Rect4 } from './pageOps';
import {
  clampOpacity,
  concatMatrix,
  invertMatrix,
  mapRect,
  placementMatrix,
  validScale,
  type AppliedMode,
  type PlaceMatrix,
  type Placement,
} from '../overlayPlacement';

/** What one applied overlay needs besides the pages: the placement, the blend mode and the opacity (used by 'blend'). */
export interface OverlayOptions extends Placement {
  mode: AppliedMode;
  opacity: number;
}

/** The Form XObject made for one page of the overlay file, and the page's geometry. Reused for every base page in one edit. */
export interface OverlayForm {
  form: Mu.PDFObject;
  /** The overlay page's display bounds. */
  bounds: Rect4;
  /** The overlay page's user space to its display space. */
  toDisplay: PlaceMatrix;
}

/**
 * What one overlay edit shares between its pages: the forms made so far, by page of the overlay file, and one graft map, so
 * a font or image that several overlay pages use is copied into the document once (a graft map made per page copies it per
 * page). Made at the start of the edit and thrown away at its end, never kept across edits: an undo removes the objects a
 * kept map would still point at.
 */
export interface OverlayContext {
  forms: Map<number, OverlayForm>;
  map: Mu.PDFGraftMap;
}

/**
 * How many graphics states (`q`) the content leaves open at its end: more `q` than `Q`, counting only operators. Strings,
 * hex strings, comments, names and the data of inline images are skipped, so a "q" inside them is not an operator. A `Q` with
 * nothing open is ignored, as viewers do. The overlay's drawing is appended after the content, and every open state must be
 * closed first or its transform and clip would leak into the drawing.
 */
export function openGraphicsStates(content: Uint8Array): number {
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
  const n = content.length;
  let depth = 0;
  let i = 0;
  // The end of the word starting at `from`: up to white space or a delimiter.
  const wordEnd = (from: number): number => {
    let j = from;
    while (j < n && !WS.has(content[j]!) && !DELIM.has(content[j]!)) j++;
    return j;
  };
  while (i < n) {
    const c = content[i]!;
    if (WS.has(c)) {
      i++;
    } else if (c === 0x25) {
      // A comment runs to the end of the line.
      while (i < n && content[i] !== 10 && content[i] !== 13) i++;
    } else if (c === 0x28) {
      // A string: parentheses nest, and a backslash escapes the next byte.
      let level = 1;
      i++;
      while (i < n && level > 0) {
        const d = content[i]!;
        if (d === 0x5c) {
          i += 2;
        } else {
          if (d === 0x28) level++;
          else if (d === 0x29) level--;
          i++;
        }
      }
    } else if (c === 0x3c && content[i + 1] === 0x3c) {
      // "<<" opens a dictionary (a BDC or DP property list, say). Its entries are read as tokens, so a string inside is skipped
      // as a string and a name as a name; ">>" is a lone delimiter below.
      i += 2;
    } else if (c === 0x3c) {
      // A hex string.
      while (i < n && content[i] !== 0x3e) i++;
      i++;
    } else if (DELIM.has(c)) {
      // A name starts with "/": its characters are not operators. Other delimiters stand alone.
      i = c === 0x2f ? wordEnd(i + 1) : i + 1;
    } else {
      const end = wordEnd(i);
      const length = end - i;
      const first = content[i]!;
      if (length === 1 && first === 0x71) {
        depth++;
      } else if (length === 1 && first === 0x51) {
        depth = Math.max(0, depth - 1);
      } else if (length === 2 && first === 0x42 && content[i + 1] === 0x49) {
        // BI <dictionary> ID <binary data> EI: skip the data. EI ends it when white space comes before and white space, a
        // delimiter or the end after.
        let j = end;
        while (j < n) {
          const w = wordEnd(j);
          if (w - j === 2 && content[j] === 0x49 && content[j + 1] === 0x44) {
            j = w + 1;
            break;
          }
          j = w > j ? w : j + 1;
        }
        const isEnd = (k: number): boolean =>
          content[k] === 0x45 && content[k + 1] === 0x49 && (k === 0 || WS.has(content[k - 1]!)) && (k + 2 >= n || WS.has(content[k + 2]!) || DELIM.has(content[k + 2]!));
        while (j < n && !isEnd(j)) j++;
        i = Math.min(n, j + 2);
        continue;
      }
      i = end;
    }
  }
  return depth;
}

/** A name the dictionary does not use yet. */
function freshName(dict: Mu.PDFObject, prefix: string): string {
  const has = (name: string): boolean => {
    let found = false;
    dict.forEach((_value, key) => {
      if (String(key) === name) found = true;
    });
    return found;
  };
  for (let k = 1; ; k++) {
    const name = `${prefix}${k}`;
    if (!has(name)) return name;
  }
}

function numberArray(pdf: Mu.PDFDocument, values: readonly number[]): Mu.PDFObject {
  const list = pdf.newArray();
  for (const value of values) list.push(pdf.newReal(value));
  return list;
}

/** A copy of the dictionary under `key` of `resources` (or a new one), so the page's own resources are never shared. */
function ownSubDictionary(pdf: Mu.PDFDocument, resources: Mu.PDFObject, key: string): Mu.PDFObject {
  const existing = optionalEntry(resources, key)?.resolve();
  return existing && existing.isDictionary() ? shallowCopy(pdf, existing, new Set<string>()) : pdf.newDictionary();
}

/**
 * Makes the Form XObject of page `srcIndex` of `src`: its content and resources are brought over by a temporary graft of the
 * page, and the form's BBox is the page's visible area, so what lies outside the overlay page's own box is clipped, as it is
 * in the view.
 */
function makeForm(pdf: Mu.PDFDocument, src: Mu.PDFDocument, srcIndex: number, map: Mu.PDFGraftMap): OverlayForm {
  const loaded = src.loadPage(srcIndex);
  let bounds: Rect4;
  let toDisplay: PlaceMatrix;
  try {
    bounds = normalize(loaded.getBounds() as Rect4);
    toDisplay = loaded.getTransform() as PlaceMatrix;
  } finally {
    loaded.destroy();
  }
  const toUser = invertMatrix(toDisplay);
  if (!toUser) throw new WorkerFault('Unsupported', 'The overlay page has no usable size.');

  const at = pdf.countPages();
  map.graftPage(at, src, srcIndex);
  try {
    const incoming = pdf.findPage(at);
    const bytes = contentBytes(incoming);
    const inherited = incoming.getInheritable('Resources');
    const resources = inherited.isNull() ? pdf.newDictionary() : inherited.resolve();
    const formDict = pdf.newDictionary();
    formDict.put('Type', pdf.newName('XObject'));
    formDict.put('Subtype', pdf.newName('Form'));
    formDict.put('BBox', numberArray(pdf, mapRect(toUser, bounds)));
    formDict.put('Resources', resources);
    // A transparency group: the overlay is blended as one picture, so two overlapping marks do not darken twice at a
    // partial opacity. Isolated, like the view's group.
    const group = pdf.newDictionary();
    group.put('S', pdf.newName('Transparency'));
    group.put('I', pdf.newBoolean(true));
    group.put('K', pdf.newBoolean(false));
    formDict.put('Group', group);
    return { form: pdf.addStream(bytes, formDict), bounds, toDisplay };
  } finally {
    // The temporary page is no longer needed: its content and resources belong to the form now.
    pdf.deletePage(at);
  }
}

/**
 * Lays page `srcIndex` of `src` over the page at `index`. `forms` holds the forms already made in this edit, so an overlay page
 * that goes on many base pages is copied into the document once.
 */
export function overlayPageAt(
  pdf: Mu.PDFDocument,
  index: number,
  src: Mu.PDFDocument,
  srcIndex: number,
  options: OverlayOptions,
  context: OverlayContext,
): void {
  if (!validScale(options.scale) || !Number.isFinite(options.dx) || !Number.isFinite(options.dy)) {
    throw new WorkerFault('Unsupported', 'The overlay placement is not valid.');
  }
  if (options.mode !== 'multiply' && options.mode !== 'blend') {
    throw new WorkerFault('Unsupported', 'This overlay look is for viewing only.');
  }
  const page = pdf.findPage(index);
  bakeFineRotation(page);

  const loaded = pdf.loadPage(index);
  let baseBounds: Rect4;
  let baseToDisplay: PlaceMatrix;
  try {
    baseBounds = normalize(loaded.getBounds() as Rect4);
    baseToDisplay = loaded.getTransform() as PlaceMatrix;
  } finally {
    loaded.destroy();
  }
  const displayToBase = invertMatrix(baseToDisplay);
  if (!displayToBase) throw new WorkerFault('Unsupported', 'The page has no usable size.');

  let made = context.forms.get(srcIndex);
  if (!made) {
    made = makeForm(pdf, src, srcIndex, context.map);
    context.forms.set(srcIndex, made);
  }
  // The overlay's user space to the base page's user space: through the overlay's display space, the placement, and back.
  const placement = placementMatrix(baseBounds, made.bounds, options);
  const ctm = concatMatrix(concatMatrix(made.toDisplay, placement), displayToBase);

  // The page's own resources, with the form and the graphics state added.
  const inherited = page.getInheritable('Resources');
  const resources = inherited.isNull() ? pdf.newDictionary() : inherited.resolve();
  const ownResources = shallowCopy(pdf, resources, new Set<string>());
  const xobjects = ownSubDictionary(pdf, resources, 'XObject');
  const formName = freshName(xobjects, 'PSOv');
  xobjects.put(formName, made.form);
  ownResources.put('XObject', xobjects);
  const states = ownSubDictionary(pdf, resources, 'ExtGState');
  const stateName = freshName(states, 'PSOg');
  const state = pdf.newDictionary();
  state.put('Type', pdf.newName('ExtGState'));
  if (options.mode === 'multiply') {
    state.put('BM', pdf.newName('Multiply'));
  } else {
    const opacity = clampOpacity(options.opacity);
    state.put('BM', pdf.newName('Normal'));
    state.put('ca', pdf.newReal(opacity));
    state.put('CA', pdf.newReal(opacity));
  }
  states.put(stateName, state);
  ownResources.put('ExtGState', states);
  page.put('Resources', ownResources);

  // Contents: [q, the original streams, Q for our q and one more for each state the original leaves open, the drawing]. The
  // original streams are shared, not copied or edited. Without the extra Q a page that leaves a `q` open would carry its
  // transform and clip into the drawing, and the result would differ from the view.
  const open = openGraphicsStates(contentBytes(page));
  const parts = pdf.newArray();
  parts.push(pdf.addStream('q', pdf.newDictionary()));
  const original = optionalEntry(page, 'Contents');
  if (original && !original.isNull()) {
    if (original.isArray()) for (let i = 0; i < original.length; i++) parts.push(original.get(i));
    else parts.push(original);
  }
  parts.push(pdf.addStream(new Array<string>(open + 1).fill('Q').join(' '), pdf.newDictionary()));
  parts.push(pdf.addStream(`q /${stateName} gs ${ctm.map(pdfNumber).join(' ')} cm /${formName} Do Q`, pdf.newDictionary()));
  page.put('Contents', parts);
}
