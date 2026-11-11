// @vitest-environment node
// Ticket 1.5.9: the catalog and the accessibility tags survive Delete, Move, Reverse and Duplicate, through Undo, Redo, save and
// recovery replay. Ruling: docs/milestone-1.5/structtree-ruling.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from './editCore';
import { saveOptions } from './saveCore';
import { shiftedLabelRanges } from './catalogGuard';
import type { PageEdit, PageUid } from './protocol';
import { EditLog, parseEditLog, replayLog, type LogPort } from '../../features/recovery/editLog';

const CORPUS = new URL('../../../tests/engine/corpus/', import.meta.url);
const FW9 = new URL('irs-fw9/fw9.pdf', CORPUS);
// The corpus PDFs are not redistributable (scripts/download-test-corpus.mjs). The tests that need them are skipped when absent.
const HAVE_CORPUS = existsSync(FW9);
const env = { mu, sources: new Map<string, mu.PDFDocument>() };

// ---- Helpers -------------------------------------------------------------------------------------------------------

/** The documents opened by the current test. They are freed after it: the WASM heap does not hold dozens of image-heavy files. */
let opened: mu.Document[] = [];
afterEach(() => {
  for (const doc of opened) doc.destroy();
  opened = [];
});

function open(bytes: Uint8Array): mu.PDFDocument | null {
  let doc: mu.Document | null = null;
  try {
    doc = mu.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
    opened.push(doc);
    if (doc.needsPassword()) return null;
    const pdf = doc.asPDF();
    return pdf && pdf.countPages() > 0 ? pdf : null;
  } catch {
    return null;
  }
}

function save(pdf: mu.PDFDocument): Uint8Array {
  return pdf.saveToBuffer(saveOptions('full', false)).asUint8Array().slice();
}

function keysOf(dict: mu.PDFObject): string[] {
  const keys: string[] = [];
  dict.forEach((_v, k) => keys.push(String(k)));
  return keys;
}

function rootKeys(pdf: mu.PDFDocument): string[] {
  return keysOf(pdf.getTrailer().get('Root')).sort();
}

function entry(dict: mu.PDFObject, key: string): mu.PDFObject | undefined {
  return keysOf(dict).includes(key) ? dict.get(key) : undefined;
}

/** Every key of the catalog with the object number of its value (or the text of a direct value). */
function catalogMap(pdf: mu.PDFDocument): Record<string, string> {
  const root = pdf.getTrailer().get('Root');
  const out: Record<string, string> = {};
  root.forEach((value, key) => {
    out[String(key)] = value.isIndirect() ? `${value.asIndirect()} R` : value.toString(true);
  });
  return out;
}

/** Everything reachable from the catalog: object number -> text of the object (a stream's own dictionary only). */
function reachable(pdf: mu.PDFDocument): Map<number, string> {
  const out = new Map<number, string>();
  const todo = [pdf.getTrailer().get('Root').asIndirect()];
  while (todo.length > 0) {
    const num = todo.pop()!;
    if (out.has(num)) continue;
    let text: string;
    try {
      text = pdf.newIndirect(num).resolve().toString(true);
    } catch {
      continue;
    }
    out.set(num, text);
    for (const m of text.matchAll(/(\d+) 0 R/g)) todo.push(Number(m[1]));
  }
  return out;
}

function sameObjects(a: Map<number, string>, b: Map<number, string>): void {
  expect([...b.keys()].sort((x, y) => x - y)).toEqual([...a.keys()].sort((x, y) => x - y));
  for (const [num, text] of a) expect(b.get(num), `object ${num}`).toBe(text);
}

/** The number of page objects (/Type /Page) in the file, whether or not the page tree reaches them. */
function pageObjectCount(pdf: mu.PDFDocument): number {
  let count = 0;
  for (let i = 1; i < pdf.countObjects(); i++) {
    try {
      const obj = pdf.newIndirect(i).resolve();
      if (!obj.isDictionary()) continue;
      const type = entry(obj, 'Type');
      if (type && type.isName() && type.asName() === 'Page') count++;
    } catch {
      /* a free or unreadable slot */
    }
  }
  return count;
}

/** Object numbers of the form fields at the leaves of /AcroForm /Fields. */
function fieldLeaves(pdf: mu.PDFDocument): Set<number> {
  const acro = entry(pdf.getTrailer().get('Root'), 'AcroForm')?.resolve();
  const out = new Set<number>();
  const fields = acro && acro.isDictionary() ? entry(acro, 'Fields')?.resolve() : undefined;
  if (!fields || !fields.isArray()) return out;
  const seen = new Set<number>();
  const walk = (list: mu.PDFObject): void => {
    for (let i = 0; i < list.length; i++) {
      const ref = list.get(i);
      const id = ref.isIndirect() ? ref.asIndirect() : -1;
      if (id >= 0) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const dict = ref.resolve();
      const kids = dict.isDictionary() ? entry(dict, 'Kids')?.resolve() : undefined;
      if (kids && kids.isArray() && kids.length > 0) walk(kids);
      else if (id >= 0) out.add(id);
    }
  };
  walk(fields);
  return out;
}

/** Object numbers of the widget annotations on the pages. */
function pageWidgets(pdf: mu.PDFDocument): Set<number> {
  const out = new Set<number>();
  for (let p = 0; p < pdf.countPages(); p++) {
    const annots = entry(pdf.findPage(p), 'Annots')?.resolve();
    if (!annots || !annots.isArray()) continue;
    for (let i = 0; i < annots.length; i++) {
      const ref = annots.get(i);
      const dict = ref.resolve();
      const sub = dict.isDictionary() ? entry(dict, 'Subtype') : undefined;
      if (ref.isIndirect() && sub && sub.isName() && sub.asName() === 'Widget') out.add(ref.asIndirect());
    }
  }
  return out;
}

/** Fills the first writable text field of the document and reads it back: 'filled', 'failed', or 'none' when there is no such field. */
function fillForm(pdf: mu.PDFDocument): 'filled' | 'failed' | 'none' {
  for (let p = 0; p < pdf.countPages(); p++) {
    for (const widget of pdf.loadPage(p).getWidgets()) {
      if (widget.getFieldType() !== 'text' || widget.isReadOnly()) continue;
      widget.setTextValue('probe');
      return widget.getValue() === 'probe' ? 'filled' : 'failed';
    }
  }
  return 'none';
}

/** Page edits by position, applied to a fresh EditCore. */
type EditMaker = (uids: PageUid[]) => PageEdit;
const OPS: Record<string, { needs: number; make: EditMaker }> = {
  'delete first': { needs: 2, make: (u) => ({ op: 'delete', uids: [u[0]!] }) },
  'delete middle': { needs: 3, make: (u) => ({ op: 'delete', uids: [u[Math.floor(u.length / 2)]!] }) },
  'delete last': { needs: 2, make: (u) => ({ op: 'delete', uids: [u[u.length - 1]!] }) },
  'delete all but the first': { needs: 2, make: (u) => ({ op: 'delete', uids: u.slice(1) }) },
  'move first to end': { needs: 2, make: (u) => ({ op: 'move', uids: [u[0]!], beforeUid: null }) },
  reverse: { needs: 2, make: (u) => ({ op: 'reverse', uids: u }) },
  'duplicate first': { needs: 1, make: (u) => ({ op: 'duplicate', uids: [u[0]!] }) },
};

/**
 * Catalog keys an edit may legitimately remove. MuPDF itself removes /Outlines when no bookmark is left (all four of Delete,
 * Move, Reverse and Duplicate keep it otherwise), and a Delete removes /OpenAction when it opens on a deleted page. Nothing
 * else: page labels, threads and old-style destinations are pruned inside their key, and the key stays.
 */
function mayLose(opName: string): Set<string> {
  return opName.startsWith('delete') ? new Set(['Outlines', 'OpenAction']) : new Set();
}

interface CorpusFile {
  name: string;
  bytes: Uint8Array;
  pages: number;
}

const FIXTURES = new URL('../../../tests/fixtures/out/', import.meta.url);

