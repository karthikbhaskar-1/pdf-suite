// Sign-Off 1.3.1, probe E2 (engine level, the app's own MupdfCore):
//  (a) a cut page that other pages link to, and that bookmarks and a named destination point at
//  (b) cut, then Extract; cut, save, then Insert / Replace from that file into another document
//  (c) the saved size after cutting many pages (content streams must not be written twice)
//  (d) a replay of an edit log with uid seeds gives the same pages and uids
import { describe, expect, it } from 'vitest';
import { type TreeNode, buildTree, halvesProblem, mu, openCore, reopen, same, shots, uids } from './e-lib';
import type { PageEdit } from '../../src/engine/mupdf/protocol';
import type { MupdfCore } from '../../src/engine/mupdf/core';

const flat = (n: number): TreeNode => ({ attrs: { MediaBox: [0, 0, 600, 800], font: 'Helvetica' }, kids: Array.from({ length: n }, (_, i) => ({ name: `p${i}` })) });

function withTargets(): Uint8Array {
  const { pdf, pages } = buildTree(flat(4));
  const dest = (page: mu.PDFObject, kind: string, ...nums: number[]) => {
    const d = pdf.newArray();
    d.push(page);
    d.push(pdf.newName(kind));
    for (const n of nums) d.push(pdf.newReal(n));
    return d;
  };
  const link = (on: mu.PDFObject, rect: number[], put: (dict: mu.PDFObject) => void) => {
    const a = pdf.newDictionary();
    a.put('Type', pdf.newName('Annot'));
    a.put('Subtype', pdf.newName('Link'));
    const r = pdf.newArray();
    for (const n of rect) r.push(pdf.newReal(n));
    a.put('Rect', r);
    put(a);
    const page = on.resolve();
    let list: mu.PDFObject;
    try {
      list = page.get('Annots');
      if (!list.isArray()) throw new Error('none');
    } catch {
      list = pdf.newArray();
      page.put('Annots', list);
    }
    page.get('Annots').push(pdf.addObject(a));
  };
  // p0: a link to a point in the RIGHT half of p2, and a GoTo action to p2. p3: a named destination in p2's LEFT half.
  link(pages[0]!, [50, 50, 150, 80], (a) => a.put('Dest', dest(pages[2]!, 'XYZ', 450, 600, 0)));
  link(pages[0]!, [50, 100, 150, 130], (a) => {
    const act = pdf.newDictionary();
    act.put('S', pdf.newName('GoTo'));
    act.put('D', dest(pages[2]!, 'Fit'));
    a.put('A', act);
  });
  link(pages[3]!, [50, 50, 150, 80], (a) => a.put('Dest', pdf.newString('nd')));
  const root = pdf.getTrailer().get('Root');
  const dests = pdf.newDictionary();
  dests.put('nd', dest(pages[2]!, 'XYZ', 100, 700, 0));
  root.put('Dests', pdf.addObject(dests));
  // Outline: "Two" -> p2, "Three" -> p3.
  const outlines = pdf.addObject(pdf.newDictionary());
  const one = pdf.addObject(pdf.newDictionary());
  const two = pdf.addObject(pdf.newDictionary());
  one.resolve().put('Title', pdf.newString('Two'));
  one.resolve().put('Parent', outlines);
  one.resolve().put('Dest', dest(pages[2]!, 'XYZ', 0, 800, 0));
  one.resolve().put('Next', two);
  two.resolve().put('Title', pdf.newString('Three'));
  two.resolve().put('Parent', outlines);
  two.resolve().put('Dest', dest(pages[3]!, 'Fit'));
  two.resolve().put('Prev', one);
  outlines.resolve().put('Type', pdf.newName('Outlines'));
  outlines.resolve().put('First', one);
  outlines.resolve().put('Last', two);
  outlines.resolve().put('Count', 2);
  root.put('Outlines', outlines);
  return pdf.saveToBuffer('').asUint8Array().slice();
}

/** Where the links of a page go (page index), and the outline's page indexes, as MuPDF resolves them. */
function targets(doc: mu.Document, linkPages: number[]): { links: number[]; outline: Array<number | undefined> } {
  const links: number[] = [];
  for (const p of linkPages) {
    const page = doc.loadPage(p);
    for (const l of page.getLinks()) links.push(doc.resolveLink(l));
  }
  return { links, outline: (doc.loadOutline() ?? []).map((o) => o.page) };
}

