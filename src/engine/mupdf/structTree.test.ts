// @vitest-environment node
// Ruling 14: what happens to a tagged PDF's structure tree (/StructTreeRoot, /ParentTree) through page edits and a save.
// Measured 2026-11-10 on tests/engine/corpus/irs-fw9/fw9.pdf (tagged, 6 pages, ParentTree with 29 entries), before ticket 1.5.9:
//   delete     -> the tree was GONE after the edit, and after save and reopen   (tags lost)
//   move       -> the tree was GONE after the edit, and after save and reopen   (tags lost)
//   duplicate  -> the tree was kept, but the copy shared its /StructParents key with the original
// Fixed by 1.5.9 (catalogGuard.ts): these were it.fails and are plain `it` now. The full catalog and prune checks are in
// catalogGuard.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from './editCore';
import { saveOptions } from './saveCore';
import type { PageEdit, PageUid } from './protocol';

const TAGGED = new URL('../../../tests/engine/corpus/irs-fw9/fw9.pdf', import.meta.url);

interface Tags {
  hasTree: boolean;
  hasParentTree: boolean;
  parentTreeEntries: number;
  structParents: (number | null)[];
}

function tagsOf(pdf: mu.PDFDocument): Tags {
  const tree = pdf.getTrailer().get('Root').get('StructTreeRoot');
  if (tree.isNull()) return { hasTree: false, hasParentTree: false, parentTreeEntries: 0, structParents: [] };
  const parent = tree.get('ParentTree');
  const nums = parent.isNull() ? null : parent.get('Nums');
  const structParents: (number | null)[] = [];
  for (let i = 0; i < pdf.countPages(); i++) {
    const value = pdf.findPage(i).get('StructParents');
    structParents.push(value.isNull() ? null : value.asNumber());
  }
  return { hasTree: true, hasParentTree: !parent.isNull(), parentTreeEntries: nums && !nums.isNull() ? nums.length / 2 : 0, structParents };
}

async function editSaveReopen(edit: (uids: PageUid[]) => PageEdit) {
  const doc = mu.Document.openDocument(new Uint8Array(readFileSync(TAGGED)), 'application/pdf');
  const pdf = doc.asPDF()!;
  const core = new EditCore(pdf, doc.countPages(), true);
  const before = tagsOf(pdf);
  await core.apply([edit(core.pages().uids)]);
  const afterEdit = tagsOf(pdf);
  const bytes = pdf.saveToBuffer(saveOptions('full', false)).asUint8Array();
  const reopened = mu.Document.openDocument(new Uint8Array(bytes), 'application/pdf').asPDF()!;
  return { before, afterEdit, afterSave: tagsOf(reopened), pages: core.pageCount, savedPages: reopened.countPages() };
}

// fw9.pdf is not redistributable: download it with scripts/download-test-corpus.mjs. Without it these tests are skipped.
describe.skipIf(!existsSync(TAGGED))('tagged PDF structure tree through edits (needs corpus fw9.pdf)', () => {
  it('the fixture is tagged', async () => {
    const doc = mu.Document.openDocument(new Uint8Array(readFileSync(TAGGED)), 'application/pdf').asPDF()!;
    const tags = tagsOf(doc);
    expect(tags.hasTree).toBe(true);
    expect(tags.hasParentTree).toBe(true);
    expect(tags.parentTreeEntries).toBeGreaterThan(0);
  });

  it('delete keeps the structure tree, through save and reopen', async () => {
    const r = await editSaveReopen((u) => ({ op: 'delete', uids: [u[1]!] }));
    expect(r.savedPages).toBe(r.pages);
    expect(r.afterEdit.hasTree).toBe(true);
    expect(r.afterSave.hasTree).toBe(true);
    expect(r.afterSave.hasParentTree).toBe(true);
  });

  it('move keeps the structure tree, through save and reopen', async () => {
    const r = await editSaveReopen((u) => ({ op: 'move', uids: [u[0]!], beforeUid: null }));
    expect(r.savedPages).toBe(r.pages);
    expect(r.afterEdit.hasTree).toBe(true);
    expect(r.afterSave.hasTree).toBe(true);
    expect(r.afterSave.hasParentTree).toBe(true);
  });

  it('duplicate keeps the structure tree through save and reopen', async () => {
    const r = await editSaveReopen((u) => ({ op: 'duplicate', uids: [u[0]!] }));
    expect(r.savedPages).toBe(r.pages);
    expect(r.afterSave.hasTree).toBe(true);
    expect(r.afterSave.hasParentTree).toBe(true);
    expect(r.afterSave.parentTreeEntries).toBe(r.before.parentTreeEntries);
  });

  it('a duplicated page never shares a /StructParents key with another page', async () => {
    const r = await editSaveReopen((u) => ({ op: 'duplicate', uids: [u[0]!] }));
    const keys = r.afterSave.structParents.filter((k) => k !== null);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
