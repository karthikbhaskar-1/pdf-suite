/**
 * Flattening of form fields and signatures for Combine and Split (blueprint B1, Amendment 2026-11-10 ask 4).
 *
 * `flattenForms` runs on the in-memory copy a job works on (never on a file or a live document): it draws every form box,
 * flattens the fields into the page content with `bake(false, true)`, draws the boxes again, and compares. A box passes when
 * the ink in its rectangle afterwards is at least FORM_INK_KEEP of what it was before, and a text or choice box that has a
 * value has ink afterwards. When any box fails the file is not accepted (`formValuesKept` false): what is filled in would
 * be lost, silently, in the new files. A value with no appearance is therefore kept or refused, never lost.
 */
import type * as Mu from 'mupdf';
import { INK_THRESHOLD, optionalEntry } from './pageOps';

type RenderKit = Pick<typeof Mu, 'Matrix' | 'Pixmap' | 'ColorSpace' | 'DrawDevice'>;

/** A box passes when its ink after flattening is at least this share of its ink before. [const, Amendment 2026-11-10] */
export const FORM_INK_KEEP = 0.9;
/** The check draws at this resolution. */
export const FORM_CHECK_DPI = 100;

export interface FormFacts {
  /** Form boxes (widgets, signatures included) in the document. */
  fields: number;
  /** False when flattening would lose what is filled in. */
  formValuesKept: boolean;
}

interface Box {
  rect: [number, number, number, number];
  hasValue: boolean;
  /** Text and choice boxes must show their value. */
  mustShow: boolean;
}

/** The widget annotations of a page object, without loading the page. */
function widgetCount(page: Mu.PDFObject): number {
  const entry = optionalEntry(page, 'Annots')?.resolve();
  if (!entry || !entry.isArray()) return 0;
  let count = 0;
  for (let i = 0; i < entry.length; i++) {
    const dict = entry.get(i).resolve();
    if (!dict.isDictionary()) continue;
    const subtype = optionalEntry(dict, 'Subtype');
    if (subtype && subtype.isName() && subtype.asName() === 'Widget') count += 1;
  }
  return count;
}

/** The ink (pixels darker than INK_THRESHOLD) inside each rectangle of a page drawn at FORM_CHECK_DPI. */
function inkInBoxes(mu: RenderKit, page: Mu.PDFPage, rects: ReadonlyArray<[number, number, number, number]>): number[] {
  const bounds = page.getBounds();
  const scale = FORM_CHECK_DPI / 72;
  const width = Math.max(1, Math.ceil((bounds[2] - bounds[0]) * scale));
  const height = Math.max(1, Math.ceil((bounds[3] - bounds[1]) * scale));
  const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, width, height], false);
  try {
    pixmap.clear(255);
    const device = new mu.DrawDevice([scale, 0, 0, scale, -bounds[0] * scale, -bounds[1] * scale], pixmap);
    try {
      page.run(device, mu.Matrix.identity);
    } finally {
      device.close();
      device.destroy();
    }
    const pixels = pixmap.getPixels();
    const stride = pixmap.getStride();
    return rects.map((rect) => {
      const x0 = Math.max(0, Math.floor((rect[0] - bounds[0]) * scale));
      const x1 = Math.min(width, Math.ceil((rect[2] - bounds[0]) * scale));
      const y0 = Math.max(0, Math.floor((rect[1] - bounds[1]) * scale));
      const y1 = Math.min(height, Math.ceil((rect[3] - bounds[1]) * scale));
      let ink = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * stride;
        for (let x = x0; x < x1; x++) if (pixels[row + x]! < INK_THRESHOLD) ink += 1;
      }
      return ink;
    });
  } finally {
    pixmap.destroy();
  }
}

/**
 * Flattens the form fields of `pdf` (which must be a copy that is never written back) and says whether what is filled in
 * survived. The document is left flattened, so the pages grafted from it carry the values as page content. When no page
 * has a form box nothing is changed.
 */
export function flattenForms(mu: RenderKit, pdf: Mu.PDFDocument): FormFacts {
  const pages = pdf.countPages();
  const formPages: number[] = [];
  let fields = 0;
  for (let i = 0; i < pages; i++) {
    const n = widgetCount(pdf.findPage(i));
    if (n > 0) {
      formPages.push(i);
      fields += n;
    }
  }
  if (fields === 0) return { fields: 0, formValuesKept: true };

  const boxes = new Map<number, Box[]>();
  const before = new Map<number, number[]>();
  for (const index of formPages) {
    const page = pdf.loadPage(index);
    try {
      const list: Box[] = [];
      for (const widget of page.getWidgets()) {
        const bounds = widget.getBounds();
        let value = '';
        try {
          value = widget.getValue() ?? '';
        } catch {
          value = '';
        }
        list.push({ rect: [bounds[0], bounds[1], bounds[2], bounds[3]], hasValue: value.trim() !== '', mustShow: widget.isText() || widget.isChoice() });
      }
      boxes.set(index, list);
      before.set(index, inkInBoxes(mu, page, list.map((b) => b.rect)));
    } finally {
      page.destroy();
    }
  }

  pdf.bake(false, true);

  let kept = true;
  for (const index of formPages) {
    const list = boxes.get(index)!;
    const page = pdf.loadPage(index);
    try {
      const after = inkInBoxes(mu, page, list.map((b) => b.rect));
      const was = before.get(index)!;
      list.forEach((box, k) => {
        if (after[k]! < was[k]! * FORM_INK_KEEP) kept = false;
        if (box.mustShow && box.hasValue && after[k]! === 0) kept = false;
      });
    } finally {
      page.destroy();
    }
  }
  return { fields, formValuesKept: kept };
}
