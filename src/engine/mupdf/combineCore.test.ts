// @vitest-environment node
// 1.3.3 Combine at engine level, on the JobSession (the worker's logic). Every file produced is re-read with pdf.js (a second
// engine); the inputs' bytes never change; a cancelled or failed run produces no `done`, and the next run on the same session works.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { JobHarness, makeDoc } from './jobTestKit';
import type { CombineSpec } from './jobProtocol';
import { LETTER, A4 } from './textLayout';
import { reread } from '../../../tests/lib/reread.mjs';
import { makeBmp, makePng, makeTiff } from '../../../tests/lib/makeImages.mjs';

const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const enc = (text: string) => new TextEncoder().encode(text);
const fw9Url = new URL('../../../tests/engine/corpus/irs-fw9/fw9.pdf', import.meta.url);

type Item = CombineSpec['items'][number];
const spec = (items: Item[], extra: Partial<CombineSpec> = {}): CombineSpec => ({
  kind: 'combine',
  items,
  fileBookmarks: true,
  imagePage: 'image',
  textPage: LETTER,
  leafName: 'Combined.pdf',
  ...extra,
});
const pdf = (name: string, extra: Partial<Item> = {}): Item => ({ kind: 'pdf', name, ...extra });

async function run(items: Item[], inputs: Uint8Array[], extra: Partial<CombineSpec> = {}) {
  const h = new JobHarness();
  const out = await h.combine(spec(items, extra), inputs);
  return { h, out };
}

function locked(pages: number, password: string): Uint8Array {
  const doc = new mu.PDFDocument(makeDoc({ pages, info: { Title: 'Secret' } }));
  return doc.saveToBuffer(`encrypt=aes-256,user-password=${password},owner-password=${password}`).asUint8Array().slice();
}

describe('the order shown is the order written, and ranges are honoured', () => {
  it('three PDFs in list order, each with its own range', async () => {
    const a = makeDoc({ pages: 4, text: (n) => `A${n}` });
    const b = makeDoc({ pages: 5, text: (n) => `B${n}` });
    const c = makeDoc({ pages: 3, text: (n) => `C${n}` });
    const { out } = await run([pdf('b.pdf', { pages: [2, 3, 5] }), pdf('a.pdf'), pdf('c.pdf', { pages: [1, 3] })], [b, a, c]);
    expect(out.error).toBeUndefined();
    expect(out.done).toMatchObject({ files: 1, pages: 9 });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.leafName).toBe('Combined.pdf');
    expect((await reread(out.files[0]!.bytes)).text).toEqual(['B2', 'B3', 'B5', 'A1', 'A2', 'A3', 'A4', 'C1', 'C3']);
  });

  it('the same file added twice is in the result twice', async () => {
    const a = makeDoc({ pages: 2, text: (n) => `A${n}` });
    const { out } = await run([pdf('a.pdf'), pdf('a.pdf', { pages: [2] }), pdf('a.pdf')], [a, a, a]);
    expect((await reread(out.files[0]!.bytes)).text).toEqual(['A1', 'A2', 'A2', 'A1', 'A2']);
  });

  it('the inputs are never changed', async () => {
    const a = makeDoc({ pages: 2 });
    const before = sha(a);
    await run([pdf('a.pdf')], [a]);
    expect(sha(a)).toBe(before);
  });

  it('page sizes follow each input', async () => {
    const small = makeDoc({ pages: 1, size: [200, 300] });
    const large = makeDoc({ pages: 1, size: [500, 400] });
    const { out } = await run([pdf('s.pdf'), pdf('l.pdf')], [small, large]);
    expect((await reread(out.files[0]!.bytes)).sizes.map((s) => [s.width, s.height])).toEqual([[200, 300], [500, 400]]);
  });

  it('a range outside the file is an Internal error with the row (the page checks ranges first)', async () => {
    const { out } = await run([pdf('a.pdf', { pages: [9] })], [makeDoc({ pages: 2 })]);
    expect(out.error).toMatchObject({ kind: 'Internal', item: 0 });
    expect(out.files).toHaveLength(0);
  });
});

