// @vitest-environment node
// The annotated-links fixture is well-formed (its note used to be an unparseable name), and a duplicated page keeps all of
// its annotations, each pointing at the copied page, with the popup pointing at the copy of its note.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';

const FILE = new URL('../../../tests/fixtures/out/annotated-links.pdf', import.meta.url);

interface Annot {
  subtype: string;
  contents: string | null;
  popupParentIsNote: boolean | null;
  samePageAsP: boolean | null;
  quad: number;
  uri: string | null;
}

function annotsOf(pdf: mu.PDFDocument, index: number): Annot[] {
  const page = pdf.findPage(index);
  const list = page.get('Annots');
  const out: Annot[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list.get(i);
    const subtype = a.get('Subtype').asName();
    const contents = a.get('Contents');
    const parent = a.get('Parent');
    const p = a.get('P');
    const action = a.get('A');
    out.push({
      subtype,
      contents: contents.isNull() ? null : contents.asString(),
      popupParentIsNote: subtype === 'Popup' ? !parent.isNull() && parent.asIndirect() === list.get(0).asIndirect() : null,
      samePageAsP: p.isNull() ? null : p.asIndirect() === page.asIndirect(),
      quad: a.get('QuadPoints').isNull() ? 0 : a.get('QuadPoints').length,
      uri: !action.isNull() && !action.get('URI').isNull() ? action.get('URI').asString() : null,
    });
  }
  return out;
}

describe('annotated-links fixture', () => {
  const open = () => mu.Document.openDocument(new Uint8Array(readFileSync(FILE)), 'application/pdf');

  it('has a note with its popup, a highlight and a link on each of 4 pages, all readable', () => {
    const doc = open();
    const pdf = doc.asPDF()!;
    expect(doc.countPages()).toBe(4);
    for (let p = 0; p < 4; p++) {
      const annots = annotsOf(pdf, p);
      expect(annots.map((a) => a.subtype), `page ${p + 1}`).toEqual(['Text', 'Popup', 'Highlight', 'Link']);
      expect(annots[0]!.contents).toBe(`note ${p + 1}`);
      expect(annots[1]!.popupParentIsNote).toBe(true);
      expect(annots[2]!.contents).toBe(`highlight ${p + 1}`);
      expect(annots[2]!.quad).toBe(8);
      expect(annots[3]!.uri).toBe(`https://example.test/p${p + 1}`);
    }
  });

  it('a duplicated page keeps the note, the popup, the highlight and the link, on the copy', async () => {
    const original = new Uint8Array(readFileSync(FILE));
    const core = new MupdfCore(mu as never, {});
    core.open(original.slice(), undefined);
    await core.applyEdits([{ op: 'duplicate', uids: [core.editState!.pages().uids[0]!] }]);
    const saved = core.save(true, true);
    const doc = mu.Document.openDocument(new Uint8Array(saved.bytes), 'application/pdf');
    const pdf = doc.asPDF()!;
    expect(doc.countPages()).toBe(5);
    const first = annotsOf(pdf, 0);
    const copy = annotsOf(pdf, 1);
    expect(copy.map((a) => a.subtype)).toEqual(['Text', 'Popup', 'Highlight', 'Link']);
    expect(copy.map((a) => a.contents)).toEqual(first.map((a) => a.contents));
    expect(copy[1]!.popupParentIsNote, 'the popup of the copy points at the copy of its note').toBe(true);
    expect(copy.filter((a) => a.samePageAsP === false), 'no annotation of the copy points at another page').toEqual([]);
    expect(first.filter((a) => a.samePageAsP === false)).toEqual([]);
    expect(copy[3]!.uri).toBe('https://example.test/p1');
  });
});