describe('E2a links, bookmarks and a named destination that point at a cut page', () => {
  const bytes = withTargets();
  it('fixture: three links to page index 2, bookmarks to 2 and 3', () => {
    const t = targets(reopen(bytes), [0, 3]);
    expect(t).toEqual({ links: [2, 2, 2], outline: [2, 3] });
  });
  for (const first of ['left', 'right'] as const) {
    for (const mode of ['incremental', 'full'] as const) {
      it(`cut page 3 (${first} first), ${mode} save: links and bookmark land on the first half, the next bookmark moves along`, async () => {
        const core = openCore(bytes);
        await core.applyEdits([{ op: 'slice', uids: [uids(core)[2]!], cut: 'vertical', at: 0.5, first }]);
        const saved = mode === 'incremental' ? core.save(true, true) : core.save(false, false);
        expect(saved.mode).toBe(mode);
        const doc = reopen(saved.bytes);
        expect(doc.countPages()).toBe(5);
        expect(targets(doc, [0, 4])).toEqual({ links: [2, 2, 2], outline: [2, 4] });
        // pdf.js agrees.
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const js = await pdfjs.getDocument({ data: new Uint8Array(saved.bytes.slice(0)) }).promise;
        const outline = await js.getOutline();
        const idx = async (d: unknown) => js.getPageIndex((typeof d === 'string' ? await js.getDestination(d) : (d as unknown[]))![0] as never);
        expect(await idx(outline[0]!.dest)).toBe(2);
        expect(await idx(outline[1]!.dest)).toBe(4);
        const annots0 = await (await js.getPage(1)).getAnnotations();
        for (const a of annots0.filter((x: { subtype: string }) => x.subtype === 'Link')) expect(await idx(a.dest)).toBe(2);
        const annots4 = await (await js.getPage(5)).getAnnotations();
        expect(await idx(annots4.find((x: { subtype: string }) => x.subtype === 'Link').dest)).toBe(2);
        await js.destroy();
        // Undo is not possible after a save, but on a fresh core: cut, undo, save gives the original targets.
        const again = openCore(bytes);
        await again.applyEdits([{ op: 'slice', uids: [uids(again)[2]!], cut: 'vertical', at: 0.5, first }]);
        again.undo();
        await again.applyEdits([{ op: 'rotate', uids: [uids(again)[0]!], degrees: 90 }]);
        expect(targets(reopen(again.save(false, false).bytes), [0, 3])).toEqual({ links: [2, 2, 2], outline: [2, 3] });
      });
    }
  }
});

describe('E2b cut, then Extract / Insert / Replace', () => {
  const { bytes } = buildTree(flat(4));
  const base = shots(reopen(bytes));
  it('extract both halves, each half alone, and the halves in a larger selection', async () => {
    const core = openCore(bytes);
    await core.applyEdits([{ op: 'slice', uids: [uids(core)[1]!], cut: 'vertical', at: 0.5, first: 'left' }]);
    const u = uids(core);
    const both = shots(reopen(core.extract([u[1]!, u[2]!]).bytes));
    expect(both.length).toBe(2);
    expect(halvesProblem(base[1]!, both[0]!, both[1]!, 'vertical', 0.5, 'left')).toBe('');
    const second = shots(reopen(core.extract([u[2]!]).bytes));
    expect(second.length).toBe(1);
    expect(halvesProblem(base[1]!, both[0]!, second[0]!, 'vertical', 0.5, 'left')).toBe('');
    const all = shots(reopen(core.extract(u).bytes));
    expect(all.length).toBe(5);
    expect(same(all[0]!, base[0]!) && same(all[3]!, base[2]!) && same(all[4]!, base[3]!)).toBe(true);
    // The live document is unchanged by the extract.
    const live = shots(reopen(core.save(false, false).bytes));
    expect(halvesProblem(base[1]!, live[1]!, live[2]!, 'vertical', 0.5, 'left')).toBe('');
  });
  it('insert the halves of a saved cut file into another document, cut one again, replace a page by a half', async () => {
    const a = openCore(bytes);
    await a.applyEdits([{ op: 'slice', uids: [uids(a)[1]!], cut: 'vertical', at: 0.5, first: 'right' }]);
    const cutFile = new Uint8Array(a.save(false, false).bytes);
    const cutShots = shots(reopen(cutFile));
    const b = openCore(buildTree(flat(3)).bytes);
    const before = shots(reopen(b.save(false, false).bytes));
    const b2 = openCore(buildTree(flat(3)).bytes);
    const src = b2.attachSource(cutFile.slice(), undefined);
    await b2.applyEdits([{ op: 'insertFrom', afterUid: uids(b2)[0]!, sourceDocId: src.sourceDocId, sourceUids: ['1', '2'] }]);
    let now = shots(reopen(b2.save(false, false).bytes));
    expect(now.length).toBe(5);
    expect(same(now[1]!, cutShots[1]!) && same(now[2]!, cutShots[2]!)).toBe(true);
    expect(halvesProblem(base[1]!, now[1]!, now[2]!, 'vertical', 0.5, 'right')).toBe('');
    // Cut the inserted right half again, top and bottom.
    await b2.applyEdits([{ op: 'slice', uids: [uids(b2)[1]!], cut: 'horizontal', at: 0.5, first: 'left' }]);
    now = shots(reopen(b2.save(false, false).bytes));
    expect(now.length).toBe(6);
    expect(halvesProblem(cutShots[1]!, now[1]!, now[2]!, 'horizontal', 0.5, 'left')).toBe('');
    expect(same(now[3]!, cutShots[2]!)).toBe(true);
    // Replace the last page by the left half of the cut file.
    await b2.applyEdits([{ op: 'replace', uid: uids(b2)[5]!, sourceDocId: src.sourceDocId, sourceUid: '2' }]);
    now = shots(reopen(b2.save(false, false).bytes));
    expect(same(now[5]!, cutShots[2]!)).toBe(true);
    expect(before.length).toBe(3);
  });
});