/** Every PDF of the engine corpus and of the generated fixtures (tests/fixtures/make-fixtures.mjs), and the ones built here. */
function corpusFiles(): { files: CorpusFile[]; dropped: string[] } {
  const files: CorpusFile[] = [];
  const dropped: string[] = [];
  const add = (name: string, bytes: Uint8Array): void => {
    const pdf = open(bytes);
    if (pdf === null) dropped.push(name);
    else files.push({ name, bytes, pages: pdf.countPages() });
    for (const doc of opened) doc.destroy();
    opened = [];
  };
  const walk = (path: string, rel: string): void => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full, `${rel}${name}/`);
      else if (name.endsWith('.pdf')) add(`${rel}${name}`, new Uint8Array(readFileSync(full)));
    }
  };
  for (const [url, prefix] of [[CORPUS, ''], [FIXTURES, 'fixtures/']] as const) {
    const dir = url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
    if (existsSync(dir)) walk(dir, prefix);
  }
  // The corpus has one multi-page tagged file (fw9). These are built with MuPDF: a six-page tagged file with a nested
  // ParentTree, and a four-page form.
  add('generated/tagged-6.pdf', save(taggedDoc().pdf));
  add('generated/form-4.pdf', save(pdfWithForm()));
  return { files, dropped };
}

const CORPUS_FILES = corpusFiles();
const FILES = CORPUS_FILES.files;
/** Files the loops cannot open as a plain PDF: a password, no pages, or not a PDF. Listed so a new corpus file is noticed. */
const EXPECTED_DROPPED = [
  'derived/aes256-locked.pdf',
  'derived/truncated-half.pdf',
  'fixtures/empty.pdf',
  'fixtures/locked.pdf',
  'fixtures/png-renamed.pdf',
  'fixtures/truncated.pdf',
];
/** The edits that need more pages than a file has, in the order the loop meets them. A change here is a decision, not an accident. */
const oneSkips = (name: string): string[] =>
  ['delete first', 'delete middle', 'delete last', 'delete all but the first', 'move first to end', 'reverse'].map((op) => `${name}: ${op}`);
const EXPECTED_SKIPS = [
  'derived/letter-spaced.pdf: delete middle',
  ...oneSkips('images-misc/images.pdf'),
  ...oneSkips('scanned-gray/perf_images_scan_gray.pdf'),
  ...oneSkips('xfa/xfa_filled_imm1344e.pdf'),
  'fixtures/margins-white.pdf: delete middle',
  ...oneSkips('fixtures/search-align.pdf'),
];
/** Files whose form has text fields, so a fill must work after an edit that leaves a widget on a page. */
const MUST_FILL = new Set(['irs-fw9/fw9.pdf', 'generated/form-4.pdf']);

// ---- The invariants, over the corpus -------------------------------------------------------------------------------

describe('catalog and tags through page edits: every corpus file, every edit', () => {
  it.skipIf(!HAVE_CORPUS)('has a corpus to run over, and drops exactly the files that cannot be opened (needs the corpus)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(6);
    expect(FILES.some((f) => f.name.includes('fw9'))).toBe(true);
    expect(CORPUS_FILES.dropped.sort()).toEqual(EXPECTED_DROPPED);
  });

  it.skipIf(!HAVE_CORPUS)('runs every edit on a tagged multi-page file besides fw9 (needs corpus fw9.pdf)', () => {
    const tagged = FILES.filter((f) => f.pages >= 3 && rootKeys(open(f.bytes)!).includes('StructTreeRoot'));
    expect(tagged.map((f) => f.name)).toEqual(expect.arrayContaining(['irs-fw9/fw9.pdf', 'generated/tagged-6.pdf']));
  });

  for (const file of FILES) {
    for (const [opName, op] of Object.entries(OPS)) {
      const skip = file.pages < op.needs;
      it.skipIf(skip)(`${file.name}: ${opName}${skip ? ` (skipped: the file has ${file.pages} page${file.pages === 1 ? '' : 's'}, the edit needs ${op.needs})` : ''}`, async () => {
        const pdf = open(file.bytes)!;
        const pages = pdf.countPages();
        const core = new EditCore(pdf, pages, true, env);
        const keysBefore = rootKeys(pdf);
        const baseline = reachable(pdf);
        const widgetsBefore = pageWidgets(pdf);
        const leavesBefore = fieldLeaves(pdf);
        const tagged = keysBefore.includes('StructTreeRoot');

        await core.apply([op.make(core.pages().uids)]);
        const afterEdit = reachable(pdf);

        // 1. The catalog keeps every key it had, except what the edit legitimately changes.
        const lost = keysBefore.filter((k) => !rootKeys(pdf).includes(k) && !mayLose(opName).has(k));
        expect(lost, 'catalog keys lost').toEqual([]);

        // 2. Form fields: the fields of the pages that stay are still in the form, and one fills.
        const leavesAfter = fieldLeaves(pdf);
        const widgetsAfter = pageWidgets(pdf);
        const expected = new Set([...leavesBefore].filter((n) => !widgetsBefore.has(n) || widgetsAfter.has(n)));
        if (opName.startsWith('duplicate')) {
          // The copy's own widgets join the form; every field that was there stays.
          for (const n of expected) expect(leavesAfter.has(n), `field ${n}`).toBe(true);
        } else {
          expect([...leavesAfter].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
        }

        // 4. Undo gives back the catalog and everything under it exactly; Redo gives back the edit.
        const catalogEdited = catalogMap(pdf);
        core.undo();
        sameObjects(baseline, reachable(pdf));
        expect(rootKeys(pdf)).toEqual(keysBefore);
        core.redo();
        sameObjects(afterEdit, reachable(pdf));
        expect(catalogMap(pdf)).toEqual(catalogEdited);
        core.undo();
        sameObjects(baseline, reachable(pdf));
        core.redo();

        // 3. (a save cannot be undone in MuPDF, so it comes last) Save and reopen: the same keys, and no object of a deleted page.
        const reopened = open(save(pdf))!;
        expect(reopened.countPages()).toBe(pdf.countPages());
        expect(pageObjectCount(reopened)).toBe(reopened.countPages());
        const savedLost = keysBefore.filter((k) => !rootKeys(reopened).includes(k) && !mayLose(opName).has(k));
        expect(savedLost, 'catalog keys lost after save').toEqual([]);
        if (tagged) expect(rootKeys(reopened)).toContain('StructTreeRoot');
        const fill = fillForm(reopened);
        expect(fill).not.toBe('failed');
        if (MUST_FILL.has(file.name) && widgetsAfter.size > 0) expect(fill, 'a form with a widget left must fill').toBe('filled');
      });
    }
  }

  it.skipIf(!HAVE_CORPUS)('skips exactly the edits a file has too few pages for (needs the corpus)', () => {
    const skipped = FILES.flatMap((f) => Object.entries(OPS).filter(([, op]) => f.pages < op.needs).map(([name]) => `${f.name}: ${name}`));
    expect(skipped).toEqual(EXPECTED_SKIPS);
  });
});

