// @vitest-environment node
// Review 1.5.8, item 6: Replace page drops the form fields of the replaced page, not only its /Annots entries.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from './editCore';
import { saveOptions } from './saveCore';

const FW9 = new URL('../../../tests/engine/corpus/irs-fw9/fw9.pdf', import.meta.url);
const env = (sources: Map<string, mu.PDFDocument>) => ({ mu, sources });

let opened: mu.Document[] = [];
afterEach(() => {
  for (const doc of opened) doc.destroy();
  opened = [];
});

function openPdf(bytes: Uint8Array): mu.PDFDocument {
  const doc = mu.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  opened.push(doc);
  return doc.asPDF()!;
}

function blankSource(): mu.PDFDocument {
  const doc = new mu.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(), ''));
  return doc;
}

function entry(dict: mu.PDFObject, key: string): mu.PDFObject | undefined {
  let present = false;
  dict.forEach((_v, k) => {
    if (String(k) === key) present = true;
  });
  return present ? dict.get(key) : undefined;
}

/** Object numbers of every entry (at any depth) of /AcroForm /Fields. */
function fieldTree(pdf: mu.PDFDocument): Set<number> {
  const out = new Set<number>();
  const acro = entry(pdf.getTrailer().get('Root'), 'AcroForm')?.resolve();
  const fields = acro && acro.isDictionary() ? entry(acro, 'Fields')?.resolve() : undefined;
  const walk = (list: mu.PDFObject): void => {
    for (let i = 0; i < list.length; i++) {
      const ref = list.get(i);
      if (ref.isIndirect()) {
        if (out.has(ref.asIndirect())) continue;
        out.add(ref.asIndirect());
      }
      const dict = ref.resolve();
      const kids = dict.isDictionary() ? entry(dict, 'Kids')?.resolve() : undefined;
      if (kids && kids.isArray()) walk(kids);
    }
  };
  if (fields && fields.isArray()) walk(fields);
  return out;
}

/** The object numbers of the widget annotations in /Annots of page `index`. */
function widgetsOn(pdf: mu.PDFDocument, index: number): Set<number> {
  const out = new Set<number>();
  const annots = entry(pdf.findPage(index), 'Annots')?.resolve();
  if (!annots || !annots.isArray()) return out;
  for (let i = 0; i < annots.length; i++) {
    const ref = annots.get(i);
    const dict = ref.resolve();
    const sub = dict.isDictionary() ? entry(dict, 'Subtype') : undefined;
    if (ref.isIndirect() && sub && sub.isName() && sub.asName() === 'Widget') out.add(ref.asIndirect());
  }
  return out;
}

/** How many objects of the file are widget annotations, reachable or not. */
function widgetObjects(pdf: mu.PDFDocument): number {
  let count = 0;
  for (let n = 1; n < pdf.countObjects(); n++) {
    try {
      const dict = pdf.newIndirect(n).resolve();
      const sub = dict.isDictionary() ? entry(dict, 'Subtype') : undefined;
      if (sub && sub.isName() && sub.asName() === 'Widget') count++;
    } catch {
      // A free slot.
    }
  }
  return count;
}

// fw9.pdf is not redistributable (scripts/download-test-corpus.mjs); these are skipped when it is absent.
describe.skipIf(!existsSync(FW9))('Replace page on a form (fw9)', () => {
  const bytes = existsSync(FW9) ? new Uint8Array(readFileSync(FW9)) : new Uint8Array();

  async function replaceFirstPage(): Promise<{ pdf: mu.PDFDocument; gone: Set<number>; kept: Set<number>; before: number }> {
    const pdf = openPdf(bytes);
    const gone = widgetsOn(pdf, 0);
    expect(gone.size).toBeGreaterThan(5);
    const kept = new Set<number>();
    for (let p = 1; p < pdf.countPages(); p++) for (const id of widgetsOn(pdf, p)) kept.add(id);
    const before = widgetObjects(pdf);
    const core = new EditCore(pdf, pdf.countPages(), true, env(new Map([['s', blankSource()]])));
    await core.apply([{ op: 'replace', uid: core.pages().uids[0]!, sourceDocId: 's', sourceUid: '0' }]);
    return { pdf, gone, kept, before };
  }

  it('takes the replaced page\'s fields out of /AcroForm /Fields, and keeps the other pages\' fields', async () => {
    const { pdf, gone, kept } = await replaceFirstPage();
    expect(widgetsOn(pdf, 0).size).toBe(0);
    const tree = fieldTree(pdf);
    for (const id of gone) expect(tree.has(id), `ghost field ${id}`).toBe(false);
    // Every field that is on another page is still in the form.
    for (const id of kept) expect(tree.has(id), `field ${id} of a kept page`).toBe(true);
  });

  it('leaves no widget or appearance stream of the old page in the saved file', async () => {
    const { pdf, gone, before } = await replaceFirstPage();
    const saved = pdf.saveToBuffer(saveOptions('full', false));
    const bytesOut = saved.asUint8Array().slice();
    saved.destroy();
    const reopened = openPdf(bytesOut);
    expect(reopened.countPages()).toBe(pdf.countPages());
    let remaining = 0;
    for (let p = 0; p < reopened.countPages(); p++) remaining += widgetsOn(reopened, p).size;
    // Every widget object that is left in the file is on a page that stays.
    expect(widgetObjects(reopened)).toBe(remaining);
    expect(widgetObjects(reopened)).toBeLessThan(before);
    expect(before - widgetObjects(reopened)).toBeGreaterThanOrEqual(gone.size);
  });

  it('undo gives the replaced page its fields back', async () => {
    const pdf = openPdf(bytes);
    const gone = widgetsOn(pdf, 0);
    const core = new EditCore(pdf, pdf.countPages(), true, env(new Map([['s', blankSource()]])));
    await core.apply([{ op: 'replace', uid: core.pages().uids[0]!, sourceDocId: 's', sourceUid: '0' }]);
    core.undo();
    const tree = fieldTree(pdf);
    for (const id of gone) expect(tree.has(id), `field ${id} after undo`).toBe(true);
    expect(widgetsOn(pdf, 0)).toEqual(gone);
  });
});