describe('E2c the saved size after cutting many pages', () => {
  it('60 pages with 40 KB of content each: cut all, save; nothing is written twice', async () => {
    const { bytes } = buildTree(flat(60), 4000);
    const streams = (data: Uint8Array | ArrayBuffer): number => {
      const doc = reopen(data).asPDF()!;
      let n = 0;
      for (let i = 1; i < doc.countObjects(); i++) {
        try {
          if (doc.newIndirect(i).isStream()) n += 1;
        } catch {
          /* free object */
        }
      }
      return n;
    };
    const s0 = bytes.length;
    const n0 = streams(bytes);
    const inc = openCore(bytes);
    await inc.applyEdits([{ op: 'slice', uids: uids(inc), cut: 'vertical', at: 0.5, first: 'left' }]);
    const incSaved = inc.save(true, true);
    const full = openCore(bytes);
    await full.applyEdits([{ op: 'slice', uids: uids(full), cut: 'vertical', at: 0.5, first: 'left' }]);
    const fullSaved = full.save(false, false);
    const extracted = full.extract(uids(full));
    // Twice: cut every half again.
    await full.applyEdits([{ op: 'slice', uids: uids(full), cut: 'horizontal', at: 0.5, first: 'left' }]);
    const fullTwice = full.save(false, false);
    console.log(
      `E2c sizes: original ${s0} bytes (${n0} streams); cut-all incremental ${incSaved.bytes.byteLength} (${incSaved.mode}); cut-all full ${fullSaved.bytes.byteLength} (${streams(fullSaved.bytes)} streams); cut twice full ${fullTwice.bytes.byteLength} (${streams(fullTwice.bytes)} streams); EXTRACT of the 120 halves ${extracted.bytes.byteLength} (${streams(extracted.bytes)} streams)`,
    );
    expect(reopen(fullSaved.bytes).countPages()).toBe(120);
    expect(incSaved.bytes.byteLength).toBeLessThan(s0 + 60 * 2000);
    expect(fullSaved.bytes.byteLength).toBeLessThan(s0 * 1.02 + 60 * 1000);
    expect(streams(fullSaved.bytes)).toBe(n0);
    expect(fullTwice.bytes.byteLength).toBeLessThan(s0 * 1.02 + 240 * 1000);
    expect(streams(fullTwice.bytes)).toBe(n0);
  });
});

describe('E2d replaying an edit log with uid seeds', () => {
  it('same uids and same pages as the live session, with an undone and a cancelled-style discarded step in between', async () => {
    const { bytes } = buildTree(flat(5));
    const live = openCore(bytes);
    const log: Array<{ edits: PageEdit[]; seed: number }> = [];
    const run = async (core: MupdfCore, edits: PageEdit[]) => {
      const r = await core.applyEdits(edits);
      log.push({ edits, seed: r.uidSeed });
    };
    await run(live, [{ op: 'slice', uids: [uids(live)[1]!], cut: 'vertical', at: 0.5, first: 'right' }]);
    await run(live, [{ op: 'duplicate', uids: [uids(live)[2]!] }]);
    // A step that is undone and replaced: the log keeps only what is in the document.
    await live.applyEdits([{ op: 'slice', uids: uids(live), cut: 'horizontal', at: 0.4, first: 'left' }]);
    live.undo();
    await run(live, [{ op: 'slice', uids: [uids(live)[0]!, uids(live)[3]!], cut: 'horizontal', at: 0.6, first: 'left' }]);
    await run(live, [{ op: 'delete', uids: [uids(live)[1]!] }]);
    await run(live, [{ op: 'slice', uids: [uids(live)[1]!], cut: 'vertical', at: 0.3, first: 'left' }]);
    await run(live, [{ op: 'move', uids: [uids(live)[2]!], beforeUid: null }]);
    const replay = openCore(bytes);
    for (const step of log) await replay.applyEdits(step.edits, undefined, step.seed);
    expect(uids(replay)).toEqual(uids(live));
    expect(replay.fingerprints()).toEqual(live.fingerprints());
    const a = shots(reopen(live.save(false, false).bytes));
    const b = shots(reopen(replay.save(false, false).bytes));
    expect(a.length).toBe(b.length);
    expect(a.every((s, i) => same(s, b[i]!))).toBe(true);
  });
});