describe('pictures and text files', () => {
  it('PDF + PNG + TXT: three kinds, in order, each page as it will be made', async () => {
    const a = makeDoc({ pages: 2, text: (n) => `Doc ${n}` });
    const { out } = await run(
      [pdf('a.pdf'), { kind: 'image', name: 'scan.png' }, { kind: 'text', name: 'notes.txt' }],
      [a, makePng(150, 100, 3, 150), enc('first line\nsecond line\n')],
    );
    expect(out.error).toBeUndefined();
    const read = await reread(out.files[0]!.bytes);
    expect(read.pages).toBe(4);
    expect(read.sizes[2]).toMatchObject({ width: 72, height: 48 });
    expect(read.sizes[3]).toMatchObject({ width: 612, height: 792 });
    expect(read.text[3]).toBe('first line second line');
    expect(read.text.slice(0, 2)).toEqual(['Doc 1', 'Doc 2']);
  });

  it('picture pages on A4 and text pages on A4', async () => {
    const { out } = await run(
      [{ kind: 'image', name: 'a.bmp' }, { kind: 'text', name: 't.txt' }],
      [makeBmp(60, 30, 2), enc('hello')],
      { imagePage: A4, textPage: A4 },
    );
    const read = await reread(out.files[0]!.bytes);
    expect(read.sizes.map((s) => [Math.round(s.width), Math.round(s.height)])).toEqual([[842, 595], [595, 842]]);
  });

  it('a multi-page TIFF with a range: only the chosen frames, in order', async () => {
    const tiff = makeTiff([
      { w: 30, h: 20, seed: 1, dpi: 72 },
      { w: 10, h: 40, seed: 2, dpi: 72 },
      { w: 25, h: 25, seed: 3, dpi: 72 },
      { w: 12, h: 12, seed: 4, dpi: 72 },
    ]);
    const { out } = await run([{ kind: 'image', name: 'scan.tif', pages: [2, 4] }], [tiff]);
    expect((await reread(out.files[0]!.bytes)).sizes.map((s) => [s.width, s.height])).toEqual([[10, 40], [12, 12]]);
    const all = await run([{ kind: 'image', name: 'scan.tif' }], [tiff]);
    expect((await reread(all.out.files[0]!.bytes)).pages).toBe(4);
  });

  it('a long text file flows over several pages, and Greek and Cyrillic read back', async () => {
    const text = Array.from({ length: 130 }, (_v, i) => `line ${i + 1}`).join('\n') + '\nΑθήνα Москва';
    const { out } = await run([{ kind: 'text', name: 'long.txt' }], [enc(text)]);
    const read = await reread(out.files[0]!.bytes);
    expect(read.pages).toBe(3);
    expect(read.text[2]!.endsWith('Αθήνα Москва')).toBe(true);
    expect(read.text[0]!.startsWith('line 1 line 2')).toBe(true);
  });

  it('a text file over 32 MB is TextTooLarge, with its row', async () => {
    const big = new Uint8Array(32 * 1024 * 1024 + 1).fill(0x61);
    const { out } = await run([pdf('a.pdf'), { kind: 'text', name: 'big.txt' }], [makeDoc({ pages: 1 }), big]);
    expect(out.error).toMatchObject({ kind: 'TextTooLarge', item: 1 });
    expect(out.files).toHaveLength(0);
  });

  it('a damaged picture is Damaged, with its row', async () => {
    const { out } = await run([{ kind: 'image', name: 'x.png' }], [new Uint8Array([1, 2, 3])]);
    expect(out.error).toMatchObject({ kind: 'Damaged', item: 0 });
  });
});