describe.skipIf(!existsSync(FW9))('Replace page with a page that has fields of its own (needs corpus fw9.pdf)', () => {
  it('the incoming page\'s widgets stay in the form', async () => {
    const bytes = new Uint8Array(readFileSync(FW9));
    const pdf = openPdf(bytes);
    const source = openPdf(bytes);
    const core = new EditCore(pdf, pdf.countPages(), true, env(new Map([['s', source]])));
    // Page 2 of fw9 replaces page 1: page 1's fields go, and the widgets now on page 1 are in the form.
    await core.apply([{ op: 'replace', uid: core.pages().uids[0]!, sourceDocId: 's', sourceUid: '1' }]);
    const tree = fieldTree(pdf);
    const now = widgetsOn(pdf, 0);
    for (const id of now) expect(tree.has(id), `incoming field ${id}`).toBe(true);
  });
});

describe('Replace page and the ParentTree keys', () => {
  /** The keys of /StructTreeRoot /ParentTree /Nums. */
  function parentTreeKeys(pdf: mu.PDFDocument): number[] {
    const tree = pdf.getTrailer().get('Root').get('StructTreeRoot').get('ParentTree').resolve();
    const nums = tree.get('Nums').resolve();
    const out: number[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) out.push(nums.get(i).asNumber());
    return out;
  }

  it('drops the keys only the replaced page used, and keeps one that another page shares', async () => {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 2; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 200, 200], 0, pdf.newDictionary(), ''));
    const [first, second] = [pdf.findPage(0), pdf.findPage(1)];
    // Page 1 uses key 0 for itself and key 1 for an annotation; page 2 also uses key 1 (a shared key) and key 2.
    const annot = pdf.addObject(pdf.newDictionary());
    annot.resolve().put('Type', pdf.newName('Annot'));
    annot.resolve().put('Subtype', pdf.newName('Text'));
    annot.resolve().put('StructParent', 1);
    const annots = pdf.newArray();
    annots.push(annot);
    first.put('Annots', annots);
    first.put('StructParents', 0);
    second.put('StructParents', 1);
    const annot2 = pdf.addObject(pdf.newDictionary());
    annot2.resolve().put('Type', pdf.newName('Annot'));
    annot2.resolve().put('Subtype', pdf.newName('Text'));
    annot2.resolve().put('StructParent', 2);
    const annots2 = pdf.newArray();
    annots2.push(annot2);
    second.put('Annots', annots2);
    const nums = pdf.newArray();
    for (const key of [0, 1, 2]) {
      nums.push(pdf.newInteger(key));
      nums.push(pdf.newArray());
    }
    const parentTree = pdf.newDictionary();
    parentTree.put('Nums', nums);
    const tree = pdf.newDictionary();
    tree.put('Type', pdf.newName('StructTreeRoot'));
    tree.put('ParentTree', pdf.addObject(parentTree));
    pdf.getTrailer().get('Root').put('StructTreeRoot', pdf.addObject(tree));

    const core = new EditCore(pdf, 2, true, env(new Map([['s', blankSource()]])));
    await core.apply([{ op: 'replace', uid: core.pages().uids[0]!, sourceDocId: 's', sourceUid: '0' }]);
    expect(parentTreeKeys(pdf)).toEqual([1, 2]);
  });
});
