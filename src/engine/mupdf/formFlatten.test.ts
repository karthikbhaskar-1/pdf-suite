// @vitest-environment node
// 1.3.2 (Amendment 2026-11-10): form flattening for Combine and Split. Fill every field type of fw9.pdf with known values,
// flatten, graft, save, re-read with pdf.js: every text value is in the page text and every ticked box is drawn. A second
// fixture holds a value with no appearance stream: it must be kept or refused, never lost silently.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import fs from 'node:fs';
import { flattenForms, FORM_INK_KEEP } from './formFlatten';
import { JobHarness } from './jobTestKit';
import { reread } from '../../../tests/lib/reread.mjs';
import { INK_THRESHOLD } from './pageOps';

const fw9Url = new URL('../../../tests/engine/corpus/irs-fw9/fw9.pdf', import.meta.url);
const haveFw9 = fs.existsSync(fw9Url);

/** fw9.pdf with every text box filled with "ZQ<n>VAL", and every checkbox and radio button ticked once. */
function filledFw9(): { bytes: Uint8Array; texts: string[]; ticked: number } {
  const pdf = new mu.PDFDocument(new Uint8Array(fs.readFileSync(fw9Url)));
  const texts: string[] = [];
  let ticked = 0;
  for (let p = 0; p < pdf.countPages(); p++) {
    const page = pdf.loadPage(p);
    let n = 0;
    for (const widget of page.getWidgets()) {
      if (widget.isReadOnly()) continue;
      if (widget.isText()) {
        const maxLen = widget.getMaxLen();
        const wanted = `ZQ${p}x${(n += 1)}VAL`;
        widget.setTextValue(maxLen > 0 ? wanted.slice(0, maxLen) : wanted);
        // What the box holds after the call (a box with a maximum length cuts the value).
        const held = widget.getValue();
        if (held !== '') texts.push(held);
      } else if (widget.isCheckbox() || widget.isRadioButton()) {
        widget.toggle();
        ticked += 1;
      }
    }
    page.update();
  }
  // 1.3.3 (orchestrator ruling): jobs treat inputs as the app does, and the app cannot edit a form that has an XFA part (fw9.pdf is
  // a hybrid), so the probe refuses it (see the test below). This test is about flattening every field type, so it runs on fw9's
  // AcroForm without the XFA part, which is an ordinary editable form.
  const acro = pdf.getTrailer().get('Root').get('AcroForm');
  acro.delete('XFA');
  return { bytes: pdf.saveToBuffer('').asUint8Array().slice(), texts, ticked };
}

const fieldTypes = (pdf: mu.PDFDocument): string[] => {
  const kinds = new Set<string>();
  for (let p = 0; p < pdf.countPages(); p++) for (const w of pdf.loadPage(p).getWidgets()) kinds.add(w.getFieldType());
  return [...kinds].sort();
};