describe('the recovery log replays these edits to the same catalog', () => {
  const KEY = 'c'.repeat(64);
  const memory = () => {
    const logs = new Map<string, string>();
    const port: LogPort = {
      write: async (key, text) => void logs.set(key, text),
      writeStash: async () => undefined,
      clear: async (key) => void logs.delete(key),
    };
    return { logs, port };
  };

  // Every file but the 1,000-page one (too slow to replay here): a copy, a second copy, a delete, a move and a reverse, which
  // works from one page up, so the form-heavy one-page xfa file is replayed too.
  const REPLAY_MAX_PAGES = 50;
  for (const file of FILES) {
    const skip = file.pages > REPLAY_MAX_PAGES;
    it.skipIf(skip)(`${file.name}: duplicate, duplicate, delete, move and reverse in one session replay onto the base file${skip ? ` (skipped: ${file.pages} pages)` : ''}`, async () => {
      const live = open(file.bytes)!;
      const pages = live.countPages();
      const liveCore = new EditCore(live, pages, true, env);
      const { logs, port } = memory();
      const log = new EditLog(KEY, 'C:/docs/x.pdf', { size: 1, modified: 2 }, port);
      const makers: EditMaker[] = [
        (u) => ({ op: 'duplicate', uids: [u[0]!] }),
        (u) => ({ op: 'duplicate', uids: [u[0]!] }),
        (u) => ({ op: 'delete', uids: [u[1]!] }),
        (u) => ({ op: 'move', uids: [u[0]!], beforeUid: null }),
        (u) => ({ op: 'reverse', uids: u }),
      ];
      const baseline = reachable(open(file.bytes)!);
      for (const make of makers) {
        const step = [make(liveCore.pages().uids)];
        log.record(step, (await liveCore.apply(step)).uidSeed);
      }
      await log.flush();
      const parsed = parseEditLog(logs.get(KEY)!)!;
      const replayed = open(file.bytes)!;
      const replayCore = new EditCore(replayed, pages, true, env);
      const result = await replayLog(parsed, async () => null, {
        attachSource: async () => 'unused',
        applyStep: async (edits, seed) => void (await replayCore.apply(edits, undefined, seed)),
        undoStep: async () => replayCore.undo(),
      });
      expect(result.applied).toBe(5);
      expect(replayCore.pages().uids).toEqual(liveCore.pages().uids);
      expect(catalogMap(replayed)).toEqual(catalogMap(live));
      sameObjects(reachable(live), reachable(replayed));
      const lostKeys = rootKeys(open(file.bytes)!).filter((k) => !rootKeys(replayed).includes(k));
      expect(lostKeys.filter((k) => k !== 'Outlines' && k !== 'OpenAction')).toEqual([]);
      // Each replayed step undoes on its own, back to the base file's catalog.
      for (let i = 0; i < 5; i++) replayCore.undo();
      sameObjects(baseline, reachable(replayed));
    });
  }

  it('replays every file it can open except the ones with more than 50 pages', () => {
    expect(FILES.filter((f) => f.pages > REPLAY_MAX_PAGES).map((f) => f.name)).toEqual(['fixtures/big-1000.pdf']);
  });
});

// ---- fw9: sizes and the prune --------------------------------------------------------------------------------------

describe.skipIf(!HAVE_CORPUS)('fw9: the form, the tags and the file size through a delete', () => {
  const bytes = existsSync(FW9) ? new Uint8Array(readFileSync(FW9)) : new Uint8Array();

  async function deleteAndSave(index: number | number[]) {
    const pdf = open(bytes)!;
    const core = new EditCore(pdf, pdf.countPages(), true, env);
    const uids = core.pages().uids;
    const list = Array.isArray(index) ? index : [index];
    await core.apply([{ op: 'delete', uids: list.map((i) => uids[i]!) }]);
    const saved = save(pdf);
    return { saved, reopened: open(saved)!, edited: pdf };
  }

  function treeStats(pdf: mu.PDFDocument) {
    const tree = entry(pdf.getTrailer().get('Root'), 'StructTreeRoot')!.resolve();
    const nums = entry(tree.get('ParentTree').resolve(), 'Nums')!.resolve();
    return { tree, entries: nums.length / 2 };
  }

  it('deleting page 2 keeps the form, the metadata, the language and the tags, and no page object of page 2', async () => {
    const before = open(bytes)!;
    const r = await deleteAndSave(1);
    expect(r.reopened.countPages()).toBe(5);
    expect(pageObjectCount(r.reopened)).toBe(5);
    for (const key of ['AcroForm', 'Metadata', 'Lang', 'MarkInfo', 'Names', 'ViewerPreferences', 'Perms', 'StructTreeRoot', 'Extensions']) {
      expect(rootKeys(r.reopened), key).toContain(key);
    }
    expect(fieldLeaves(r.reopened).size).toBe(fieldLeaves(before).size);
    expect(treeStats(r.reopened).entries).toBeLessThan(treeStats(before).entries);
    expect(fillForm(r.reopened)).toBe('filled');
    // The saved file keeps most of its size (the ruling measured 224,740 before and 209,837 for the pruned delete; the
    // unfixed delete wrote 66,811).
    expect(r.saved.length).toBeGreaterThan(150_000);
    console.info(`[fw9] before ${save(before).length} bytes; delete page 2 -> ${r.saved.length} bytes, ${pageObjectCount(r.reopened)} page objects for ${r.reopened.countPages()} pages`);
  });

  it("deleting page 1 (the 23 form widgets) takes their fields out of the form and keeps the other tags", async () => {
    const before = open(bytes)!;
    const r = await deleteAndSave(0);
    expect(pageObjectCount(r.reopened)).toBe(5);
    expect(fieldLeaves(r.reopened).size).toBeLessThan(fieldLeaves(before).size);
    // All 23 widgets were on page 1, so no field is left (and the assertion below is not vacuous for page 2).
    expect(fieldLeaves(before).size).toBe(23);
    expect(fieldLeaves(r.reopened).size).toBe(0);
    expect(rootKeys(r.reopened)).toContain('StructTreeRoot');
    console.info(`[fw9] delete page 1 -> ${r.saved.length} bytes, ${fieldLeaves(before).size} -> ${fieldLeaves(r.reopened).size} fields`);
  });

  it('deleting page 2 leaves every field in the form, each with its widget on a page that is still there', async () => {
    const before = open(bytes)!;
    const r = await deleteAndSave(1);
    const leaves = fieldLeaves(r.reopened);
    expect(leaves.size).toBe(fieldLeaves(before).size);
    expect(leaves.size).toBeGreaterThan(0);
    const widgets = pageWidgets(r.reopened);
    for (const field of leaves) expect(widgets.has(field), `field ${field}`).toBe(true);
  });

  it('deleting pages 2 to 6 leaves one page, one page object and a tree that is not empty', async () => {
    const r = await deleteAndSave([1, 2, 3, 4, 5]);
    expect(r.reopened.countPages()).toBe(1);
    expect(pageObjectCount(r.reopened)).toBe(1);
    expect(rootKeys(r.reopened)).toContain('StructTreeRoot');
    expect(treeStats(r.reopened).entries).toBeGreaterThan(0);
  });

  it('a duplicate has no /StructParents and its annotations have no /StructParent', async () => {
    const pdf = open(bytes)!;
    const core = new EditCore(pdf, pdf.countPages(), true, env);
    await core.apply([{ op: 'duplicate', uids: [core.pages().uids[0]!] }]);
    const original = pdf.findPage(0);
    const copy = pdf.findPage(1);
    expect(entry(original, 'StructParents')).toBeDefined();
    expect(entry(copy, 'StructParents')).toBeUndefined();
    const annots = entry(copy, 'Annots')!.resolve();
    expect(annots.length).toBeGreaterThan(0);
    for (let i = 0; i < annots.length; i++) expect(entry(annots.get(i).resolve(), 'StructParent')).toBeUndefined();
    // The original's annotations keep theirs.
    const originals = entry(original, 'Annots')!.resolve();
    let withKey = 0;
    for (let i = 0; i < originals.length; i++) if (entry(originals.get(i).resolve(), 'StructParent')) withKey++;
    expect(withKey).toBeGreaterThan(0);
  });
});

// ---- Hand-built trees ----------------------------------------------------------------------------------------------

/** Six pages with a hand-made structure tree: a nested ParentTree (/Kids with limits), marked-content references that carry their
 * own /Pg, an object reference to an annotation, and an element nested in a section that only has content on page 3. */
