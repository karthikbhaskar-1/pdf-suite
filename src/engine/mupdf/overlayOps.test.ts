// @vitest-environment node
// 1.3.4 review fixes, on real MuPDF: (1) the overlay pages of one edit share one graft map, so a resource that several overlay
// pages use is copied into the document once; (2) a base page that leaves a `q` open does not leak its transform into the
// overlay's drawing (the view and the applied result agree); and the tokenizer that counts the open states.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { openGraphicsStates } from './overlayOps';
import type { OverlayArgs } from './protocol';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('openGraphicsStates counts the q that the content leaves open', () => {
  it('counts balanced and unbalanced operators', () => {
    expect(openGraphicsStates(bytes('q 1 0 0 1 0 0 cm Q'))).toBe(0);
    expect(openGraphicsStates(bytes('q q 0 g Q'))).toBe(1);
    expect(openGraphicsStates(bytes('0.5 0 0 0.5 0 0 cm q 0 g 10 10 5 5 re f'))).toBe(1);
    expect(openGraphicsStates(bytes('q\nq\nq\nQ'))).toBe(2);
  });

  it('a Q with nothing open is ignored, as viewers do', () => {
    expect(openGraphicsStates(bytes('Q Q q'))).toBe(1);
  });

  it('a q inside a string, a hex string, a comment, a name or a longer word is not an operator', () => {
    expect(openGraphicsStates(bytes('BT (q q q) Tj ET'))).toBe(0);
    expect(openGraphicsStates(bytes('BT (a \\( q \\) b (nested q) c) Tj ET q'))).toBe(1);
    expect(openGraphicsStates(bytes('<7171> Tj % q q\n q'))).toBe(1);
    expect(openGraphicsStates(bytes('/q gs /Q gs q'))).toBe(1);
    expect(openGraphicsStates(bytes('qq QQ q* 0 q0'))).toBe(0);
    expect(openGraphicsStates(bytes('<< /q 1 >> BDC q'))).toBe(1);
  });

  it('dictionaries are not hex strings: the property lists of a tagged page are read as tokens, nested ones too', () => {
    expect(openGraphicsStates(bytes('/Span <</ActualText (q q)>> BDC q 0 g EMC'))).toBe(1);
    expect(openGraphicsStates(bytes('/P <</MCID 0 /A <</O /Layout /K (Q)>> >> BDC q Q EMC q'))).toBe(1);
    expect(openGraphicsStates(bytes('/Artifact <</Type /Pagination>> BDC EMC <71> Tj q q'))).toBe(2);
    expect(openGraphicsStates(bytes('q /OC <</Type /OCG >> BDC Q EMC'))).toBe(0);
  });

  it('the data of an inline image is skipped, even when it holds q and Q bytes', () => {
    const data = 'BI /W 2 /H 2 /CS /G /BPC 8 ID qQqQ q Q EI Q\nq';
    expect(openGraphicsStates(bytes(`q ${data}`))).toBe(1);
    expect(openGraphicsStates(bytes(`q q ${data}`))).toBe(2);
  });

  it('an empty stream leaves nothing open', () => {
    expect(openGraphicsStates(new Uint8Array(0))).toBe(0);
  });
});

function numbers(pdf: mu.PDFDocument, values: readonly number[]): mu.PDFObject {
  const list = pdf.newArray();
  for (const v of values) list.push(pdf.newReal(v));
  return list;
}

describe('a page that leaves a q open', () => {
  function pixelsOf(core: MupdfCore, overlay?: OverlayArgs) {
    const { pixmap, w, h } = core.renderPixmap({ page: 0, scale: 1, rotation: 0, overlay });
    const px = new Uint8Array(w * h * 4);
    const stride = pixmap.getStride();
    const src = pixmap.getPixels();
    for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w * 4), y * w * 4);
    pixmap.destroy();
    return { w, h, px };
  }
  const differing = (a: { w: number; h: number; px: Uint8Array }, b: { px: Uint8Array }) => {
    let bad = 0;
    for (let i = 0; i < a.w * a.h; i++) {
      const j = i * 4;
      if (Math.abs(a.px[j]! - b.px[j]!) > 12 || Math.abs(a.px[j + 1]! - b.px[j + 1]!) > 12 || Math.abs(a.px[j + 2]! - b.px[j + 2]!) > 12) bad++;
    }
    return bad / (a.w * a.h);
  };

  for (const [name, content] of [
    ['a scale and a q left open', '0.5 0 0 0.5 0 0 cm q 0 g 100 100 200 100 re f'],
    ['a clip left open', 'q 0 0 50 50 re W n 0 g 10 10 20 20 re f'],
    ['several states left open', 'q 0.5 0 0 0.5 0 0 cm q 1 0 0 1 30 30 cm q 0 g 10 10 80 40 re f'],
    ['a tagged page: property dictionaries and a q left open', '/P <</MCID 0 /ActualText (q q)>> BDC 0.5 0 0 0.5 0 0 cm q 0 g 100 100 200 100 re f EMC /Span <</Lang (en)>> BDC EMC'],
  ] as const) {
    it(`${name}: the view and the saved result agree, and the result keeps the overlay in place`, async () => {
      const base = new mu.PDFDocument();
      base.insertPage(0, base.addPage([0, 0, 400, 300], 0, {}, content));
      const over = new mu.PDFDocument();
      over.insertPage(0, over.addPage([0, 0, 400, 300], 0, {}, '0 g 250 200 100 60 re f'));
      const core = new MupdfCore(mu as never, {});
      core.open(base.saveToBuffer('').asUint8Array().slice(), undefined);
      const source = core.attachSource(over.saveToBuffer('').asUint8Array().slice(), undefined).sourceDocId;
      const args: OverlayArgs = { sourceDocId: source, sourcePage: 0, dx: 10, dy: 20, scale: 1, mode: 'multiply', opacity: 0.5 };
      const view = pixelsOf(core, args);
      await core.applyEdits([{ op: 'overlay', uids: ['0'], sourceDocId: source, sourceUids: ['0'], dx: 10, dy: 20, scale: 1, mode: 'multiply', opacity: 0.5 }]);
      const applied = pixelsOf(core);
      expect(differing(view, applied)).toBeLessThanOrEqual(0.001);
      // The saved file shows the same.
      const saved = core.save(false, false).bytes;
      const reopened = new MupdfCore(mu as never, {});
      reopened.open(new Uint8Array(saved.slice(0)), undefined);
      expect(differing(view, pixelsOf(reopened))).toBeLessThanOrEqual(0.001);
      core.close();
      reopened.close();
    });
  }
});

