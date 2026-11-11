// @vitest-environment node
// 1.3.2: what a Split part carries (blueprint B1): comments and markup with their popups, web links, internal links whose target
// is in the part, bookmarks that point into it (nested), metadata. Every output is re-read with pdf.js.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { carryLinks, copyPageAnnotations } from './annotCarry';
import { JobHarness, makeDoc } from './jobTestKit';
import { buildPart, type SplitSource } from './splitCore';
import { countBookmarks, readBookmarks, remapBookmarks, topLevelEntries, writeBookmarks, viewOfUri, type BookmarkNode } from './outlineCarry';
import { graftPages } from './pageCopy';
import { reread } from '../../../tests/lib/reread.mjs';

const node = (title: string, page: number | null, children: BookmarkNode[] = []): BookmarkNode => ({ title, page, open: false, children });

describe('remapBookmarks and topLevelEntries (pure)', () => {
  const tree = [
    node('A', 0, [node('A1', 1), node('A2', 2)]),
    node('B', 5, [node('B1', 6), node('B2', 7, [node('B2a', 8)])]),
    node('C', 9),
  ];

  it('keeps the bookmarks that point into the part and renumbers their pages from 0', () => {
    const part = remapBookmarks(tree, 5, 7);
    expect(part.map((n) => [n.title, n.page, n.children.map((c) => c.title)])).toEqual([['B', 0, ['B1', 'B2']]]);
    expect(part[0]!.children[1]!.page).toBe(2);
    expect(part[0]!.children[1]!.children).toEqual([]);
  });

  it('drops a bookmark to a left-out page; its children inside the part take its place', () => {
    const part = remapBookmarks(tree, 1, 2);
    expect(part.map((n) => [n.title, n.page])).toEqual([['A1', 0], ['A2', 1]]);
    const deep = remapBookmarks(tree, 8, 9);
    expect(deep.map((n) => [n.title, n.page])).toEqual([['B2a', 0], ['C', 1]]);
  });

  it('a part with no bookmark in it has an empty outline', () => {
    expect(remapBookmarks([node('Only', 0)], 3, 4)).toEqual([]);
    expect(countBookmarks(remapBookmarks(tree, 3, 4))).toBe(0);
  });

  it('lists the top-level bookmarks that point into the document, 1-based, in order', () => {
    expect(topLevelEntries([node('x', 4), node('gone', null), node('y', 0)])).toEqual([{ title: 'x', page: 5 }, { title: 'y', page: 1 }]);
  });

  it('reads the position and zoom of a MuPDF destination', () => {
    expect(viewOfUri('#page=3&zoom=nan,0,28.35')).toEqual({ zoom: null, x: 0, y: 28.35 });
    expect(viewOfUri('#page=3&zoom=1.5,10,20')).toEqual({ zoom: 1.5, x: 10, y: 20 });
    expect(viewOfUri('#page=3')).toBeUndefined();
  });
});

describe('outlines written into a part are read by pdf.js, nested', () => {
  it('a three-level outline survives writing and a re-read', async () => {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 6; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 200, 200], 0, {}, ''));
    writeBookmarks(mu, pdf, [
      { title: 'One', page: 0, open: true, children: [{ title: 'One.1', page: 1, open: false, children: [{ title: 'One.1.1', page: 2, open: false, children: [] }] }] },
      { title: 'Two', page: 4, open: false, children: [] },
    ]);
    const { outline } = await reread(pdf.saveToBuffer('garbage=compact').asUint8Array().slice());
    expect(outline.map((o) => `${o.depth}:${o.title}:${o.page}`)).toEqual(['0:One:1', '1:One.1:2', '2:One.1.1:3', '0:Two:5']);
  });

  it('MuPDF reads the same outline back, with the pages', () => {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 4; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 200, 200], 0, {}, ''));
    writeBookmarks(mu, pdf, [{ title: 'A', page: 1, open: true, children: [{ title: 'A1', page: 3, open: false, children: [] }] }]);
    const re = mu.Document.openDocument(pdf.saveToBuffer('garbage=compact').asUint8Array().slice(), 'application/pdf');
    const tree = readBookmarks(re, 4);
    expect(tree.map((n) => [n.title, n.page, n.children.map((c) => [c.title, c.page])])).toEqual([['A', 1, [['A1', 3]]]]);
  });
});