describe('probe and preview of pictures and text', () => {
  it('a picture probes as one page (frames for a TIFF), and the preview is the page as it will be made', async () => {
    const h = new JobHarness();
    const tiff = makeTiff([{ w: 30, h: 20, dpi: 72 }, { w: 10, h: 40, dpi: 72 }]);
    const probed = (await h.probeKind('image', tiff, { item: 3, imagePage: LETTER })).probed!;
    expect(probed).toMatchObject({ pages: 2, encrypted: false, fields: 0, unprintable: 0 });
    h.send({ t: 'thumb', id: 2, item: 3, page: 1, maxPx: 100 });
    await h.session.idle();
    const thumbed = h.messages.find((m) => m.t === 'thumbed');
    // Page 2 of the TIFF is tall (10 x 40): on Letter it is a portrait page, 100 px on its longer side.
    expect(thumbed).toMatchObject({ t: 'thumbed', item: 3, page: 1, height: 100 });
    expect((thumbed as { width: number }).width).toBe(78);
    const pixels = new Uint8ClampedArray((thumbed as { pixels: ArrayBuffer }).pixels);
    expect(pixels.length).toBe(78 * 100 * 4);
    expect([...pixels.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it('text probes with its page count and the count of characters it cannot print, and follows the page size', async () => {
    const h = new JobHarness();
    const text = enc(Array.from({ length: 60 }, (_v, i) => (i === 0 ? '日本 ok' : `l${i}`)).join('\n'));
    const letter = (await h.probeKind('text', text, { textPage: LETTER })).probed!;
    expect(letter).toMatchObject({ pages: 2, unprintable: 2 });
    const a4 = (await new JobHarness().probeKind('text', text, { textPage: A4 })).probed!;
    expect(a4).toMatchObject({ pages: 2 });
    const short = (await new JobHarness().probeKind('text', enc(Array.from({ length: 56 }, (_v, i) => `l${i}`).join('\n')), { textPage: A4 })).probed!;
    expect(short.pages).toBe(1);
    expect((await new JobHarness().probeKind('text', enc(Array.from({ length: 56 }, (_v, i) => `l${i}`).join('\n')), { textPage: LETTER })).probed!.pages).toBe(2);
  });

  it('a PDF preview is of the file as it is, and a thumb for another row is refused', async () => {
    const h = new JobHarness();
    await h.probeKind('pdf', makeDoc({ pages: 3 }), { item: 0, preview: true });
    h.send({ t: 'thumb', id: 2, item: 0, page: 2, maxPx: 80 });
    h.send({ t: 'thumb', id: 3, item: 5, page: 0, maxPx: 80 });
    await h.session.idle();
    expect(h.messages.filter((m) => m.t === 'thumbed')).toHaveLength(1);
    expect(h.messages.find((m) => m.t === 'error')).toMatchObject({ id: 3, kind: 'Internal' });
  });

  it('a picture over 50 megapixels is ImageTooLarge at probe time', async () => {
    const big = Buffer.from(makePng(8, 8));
    big.writeUInt32BE(8000, 16);
    big.writeUInt32BE(8000, 20);
    const out = await new JobHarness().probeKind('image', new Uint8Array(big), { item: 2 });
    expect(out.error).toMatchObject({ kind: 'ImageTooLarge', item: 2 });
  });
});

describe('carry-over (blueprint B1)', () => {
  it('comments, web links and internal links come with the pages; an internal link to a page left out is removed', async () => {
    const a = makeDoc({ pages: 4, notes: [1, 3], links: [{ page: 1, url: 'https://example.com/x' }, { page: 1, toPage: 3 }, { page: 2, toPage: 4 }] });
    const { out } = await run([pdf('a.pdf', { pages: [1, 2, 3] })], [a]);
    const read = await reread(out.files[0]!.bytes);
    expect(read.pages).toBe(3);
    const onPage = (n: number) => read.annotations.filter((x) => x.page === n);
    expect(onPage(1).filter((x) => x.subtype === 'Text')).toHaveLength(1);
    expect(onPage(3).filter((x) => x.subtype === 'Highlight')).toHaveLength(1);
    expect(onPage(1).some((x) => x.url === 'https://example.com/x')).toBe(true);
    const doc = mu.Document.openDocument(out.files[0]!.bytes, 'application/pdf');
    const links = (n: number) => doc.loadPage(n).getLinks().map((l) => ({ external: l.isExternal(), target: l.isExternal() ? l.getURI() : doc.resolveLink(l.getURI()) }));
    // Page 1's internal link pointed at page 3, which is page 3 of the output; page 2's link pointed at page 4, which is left out.
    expect(links(0)).toContainEqual({ external: false, target: 2 });
    expect(links(1)).toEqual([]);
  });

  it('links between two inputs stay inside their own file: each file\'s internal link follows its own page', async () => {
    const a = makeDoc({ pages: 2, links: [{ page: 1, toPage: 2 }] });
    const b = makeDoc({ pages: 2, links: [{ page: 1, toPage: 2 }] });
    const { out } = await run([pdf('a.pdf'), pdf('b.pdf')], [a, b]);
    const doc = mu.Document.openDocument(out.files[0]!.bytes, 'application/pdf');
    const target = (n: number) => doc.resolveLink(doc.loadPage(n).getLinks()[0]!.getURI());
    expect([target(0), target(2)]).toEqual([1, 3]);
  });

  it('bookmarks are nested under one bookmark per file, with pages renumbered', async () => {
    const a = makeDoc({ pages: 3, outline: [{ title: 'A one', page: 1 }, { title: 'A two', page: 3, children: [{ title: 'A two-b', page: 3 }] }] });
    const b = makeDoc({ pages: 2, outline: [{ title: 'B one', page: 2 }] });
    const { out } = await run([pdf('Alpha.pdf'), { kind: 'text', name: 'notes.txt' }, pdf('Beta.pdf')], [a, enc('x'), b]);
    const read = await reread(out.files[0]!.bytes);
    expect(read.outline.map((o) => `${o.depth}:${o.title}:${o.page}`)).toEqual([
      '0:Alpha:1',
      '1:A one:1',
      '1:A two:3',
      '2:A two-b:3',
      '0:notes:4',
      '0:Beta:5',
      '1:B one:6',
    ]);
  });

  it('without the per-file bookmark, the files\' own bookmarks stand at the top level; a bookmark to a left-out page is dropped', async () => {
    const a = makeDoc({ pages: 3, outline: [{ title: 'One', page: 1 }, { title: 'Two', page: 2 }, { title: 'Three', page: 3 }] });
    const { out } = await run([pdf('a.pdf', { pages: [1, 3] })], [a], { fileBookmarks: false });
    const read = await reread(out.files[0]!.bytes);
    expect(read.outline.map((o) => `${o.depth}:${o.title}:${o.page}`)).toEqual(['0:One:1', '0:Three:2']);
  });

  it('a file with no bookmarks and the option off makes an output with no outline at all', async () => {
    const { out } = await run([pdf('a.pdf')], [makeDoc({ pages: 2 })], { fileBookmarks: false });
    expect((await reread(out.files[0]!.bytes)).outline).toEqual([]);
  });

  it('a positioned bookmark lands at the same place on the same page (raw destination compared)', async () => {
    // A bookmark with /XYZ 100 250 0 on page 2 of a 300 x 400 page.
    const src = new mu.PDFDocument(makeDoc({ pages: 3 }));
    const outlines = src.createObject();
    const item = src.createObject();
    const dest = src.newArray();
    dest.push(src.findPage(1));
    dest.push(src.newName('XYZ'));
    dest.push(src.newReal(100));
    dest.push(src.newReal(250));
    dest.push(src.newReal(0));
    const dict = src.newDictionary();
    dict.put('Title', src.newString('Placed'));
    dict.put('Parent', outlines);
    dict.put('Dest', dest);
    item.writeObject(dict);
    const top = src.newDictionary();
    top.put('Type', src.newName('Outlines'));
    top.put('First', item);
    top.put('Last', item);
    top.put('Count', 1);
    outlines.writeObject(top);
    src.getTrailer().get('Root').put('Outlines', outlines);
    const bytes = src.saveToBuffer('garbage=compact').asUint8Array().slice();

    const { out } = await run([{ kind: 'text', name: 'first.txt' }, pdf('p.pdf')], [enc('x'), bytes], { fileBookmarks: false });
    const result = new mu.PDFDocument(out.files[0]!.bytes);
    const first = result.getTrailer().get('Root').get('Outlines').get('First');
    expect(first.get('Title').asString()).toBe('Placed');
    const raw = first.get('Dest');
    // Page 2 of the source is page 3 of the output; the position is untouched.
    expect(raw.get(0).asIndirect()).toBe(result.findPage(2).asIndirect());
    expect(raw.get(1).asName()).toBe('XYZ');
    expect(raw.get(2).asNumber()).toBeCloseTo(100, 1);
    expect(raw.get(3).asNumber()).toBeCloseTo(250, 1);
  });

  it('metadata: Title, Author, Subject and Keywords from the first PDF, Producer is PDF Suite, dates are now', async () => {
    const first = makeDoc({ pages: 1, info: { Title: 'First title', Author: 'Ann', Subject: 'S', Keywords: 'k1, k2' } });
    const second = makeDoc({ pages: 1, info: { Title: 'Second title', Author: 'Bob' } });
    const { out } = await run([{ kind: 'text', name: 't.txt' }, pdf('1.pdf'), pdf('2.pdf')], [enc('x'), first, second]);
    const doc = mu.Document.openDocument(out.files[0]!.bytes, 'application/pdf');
    expect(doc.getMetaData('info:Title')).toBe('First title');
    expect(doc.getMetaData('info:Author')).toBe('Ann');
    expect(doc.getMetaData('info:Subject')).toBe('S');
    expect(doc.getMetaData('info:Keywords')).toBe('k1, k2');
    expect(doc.getMetaData('info:Producer')).toBe('PDF Suite');
    expect(doc.getMetaData('info:CreationDate')).toMatch(/^D:20\d{12}Z$/);
  });

  it('attachments, page labels and the structure tree are not carried (knowingly dropped)', async () => {
    const src = new mu.PDFDocument(makeDoc({ pages: 2 }));
    src.addEmbeddedFile('a.txt', 'text/plain', new TextEncoder().encode('hi'), new Date(), new Date());
    const root = src.getTrailer().get('Root');
    const labels = src.newDictionary();
    labels.put('Nums', src.newArray());
    root.put('PageLabels', labels);
    root.put('StructTreeRoot', src.newDictionary());
    root.put('Lang', src.newString('en'));
    const bytes = src.saveToBuffer('garbage=compact').asUint8Array().slice();
    const { out } = await run([pdf('a.pdf')], [bytes]);
    const result = new mu.PDFDocument(out.files[0]!.bytes);
    const outRoot = result.getTrailer().get('Root');
    for (const key of ['PageLabels', 'StructTreeRoot', 'Lang', 'MarkInfo', 'Names', 'OCProperties']) expect(outRoot.get(key).isNull(), key).toBe(true);
    expect(Object.keys(result.getEmbeddedFiles())).toEqual([]);
    expect(result.findPage(0).get('StructParents').isNull()).toBe(true);
  });

  it('a hidden layer becomes visible in the combined file', async () => {
    const src = new mu.PDFDocument();
    const ocg = src.addObject(src.newDictionary());
    ocg.put('Type', src.newName('OCG'));
    ocg.put('Name', src.newString('Hidden'));
    const props = src.newDictionary();
    props.put('OC1', ocg);
    const resources = src.addObject(src.newDictionary());
    resources.put('Properties', props);
    src.insertPage(-1, src.addPage([0, 0, 200, 200], 0, resources, '/OC /OC1 BDC 0 0 0 rg 20 20 160 160 re f EMC'));
    const root = src.getTrailer().get('Root');
    const oc = src.newDictionary();
    const ocgs = src.newArray();
    ocgs.push(ocg);
    oc.put('OCGs', ocgs);
    const d = src.newDictionary();
    const off = src.newArray();
    off.push(ocg);
    d.put('OFF', off);
    oc.put('D', d);
    root.put('OCProperties', oc);
    const bytes = src.saveToBuffer('garbage=compact').asUint8Array().slice();
    const inkOf = (file: Uint8Array) => {
      const px = mu.Document.openDocument(file, 'application/pdf').loadPage(0).toPixmap(mu.Matrix.identity, mu.ColorSpace.DeviceGray, false, true).getPixels();
      return [...px].filter((v) => v < 100).length;
    };
    expect(inkOf(bytes)).toBe(0);
    const { out } = await run([pdf('layers.pdf')], [bytes]);
    expect(inkOf(out.files[0]!.bytes)).toBeGreaterThan(10000);
  });
});

describe('forms (flattened) and XFA', () => {
  it('a filled form keeps its values as page content, and the output has no form (fw9 without its XFA part, as in formFlatten.test.ts)', async () => {
    if (!fs.existsSync(fw9Url)) return;
    const form = new mu.PDFDocument(new Uint8Array(fs.readFileSync(fw9Url)));
    const texts: string[] = [];
    for (let p = 0; p < form.countPages(); p++) {
      const page = form.loadPage(p);
      let n = 0;
      for (const widget of page.getWidgets()) {
        if (!widget.isText() || widget.isReadOnly()) continue;
        const maxLen = widget.getMaxLen();
        const wanted = `ZQ${p}x${(n += 1)}VAL`;
        widget.setTextValue(maxLen > 0 ? wanted.slice(0, maxLen) : wanted);
        if (widget.getValue() !== '') texts.push(widget.getValue());
      }
      page.update();
    }
    form.getTrailer().get('Root').get('AcroForm').delete('XFA');
    const bytes = form.saveToBuffer('').asUint8Array().slice();
    const { out } = await run([pdf('cover.pdf'), pdf('fw9.pdf')], [makeDoc({ pages: 1 }), bytes]);
    expect(out.error).toBeUndefined();
    const read = await reread(out.files[0]!.bytes);
    const all = read.text.join(' ').replace(/\s+/g, '');
    for (const value of texts) expect(all, value).toContain(value.replace(/\s+/g, ''));
    expect(read.annotations.filter((x) => x.subtype === 'Widget')).toHaveLength(0);
    expect(new mu.PDFDocument(out.files[0]!.bytes).getTrailer().get('Root').get('AcroForm').isNull()).toBe(true);
  });

  it('fw9.pdf (a hybrid XFA form, which the app cannot edit) is refused as Xfa with its row, and nothing is made', async () => {
    if (!fs.existsSync(fw9Url)) return;
    const { out } = await run([pdf('ok.pdf'), pdf('fw9.pdf')], [makeDoc({ pages: 1 }), new Uint8Array(fs.readFileSync(fw9Url))]);
    expect(out.error).toMatchObject({ kind: 'Xfa', item: 1 });
    expect(out.files).toHaveLength(0);
    expect(out.done).toBeUndefined();
  });
});

describe('encrypted inputs', () => {
  it('the password opens the input and the output is not encrypted', async () => {
    const { out } = await run([pdf('locked.pdf', { password: 'open sesame' })], [locked(3, 'open sesame')]);
    expect(out.error).toBeUndefined();
    const doc = mu.Document.openDocument(out.files[0]!.bytes, 'application/pdf');
    expect(doc.needsPassword()).toBe(false);
    expect((await reread(out.files[0]!.bytes)).text).toEqual(['Page 1', 'Page 2', 'Page 3']);
  });

  it('no password or a wrong one fails with the row, and nothing is made', async () => {
    const src = locked(3, 'open sesame');
    expect((await run([pdf('a.pdf'), pdf('locked.pdf')], [makeDoc({ pages: 1 }), src])).out.error).toMatchObject({ kind: 'PasswordNeeded', item: 1 });
    const wrong = await run([pdf('locked.pdf', { password: 'nope' })], [src]);
    expect(wrong.out.error).toMatchObject({ kind: 'WrongPassword', item: 0 });
    expect(wrong.out.files).toHaveLength(0);
  });

  it('a password in the spec never appears in any message the worker sends', async () => {
    const { out } = await run([pdf('locked.pdf', { password: 'open sesame' })], [locked(2, 'open sesame')]);
    expect(JSON.stringify(out.messages.map((m) => ({ ...m, bytes: undefined })))).not.toContain('open sesame');
  });
});

describe('progress, cancel and failure', () => {
  it('progress counts pages when every item says how many it adds, and ends with saving, checking, writing', async () => {
    const a = makeDoc({ pages: 3 });
    const b = makeDoc({ pages: 2 });
    const { out } = await run([pdf('a.pdf', { count: 3 }), pdf('b.pdf', { count: 2 })], [a, b]);
    const progress = out.messages.filter((m) => m.t === 'progress') as Array<Extract<(typeof out.messages)[number], { t: 'progress' }>>;
    expect(progress[0]).toMatchObject({ phase: 'reading', done: 0, total: 5, unit: 'pages' });
    expect(progress.filter((p) => p.phase === 'copying').at(-1)).toMatchObject({ done: 5, total: 5 });
    expect(progress.map((p) => p.phase).slice(-3)).toEqual(['saving', 'checking', 'writing']);
  });

  it('progress counts files when the items do not say', async () => {
    const { out } = await run([pdf('a.pdf'), pdf('b.pdf')], [makeDoc({ pages: 1 }), makeDoc({ pages: 1 })]);
    const first = out.messages.find((m) => m.t === 'progress');
    expect(first).toMatchObject({ unit: 'files', total: 2 });
  });

  it('a cancel while the second input is awaited ends with Cancelled and no file; the next run works', async () => {
    const h = new JobHarness();
    h.inputs = [makeDoc({ pages: 2 })];
    h.send({ t: 'start', id: 5, spec: spec([pdf('a.pdf'), pdf('b.pdf')]) });
    // The page answers need 0 (the harness does), never answers need 1, and cancels.
    await new Promise((r) => setTimeout(r, 30));
    h.send({ t: 'cancel', id: 5 });
    await h.session.idle();
    const first = h.output();
    expect(first.error).toMatchObject({ kind: 'Cancelled' });
    expect(first.files).toHaveLength(0);
    h.messages.length = 0;
    const again = await h.combine(spec([pdf('a.pdf')]), [makeDoc({ pages: 2 })], 6);
    expect(again.error).toBeUndefined();
    expect(again.done).toMatchObject({ pages: 2 });
  });

  it('a write failure at chunk 0 ends in an error with no done, and the next run on the session succeeds', async () => {
    let fail = true;
    const h = new JobHarness({
      beforeChunk: () => {
        if (fail) {
          fail = false;
          throw new Error('disk gone');
        }
      },
    });
    const first = await h.combine(spec([pdf('a.pdf')]), [makeDoc({ pages: 1 })]);
    expect(first.error).toMatchObject({ kind: 'Internal' });
    expect(first.done).toBeUndefined();
    h.messages.length = 0;
    const second = await h.combine(spec([pdf('a.pdf')]), [makeDoc({ pages: 1 })], 4);
    expect(second.done).toMatchObject({ files: 1, pages: 1 });
  });

  it('an output of several MB leaves in 4 MB chunks, in order, and the pieces add up to a file pdf.js reads', async () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const words = Array.from({ length: 700000 }, () => rnd().toString(36).slice(0, 5)).join(' ');
    const { out } = await run([{ kind: 'text', name: 'big.txt' }], [enc(words)]);
    expect(out.error).toBeUndefined();
    const chunks = out.messages.filter((m) => m.t === 'chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => (c as { seq: number }).seq)).toEqual(chunks.map((_c, i) => i));
    expect((await reread(out.files[0]!.bytes)).pages).toBe(out.done!.pages);
  }, 60000);

  it('a fonts-shared combine does not copy the fonts once per page: 60 pages of one font stay small', async () => {
    const a = makeDoc({ pages: 60 });
    const { out } = await run([pdf('a.pdf')], [a]);
    expect(out.files[0]!.bytes.length).toBeLessThan(a.length * 1.6);
  });
});

describe('a job that runs out of memory', () => {
  it('MuPDF\'s failed allocation is reported as OutOfMemory, with no file, and the next run on the session works', async () => {
    let fail = true;
    const h = new JobHarness({
      beforeChunk: () => {
        if (fail) {
          fail = false;
          throw new Error('realloc (367746783 bytes) failed');
        }
      },
    });
    const first = await h.combine(spec([pdf('a.pdf')]), [makeDoc({ pages: 1 })]);
    expect(first.error).toMatchObject({ kind: 'OutOfMemory' });
    expect(first.done).toBeUndefined();
    h.messages.length = 0;
    expect((await h.combine(spec([pdf('a.pdf')]), [makeDoc({ pages: 1 })], 4)).done).toMatchObject({ files: 1 });
  });

  it('which errors count', async () => {
    const { isOutOfMemory } = await import('./jobProtocol');
    expect(isOutOfMemory(new Error('realloc (36 bytes) failed'))).toBe(true);
    expect(isOutOfMemory(new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded'))).toBe(true);
    expect(isOutOfMemory(new Error('out of memory'))).toBe(true);
    expect(isOutOfMemory(new Error('The file has no pages'))).toBe(false);
  });
});
