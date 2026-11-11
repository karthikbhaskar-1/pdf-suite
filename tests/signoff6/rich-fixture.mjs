// Builds the "rich" fixture for sign-off 6: two 800x500 pages with links, annotations, form fields and bookmarks on each side.
import * as mu from 'mupdf';
import { readFileSync } from 'node:fs';
import { buildPdf, content, numbers } from './lib.mjs';

export function richBytes() {
  return buildPdf([{ media: [0, 0, 800, 500], content: content('R1') }, { media: [0, 0, 800, 500], content: content('R2') }], (pdf) => {
    const p0 = pdf.loadPage(0);
    // Links in display space (top-left origin): left, right, and an internal link to page 2 on the left half.
    p0.createLink([50, 50, 150, 100], 'https://left.test/');
    p0.createLink([650, 50, 750, 100], 'https://right.test/');
    p0.createLink([50, 150, 150, 200], pdf.formatLinkURI({ type: 'Fit', chapter: 0, page: 1, x: 0, y: 0, width: 0, height: 0, zoom: 0 }));
    // Annotations: a text note on the left, a square on the right.
    const note = p0.createAnnotation('Text');
    note.setRect([100, 300, 120, 320]);
    note.setContents('left note');
    const sq = p0.createAnnotation('Square');
    sq.setRect([600, 300, 700, 360]);
    sq.setContents('right square');
    pdf.loadPage(0);
    // Form fields: two text fields, one on each side of page 1 (PDF space, y up).
    const fieldNames = ['leftfield', 'rightfield'];
    const rects = [[60, 100, 200, 130], [600, 100, 740, 130]];
    const annots = pdf.newArray();
    const fields = pdf.newArray();
    const pageObj = pdf.findPage(0);
    fieldNames.forEach((name, i) => {
      const d = pdf.newDictionary();
      d.put('Type', pdf.newName('Annot'));
      d.put('Subtype', pdf.newName('Widget'));
      d.put('FT', pdf.newName('Tx'));
      d.put('T', pdf.newString(name));
      d.put('V', pdf.newString(`value-${name}`));
      d.put('Rect', numbers(pdf, rects[i]));
      d.put('F', pdf.newInteger(4));
      d.put('P', pageObj);
      const ref = pdf.addObject(d);
      annots.push(ref);
      fields.push(ref);
    });
    const existing = pageObj.get('Annots');
    if (existing && existing.isArray()) for (let i = 0; i < existing.length; i++) annots.push(existing.get(i));
    pageObj.put('Annots', annots);
    const form = pdf.newDictionary();
    form.put('Fields', fields);
    pdf.getTrailer().get('Root').put('AcroForm', form);
    // Bookmarks: one to page 1, one to page 2 (and a child of the first on page 1 again).
    const it = pdf.outlineIterator();
    it.insert({ title: 'Go page 1', uri: pdf.formatLinkURI({ type: 'Fit', chapter: 0, page: 0, x: 0, y: 0, width: 0, height: 0, zoom: 0 }), open: true });
    it.insert({ title: 'Go page 2', uri: pdf.formatLinkURI({ type: 'Fit', chapter: 0, page: 1, x: 0, y: 0, width: 0, height: 0, zoom: 0 }), open: true });
  });
}

/** What a saved file holds, per page: links, annotations, widgets (bounds in display space), plus the outline's target pages. */
export function inspectRich(path) {
  const doc = mu.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    const pages = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      const links = page.getLinks().map((l) => ({ bounds: l.getBounds().map(Math.round), uri: l.getURI(), page: l.isExternal() ? null : doc.resolveLink(l) }));
      const pdfPage = page.asPDF ? page.asPDF() : page;
      const annots = pdfPage.getAnnotations().map((a) => ({ type: a.getType(), bounds: a.getBounds().map(Math.round), contents: a.getContents?.() }));
      const widgets = pdfPage.getWidgets().map((w) => ({ bounds: w.getBounds().map(Math.round), name: w.getName?.(), value: w.getValue?.() }));
      pages.push({ size: [Math.round(b[2] - b[0]), Math.round(b[3] - b[1])], links, annots, widgets });
      page.destroy();
    }
    const outline = [];
    const walk = (items) => { for (const it of items ?? []) { outline.push({ title: it.title, page: it.page ?? (it.uri ? doc.resolveLink(it.uri) : null) }); walk(it.down); } };
    walk(doc.loadOutline());
    return { pages, outline };
  } finally { doc.destroy(); }
}