describe('a Split part carries links', () => {
  function open(bytes: Uint8Array) {
    return new mu.PDFDocument(bytes);
  }

  it('keeps web links, keeps an internal link whose target is in the part (renumbered), removes one whose target is left out', () => {
    const src = open(makeDoc({ pages: 8, links: [{ page: 3, url: 'https://example.org/a' }, { page: 3, toPage: 4 }, { page: 3, toPage: 7 }, { page: 5, toPage: 3 }] }));
    // The part is pages 3..5 (0-based 2..4).
    const out = new mu.PDFDocument();
    graftPages(out, src, [2, 3, 4]);
    const inPart = (t: number) => (t >= 2 && t <= 4 ? t - 2 : null);
    for (let k = 0; k < 3; k++) {
      const s = src.loadPage(2 + k);
      const o = out.loadPage(k);
      carryLinks(src, s, o, inPart);
    }
    const first = out.loadPage(0).getLinks();
    const uris = first.map((l) => l.getURI()).sort();
    expect(uris).toHaveLength(2);
    expect(uris.some((u) => u.startsWith('https://example.org/a'))).toBe(true);
    // Source page 4 (0-based 3) is the second page of the part: "#page=2".
    expect(uris.some((u) => /page=2\b/.test(u))).toBe(true);
    // The link to source page 3 (0-based 2) from source page 5 (0-based 4) is page 1 of the part, kept on the third page.
    const third = out.loadPage(2).getLinks().map((l) => l.getURI());
    expect(third).toHaveLength(1);
    expect(/page=1\b/.test(third[0]!)).toBe(true);
  });

  it('a link keeps its rectangle on a rotated page', () => {
    const doc = new mu.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 300, 400], 90, {}, '0 g 10 10 50 50 re f'));
    doc.insertPage(-1, doc.addPage([0, 0, 300, 400], 0, {}, ''));
    const page = doc.loadPage(0);
    page.createLink([40, 60, 140, 90], 'https://example.org/rot');
    page.update();
    const src = open(doc.saveToBuffer('').asUint8Array().slice());
    const before = src.loadPage(0).getLinks()[0]!.getBounds();
    const out = new mu.PDFDocument();
    graftPages(out, src, [0]);
    carryLinks(src, src.loadPage(0), out.loadPage(0), (t) => (t === 0 ? 0 : null));
    const after = out.loadPage(0).getLinks()[0]!.getBounds();
    expect(after.map((n) => Math.round(n))).toEqual(before.map((n) => Math.round(n)));
  });

  it('split output read by pdf.js: web links and the kept internal link are there', async () => {
    const h = new JobHarness();
    await h.probe(makeDoc({ pages: 6, links: [{ page: 2, url: 'https://example.org/x' }, { page: 2, toPage: 3 }, { page: 2, toPage: 6 }] }));
    const out = await h.split({ kind: 'split', baseName: 'L', plan: { by: 'ranges', parts: [{ from: 1, to: 3, leafName: 'L - 01.pdf' }, { from: 4, to: 6, leafName: 'L - 02.pdf' }] } });
    const first = await reread(out.files[0]!.bytes);
    const links = first.annotations.filter((a) => a.subtype === 'Link');
    // Page 2 had three links: the web link and the link to page 3 stay; the link to page 6 is in the other part, so it goes.
    expect(links.filter((a) => a.page === 2)).toHaveLength(2);
    expect(links.some((a) => a.url?.startsWith('https://example.org/x'))).toBe(true);
    const second = await reread(out.files[1]!.bytes);
    expect(second.annotations.filter((a) => a.subtype === 'Link')).toHaveLength(0);
  });
});

describe('a Split part carries comments and markup', () => {
  it('a note with its popup and a highlight are copied, point at the copy of the page, and share the page\'s font and appearance objects', () => {
    const srcBytes = makeDoc({ pages: 4, notes: [2, 3] });
    const src = new mu.PDFDocument(srcBytes);
    const out = new mu.PDFDocument();
    const map = out.newGraftMap();
    graftPages(out, src, [1, 2], map);
    const counts = [0, 1].map((k) => copyPageAnnotations(out, map, src.findPage(1 + k), out.findPage(k)));
    // A text note comes with its popup, and there is the highlight: three annotations on each page.
    expect(counts).toEqual([3, 3]);
    const page = out.findPage(0);
    const annots = page.get('Annots');
    expect(annots.length).toBe(3);
    const subtypes: string[] = [];
    for (let i = 0; i < annots.length; i++) {
      const dict = annots.get(i).resolve();
      subtypes.push(dict.get('Subtype').asName());
      expect(dict.get('P').asIndirect()).toBe(page.asIndirect());
    }
    expect(subtypes.sort()).toEqual(['Highlight', 'Popup', 'Text']);
    // The popup points at its note (the copy) and the note at its popup.
    const byType = new Map<string, mu.PDFObject>();
    for (let i = 0; i < annots.length; i++) byType.set(annots.get(i).resolve().get('Subtype').asName(), annots.get(i));
    const popup = byType.get('Popup')!.resolve();
    const text = byType.get('Text')!.resolve();
    expect(popup.get('Parent').asIndirect()).toBe(byType.get('Text')!.asIndirect());
    expect(text.get('Popup').asIndirect()).toBe(byType.get('Popup')!.asIndirect());
    // The copies are not the source's objects: deleting the source changes nothing here.
    expect(annots.get(0).asIndirect()).not.toBe(src.findPage(1).get('Annots').get(0).asIndirect());
  });

  it('split output read by pdf.js: the note, its popup and the highlight stay on the pages they were on', async () => {
    const h = new JobHarness();
    await h.probe(makeDoc({ pages: 6, notes: [2, 5] }));
    const out = await h.split({ kind: 'split', baseName: 'N', plan: { by: 'ranges', parts: [{ from: 1, to: 3, leafName: 'N - 01.pdf' }, { from: 4, to: 6, leafName: 'N - 02.pdf' }] } });
    const a = await reread(out.files[0]!.bytes);
    const b = await reread(out.files[1]!.bytes);
    const kinds = (r: typeof a) => r.annotations.map((x) => `${x.page}:${x.subtype}`).sort();
    expect(kinds(a)).toEqual(['2:Highlight', '2:Popup', '2:Text']);
    expect(kinds(b)).toEqual(['2:Highlight', '2:Popup', '2:Text']);
  });
});