function taggedDoc(): { pdf: mu.PDFDocument; pageNums: number[] } {
  const pdf = new mu.PDFDocument();
  const pageNums: number[] = [];
  for (let i = 0; i < 6; i++) {
    const page = pdf.addPage([0, 0, 200, 200], 0, {}, `${10 + i} 10 20 20 re f`);
    pdf.insertPage(-1, page);
    pageNums.push(page.asIndirect());
  }
  const ref = (n: number) => pdf.newIndirect(n);
  const dict = (props: Record<string, unknown>) => {
    const d = pdf.newDictionary();
    for (const [k, v] of Object.entries(props)) d.put(k, v as never);
    return d;
  };
  const arr = (...items: unknown[]) => {
    const a = pdf.newArray();
    for (const item of items) a.push(item as never);
    return a;
  };
  const treeRoot = pdf.addObject(dict({ Type: pdf.newName('StructTreeRoot') }));
  const docElem = pdf.addObject(dict({ Type: pdf.newName('StructElem'), S: pdf.newName('Document'), P: treeRoot }));
  const paras = pageNums.map((n) =>
    pdf.addObject(dict({ Type: pdf.newName('StructElem'), S: pdf.newName('P'), P: docElem, Pg: ref(n), K: pdf.newInteger(0) })),
  );
  // A section with marked content on page 2 and page 5, each through an MCR with its own /Pg.
  const mcr = (n: number, mcid: number) => dict({ Type: pdf.newName('MCR'), Pg: ref(n), MCID: pdf.newInteger(mcid) });
  const mixed = pdf.addObject(
    dict({ Type: pdf.newName('StructElem'), S: pdf.newName('Sect'), P: docElem, K: arr(mcr(pageNums[1]!, 1), mcr(pageNums[4]!, 1)) }),
  );
  // A link on page 3 with an annotation, reached through an OBJR; and a section that holds only an element of page 3.
  const annot = pdf.addObject(
    dict({ Type: pdf.newName('Annot'), Subtype: pdf.newName('Link'), Rect: arr(pdf.newInteger(0), pdf.newInteger(0), pdf.newInteger(10), pdf.newInteger(10)), StructParent: pdf.newInteger(100) }),
  );
  pdf.findPage(2).put('Annots', arr(annot));
  const link = pdf.addObject(
    dict({ Type: pdf.newName('StructElem'), S: pdf.newName('Link'), P: docElem, Pg: ref(pageNums[2]!), K: dict({ Type: pdf.newName('OBJR'), Pg: ref(pageNums[2]!), Obj: annot }) }),
  );
  const inner = pdf.addObject(
    dict({ Type: pdf.newName('StructElem'), S: pdf.newName('P'), Pg: ref(pageNums[2]!), K: pdf.newInteger(2) }),
  );
  const outer = pdf.addObject(dict({ Type: pdf.newName('StructElem'), S: pdf.newName('Sect'), P: docElem, K: arr(inner) }));
  inner.resolve().put('P', outer);
  docElem.resolve().put('K', arr(...paras, mixed, link, outer));
  treeRoot.resolve().put('K', docElem);
  for (let i = 0; i < 6; i++) pdf.findPage(i).put('StructParents', pdf.newInteger(i));
  // ParentTree: two leaves under a root with /Kids. Page 2 (position 1) also owns the mixed section at MCID 1.
  const leafA = pdf.addObject(
    dict({ Limits: arr(pdf.newInteger(0), pdf.newInteger(2)), Nums: arr(pdf.newInteger(0), arr(paras[0]), pdf.newInteger(1), arr(paras[1], mixed), pdf.newInteger(2), arr(paras[2], null as never, inner)) }),
  );
  const leafB = pdf.addObject(
    dict({
      Limits: arr(pdf.newInteger(3), pdf.newInteger(100)),
      Nums: arr(pdf.newInteger(3), arr(paras[3]), pdf.newInteger(4), arr(paras[4], mixed), pdf.newInteger(5), arr(paras[5]), pdf.newInteger(100), link),
    }),
  );
  treeRoot.resolve().put('ParentTree', pdf.addObject(dict({ Kids: arr(leafA, leafB) })));
  const root = pdf.getTrailer().get('Root');
  root.put('StructTreeRoot', treeRoot);
  root.put('MarkInfo', dict({ Marked: pdf.newBoolean(true) }));
  root.put('Lang', pdf.newString('en-US'));
  return { pdf, pageNums };
}

function parentTreeKeys(pdf: mu.PDFDocument): number[] {
  const tree = entry(pdf.getTrailer().get('Root'), 'StructTreeRoot')!.resolve();
  const out: number[] = [];
  const walk = (node: mu.PDFObject) => {
    const d = node.resolve();
    const nums = entry(d, 'Nums')?.resolve();
    if (nums && nums.isArray()) for (let i = 0; i < nums.length; i += 2) out.push(nums.get(i).asNumber());
    const kids = entry(d, 'Kids')?.resolve();
    if (kids && kids.isArray()) for (let i = 0; i < kids.length; i++) walk(kids.get(i));
  };
  walk(tree.get('ParentTree'));
  return out.sort((a, b) => a - b);
}

/** All structure elements reachable from the tree's /K, as `S` names, with the number of kids each has. */
function elementsOf(pdf: mu.PDFDocument): Array<{ s: string; kids: number }> {
  const tree = entry(pdf.getTrailer().get('Root'), 'StructTreeRoot')!.resolve();
  const out: Array<{ s: string; kids: number }> = [];
  const visit = (node: mu.PDFObject) => {
    const d = node.resolve();
    if (!d.isDictionary()) return;
    const type = entry(d, 'Type');
    if (type && type.asName() === 'MCR') return;
    if (type && type.asName() === 'OBJR') return;
    const k = entry(d, 'K')?.resolve();
    const kids = k === undefined ? [] : k.isArray() ? Array.from({ length: k.length }, (_v, i) => k.get(i)) : [k];
    out.push({ s: entry(d, 'S')?.asName() ?? '?', kids: kids.length });
    for (const kid of kids) if (kid.resolve().isDictionary()) visit(kid);
  };
  visit(tree.get('K'));
  return out;
}

describe('the structure prune on a hand-built tree (nested ParentTree, MCR with its own /Pg, OBJR, nested parents)', () => {
  it('the fixture is what the tests below assume', () => {
    const { pdf } = taggedDoc();
    expect(parentTreeKeys(pdf)).toEqual([0, 1, 2, 3, 4, 5, 100]);
    expect(pageObjectCount(pdf)).toBe(6);
    expect(elementsOf(pdf).length).toBe(1 + 6 + 1 + 1 + 1 + 1);
  });

  it('deleting page 3 removes its keys, its elements, its annotation reference and the sections it emptied, and its page object', async () => {
    const { pdf } = taggedDoc();
    const core = new EditCore(pdf, 6, true, env);
    await core.apply([{ op: 'delete', uids: [core.pages().uids[2]!] }]);
    expect(parentTreeKeys(pdf)).toEqual([0, 1, 3, 4, 5]);
    // Document, 5 paragraphs, the mixed section: the link and the outer section (with its inner paragraph) are gone.
    expect(elementsOf(pdf).map((e) => e.s).sort()).toEqual(['Document', 'P', 'P', 'P', 'P', 'P', 'Sect']);
    const reopened = open(save(pdf))!;
    expect(reopened.countPages()).toBe(5);
    expect(pageObjectCount(reopened)).toBe(5);
    expect(parentTreeKeys(reopened)).toEqual([0, 1, 3, 4, 5]);
    expect(rootKeys(reopened)).toEqual(expect.arrayContaining(['StructTreeRoot', 'MarkInfo', 'Lang']));
  });

  it('deleting page 2 keeps the section that also has content on page 5, with one reference left', async () => {
    const { pdf } = taggedDoc();
    const core = new EditCore(pdf, 6, true, env);
    await core.apply([{ op: 'delete', uids: [core.pages().uids[1]!] }]);
    const sections = elementsOf(pdf).filter((e) => e.s === 'Sect');
    expect(sections.map((s) => s.kids).sort()).toEqual([1, 1]); // the mixed section (one MCR) and the outer one (inner paragraph)
    expect(parentTreeKeys(pdf)).toEqual([0, 2, 3, 4, 5, 100]);
    expect(pageObjectCount(open(save(pdf))!)).toBe(5);
  });

  it('Undo of the prune restores the tree exactly; Redo prunes again; replaying gives the same', async () => {
    const { pdf } = taggedDoc();
    const baseline = reachable(pdf);
    const core = new EditCore(pdf, 6, true, env);
    await core.apply([{ op: 'delete', uids: [core.pages().uids[2]!] }]);
    const pruned = reachable(pdf);
    core.undo();
    sameObjects(baseline, reachable(pdf));
    expect(parentTreeKeys(pdf)).toEqual([0, 1, 2, 3, 4, 5, 100]);
    core.redo();
    sameObjects(pruned, reachable(pdf));
    const { pdf: twin } = taggedDoc();
    const twinCore = new EditCore(twin, 6, true, env);
    await twinCore.apply([{ op: 'delete', uids: [twinCore.pages().uids[2]!] }]);
    sameObjects(pruned, reachable(twin));
  });

  it('Move and Reverse leave every element and ParentTree entry alone', async () => {
    const { pdf } = taggedDoc();
    const core = new EditCore(pdf, 6, true, env);
    const keys = parentTreeKeys(pdf);
    const elements = elementsOf(pdf);
    await core.apply([{ op: 'reverse', uids: core.pages().uids }]);
    await core.apply([{ op: 'move', uids: [core.pages().uids[0]!], beforeUid: null }]);
    expect(parentTreeKeys(pdf)).toEqual(keys);
    expect(elementsOf(pdf)).toEqual(elements);
    expect(pageObjectCount(open(save(pdf))!)).toBe(6);
  });
});

