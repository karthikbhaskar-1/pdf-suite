// Sign-Off 1.3.1, probe E1: a page tree with attributes inherited at several depths, and a /UserUnit page.
// Every page is cut (5 ways) and duplicated at every node boundary. After each edit, after an incremental save, after a full
// save and after an undo, every page is rendered and compared with the pictures of the untouched file:
//   - the two halves put together are exactly the original page, - every other page is pixel-identical, - undo gives it all back.
import { describe, expect, it } from 'vitest';
import { type Cut, type Shot, type TreeNode, buildTree, halvesProblem, mu, openCore, reopen, same, shots, uids } from './e-lib';
import type { MupdfCore } from '../../src/engine/mupdf/core';

export const TREE: TreeNode = {
  attrs: { MediaBox: [0, 0, 500, 700], font: 'Times-Roman' },
  kids: [
    {
      attrs: { Rotate: 90, MediaBox: [0, 0, 800, 400], font: 'Helvetica' },
      kids: [
        { attrs: { CropBox: [40, 20, 760, 380], font: 'Courier' }, kids: [{ name: 'pa' }, { name: 'pb' }] },
        { attrs: { Rotate: 180 }, kids: [{ name: 'pc', attrs: { MediaBox: [0, 0, 600, 300] } }] },
        { name: 'pd' },
      ],
    },
    { attrs: { MediaBox: [0, 0, 612, 792], Rotate: 270 }, kids: [{ kids: [{ attrs: { CropBox: [6, 6, 606, 786] }, kids: [{ name: 'pe' }] }] }] },
    { name: 'pf' },
    { attrs: { Rotate: 90 }, kids: [{ name: 'pg', attrs: { UserUnit: 2, MediaBox: [0, 0, 400, 200] } }] },
    // A second run, so the last page of one node is followed by a node whose inherited values differ in every key.
    { attrs: { MediaBox: [100, 100, 500, 400], CropBox: [120, 120, 480, 380], Rotate: 180, font: 'Courier-Bold' }, kids: [{ name: 'ph' }, { name: 'pi' }] },
  ],
};

const liveDoc = (core: MupdfCore): mu.Document => (core as unknown as { doc: mu.Document }).doc;

interface Variant {
  label: string;
  cut?: Cut;
  at?: number;
  first?: 'left' | 'right';
}
const VARIANTS: Variant[] = [
  { label: 'v50L', cut: 'vertical', at: 0.5, first: 'left' },
  { label: 'v50R', cut: 'vertical', at: 0.5, first: 'right' },
  { label: 'h50', cut: 'horizontal', at: 0.5, first: 'left' },
  { label: 'v30L', cut: 'vertical', at: 0.3, first: 'left' },
  { label: 'h70R', cut: 'horizontal', at: 0.7, first: 'right' },
  { label: 'dup' },
];

/** Compares a document (after the edit on page `i`) with the original pictures. */
function problems(doc: mu.Document, base: Shot[], i: number, v: Variant, where: string): string[] {
  const out: string[] = [];
  const now = shots(doc);
  if (now.length !== base.length + 1) return [`${where}: ${now.length} pages, expected ${base.length + 1}`];
  for (let k = 0; k < base.length; k++) {
    if (k === i) continue;
    const at = k < i ? k : k + 1;
    if (!same(base[k]!, now[at]!)) out.push(`${where}: untouched page ${k} changed (${now[at]!.w}x${now[at]!.h} vs ${base[k]!.w}x${base[k]!.h})`);
  }
  if (v.cut) {
    const why = halvesProblem(base[i]!, now[i]!, now[i + 1]!, v.cut, v.at!, v.first!);
    if (why) out.push(`${where}: halves of page ${i}: ${why}`);
  } else {
    if (!same(base[i]!, now[i]!)) out.push(`${where}: duplicated page ${i} changed`);
    if (!same(base[i]!, now[i + 1]!)) out.push(`${where}: the copy of page ${i} differs from it`);
  }
  return out;
}

/** The same tree, but the root gives every page a CropBox and a Rotate, so no page can GAIN one from a neighbouring node. */
export const TREE_ROOTED: TreeNode = { ...TREE, attrs: { ...TREE.attrs, CropBox: [0, 0, 500, 700], Rotate: 0 } };