describe('overlay pages that share a resource copy it once', () => {
  /** An overlay of 4 pages that all use one big Form XObject (a marker in its stream makes the copies countable). */
  function sharedOverlay(): Uint8Array {
    const pdf = new mu.PDFDocument();
    const filler = `%%SHAREDMARK\n${'q 1 0 0 1 0 0 cm 0.5 g 0 0 1 1 re f Q\n'.repeat(1500)}`;
    const formDict = pdf.newDictionary();
    formDict.put('Type', pdf.newName('XObject'));
    formDict.put('Subtype', pdf.newName('Form'));
    formDict.put('BBox', numbers(pdf, [0, 0, 10, 10]));
    const big = pdf.addStream(filler, formDict);
    const xobjects = pdf.newDictionary();
    xobjects.put('Big', big);
    const resources = pdf.newDictionary();
    resources.put('XObject', xobjects);
    for (let i = 0; i < 4; i++) pdf.insertPage(i, pdf.addPage([0, 0, 400, 300], 0, resources, `/Big Do 0 g ${20 + i * 30} 20 20 20 re f`));
    return pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
  }

  it('Page by page over 4 pages that share one resource: one copy in the saved file, not four', async () => {
    const base = new mu.PDFDocument();
    for (let i = 0; i < 4; i++) base.insertPage(i, base.addPage([0, 0, 400, 300], 0, {}, `0 g ${10 + i * 20} 200 15 15 re f`));
    const core = new MupdfCore(mu as never, {});
    const plain = base.saveToBuffer('garbage=compact').asUint8Array().slice();
    core.open(plain, undefined);
    const overlayFile = sharedOverlay();
    const source = core.attachSource(overlayFile, undefined).sourceDocId;
    await core.applyEdits([{ op: 'overlay', uids: ['0', '1', '2', '3'], sourceDocId: source, sourceUids: ['0', '1', '2', '3'], dx: 0, dy: 0, scale: 1, mode: 'multiply', opacity: 0.5 }]);
    const saved = Buffer.from(core.save(false, false).bytes);
    const text = saved.toString('latin1');
    expect(text.match(/%%SHAREDMARK/g)?.length).toBe(1);
    // The shared stream is about 55 KB: four copies would add about 220 KB, one adds about 55 KB.
    const overlayCopy = Buffer.from(overlayFile).length;
    expect(saved.length - plain.length).toBeLessThan(overlayCopy * 1.3);
    core.close();
  });

  it('the map is not kept across edits: after two applies and two undos, one edit over two pages copies the resource once', async () => {
    const base = new mu.PDFDocument();
    for (let i = 0; i < 2; i++) base.insertPage(i, base.addPage([0, 0, 400, 300], 0, {}, '0 g 10 10 5 5 re f'));
    const core = new MupdfCore(mu as never, {});
    core.open(base.saveToBuffer('garbage=compact').asUint8Array().slice(), undefined);
    const source = core.attachSource(sharedOverlay(), undefined).sourceDocId;
    const edit = (uids: string[], pages: string[]) => ({ op: 'overlay' as const, uids, sourceDocId: source, sourceUids: pages, dx: 0, dy: 0, scale: 1, mode: 'multiply' as const, opacity: 0.5 });
    await core.applyEdits([edit(['0'], ['0'])]);
    await core.applyEdits([edit(['1'], ['1'])]);
    core.undo();
    core.undo();
    expect(core.editState!.history.canUndo).toBe(false);
    await core.applyEdits([edit(['0', '1'], ['2', '3'])]);
    const text = Buffer.from(core.save(false, false).bytes).toString('latin1');
    expect(text.match(/%%SHAREDMARK/g)?.length).toBe(1);
    core.close();
  });
});