// ---- Form fields, page labels, open action, name trees ---------------------------------------------------------------

function pdfWithForm(): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  const fields = pdf.newArray();
  for (let i = 0; i < 4; i++) {
    const page = pdf.addPage([0, 0, 200, 200], 0, {}, '0 g');
    pdf.insertPage(-1, page);
    const annots = pdf.newArray();
    // One text field per page, plus a field with two widgets (a kid on page 1 and one on page 2).
    const widget = pdf.newDictionary();
    widget.put('Type', pdf.newName('Annot'));
    widget.put('Subtype', pdf.newName('Widget'));
    widget.put('FT', pdf.newName('Tx'));
    widget.put('T', pdf.newString(`f${i}`));
    const r = pdf.newArray();
    for (const v of [10, 10, 100, 30]) r.push(pdf.newInteger(v));
    widget.put('Rect', r);
    widget.put('P', page);
    const w = pdf.addObject(widget);
    annots.push(w);
    fields.push(w);
    pdf.findPage(i).put('Annots', annots);
  }
  const acro = pdf.newDictionary();
  acro.put('Fields', fields);
  pdf.getTrailer().get('Root').put('AcroForm', acro);
  return pdf;
}

describe('form fields', () => {
  it('deleting a page takes its fields out of /Fields, the others stay, and the form still fills', async () => {
    const pdf = pdfWithForm();
    const core = new EditCore(pdf, 4, true, env);
    expect(fieldLeaves(pdf).size).toBe(4);
    await core.apply([{ op: 'delete', uids: [core.pages().uids[1]!] }]);
    expect(fieldLeaves(pdf).size).toBe(3);
    core.undo();
    expect(fieldLeaves(pdf).size).toBe(4);
    core.redo();
    const reopened = open(save(pdf))!;
    expect(fieldLeaves(reopened).size).toBe(3);
    expect(pageObjectCount(reopened)).toBe(3);
    expect(fillForm(reopened)).toBe('filled');
  });

  it('a field with widgets on two pages stays while one widget is left, and goes with the last one', async () => {
    const pdf = pdfWithForm();
    // Make field f0's widget on page 1 a kid of a parent field that also has the widget of page 2 as a kid.
    const fields = entry(entry(pdf.getTrailer().get('Root'), 'AcroForm')!.resolve(), 'Fields')!.resolve();
    const w0 = fields.get(0);
    const w1 = fields.get(1);
    const parent = pdf.newDictionary();
    parent.put('FT', pdf.newName('Tx'));
    parent.put('T', pdf.newString('both'));
    const kids = pdf.newArray();
    kids.push(w0);
    kids.push(w1);
    parent.put('Kids', kids);
    const parentRef = pdf.addObject(parent);
    w0.resolve().put('Parent', parentRef);
    w1.resolve().put('Parent', parentRef);
    w0.resolve().delete('T');
    w1.resolve().delete('T');
    fields.delete(1);
    fields.delete(0);
    fields.push(parentRef);
    const core = new EditCore(pdf, 4, true, env);
    expect(fieldLeaves(pdf).size).toBe(4); // two kids, two other fields
    await core.apply([{ op: 'delete', uids: [core.pages().uids[0]!] }]);
    expect(fieldLeaves(pdf).size).toBe(3);
    await core.apply([{ op: 'delete', uids: [core.pages().uids[0]!] }]);
    expect(fieldLeaves(pdf).size).toBe(2);
    expect(pageObjectCount(open(save(pdf))!)).toBe(2);
  });
});

function labelsOf(pdf: mu.PDFDocument): string[] {
  const out: string[] = [];
  for (let i = 0; i < pdf.countPages(); i++) out.push(pdf.loadPage(i).getLabel());
  return out;
}

function labelledDoc(): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < 6; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 200, 200], 0, {}, '0 g'));
  pdf.setPageLabels(0, 'r', '', 1);
  pdf.setPageLabels(2, 'D', '', 1);
  pdf.setPageLabels(4, 'D', 'A-', 1);
  return pdf;
}

describe('page labels', () => {
  it('the fixture labels i, ii, 1, 2, A-1, A-2', () => {
    expect(labelsOf(labelledDoc())).toEqual(['i', 'ii', '1', '2', 'A-1', 'A-2']);
  });

  it('delete shifts the ranges with the pages', async () => {
    const cases: Array<[number[], string[]]> = [
      [[0], ['i', '1', '2', 'A-1', 'A-2']],
      [[3], ['i', 'ii', '1', 'A-1', 'A-2']],
      [[0, 1], ['1', '2', 'A-1', 'A-2']],
      [[2, 3], ['i', 'ii', 'A-1', 'A-2']],
      [[4, 5], ['i', 'ii', '1', '2']],
      [[1, 2, 5], ['i', '1', 'A-1']],
    ];
    for (const [gone, expected] of cases) {
      const pdf = labelledDoc();
      const core = new EditCore(pdf, 6, true, env);
      await core.apply([{ op: 'delete', uids: gone.map((i) => core.pages().uids[i]!) }]);
      expect(labelsOf(pdf), `delete ${gone}`).toEqual(expected);
      core.undo();
      expect(labelsOf(pdf), `undo delete ${gone}`).toEqual(['i', 'ii', '1', '2', 'A-1', 'A-2']);
      core.redo();
      expect(labelsOf(pdf), `redo delete ${gone}`).toEqual(expected);
      expect(labelsOf(open(save(pdf))!), `delete ${gone} saved`).toEqual(expected);
    }
  });

  it('move and reverse keep the labels with the positions, through undo, redo and save', async () => {
    for (const make of [
      (u: PageUid[]): PageEdit => ({ op: 'move', uids: [u[0]!], beforeUid: null }),
      (u: PageUid[]): PageEdit => ({ op: 'reverse', uids: u }),
    ]) {
      const pdf = labelledDoc();
      const core = new EditCore(pdf, 6, true, env);
      await core.apply([make(core.pages().uids)]);
      expect(labelsOf(pdf)).toEqual(['i', 'ii', '1', '2', 'A-1', 'A-2']);
      core.undo();
      core.redo();
      expect(labelsOf(pdf)).toEqual(['i', 'ii', '1', '2', 'A-1', 'A-2']);
      expect(labelsOf(open(save(pdf))!)).toEqual(['i', 'ii', '1', '2', 'A-1', 'A-2']);
    }
  });

  it('duplicate and insert keep the numbering running (MuPDF extends the range the page lands in)', async () => {
    const pdf = labelledDoc();
    const core = new EditCore(pdf, 6, true, env);
    await core.apply([{ op: 'duplicate', uids: [core.pages().uids[2]!] }]);
    expect(labelsOf(pdf)).toEqual(['i', 'ii', '1', '2', '3', 'A-1', 'A-2']);
    await core.apply([{ op: 'insertBlank', afterUid: core.pages().uids[0]!, size: { width: 200, height: 200 }, template: 'blank' }]);
    expect(labelsOf(pdf)).toEqual(['i', 'ii', 'iii', '1', '2', '3', 'A-1', 'A-2']);
    expect(labelsOf(open(save(pdf))!)).toEqual(['i', 'ii', 'iii', '1', '2', '3', 'A-1', 'A-2']);
  });

  it('shiftedLabelRanges drops a range with no page left and merges ranges that start on the same page', () => {
    const d = (n: number) => ({ at: n, dict: {} as mu.PDFObject });
    expect(shiftedLabelRanges([d(0), d(2), d(4)], [4, 5]).map((r) => r.at)).toEqual([0]);
    expect(shiftedLabelRanges([d(0), d(2), d(4)], [1, 5]).map((r) => r.at)).toEqual([0, 1]);
    expect(shiftedLabelRanges([d(3), d(5)], [0, 5]).map((r) => r.at)).toEqual([1]);
  });
});