describe('a Split part: structure keys and language', () => {
  it('no /StructParents on the pages or /StructParent on the annotations; /Lang is kept', () => {
    const src = new mu.PDFDocument(makeDoc({ pages: 3, notes: [2] }));
    for (let i = 0; i < 3; i++) src.findPage(i).put('StructParents', i);
    const annots = src.findPage(1).get('Annots');
    for (let i = 0; i < annots.length; i++) annots.get(i).resolve().put('StructParent', 7 + i);
    src.getTrailer().get('Root').put('Lang', src.newString('de-DE'));
    const saved = src.saveToBuffer('').asUint8Array().slice();
    const reopened = new mu.PDFDocument(saved);
    expect(reopened.findPage(0).get('StructParents').asNumber()).toBe(0);
    const source: SplitSource = { doc: reopened, pdf: reopened, pages: 3, encrypted: false, bookmarks: [] };
    const built = buildPart(mu, source, 0, 2, { encrypted: false, password: undefined, dropEncryption: false });
    const part = new mu.PDFDocument(built.bytes);
    for (let i = 0; i < 3; i++) expect(part.findPage(i).get('StructParents').isNull(), `page ${i + 1}`).toBe(true);
    const list = part.findPage(1).get('Annots');
    expect(list.length).toBeGreaterThan(0);
    for (let i = 0; i < list.length; i++) expect(list.get(i).resolve().get('StructParent').isNull()).toBe(true);
    expect(part.getTrailer().get('Root').get('Lang').asString()).toBe('de-DE');
  });
});

describe('a Split part: bookmarks and metadata', () => {
  it('each part has the bookmarks that point into it, nested, with pages renumbered', async () => {
    const outline = [
      { title: 'Intro', page: 1, children: [{ title: 'Intro.1', page: 2 }, { title: 'Intro.2', page: 3 }] },
      { title: 'Body', page: 4, children: [{ title: 'Body.1', page: 5 }] },
      { title: 'End', page: 6 },
    ];
    const h = new JobHarness();
    await h.probe(makeDoc({ pages: 6, outline }));
    const out = await h.split({ kind: 'split', baseName: 'O', plan: { by: 'ranges', parts: [{ from: 1, to: 3, leafName: 'O - 01.pdf' }, { from: 4, to: 6, leafName: 'O - 02.pdf' }] } });
    const a = await reread(out.files[0]!.bytes);
    expect(a.outline.map((o) => `${o.depth}:${o.title}:${o.page}`)).toEqual(['0:Intro:1', '1:Intro.1:2', '1:Intro.2:3']);
    const b = await reread(out.files[1]!.bytes);
    expect(b.outline.map((o) => `${o.depth}:${o.title}:${o.page}`)).toEqual(['0:Body:1', '1:Body.1:2', '0:End:3']);
  });

  it('Title, Author, Subject and Keywords come from the source; Producer is PDF Suite; the dates are now', () => {
    const src = new mu.PDFDocument(makeDoc({ pages: 3, info: { Title: 'Annual report', Author: 'A. Writer', Subject: 'Numbers', Keywords: 'one, two' } }));
    const source: SplitSource = { doc: src, pdf: src, pages: 3, encrypted: false, bookmarks: [] };
    const before = Date.now();
    const built = buildPart(mu, source, 0, 1, { encrypted: false, password: undefined, dropEncryption: false });
    const part = mu.Document.openDocument(built.bytes, 'application/pdf');
    expect(part.getMetaData('info:Title')).toBe('Annual report');
    expect(part.getMetaData('info:Author')).toBe('A. Writer');
    expect(part.getMetaData('info:Subject')).toBe('Numbers');
    expect(part.getMetaData('info:Keywords')).toBe('one, two');
    expect(part.getMetaData('info:Producer')).toBe('PDF Suite');
    const created = part.getMetaData('info:CreationDate')!;
    expect(created).toMatch(/^D:\d{14}Z$/);
    const stamp = Date.UTC(+created.slice(2, 6), +created.slice(6, 8) - 1, +created.slice(8, 10), +created.slice(10, 12), +created.slice(12, 14), +created.slice(14, 16));
    expect(Math.abs(stamp - before)).toBeLessThan(60_000);
    expect(built.pages).toBe(2);
  });
});
