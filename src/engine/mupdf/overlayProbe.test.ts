// @vitest-environment node
// 1.3.4 Appendix D verify-first probes for the overlay, pinned as tests. They state what MuPDF 1.28.6 (WASM) actually does,
// so the overlay design is built on facts: (1) what graftPage copies for annotations, links and widgets; (2) whether a page's
// contents draw outside its CropBox; (3) that a device group with a blend mode composites like a /BM in the page.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { optionalEntry } from './pageOps';

function pageWithAnnots(): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  const page = pdf.addPage([0, 0, 300, 200], 0, {}, '0 g 10 10 50 50 re f');
  pdf.insertPage(0, page);
  const p = pdf.findPage(0);
  // A link, a text note and a text-field widget (with a field in an AcroForm that the page's /Annots points at).
  const link = pdf.addObject(pdf.newDictionary());
  link.put('Type', pdf.newName('Annot'));
  link.put('Subtype', pdf.newName('Link'));
  const rect = pdf.newArray();
  for (const v of [100, 100, 150, 130]) rect.push(pdf.newInteger(v));
  link.put('Rect', rect);
  const note = pdf.addObject(pdf.newDictionary());
  note.put('Type', pdf.newName('Annot'));
  note.put('Subtype', pdf.newName('Text'));
  const rect2 = pdf.newArray();
  for (const v of [200, 100, 220, 120]) rect2.push(pdf.newInteger(v));
  note.put('Rect', rect2);
  note.put('Contents', pdf.newString('hello'));
  const widget = pdf.addObject(pdf.newDictionary());
  widget.put('Type', pdf.newName('Annot'));
  widget.put('Subtype', pdf.newName('Widget'));
  widget.put('FT', pdf.newName('Tx'));
  widget.put('T', pdf.newString('f1'));
  widget.put('V', pdf.newString('value'));
  const rect3 = pdf.newArray();
  for (const v of [20, 150, 120, 170]) rect3.push(pdf.newInteger(v));
  widget.put('Rect', rect3);
  const annots = pdf.newArray();
  annots.push(link);
  annots.push(note);
  annots.push(widget);
  p.put('Annots', annots);
  const fields = pdf.newArray();
  fields.push(widget);
  const acro = pdf.newDictionary();
  acro.put('Fields', fields);
  pdf.getTrailer().get('Root').put('AcroForm', acro);
  return pdf;
}

describe('Appendix D probe 1: what graftPage copies', () => {
  it('copies the page, its content, resources and boxes, but NO annotations: links, notes and widgets are all left behind', () => {
    const src = pageWithAnnots();
    // The source really has the three annotations.
    expect(optionalEntry(src.findPage(0), 'Annots')?.resolve().length).toBe(3);
    const dst = new mu.PDFDocument();
    dst.insertPage(0, dst.addPage([0, 0, 100, 100], 0, {}, ''));
    dst.graftPage(1, src, 0);
    const grafted = dst.findPage(1);
    // Pinned: MuPDF's graft copies only Contents, Resources, the page boxes and Rotate. So an overlay needs no step to drop the
    // overlay file's comments and form boxes ("not copied" is what happens by itself), and the source form is not carried.
    expect(optionalEntry(grafted, 'Annots')).toBeUndefined();
    expect(optionalEntry(grafted, 'Contents')).toBeDefined();
    expect(optionalEntry(grafted, 'MediaBox')).toBeDefined();
    expect(dst.getTrailer().get('Root').get('AcroForm').isNull()).toBe(true);
  });

  it('copies the CropBox, so the overlay page box can be read from the grafted page', () => {
    const src = new mu.PDFDocument();
    src.insertPage(0, src.addPage([0, 0, 300, 200], 0, {}, '0 g 10 10 50 50 re f'));
    const crop = src.newArray();
    for (const v of [10, 10, 200, 150]) crop.push(src.newInteger(v));
    src.findPage(0).put('CropBox', crop);
    const dst = new mu.PDFDocument();
    dst.insertPage(0, dst.addPage([0, 0, 100, 100], 0, {}, ''));
    dst.graftPage(1, src, 0);
    expect(optionalEntry(dst.findPage(1), 'CropBox')).toBeDefined();
  });
});

describe('Appendix D probe 2: contents outside the CropBox', () => {
  it('runPageContents clips to the CropBox itself, even into a larger pixmap, so the view needs no clip of its own', () => {
    const pdf = new mu.PDFDocument();
    // Ink at the far right, outside the crop (0..100).
    pdf.insertPage(0, pdf.addPage([0, 0, 300, 100], 0, {}, '0 g 200 10 50 50 re f'));
    pdf.findPage(0).put('CropBox', (() => {
      const a = pdf.newArray();
      for (const v of [0, 0, 100, 100]) a.push(pdf.newInteger(v));
      return a;
    })());
    const page = pdf.loadPage(0);
    const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, 300, 100], false);
    pixmap.clear(255);
    const device = new mu.DrawDevice([1, 0, 0, 1, 0, 0], pixmap);
    page.runPageContents(device, mu.Matrix.identity);
    device.close();
    const px = pixmap.getPixels();
    const stride = pixmap.getStride();
    // The ink is at x 200..250 in user space, outside the crop (0..100).
    let outside = 0;
    for (let y = 0; y < 100; y++) for (let x = 150; x < 300; x++) if (px[y * stride + x]! < 128) outside++;
    // Pinned: nothing outside the crop is drawn. The applied result clips the same way with its Form XObject's BBox.
    expect(outside).toBe(0);
  });
});