describe('open action, destinations, name trees', () => {
  function docWithCatalogExtras(): mu.PDFDocument {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 4; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 200, 200], 0, {}, '0 g'));
    const root = pdf.getTrailer().get('Root');
    const dest = pdf.newArray();
    dest.push(pdf.findPage(1));
    dest.push(pdf.newName('Fit'));
    root.put('OpenAction', dest);
    root.put('PageMode', pdf.newName('UseOutlines'));
    root.put('PageLayout', pdf.newName('TwoColumnLeft'));
    const js = pdf.newDictionary();
    js.put('Names', pdf.newArray());
    const names = pdf.newDictionary();
    names.put('JavaScript', pdf.addObject(js));
    const files = pdf.newDictionary();
    files.put('Names', pdf.newArray());
    names.put('EmbeddedFiles', pdf.addObject(files));
    root.put('Names', names);
    const prefs = pdf.newDictionary();
    prefs.put('HideToolbar', pdf.newBoolean(true));
    root.put('ViewerPreferences', prefs);
    root.put('Lang', pdf.newString('de-DE'));
    return pdf;
  }

  it('Move, Reverse and Delete keep PageMode, PageLayout, ViewerPreferences, Lang and the JavaScript and attachment trees', async () => {
    for (const make of [
      (u: PageUid[]): PageEdit => ({ op: 'move', uids: [u[0]!], beforeUid: null }),
      (u: PageUid[]): PageEdit => ({ op: 'reverse', uids: u }),
      (u: PageUid[]): PageEdit => ({ op: 'delete', uids: [u[3]!] }),
    ]) {
      const pdf = docWithCatalogExtras();
      const baseline = reachable(pdf);
      const core = new EditCore(pdf, 4, true, env);
      await core.apply([make(core.pages().uids)]);
      core.undo();
      sameObjects(baseline, reachable(pdf));
      core.redo();
      const reopened = open(save(pdf))!;
      const root = reopened.getTrailer().get('Root');
      for (const key of ['OpenAction', 'PageMode', 'PageLayout', 'ViewerPreferences', 'Lang']) expect(rootKeys(reopened), key).toContain(key);
      expect(keysOf(root.get('Names')).sort()).toEqual(['EmbeddedFiles', 'JavaScript']);
    }
  });

  it('/OpenAction is dropped only when its page is deleted', async () => {
    const kept = docWithCatalogExtras();
    const keptCore = new EditCore(kept, 4, true, env);
    await keptCore.apply([{ op: 'delete', uids: [keptCore.pages().uids[3]!] }]);
    expect(rootKeys(kept)).toContain('OpenAction');
    const gone = docWithCatalogExtras();
    const goneCore = new EditCore(gone, 4, true, env);
    await goneCore.apply([{ op: 'delete', uids: [goneCore.pages().uids[1]!] }]);
    expect(rootKeys(gone)).not.toContain('OpenAction');
    goneCore.undo();
    expect(rootKeys(gone)).toContain('OpenAction');
    goneCore.redo();
    expect(pageObjectCount(open(save(gone))!)).toBe(3);
  });
});

// ---- Speed ---------------------------------------------------------------------------------------------------------

describe('speed on 1,000 pages (protected: delete 500 and move 50 stay within 1 s; measured before 141 / 59 ms)', () => {
  function bigDoc(tagged: boolean): mu.PDFDocument {
    const pdf = new mu.PDFDocument();
    const paras: mu.PDFObject[] = [];
    for (let i = 0; i < 1000; i++) {
      const page = pdf.addPage([0, 0, 200, 200], 0, {}, `${i % 90} 10 20 20 re f`);
      pdf.insertPage(-1, page);
    }
    if (!tagged) return pdf;
    const treeRoot = pdf.addObject(pdf.newDictionary());
    const nums = pdf.newArray();
    const kids = pdf.newArray();
    for (let i = 0; i < 1000; i++) {
      const elem = pdf.newDictionary();
      elem.put('S', pdf.newName('P'));
      elem.put('Pg', pdf.findPage(i));
      elem.put('K', pdf.newInteger(0));
      const ref = pdf.addObject(elem);
      paras.push(ref);
      kids.push(ref);
      pdf.findPage(i).put('StructParents', pdf.newInteger(i));
      nums.push(pdf.newInteger(i));
      const arr = pdf.newArray();
      arr.push(ref);
      nums.push(arr);
    }
    const parentTree = pdf.newDictionary();
    parentTree.put('Nums', nums);
    treeRoot.resolve().put('Type', pdf.newName('StructTreeRoot'));
    treeRoot.resolve().put('K', kids);
    treeRoot.resolve().put('ParentTree', pdf.addObject(parentTree));
    const root = pdf.getTrailer().get('Root');
    root.put('StructTreeRoot', treeRoot);
    root.put('Lang', pdf.newString('en'));
    return pdf;
  }

  for (const tagged of [false, true]) {
    it(`${tagged ? 'a tagged' : 'an untagged'} document: delete 500, and move 50, each under 1 s, then undo`, async () => {
      const pdf = bigDoc(tagged);
      const core = new EditCore(pdf, 1000, true, env);
      const uids = core.pages().uids;
      const t0 = performance.now();
      await core.apply([{ op: 'delete', uids: uids.filter((_u, i) => i % 2 === 1) }]);
      const deleteMs = performance.now() - t0;
      expect(pdf.countPages()).toBe(500);
      const t1 = performance.now();
      await core.apply([{ op: 'move', uids: core.pages().uids.slice(0, 50), beforeUid: null }]);
      const moveMs = performance.now() - t1;
      expect(deleteMs).toBeLessThan(1000);
      expect(moveMs).toBeLessThan(1000);
      if (tagged) expect(parentTreeKeys(pdf).length).toBe(500);
      core.undo();
      core.undo();
      expect(pdf.countPages()).toBe(1000);
      if (tagged) expect(parentTreeKeys(pdf).length).toBe(1000);
      console.info(`[1000 pages, ${tagged ? 'tagged' : 'untagged'}] delete 500 ${Math.round(deleteMs)} ms, move 50 ${Math.round(moveMs)} ms`);
    });
  }
});

// ---- Review cases: what a delete takes away is found by comparing the pages before and after -------------------------

function builders(pdf: mu.PDFDocument) {
  const dict = (props: Record<string, unknown>): mu.PDFObject => {
    const d = pdf.newDictionary();
    for (const [k, v] of Object.entries(props)) d.put(k, v as never);
    return d;
  };
  const arr = (...items: unknown[]): mu.PDFObject => {
    const a = pdf.newArray();
    for (const item of items) a.push(item as never);
    return a;
  };
  return { dict, arr, n: (x: number) => pdf.newInteger(x), nm: (s: string) => pdf.newName(s), str: (s: string) => pdf.newString(s) };
}

function bareDoc(count: number): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < count; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 200, 200], 0, {}, '0 g'));
  return pdf;
}

async function deleteAt(pdf: mu.PDFDocument, positions: number[]): Promise<EditCore> {
  const core = new EditCore(pdf, pdf.countPages(), true, env);
  await core.apply([{ op: 'delete', uids: positions.map((i) => core.pages().uids[i]!) }]);
  return core;
}

function fieldList(pdf: mu.PDFDocument, key: 'Fields' | 'CO'): mu.PDFObject | undefined {
  const acro = entry(pdf.getTrailer().get('Root'), 'AcroForm')?.resolve();
  return acro ? entry(acro, key)?.resolve() : undefined;
}

describe('a link on a kept page that pointed at the deleted page (MuPDF removes the link; its tag must go too)', () => {
  function docWithTaggedLink(): mu.PDFDocument {
    const pdf = bareDoc(3);
    const { dict, arr, n, nm } = builders(pdf);
    const link = pdf.addObject(
      dict({ Type: nm('Annot'), Subtype: nm('Link'), Rect: arr(n(0), n(0), n(10), n(10)), Dest: arr(pdf.findPage(2), nm('Fit')), StructParent: n(10), P: pdf.findPage(0) }),
    );
    pdf.findPage(0).put('Annots', arr(link));
    const tree = pdf.addObject(dict({ Type: nm('StructTreeRoot') }));
    const elem = pdf.addObject(dict({ Type: nm('StructElem'), S: nm('Link'), P: tree, Pg: pdf.findPage(0), K: dict({ Type: nm('OBJR'), Obj: link }) }));
    tree.resolve().put('K', arr(elem));
    tree.resolve().put('ParentTree', pdf.addObject(dict({ Nums: arr(n(10), elem) })));
    pdf.getTrailer().get('Root').put('StructTreeRoot', tree);
    return pdf;
  }

  it('the saved file has 2 page objects for 2 pages, no ParentTree key for the removed link, and Undo restores it', async () => {
    const pdf = docWithTaggedLink();
    const baseline = reachable(pdf);
    const core = await deleteAt(pdf, [2]);
    expect(entry(pdf.findPage(0), 'Annots')?.resolve().length ?? 0).toBe(0); // MuPDF removed the link
    expect(parentTreeKeys(pdf)).toEqual([]);
    core.undo();
    sameObjects(baseline, reachable(pdf));
    core.redo();
    const reopened = open(save(pdf))!;
    expect(reopened.countPages()).toBe(2);
    expect(pageObjectCount(reopened)).toBe(2);
  });
});

