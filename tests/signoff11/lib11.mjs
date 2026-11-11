// Sign-Off 11 shared builders. Auditor code only.
import * as mu from 'mupdf';
import { buildPdf } from '../signoff9/lib9.mjs';

/** A file whose page 1 holds four links: /Dest (chapter1), GoTo (chapter1), /Dest /intro (old-style), and a plain page link. */
export function namedPdf(tag, pages, chapterPage, introPage, plainPage, style = 'tree') {
  const pdf = new mu.PDFDocument(buildPdf({ pages, tag }));
  const root = pdf.getTrailer().get('Root');
  const destTo = (n) => { const d = pdf.newArray(); d.push(pdf.findPage(n - 1)); d.push(pdf.newName('Fit')); return d; };
  if (style === 'tree') {
    const names = pdf.newArray();
    names.push(pdf.newString('chapter1'));
    names.push(destTo(chapterPage));
    names.push(pdf.newString('intro'));
    names.push(destTo(introPage));
    const dests = pdf.newDictionary();
    dests.put('Names', names);
    const nm = pdf.newDictionary();
    nm.put('Dests', dests);
    root.put('Names', pdf.addObject(nm));
  } else {
    const old = pdf.newDictionary();
    old.put('chapter1', destTo(chapterPage));
    old.put('intro', destTo(introPage));
    root.put('Dests', pdf.addObject(old));
  }
  const named = (n) => (style === 'tree' ? pdf.newString(n) : pdf.newName(n));
  const page1 = pdf.findPage(0);
  const annots = pdf.newArray();
  const link = (y, fill) => {
    const a = pdf.newDictionary();
    a.put('Type', pdf.newName('Annot'));
    a.put('Subtype', pdf.newName('Link'));
    const r = pdf.newArray();
    for (const v of [60, y, 260, y + 24]) r.push(pdf.newInteger(v));
    a.put('Rect', r);
    fill(a);
    annots.push(pdf.addObject(a));
  };
  link(600, (a) => a.put('Dest', named('chapter1')));
  link(560, (a) => { const act = pdf.newDictionary(); act.put('S', pdf.newName('GoTo')); act.put('D', named('chapter1')); a.put('A', act); });
  link(520, (a) => a.put('Dest', named('intro')));
  link(480, (a) => a.put('Dest', destTo(plainPage)));
  link(440, (a) => { const act = pdf.newDictionary(); act.put('S', pdf.newName('URI')); act.put('URI', pdf.newString(`https://example.com/${tag}`)); a.put('A', act); });
  page1.put('Annots', annots);
  // outline: one item by name, one by page
  const outlines = pdf.createObject();
  const i1 = pdf.createObject();
  const i2 = pdf.createObject();
  const d1 = pdf.newDictionary();
  d1.put('Title', pdf.newString(`${tag} chapter (named)`));
  d1.put('Parent', outlines);
  d1.put('Next', i2);
  d1.put('Dest', named('chapter1'));
  i1.writeObject(d1);
  const d2 = pdf.newDictionary();
  d2.put('Title', pdf.newString(`${tag} intro (old named)`));
  d2.put('Parent', outlines);
  d2.put('Prev', i1);
  d2.put('Dest', named('intro'));
  i2.writeObject(d2);
  const od = pdf.newDictionary();
  od.put('Type', pdf.newName('Outlines'));
  od.put('First', i1);
  od.put('Last', i2);
  od.put('Count', pdf.newInteger(2));
  outlines.writeObject(od);
  root.put('Outlines', outlines);
  return Buffer.from(pdf.saveToBuffer('').asUint8Array().slice());
}