describe.skipIf(!haveFw9)('flattening fw9.pdf (every field type it has)', () => {
  it('has text and button fields to fill', () => {
    const pdf = new mu.PDFDocument(new Uint8Array(fs.readFileSync(fw9Url)));
    const kinds = fieldTypes(pdf);
    expect(kinds).toContain('text');
    expect(kinds.some((k) => k === 'checkbox' || k === 'radiobutton')).toBe(true);
  });

  it('fw9.pdf as it is (a hybrid XFA form) is refused by the probe, as the app cannot edit it (ruling 2026-11-10)', async () => {
    const h = new JobHarness();
    const probed = (await h.probe(new Uint8Array(fs.readFileSync(fw9Url)))).probed!;
    expect(probed.xfa).toBe(true);
  });

  it('every filled text value is in the page text of the split output, every ticked box is drawn, and the output has no form', async () => {
    const { bytes, texts, ticked } = filledFw9();
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.some((t) => t.startsWith('ZQ0x') && t.endsWith('VAL'))).toBe(true);
    expect(ticked).toBeGreaterThan(0);
    const h = new JobHarness();
    const probed = (await h.probe(bytes)).probed!;
    expect(probed.fields).toBeGreaterThan(10);
    expect(probed.formValuesKept).toBe(true);
    const pages = probed.pages;
    const out = await h.split({ kind: 'split', baseName: 'W9', plan: { by: 'ranges', parts: [{ from: 1, to: pages, leafName: 'W9 - 01.pdf' }] } });
    expect(out.error).toBeUndefined();
    const file = out.files[0]!;
    const seen = await reread(file.bytes);
    const all = seen.text.join(' ').replace(/\s+/g, '');
    for (const value of texts) expect(all, value).toContain(value.replace(/\s+/g, ''));
    // No fillable field is left in the new file, and no widget annotation.
    const reopened = new mu.PDFDocument(file.bytes);
    expect(reopened.getTrailer().get('Root').get('AcroForm').isNull()).toBe(true);
    expect(seen.annotations.filter((a) => a.subtype === 'Widget')).toHaveLength(0);

    // Ticked boxes: the ink in each box's rectangle in the output is at least 90% of what the filled original drew there.
    const original = new mu.PDFDocument(bytes);
    const inkIn = (pdf: mu.PDFDocument, page: number, rect: mu.Rect): number => {
      const loaded = pdf.loadPage(page);
      const b = loaded.getBounds();
      const s = 100 / 72;
      const w = Math.ceil((b[2] - b[0]) * s);
      const hgt = Math.ceil((b[3] - b[1]) * s);
      const pix = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, w, hgt], false);
      pix.clear(255);
      const dev = new mu.DrawDevice([s, 0, 0, s, -b[0] * s, -b[1] * s], pix);
      loaded.run(dev, mu.Matrix.identity);
      dev.close();
      const px = pix.getPixels();
      const stride = pix.getStride();
      let ink = 0;
      for (let y = Math.floor((rect[1] - b[1]) * s); y < Math.ceil((rect[3] - b[1]) * s); y++)
        for (let x = Math.floor((rect[0] - b[0]) * s); x < Math.ceil((rect[2] - b[0]) * s); x++) if (px[y * stride + x]! < INK_THRESHOLD) ink += 1;
      return ink;
    };
    let checked = 0;
    for (let p = 0; p < original.countPages(); p++) {
      for (const widget of original.loadPage(p).getWidgets()) {
        if (!(widget.isCheckbox() || widget.isRadioButton()) || widget.isReadOnly()) continue;
        const rect = widget.getBounds();
        const before = inkInOriginal(original, p, rect, inkIn);
        const after = inkIn(new mu.PDFDocument(file.bytes), p, rect);
        expect(after, `box on page ${p + 1}`).toBeGreaterThanOrEqual(before * FORM_INK_KEEP);
        if (before > 0) checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('a form with nothing filled in is flattened too, and passes', () => {
    const pdf = new mu.PDFDocument(new Uint8Array(fs.readFileSync(fw9Url)));
    const facts = flattenForms(mu, pdf);
    expect(facts.fields).toBeGreaterThan(10);
    expect(facts.formValuesKept).toBe(true);
  });
});

function inkInOriginal(pdf: mu.PDFDocument, page: number, rect: mu.Rect, inkIn: (pdf: mu.PDFDocument, page: number, rect: mu.Rect) => number): number {
  return inkIn(pdf, page, rect);
}

/** A one-page PDF with one text field. `appearance` false leaves the widget without an /AP; `rect` is the box. */
function oneTextField(value: string, options: { rect: number[]; appearance: boolean; da?: string }): Uint8Array {
  const pdf = new mu.PDFDocument();
  const helv = pdf.newDictionary();
  helv.put('Type', pdf.newName('Font'));
  helv.put('Subtype', pdf.newName('Type1'));
  helv.put('BaseFont', pdf.newName('Helvetica'));
  const fonts = pdf.newDictionary();
  fonts.put('Helv', pdf.addObject(helv));
  const dr = pdf.newDictionary();
  dr.put('Font', fonts);
  pdf.insertPage(-1, pdf.addPage([0, 0, 300, 200], 0, {}, '0 g 10 10 20 20 re f'));
  const page = pdf.findPage(0);
  const widget = pdf.newDictionary();
  widget.put('Type', pdf.newName('Annot'));
  widget.put('Subtype', pdf.newName('Widget'));
  widget.put('FT', pdf.newName('Tx'));
  widget.put('T', pdf.newString('field1'));
  widget.put('V', pdf.newString(value));
  widget.put('F', 4);
  widget.put('DA', pdf.newString(options.da ?? '/Helv 14 Tf 0 g'));
  const rect = pdf.newArray();
  for (const n of options.rect) rect.push(pdf.newReal(n));
  widget.put('Rect', rect);
  widget.put('P', page);
  if (options.appearance) {
    const form = pdf.addStream(`/Tx BMC q BT /Helv 14 Tf 0 g 2 6 Td (${value}) Tj ET Q EMC`, pdf.newDictionary());
    const dict = form.resolve();
    dict.put('Type', pdf.newName('XObject'));
    dict.put('Subtype', pdf.newName('Form'));
    const bbox = pdf.newArray();
    for (const n of [0, 0, options.rect[2]! - options.rect[0]!, options.rect[3]! - options.rect[1]!]) bbox.push(pdf.newReal(n));
    dict.put('BBox', bbox);
    const res = pdf.newDictionary();
    res.put('Font', fonts);
    dict.put('Resources', res);
    const ap = pdf.newDictionary();
    ap.put('N', form);
    widget.put('AP', ap);
  }
  const ref = pdf.addObject(widget);
  const annots = pdf.newArray();
  annots.push(ref);
  page.put('Annots', annots);
  const acro = pdf.newDictionary();
  const fields = pdf.newArray();
  fields.push(ref);
  acro.put('Fields', fields);
  acro.put('DR', dr);
  acro.put('DA', pdf.newString('/Helv 0 Tf 0 g'));
  pdf.getTrailer().get('Root').put('AcroForm', acro);
  return pdf.saveToBuffer('').asUint8Array().slice();
}

describe('a value that may have no appearance: kept or refused, never lost silently', () => {
  it('a box with an appearance stream keeps its value in the new file', async () => {
    const h = new JobHarness();
    const probed = (await h.probe(oneTextField('HELLOVAL', { rect: [50, 100, 250, 130], appearance: true }))).probed!;
    expect(probed.fields).toBe(1);
    expect(probed.formValuesKept).toBe(true);
    const out = await h.split({ kind: 'split', baseName: 'F', plan: { by: 'ranges', parts: [{ from: 1, to: 1, leafName: 'F - 01.pdf' }] } });
    expect((await reread(out.files[0]!.bytes)).text.join(' ')).toContain('HELLOVAL');
  });

  it('a box with a value and no appearance stream is either kept (the value is in the new file) or refused', async () => {
    const h = new JobHarness();
    const probed = (await h.probe(oneTextField('NOAPPVAL', { rect: [50, 100, 250, 130], appearance: false }))).probed!;
    if (probed.formValuesKept) {
      const out = await h.split({ kind: 'split', baseName: 'F', plan: { by: 'ranges', parts: [{ from: 1, to: 1, leafName: 'F - 01.pdf' }] } });
      expect((await reread(out.files[0]!.bytes)).text.join(' ')).toContain('NOAPPVAL');
    } else {
      expect(probed.formValuesKept).toBe(false);
    }
  });

  it('a value that cannot be drawn at all (a box of no size) is refused', async () => {
    const h = new JobHarness();
    const probed = (await h.probe(oneTextField('LOSTVAL', { rect: [50, 100, 50, 100], appearance: false }))).probed!;
    expect(probed.formValuesKept).toBe(false);
  });

  it('refusal means the split would not start: the page turns formValuesKept false into FormValuesLost (see splitFlow)', async () => {
    // The worker itself still opens the file; the refusal is the page\'s, from the probe facts. Pinned here: the fact is reported.
    const h = new JobHarness();
    const out = await h.probe(oneTextField('LOSTVAL', { rect: [50, 100, 50, 100], appearance: false }));
    expect(out.probed).toMatchObject({ fields: 1, formValuesKept: false });
  });
});
