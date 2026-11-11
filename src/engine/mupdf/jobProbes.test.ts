// @vitest-environment node
// Appendix D "verify first" probes for 1.3.2, pinned as tests (MuPDF 1.28.6 WASM). The design builds on these facts.
//   D1  what graftPage copies for annotations, links and widgets
//   D4  bake(false, true) keeps field values visible
//   D5  outlineIterator().insert builds nested bookmarks that pdf.js reads
// (D2 and D3, images and fonts, belong to Combine, 1.3.3; D6 is the multi-page TIFF.)
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import fs from 'node:fs';
import { reread } from '../../../tests/lib/reread.mjs';

const fw9Url = new URL('../../../tests/engine/corpus/irs-fw9/fw9.pdf', import.meta.url);
const haveFw9 = fs.existsSync(fw9Url);

function annotated(): mu.PDFDocument {
  const doc = new mu.PDFDocument();
  for (let i = 0; i < 3; i++) doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, {}, 'BT 20 20 Td ET'));
  const page = doc.loadPage(0);
  page.createLink([10, 10, 50, 50], 'https://example.com/a');
  page.createLink([60, 10, 100, 50], '#page=2');
  const hl = page.createAnnotation('Highlight');
  hl.setQuadPoints([[10, 100, 100, 100, 10, 120, 100, 120]]);
  const note = page.createAnnotation('Text');
  note.setRect([200, 200, 220, 220]);
  note.setContents('a note');
  page.update();
  return doc;
}

describe('D1: what graftPage copies', () => {
  it('copies content, resources and the boxes; it does NOT copy annotations, links or widgets', () => {
    const src = annotated();
    expect(src.loadPage(0).getAnnotations().length).toBeGreaterThan(0);
    expect(src.loadPage(0).getLinks().length).toBe(2);
    for (const useMap of [false, true]) {
      const out = new mu.PDFDocument();
      if (useMap) out.newGraftMap().graftPage(0, src, 0);
      else out.graftPage(0, src, 0);
      const page = out.loadPage(0);
      expect(page.getAnnotations()).toHaveLength(0);
      expect(page.getLinks()).toHaveLength(0);
      const keys: string[] = [];
      out.findPage(0).forEach((_v, k) => keys.push(String(k)));
      expect(keys).not.toContain('Annots');
      expect(keys).toEqual(expect.arrayContaining(['Contents', 'Resources', 'MediaBox']));
    }
  });

  it.skipIf(!haveFw9)('a form page loses its widgets when grafted', () => {
    const fw9 = new mu.PDFDocument(new Uint8Array(fs.readFileSync(fw9Url)));
    expect(fw9.loadPage(0).getWidgets().length).toBeGreaterThan(10);
    const out = new mu.PDFDocument();
    out.graftPage(0, fw9, 0);
    expect(out.loadPage(0).getWidgets()).toHaveLength(0);
  });
});

describe('D4: bake(false, true) keeps field values visible', () => {
  it.skipIf(!haveFw9)('every filled text value is in the page text after flattening, and the fields are gone', async () => {
    const pdf = new mu.PDFDocument(new Uint8Array(fs.readFileSync(fw9Url)));
    const page = pdf.loadPage(0);
    const filled: string[] = [];
    let n = 0;
    for (const widget of page.getWidgets()) {
      if (widget.isText() && !widget.isReadOnly()) {
        const value = `ZQ${(n += 1)}VAL`;
        widget.setTextValue(value);
        filled.push(value);
      }
    }
    page.update();
    expect(filled.length).toBeGreaterThan(5);
    pdf.bake(false, true);
    // The page's /Annots is empty and the catalog has no AcroForm any more (a page object reloaded may still list cached widgets).
    expect(pdf.findPage(0).get('Annots').length).toBe(0);
    expect(pdf.getTrailer().get('Root').get('AcroForm').isNull()).toBe(true);
    const baked = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
    const seen = (await reread(baked)).text[0]!.replace(/\s+/g, '');
    for (const value of filled) expect(seen, value).toContain(value);
  });
});

describe('D5: outlineIterator().insert and nested bookmarks', () => {
  it('the iterator builds a flat list that pdf.js reads, but down() does not move after an insert, so nesting is not possible through it', async () => {
    const doc = new mu.PDFDocument();
    for (let i = 0; i < 6; i++) doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const it = doc.outlineIterator();
    it.insert({ title: 'One', uri: '#page=1', open: true });
    expect(it.down()).toBe(mu.OutlineIterator.ITERATOR_DID_NOT_MOVE);
    it.insert({ title: 'Two', uri: '#page=3', open: true });
    const { outline } = await reread(doc.saveToBuffer('garbage=compact').asUint8Array().slice());
    expect(outline.map((o) => `${o.depth}:${o.title}:${o.page}`)).toEqual(['0:One:1', '0:Two:3']);
  });
});