describe('what a page that stays still uses is never taken away', () => {
  it.skipIf(!HAVE_CORPUS)('a deleted page that shares /StructParents with a kept page leaves that page its ParentTree entry', async () => {
    const pdf = open(new Uint8Array(readFileSync(FW9)))!;
    const key = pdf.findPage(0).get('StructParents').asNumber();
    pdf.findPage(5).put('StructParents', pdf.newInteger(key)); // page 6 claims page 1's key, as a copy made before 1.5.9 did
    await deleteAt(pdf, [5]);
    expect(parentTreeKeys(pdf)).toContain(key);
    expect(pdf.findPage(0).get('StructParents').asNumber()).toBe(key);
  });

  it('a widget with a stale /P that names the deleted page, but sits on a kept page, stays in /Fields', async () => {
    const pdf = bareDoc(2);
    const { dict, arr, n, nm, str } = builders(pdf);
    const widget = pdf.addObject(dict({ Type: nm('Annot'), Subtype: nm('Widget'), FT: nm('Tx'), T: str('onPage2'), Rect: arr(n(10), n(10), n(100), n(30)), P: pdf.findPage(0) }));
    pdf.findPage(1).put('Annots', arr(widget));
    pdf.getTrailer().get('Root').put('AcroForm', dict({ Fields: arr(widget) }));
    await deleteAt(pdf, [0]);
    expect(fieldList(pdf, 'Fields')!.length).toBe(1);
    const reopened = open(save(pdf))!;
    expect(pageObjectCount(reopened)).toBe(1);
    expect(fieldLeaves(reopened).size).toBe(1);
  });

  it('a widget listed on both a deleted and a kept page stays in /Fields', async () => {
    const pdf = bareDoc(2);
    const { dict, arr, n, nm, str } = builders(pdf);
    const widget = pdf.addObject(dict({ Type: nm('Annot'), Subtype: nm('Widget'), FT: nm('Tx'), T: str('both'), Rect: arr(n(10), n(10), n(100), n(30)), P: pdf.findPage(0) }));
    pdf.findPage(0).put('Annots', arr(widget));
    pdf.findPage(1).put('Annots', arr(widget));
    pdf.getTrailer().get('Root').put('AcroForm', dict({ Fields: arr(widget) }));
    await deleteAt(pdf, [0]);
    expect(fieldList(pdf, 'Fields')!.length).toBe(1);
  });
});

describe('structure elements the first version missed', () => {
  it('an element with /Pg on the deleted page and no /K loses the /Pg, so the page object is not kept', async () => {
    const pdf = bareDoc(2);
    const { dict, arr, n, nm } = builders(pdf);
    const tree = pdf.addObject(dict({ Type: nm('StructTreeRoot') }));
    const figure = pdf.addObject(dict({ Type: nm('StructElem'), S: nm('Figure'), P: tree, Pg: pdf.findPage(1) }));
    const para = pdf.addObject(dict({ Type: nm('StructElem'), S: nm('P'), P: tree, Pg: pdf.findPage(0), K: n(0) }));
    tree.resolve().put('K', arr(figure, para));
    pdf.getTrailer().get('Root').put('StructTreeRoot', tree);
    await deleteAt(pdf, [1]);
    const reopened = open(save(pdf))!;
    expect(pageObjectCount(reopened)).toBe(1);
  });

  it('a marked-content reference without /Type (it has /MCID) and an object reference without /Type (it has /Obj) are pruned', async () => {
    const pdf = bareDoc(2);
    const { dict, arr, n, nm } = builders(pdf);
    const annot = pdf.addObject(dict({ Type: nm('Annot'), Subtype: nm('Link'), Rect: arr(n(0), n(0), n(5), n(5)), StructParent: n(7) }));
    pdf.findPage(1).put('Annots', arr(annot));
    const tree = pdf.addObject(dict({ Type: nm('StructTreeRoot') }));
    const sect = pdf.addObject(
      dict({ Type: nm('StructElem'), S: nm('Sect'), P: tree, K: arr(dict({ Pg: pdf.findPage(1), MCID: n(0) }), dict({ Pg: pdf.findPage(0), MCID: n(1) }), dict({ Obj: annot })) }),
    );
    tree.resolve().put('K', arr(sect));
    pdf.getTrailer().get('Root').put('StructTreeRoot', tree);
    await deleteAt(pdf, [1]);
    const left = entry(sect.resolve(), 'K')!.resolve();
    expect(left.length).toBe(1);
    expect(entry(left.get(0).resolve(), 'Pg')!.asIndirect()).toBe(pdf.findPage(0).asIndirect());
    expect(pageObjectCount(open(save(pdf))!)).toBe(1);
  });

  for (const depth of [2, 3000, 20000]) {
    it(`a tree ${depth === 2 ? 'with a cycle' : `${depth} elements deep`} is pruned without an overflow`, async () => {
      const pdf = bareDoc(2);
      const { dict, arr, n, nm } = builders(pdf);
      const tree = pdf.addObject(dict({ Type: nm('StructTreeRoot') }));
      const top = pdf.addObject(dict({ Type: nm('StructElem'), S: nm('Sect'), P: tree }));
      let cur = top;
      for (let i = 0; i < depth; i++) {
        const child = pdf.addObject(dict({ Type: nm('StructElem'), S: nm('Div'), P: cur }));
        cur.resolve().put('K', arr(child));
        cur = child;
      }
      if (depth === 2) cur.resolve().put('K', arr(top, n(0)));
      else {
        cur.resolve().put('K', n(0));
        cur.resolve().put('Pg', pdf.findPage(1));
      }
      tree.resolve().put('K', arr(top));
      pdf.getTrailer().get('Root').put('StructTreeRoot', tree);
      await deleteAt(pdf, [1]);
      expect(pdf.countPages()).toBe(1);
      expect(rootKeys(pdf)).toContain('StructTreeRoot');
      if (depth > 2) {
        // The one leaf had content only on the deleted page, so the whole chain is empty and gone.
        expect(entry(tree.resolve(), 'K')!.resolve().length).toBe(0);
        expect(pageObjectCount(open(save(pdf))!)).toBe(1);
      }
      // The 20,000-deep tree takes about 2 s alone and several times that when the whole suite runs in parallel: the 5 s default
      // timeout is a load limit, not a correctness one. 60 s is far above any load and still ends a real hang.
    }, 60_000);
  }
});

