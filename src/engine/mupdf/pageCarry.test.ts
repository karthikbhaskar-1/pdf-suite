// @vitest-environment node
// 1.3.2: MuPDF's graftPage drops annotations (jobProbes.test.ts, D1). Extract, Insert from a PDF and Replace carry them over
// through the shared helpers (annotCarry.ts: PageCarrier, FormCarry): links (renumbered or removed by target), notes with their
// popups, highlights, and form fields (merged into the AcroForm, one field per source field, names kept unique).
// Extract -> save -> reopen -> count, as the check the 1.3.4 developer asked for.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import fs from 'node:fs';
import { EditCore } from './editCore';
import { MupdfCore } from './core';
import { pageFingerprints } from './pageFingerprint';

const open = (bytes: Uint8Array) => mu.Document.openDocument(bytes, 'application/pdf').asPDF()!;
const annotatedUrl = new URL('../../../tests/fixtures/out/annotated-links.pdf', import.meta.url);
const fw9Url = new URL('../../../tests/engine/corpus/irs-fw9/fw9.pdf', import.meta.url);

/** A document of `pages` plain pages, to insert into. */
function plain(pages: number): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < pages; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, {}, '0 g 10 10 20 20 re f'));
  return open(pdf.saveToBuffer('').asUint8Array().slice());
}

function counts(bytes: Uint8Array) {
  const doc = new mu.PDFDocument(bytes);
  const annots: Record<string, number> = {};
  let links = 0;
  let widgets = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    links += page.getLinks().length;
    widgets += page.getWidgets().length;
    for (const a of page.getAnnotations()) annots[a.getType()] = (annots[a.getType()] ?? 0) + 1;
  }
  const acro = doc.getTrailer().get('Root').get('AcroForm');
  const fields = acro.isNull() ? 0 : acro.get('Fields').length;
  return { pages: doc.countPages(), links, widgets, annots, fields };
}

describe.skipIf(!fs.existsSync(annotatedUrl))('Extract keeps links, notes and highlights (annotated-links.pdf)', () => {
  const bytes = new Uint8Array(fs.readFileSync(annotatedUrl));

  it('extracting pages 2 and 3: their notes, popups, highlights and links are in the saved file', () => {
    const core = new MupdfCore(mu, {});
    core.open(bytes, undefined);
    const src = new mu.PDFDocument(bytes);
    const per = (index: number) => {
      const page = src.loadPage(index);
      return { links: page.getLinks().length, annots: page.getAnnotations().length };
    };
    const want = { links: per(1).links + per(2).links, annots: per(1).annots + per(2).annots };
    expect(want.links).toBeGreaterThan(0);
    expect(want.annots).toBeGreaterThan(0);
    const out = counts(new Uint8Array(core.extract(['1', '2']).bytes));
    expect(out.pages).toBe(2);
    // An internal link to a page that is not extracted is removed, so at most as many as the source pages had.
    expect(out.links).toBeGreaterThan(0);
    expect(out.links).toBeLessThanOrEqual(want.links);
    expect(Object.values(out.annots).reduce((a, b) => a + b, 0)).toBe(want.annots);
  });
});