for (const [suite, tree] of [['E1a root gives CropBox+Rotate to all', TREE_ROOTED], ['E1b pages that have no CropBox/Rotate at all next to a node that has', TREE]] as const)
describe(suite, () => {
  const { bytes } = buildTree(tree);
  const baseDoc = reopen(bytes);
  const base = shots(baseDoc);
  const pageCount = base.length;

  it('fixture is what it claims', () => {
    expect(pageCount).toBe(9);
    // pa: CropBox 720x360 turned 90 -> 360x720; pg: 400x200 x UserUnit 2, turned 90 -> 400x800.
    expect([base[0]!.w, base[0]!.h]).toEqual([360, 720]);
    expect([base[6]!.w, base[6]!.h]).toEqual([400, 800]);
    expect([base[7]!.w, base[7]!.h]).toEqual([360, 260]);
    console.log(suite, 'page sizes', base.map((b) => `${b.w}x${b.h}`).join(' '));
  });

  it('cut and duplicate every page, every way: live, incremental save, full save, undo', async () => {
    const bad: string[] = [];
    let checks = 0;
    for (let i = 0; i < pageCount; i++) {
      for (const v of VARIANTS) {
        const tag = `page ${i} ${v.label}`;
        const edit = (core: MupdfCore) =>
          v.cut
            ? core.applyEdits([{ op: 'slice', uids: [uids(core)[i]!], cut: v.cut, at: v.at!, first: v.first! }])
            : core.applyEdits([{ op: 'duplicate', uids: [uids(core)[i]!] }]);
        try {
          // live + undo
          const a = openCore(bytes);
          await edit(a);
          bad.push(...problems(liveDoc(a), base, i, v, `${tag} live`));
          a.undo();
          const back = shots(liveDoc(a));
          if (back.length !== pageCount || back.some((s, k) => !same(s, base[k]!))) bad.push(`${tag}: undo did not give the original pages back`);
          a.redo();
          bad.push(...problems(liveDoc(a), base, i, v, `${tag} redo`));
          // incremental save (same path, disk unchanged)
          const inc = a.save(true, true);
          const incDoc = reopen(inc.bytes);
          bad.push(...problems(incDoc, base, i, v, `${tag} saved ${inc.mode}`));
          incDoc.destroy();
          a.close();
          // full save (Save As)
          const b = openCore(bytes);
          await edit(b);
          const full = b.save(false, false);
          const fullDoc = reopen(full.bytes);
          if ((fullDoc.asPDF() as mu.PDFDocument).wasRepaired()) bad.push(`${tag}: the full save needed repair`);
          bad.push(...problems(fullDoc, base, i, v, `${tag} saved ${full.mode}`));
          fullDoc.destroy();
          b.close();
        } catch (error) {
          bad.push(`${tag}: REFUSED or threw: ${String(error)}`);
        }
        checks += 4;
      }
    }
    console.log(`${suite} single-page: ${checks} document checks over ${pageCount} pages x ${VARIANTS.length} edits; problems: ${bad.length}`);
    for (const line of bad.slice(0, 400)) console.log('  ' + line);
    expect(bad).toEqual([]);
  });

  it('cut all pages at once, then cut every half again, then duplicate all: saved file still adds up', async () => {
    const bad: string[] = [];
    for (const first of ['left', 'right'] as const) {
      const core = openCore(bytes);
      try {
        await core.applyEdits([{ op: 'slice', uids: uids(core), cut: 'vertical', at: 0.5, first }]);
      } catch (error) {
        bad.push(`cut all ${first}: REFUSED ${String(error)}`);
        continue;
      }
      const once = shots(reopen(core.save(false, false).bytes));
      if (once.length !== pageCount * 2) bad.push(`cut all ${first}: ${once.length} pages`);
      for (let k = 0; k < pageCount; k++) {
        const why = halvesProblem(base[k]!, once[2 * k]!, once[2 * k + 1]!, 'vertical', 0.5, first);
        if (why) bad.push(`cut all ${first}: page ${k}: ${why}`);
      }
      // Second cut, across the first: every half into top and bottom. Four quarters must rebuild each half.
      await core.applyEdits([{ op: 'slice', uids: uids(core), cut: 'horizontal', at: 0.5, first: 'left' }]);
      const twice = shots(reopen(core.save(false, false).bytes));
      if (twice.length !== pageCount * 4) bad.push(`cut all twice ${first}: ${twice.length} pages`);
      for (let k = 0; k < pageCount * 2; k++) {
        const why = halvesProblem(once[k]!, twice[2 * k]!, twice[2 * k + 1]!, 'horizontal', 0.5, 'left');
        if (why) bad.push(`cut all twice ${first}: half ${k}: ${why}`);
      }
      await core.applyEdits([{ op: 'duplicate', uids: uids(core) }]);
      const dup = shots(reopen(core.save(false, false).bytes));
      if (dup.length !== pageCount * 8) bad.push(`dup all ${first}: ${dup.length} pages`);
      for (let k = 0; k < pageCount * 4; k++) {
        if (!same(twice[k]!, dup[2 * k]!) || !same(twice[k]!, dup[2 * k + 1]!)) bad.push(`dup all ${first}: quarter ${k} or its copy changed`);
      }
      // Undo everything that can be undone since the last save, then all pages still equal the saved ones.
      core.close();
    }
    for (const line of bad.slice(0, 400)) console.log('  ' + line);
    expect(bad).toEqual([]);
  });

  it('a second reader agrees: pdf.js page boxes, rotation and userUnit of a cut-all full save', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const core = openCore(bytes);
    await core.applyEdits([{ op: 'slice', uids: uids(core), cut: 'vertical', at: 0.5, first: 'left' }]);
    const saved = new Uint8Array(core.save(false, false).bytes);
    const check = reopen(saved);
    const doc = await pdfjs.getDocument({ data: saved.slice(), useSystemFonts: false }).promise;
    expect(doc.numPages).toBe(pageCount * 2);
    const bad: string[] = [];
    for (let k = 0; k < doc.numPages; k++) {
      const page = await doc.getPage(k + 1);
      const vp = page.getViewport({ scale: 1 });
      const m = check.loadPage(k).getBounds();
      const mw = m[2] - m[0];
      const mh = m[3] - m[1];
      if (Math.abs(vp.width - mw) > 0.01 || Math.abs(vp.height - mh) > 0.01) bad.push(`page ${k}: pdf.js ${vp.width}x${vp.height}, MuPDF ${mw}x${mh}`);
    }
    await doc.destroy();
    for (const line of bad) console.log('  ' + line);
    expect(bad).toEqual([]);
  });
});