describe('form details the first version missed', () => {
  it('/CO drops a parent field whose only widget was on the deleted page, as /Fields does', async () => {
    const pdf = bareDoc(2);
    const { dict, arr, n, nm, str } = builders(pdf);
    const parent = pdf.addObject(dict({ FT: nm('Tx'), T: str('total') }));
    const kid = pdf.addObject(dict({ Type: nm('Annot'), Subtype: nm('Widget'), Parent: parent, Rect: arr(n(10), n(10), n(100), n(30)), P: pdf.findPage(1) }));
    parent.resolve().put('Kids', arr(kid));
    pdf.findPage(1).put('Annots', arr(kid));
    pdf.getTrailer().get('Root').put('AcroForm', dict({ Fields: arr(parent), CO: arr(parent) }));
    const core = await deleteAt(pdf, [1]);
    expect(fieldList(pdf, 'Fields')!.length).toBe(0);
    expect(fieldList(pdf, 'CO')!.length).toBe(0);
    core.undo();
    expect(fieldList(pdf, 'Fields')!.length).toBe(1);
    expect(fieldList(pdf, 'CO')!.length).toBe(1);
  });

  /** Two radio buttons, one per page; `chosen` is the group's /V. */
  function radioDoc(chosen: string): { pdf: mu.PDFDocument; group: mu.PDFObject } {
    const pdf = bareDoc(2);
    const { dict, arr, n, nm, str } = builders(pdf);
    const group = pdf.addObject(dict({ FT: nm('Btn'), Ff: n(49152), T: str('choice'), V: nm(chosen) }));
    const kids = arr();
    for (const [i, state] of [[0, 'A'], [1, 'B']] as const) {
      const states = dict({ [state]: pdf.addStream('', {}), Off: pdf.addStream('', {}) });
      const widget = pdf.addObject(
        dict({ Type: nm('Annot'), Subtype: nm('Widget'), Parent: group, P: pdf.findPage(i), Rect: arr(n(10), n(10), n(30), n(30)), AS: nm(state === chosen ? state : 'Off'), AP: dict({ N: states }) }),
      );
      kids.push(widget);
      pdf.findPage(i).put('Annots', arr(widget));
    }
    group.resolve().put('Kids', kids);
    pdf.getTrailer().get('Root').put('AcroForm', dict({ Fields: arr(group) }));
    return { pdf, group };
  }

  it('a radio group whose chosen button was on the deleted page is set back to Off, and the other button stays', async () => {
    const { pdf, group } = radioDoc('B');
    await deleteAt(pdf, [1]);
    expect(entry(group.resolve(), 'Kids')!.resolve().length).toBe(1);
    expect(entry(group.resolve(), 'V')!.asName()).toBe('Off');
    const reopened = open(save(pdf))!;
    expect(pageObjectCount(reopened)).toBe(1);
    expect(reopened.loadPage(0).getWidgets().length).toBe(1);
  });

  it('a radio group whose chosen button stays keeps its value', async () => {
    const { pdf, group } = radioDoc('A');
    await deleteAt(pdf, [1]);
    expect(entry(group.resolve(), 'V')!.asName()).toBe('A');
  });
});

describe('catalog references to a deleted page', () => {
  it('/Names/Pages and /Names/Templates entries naming a deleted page are removed, the others stay', async () => {
    const pdf = bareDoc(3);
    const { dict, arr, str } = builders(pdf);
    const tree = (...pairs: Array<[string, mu.PDFObject]>) => pdf.addObject(dict({ Names: arr(...pairs.flatMap(([k, v]) => [str(k), v])) }));
    pdf.getTrailer().get('Root').put('Names', dict({ Pages: tree(['a', pdf.findPage(0)], ['b', pdf.findPage(1)]), Templates: tree(['t', pdf.findPage(1)], ['u', pdf.findPage(2)]) }));
    await deleteAt(pdf, [1]);
    const names = entry(pdf.getTrailer().get('Root'), 'Names')!.resolve();
    expect(entry(entry(names, 'Pages')!.resolve(), 'Names')!.resolve().length).toBe(2);
    expect(entry(entry(names, 'Templates')!.resolve(), 'Names')!.resolve().length).toBe(2);
    expect(pageObjectCount(open(save(pdf))!)).toBe(2);
  });

  it('an /IDS entry whose content set lists a deleted page is removed', async () => {
    const pdf = bareDoc(2);
    const { dict, arr, str } = builders(pdf);
    const set = (page: mu.PDFObject) => pdf.addObject(dict({ O: arr(page) }));
    pdf.getTrailer().get('Root').put('Names', dict({ IDS: pdf.addObject(dict({ Names: arr(str('x'), set(pdf.findPage(0)), str('y'), set(pdf.findPage(1))) })) }));
    await deleteAt(pdf, [1]);
    const ids = entry(entry(pdf.getTrailer().get('Root'), 'Names')!.resolve(), 'IDS')!.resolve();
    expect(entry(ids, 'Names')!.resolve().length).toBe(2);
    expect(pageObjectCount(open(save(pdf))!)).toBe(1);
  });

  it('old-style /Dests entries and /Threads that point at a deleted page are removed, the others stay', async () => {
    const pdf = bareDoc(3);
    const { dict, arr, nm, n } = builders(pdf);
    pdf.getTrailer().get('Root').put('Dests', dict({ keep: arr(pdf.findPage(0), nm('Fit')), gone: arr(pdf.findPage(1), nm('Fit')), viaAction: dict({ D: arr(pdf.findPage(1), nm('Fit')) }) }));
    const bead = (page: mu.PDFObject) => pdf.addObject(dict({ P: page, R: arr(n(0), n(0), n(10), n(10)) }));
    const ring = (...pages: mu.PDFObject[]) => {
      const beads = pages.map(bead);
      beads.forEach((b, i) => {
        b.resolve().put('N', beads[(i + 1) % beads.length]);
        b.resolve().put('V', beads[(i + beads.length - 1) % beads.length]);
      });
      return pdf.addObject(dict({ F: beads[0] }));
    };
    pdf.getTrailer().get('Root').put('Threads', arr(ring(pdf.findPage(0), pdf.findPage(2)), ring(pdf.findPage(0), pdf.findPage(1))));
    const core = await deleteAt(pdf, [1]);
    const root = pdf.getTrailer().get('Root');
    expect(keysOf(entry(root, 'Dests')!.resolve()).sort()).toEqual(['keep']);
    expect(entry(root, 'Threads')!.resolve().length).toBe(1);
    core.undo();
    expect(keysOf(entry(pdf.getTrailer().get('Root'), 'Dests')!.resolve()).sort()).toEqual(['gone', 'keep', 'viaAction']);
    expect(entry(pdf.getTrailer().get('Root'), 'Threads')!.resolve().length).toBe(2);
  });
});

describe.skipIf(!HAVE_CORPUS)('Move and Reverse on fw9, a failed prune, and a save after Undo', () => {
  const fw9Bytes = HAVE_CORPUS ? new Uint8Array(readFileSync(FW9)) : new Uint8Array();

  it('reverse keeps every /StructParents and /StructParent value, only the pages change places', async () => {
    const pdf = open(fw9Bytes)!;
    const keys = (doc: mu.PDFDocument) =>
      Array.from({ length: doc.countPages() }, (_v, p) => {
        const page = doc.findPage(p);
        const annots = entry(page, 'Annots')?.resolve();
        const annotKeys: string[] = [];
        if (annots) for (let i = 0; i < annots.length; i++) annotKeys.push(String(entry(annots.get(i).resolve(), 'StructParent')?.asNumber() ?? '-'));
        return `${entry(page, 'StructParents')?.asNumber() ?? '-'}:[${annotKeys.join(',')}]`;
      });
    const before = keys(pdf);
    const core = new EditCore(pdf, 6, true, env);
    await core.apply([{ op: 'reverse', uids: core.pages().uids }]);
    expect(keys(pdf)).toEqual([...before].reverse());
  });

  it('an error inside the prune rolls the whole edit back to the exact original, and the document takes the next edit', async () => {
    const pdf = open(fw9Bytes)!;
    const baseline = reachable(pdf);
    const core = new EditCore(pdf, 6, true, env);
    const real = pdf.addObject.bind(pdf);
    (pdf as unknown as { addObject: () => never }).addObject = () => {
      throw new Error('boom in prune');
    };
    await expect(core.apply([{ op: 'delete', uids: [core.pages().uids[1]!] }])).rejects.toThrow('boom in prune');
    (pdf as unknown as { addObject: typeof real }).addObject = real;
    expect(pdf.countPages()).toBe(6);
    expect(pdf.canUndo()).toBe(false);
    sameObjects(baseline, reachable(pdf));
    await core.apply([{ op: 'delete', uids: [core.pages().uids[1]!] }]);
    expect(pdf.countPages()).toBe(5);
  });

  it('delete, Undo, then save gives the original catalog and 6 page objects', async () => {
    const pdf = open(fw9Bytes)!;
    const keysBefore = rootKeys(pdf);
    const core = new EditCore(pdf, 6, true, env);
    await core.apply([{ op: 'delete', uids: [core.pages().uids[0]!] }]);
    core.undo();
    const reopened = open(save(pdf))!;
    expect(reopened.countPages()).toBe(6);
    expect(pageObjectCount(reopened)).toBe(6);
    expect(rootKeys(reopened)).toEqual(keysBefore);
    expect(fieldLeaves(reopened).size).toBe(23);
  });
});