describe.skipIf(!fs.existsSync(fw9Url))('Extract, Insert and Replace keep form fields (fw9.pdf)', () => {
  const bytes = fs.existsSync(fw9Url) ? new Uint8Array(fs.readFileSync(fw9Url)) : new Uint8Array();
  const present = fs.existsSync(fw9Url);
  const whole = present ? counts(bytes) : counts(plain(1).saveToBuffer('').asUint8Array());
  const perFirstPage = present ? new mu.PDFDocument(bytes).loadPage(0).getWidgets().length : 0;

  it('the source has form fields to carry', () => {
    expect(whole.widgets).toBeGreaterThan(10);
    expect(perFirstPage).toBeGreaterThan(10);
  });

  it('extract of every page: the same number of widgets, listed in the AcroForm', () => {
    const core = new MupdfCore(mu, {});
    const { pages } = core.open(bytes, undefined);
    const out = counts(new Uint8Array(core.extract(Array.from({ length: pages }, (_u, i) => String(i))).bytes));
    expect(out.widgets).toBe(whole.widgets);
    expect(out.fields).toBeGreaterThan(0);
  });

  it('extract of page 1 only: its widgets and not those of the other pages; a filled value survives', () => {
    const filled = new mu.PDFDocument(bytes);
    const page = filled.loadPage(0);
    const first = page.getWidgets().find((w) => w.isText() && !w.isReadOnly())!;
    first.setTextValue('ZZ');
    page.update();
    const saved = filled.saveToBuffer('').asUint8Array().slice();
    const core = new MupdfCore(mu, {});
    core.open(saved, undefined);
    const out = new mu.PDFDocument(new Uint8Array(core.extract(['0']).bytes));
    const widgets = out.loadPage(0).getWidgets();
    expect(widgets).toHaveLength(perFirstPage);
    expect(widgets.some((w) => w.isText() && w.getValue() === 'ZZ')).toBe(true);
  });

  it('insert from a PDF twice: the second set gets other field names, undo removes them, redo puts them back, and it saves', async () => {
    const target = plain(1);
    const src = open(bytes);
    const core = new EditCore(target, 1, true, { mu, sources: new Map([['s', src]]) });
    await core.apply([{ op: 'insertFrom', afterUid: '0', sourceDocId: 's', sourceUids: ['0'] }]);
    await core.apply([{ op: 'insertFrom', afterUid: '0', sourceDocId: 's', sourceUids: ['0'] }]);
    const widgetCount = () => Array.from({ length: target.countPages() }, (_u, i) => target.loadPage(i).getWidgets().length).reduce((a, b) => a + b, 0);
    expect(widgetCount()).toBe(perFirstPage * 2);
    const names = new Set<string>();
    const fields = target.getTrailer().get('Root').get('AcroForm').get('Fields');
    for (let i = 0; i < fields.length; i++) names.add(fields.get(i).resolve().get('T').asString());
    expect(names.size).toBe(fields.length);
    core.undo();
    expect(widgetCount()).toBe(perFirstPage);
    core.undo();
    expect(widgetCount()).toBe(0);
    core.redo();
    core.redo();
    expect(widgetCount()).toBe(perFirstPage * 2);
    expect(counts(target.saveToBuffer('garbage=compact').asUint8Array().slice()).widgets).toBe(perFirstPage * 2);
  });

  it('replace a page with a form page: the page takes the widgets', async () => {
    const target = plain(2);
    const src = open(bytes);
    const core = new EditCore(target, 2, true, { mu, sources: new Map([['s', src]]) });
    await core.apply([{ op: 'replace', uid: '1', sourceDocId: 's', sourceUid: '0' }]);
    expect(target.loadPage(1).getWidgets()).toHaveLength(perFirstPage);
    expect(target.loadPage(0).getWidgets()).toHaveLength(0);
  });
});

describe('Insert from a PDF keeps a link and a note, and renumbers an internal link', () => {
  it('inserting source pages 2 and 3 keeps the web link and the link to page 3 (now page 3 here); the link to page 4 is removed', async () => {
    const srcPdf = new mu.PDFDocument();
    for (let i = 0; i < 4; i++) srcPdf.insertPage(-1, srcPdf.addPage([0, 0, 200, 200], 0, {}, '0 g 10 10 20 20 re f'));
    const p1 = srcPdf.loadPage(1);
    p1.createLink([10, 10, 60, 40], 'https://example.org/x');
    p1.createLink([70, 10, 120, 40], '#page=3');
    p1.createLink([130, 10, 180, 40], '#page=4');
    const note = p1.createAnnotation('Text');
    note.setRect([100, 100, 120, 120]);
    note.setContents('hi');
    p1.update();
    const src = open(srcPdf.saveToBuffer('').asUint8Array().slice());
    const target = plain(1);
    const core = new EditCore(target, 1, true, { mu, sources: new Map([['s', src]]) });
    await core.apply([{ op: 'insertFrom', afterUid: '0', sourceDocId: 's', sourceUids: ['1', '2'] }]);
    const landed = target.loadPage(1);
    const uris = landed.getLinks().map((l) => l.getURI());
    expect(uris).toHaveLength(2);
    expect(uris.some((u) => u.startsWith('https://example.org/x'))).toBe(true);
    expect(uris.some((u) => /page=3\b/.test(u))).toBe(true);
    expect(landed.getAnnotations().some((a) => a.getType() === 'Text')).toBe(true);
  });
});

describe.skipIf(!fs.existsSync(fw9Url))('recovery replay of an insertFrom log (same edit, same seed, a fresh document and a fresh source)', () => {
  it('gives the same uids, the same page fingerprints and the same widgets', async () => {
    const bytes = new Uint8Array(fs.readFileSync(fw9Url));
    const edits = [{ op: 'insertFrom' as const, afterUid: '0', sourceDocId: 's', sourceUids: ['0', '2'] }];
    const live = plain(2);
    const liveCore = new EditCore(live, 2, true, { mu, sources: new Map([['s', open(bytes)]]) });
    const applied = await liveCore.apply(edits);
    const expectedUids = liveCore.pages().uids;
    const expectedPrints = pageFingerprints(live);
    const widgetsOf = (pdf: mu.PDFDocument) => Array.from({ length: pdf.countPages() }, (_u, i) => pdf.loadPage(i).getWidgets().length);
    expect(widgetsOf(live).some((n) => n > 0)).toBe(true);

    const replayed = plain(2);
    const replayCore = new EditCore(replayed, 2, true, { mu, sources: new Map([['s', open(bytes)]]) });
    await replayCore.apply(edits, undefined, applied.uidSeed);
    expect(replayCore.pages().uids).toEqual(expectedUids);
    expect(pageFingerprints(replayed)).toEqual(expectedPrints);
    expect(widgetsOf(replayed)).toEqual(widgetsOf(live));
  });
});
