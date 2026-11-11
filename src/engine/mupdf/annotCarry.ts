/**
 * What a grafted page leaves behind (pinned by jobProbes.test.ts: this MuPDF build's graftPage drops /Annots) and Split
 * puts back, for a copied page:
 *  - comments and markup (every annotation except links and widgets) are copied through the part's graft map, so their
 *    appearance streams and fonts are shared with the page content and copied once. Each copy points at the copied page; a
 *    popup and a reply link point at the copies of their targets. See `copyPageAnnotations`.
 *  - links are rebuilt from the source page's own link list. See `carryLinks`.
 * Widgets are not copied: Split flattens forms first (formFlatten.ts), so none are left.
 */
import type * as Mu from 'mupdf';
import { annotationsOf, optionalEntry } from './pageOps';

/** Keys of an annotation that are rebuilt for a copy: the page, the popup and parent links, and a reply's target. */
/** Actions and destinations are dropped (scripts are not carried, and a Go-to action would pull in other pages). */
const REBUILT_KEYS = new Set(['P', 'Popup', 'Parent', 'IRT', 'StructParent', 'A', 'AA', 'Dest']);

function subtypeOf(dict: Mu.PDFObject): string {
  const subtype = optionalEntry(dict, 'Subtype');
  return subtype && subtype.isName() ? subtype.asName() : '';
}

/**
 * Copies the comments and markup of `srcPage` (a page of the document the map grafts from) onto `outPage` (the grafted
 * page, as an indirect reference). Returns how many annotations were copied.
 */
export function copyPageAnnotations(out: Mu.PDFDocument, map: Mu.PDFGraftMap, srcPage: Mu.PDFObject, outPage: Mu.PDFObject, forms?: FormCarry): number {
  const annots = annotationsOf(srcPage).filter((a) => {
    const subtype = subtypeOf(a.dict);
    // Links are rebuilt (carryLinks). Widgets are carried only with a FormCarry; Split flattens them first.
    return subtype !== 'Link' && (subtype !== 'Widget' || forms !== undefined);
  });
  if (annots.length === 0) return 0;
  const refs = annots.map(() => out.createObject());
  const copyOf = new Map<number, Mu.PDFObject>();
  annots.forEach((annot, i) => {
    if (annot.key !== null) copyOf.set(annot.key, refs[i]!);
  });
  annots.forEach((annot, i) => {
    const dict = out.newDictionary();
    annot.dict.forEach((value, key) => {
      const name = String(key);
      if (!REBUILT_KEYS.has(name)) dict.put(name, map.graftObject(value));
    });
    dict.put('P', outPage);
    const popup = optionalEntry(annot.dict, 'Popup');
    if (popup) {
      const mapped = popup.isIndirect() ? copyOf.get(popup.asIndirect()) : undefined;
      if (mapped) {
        dict.put('Popup', mapped);
      } else if (popup.resolve().isDictionary()) {
        // A popup that is not one of the page's annotations is copied too, and linked back to this copy.
        const popupRef = out.createObject();
        const popupDict = out.newDictionary();
        popup.resolve().forEach((value, key) => {
          const name = String(key);
          if (!REBUILT_KEYS.has(name)) popupDict.put(name, map.graftObject(value));
        });
        popupDict.put('P', outPage);
        popupDict.put('Parent', refs[i]!);
        popupRef.writeObject(popupDict);
        dict.put('Popup', popupRef);
      }
    }
    const widget = subtypeOf(annot.dict) === 'Widget';
    if (forms && widget) forms.attach(annot.dict, refs[i]!, dict);
    for (const key of ['Parent', 'IRT'] as const) {
      if (widget && key === 'Parent') continue;
      const link = optionalEntry(annot.dict, key);
      const mapped = link && link.isIndirect() ? copyOf.get(link.asIndirect()) : undefined;
      if (mapped) dict.put(key, mapped);
    }
    refs[i]!.writeObject(dict);
  });
  const list = out.newArray();
  for (const ref of refs) list.push(ref);
  outPage.put('Annots', list);
  return annots.length;
}

/**
 * Rebuilds the links of a copied page from the source page's own link list. A web link is kept as it is. An internal link is
 * kept when its target page is in the copy (its page number is changed to the new one, any zoom and position stay) and
 * removed otherwise. `newIndexOf` maps a source page index (0-based) to the page index in the copy, or null when the page is
 * not in the copy.
 */
export function carryLinks(
  src: Mu.PDFDocument,
  srcPage: Mu.PDFPage,
  outPage: Mu.PDFPage,
  newIndexOf: (sourceIndex: number) => number | null,
): number {
  let kept = 0;
  for (const link of srcPage.getLinks()) {
    try {
      const uri = link.getURI();
      if (uri === '') continue;
      if (link.isExternal()) {
        outPage.createLink(link.getBounds(), uri);
        kept += 1;
        continue;
      }
      const target = src.resolveLink(uri);
      const mapped = Number.isInteger(target) && target >= 0 ? newIndexOf(target) : null;
      if (mapped === null) continue;
      const rewritten = /page=\d+/.test(uri) ? uri.replace(/page=\d+/, `page=${mapped + 1}`) : `#page=${mapped + 1}`;
      outPage.createLink(link.getBounds(), rewritten);
      kept += 1;
    } finally {
      link.destroy();
    }
  }
  return kept;
}

// ---- Form fields -----------------------------------------------------------------------------------------------------------------

/** Field attributes a widget may inherit from the fields above it (PDF 32000-1, table 220). */
const INHERITED_FIELD_KEYS = ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'MaxLen', 'Opt', 'TI', 'I'] as const;

/**
 * Carries the form fields of copied pages into the document the pages went to. Each source field becomes ONE field there (a
 * radio group or a check box with widgets on several copied pages stays one field), its widgets are the copies on the copied
 * pages, and it is listed in the document's /AcroForm /Fields. A field hierarchy is flattened into one field whose name is the
 * full name with "_" between the parts. A name the document already has is made unique ("_2", "_3"), so fields of different
 * origin never share a value. The AcroForm's default resources (fonts) are merged, keeping what the document already has.
 *
 * One FormCarry per edit or extract (it remembers the fields it made), never kept across edits: an undo removes them.
 */
export class FormCarry {
  private readonly made = new Map<number, Mu.PDFObject>();
  private fieldList: Mu.PDFObject | null = null;
  private names: Set<string> = new Set();
  private resources = false;

  constructor(
    private readonly out: Mu.PDFDocument,
    private readonly src: Mu.PDFDocument,
    private readonly map: Mu.PDFGraftMap,
  ) {}

  private acroForm(): Mu.PDFObject {
    const root = this.out.getTrailer().get('Root');
    let acro = optionalEntry(root, 'AcroForm')?.resolve();
    if (!acro || !acro.isDictionary()) {
      root.put('AcroForm', this.out.newDictionary());
      acro = root.get('AcroForm').resolve();
    }
    return acro;
  }

  private ensure(): Mu.PDFObject {
    if (this.fieldList) return this.fieldList;
    const acro = this.acroForm();
    let list = optionalEntry(acro, 'Fields')?.resolve();
    if (!list || !list.isArray()) {
      acro.put('Fields', this.out.newArray());
      list = acro.get('Fields').resolve();
    }
    this.fieldList = list;
    for (let i = 0; i < list.length; i++) this.collectNames(list.get(i).resolve(), '');
    this.mergeResources(acro);
    return list;
  }

  private collectNames(field: Mu.PDFObject, prefix: string): void {
    if (!field.isDictionary()) return;
    const t = optionalEntry(field, 'T');
    const full = t && t.isString() ? (prefix === '' ? t.asString() : `${prefix}_${t.asString()}`) : prefix;
    const kids = optionalEntry(field, 'Kids')?.resolve();
    if (kids && kids.isArray()) {
      for (let i = 0; i < kids.length; i++) this.collectNames(kids.get(i).resolve(), full);
    }
    if (full !== '') this.names.add(full);
  }

  /** The source AcroForm's /DR resources the document does not have yet. */
  private mergeResources(acro: Mu.PDFObject): void {
    if (this.resources) return;
    this.resources = true;
    const srcAcro = optionalEntry(this.src.getTrailer().get('Root'), 'AcroForm')?.resolve();
    const srcDr = srcAcro && srcAcro.isDictionary() ? optionalEntry(srcAcro, 'DR')?.resolve() : undefined;
    if (!srcDr || !srcDr.isDictionary()) return;
    let dr = optionalEntry(acro, 'DR')?.resolve();
    if (!dr || !dr.isDictionary()) {
      acro.put('DR', this.out.newDictionary());
      dr = acro.get('DR').resolve();
    }
    const have = dr;
    srcDr.forEach((group, key) => {
      const name = String(key);
      const mine = optionalEntry(have, name)?.resolve();
      const incoming = group.resolve();
      if (!mine || !mine.isDictionary()) {
        have.put(name, this.map.graftObject(group));
      } else if (incoming.isDictionary()) {
        incoming.forEach((value, entry) => {
          if (optionalEntry(mine, String(entry)) === undefined) mine.put(String(entry), this.map.graftObject(value));
        });
      }
    });
    if (srcAcro && optionalEntry(acro, 'DA') === undefined) {
      const da = optionalEntry(srcAcro, 'DA');
      if (da) acro.put('DA', da);
    }
  }

  /** A name for a new field that the document does not have yet. */
  private uniqueName(base: string): string {
    let name = base;
    for (let n = 2; this.names.has(name); n++) name = `${base}_${n}`;
    this.names.add(name);
    return name;
  }

  /** The full name of a source field: the partial names from the top, joined with "_". */
  private fullName(field: Mu.PDFObject): string {
    const parts: string[] = [];
    let at: Mu.PDFObject | undefined = field;
    for (let depth = 0; at && depth < 32; depth++) {
      const t = optionalEntry(at, 'T');
      if (t && t.isString()) parts.unshift(t.asString());
      const parent: Mu.PDFObject | undefined = optionalEntry(at, 'Parent')?.resolve();
      at = parent && parent.isDictionary() ? parent : undefined;
    }
    return parts.join('_');
  }

  /**
   * Called for each copied widget. `copy` is the new widget dictionary (not yet written to `ref`). A widget that is itself the
   * field (no parent field) is listed as a field. One with a parent field joins the one field this carry made for that parent.
   */
  attach(srcWidget: Mu.PDFObject, ref: Mu.PDFObject, copy: Mu.PDFObject): void {
    const list = this.ensure();
    const parentRaw = optionalEntry(srcWidget, 'Parent');
    const parent = parentRaw?.resolve();
    if (!parentRaw || !parent || !parent.isDictionary()) {
      copy.put('T', this.out.newString(this.uniqueName(this.fullName(srcWidget) || 'field')));
      list.push(ref);
      return;
    }
    const key = parentRaw.isIndirect() ? parentRaw.asIndirect() : -1;
    let field = key >= 0 ? this.made.get(key) : undefined;
    if (!field) {
      const dict = this.out.newDictionary();
      // The field's own entries, then what it inherits from the fields above it.
      parent.forEach((value, k) => {
        const name = String(k);
        if (name !== 'Parent' && name !== 'Kids' && name !== 'T' && !REBUILT_KEYS.has(name)) dict.put(name, this.map.graftObject(value));
      });
      for (const inherited of INHERITED_FIELD_KEYS) {
        if (optionalEntry(parent, inherited) !== undefined) continue;
        let up: Mu.PDFObject | undefined = optionalEntry(parent, 'Parent')?.resolve();
        for (let depth = 0; up && up.isDictionary() && depth < 32; depth++) {
          const value = optionalEntry(up, inherited);
          if (value) {
            dict.put(inherited, this.map.graftObject(value));
            break;
          }
          up = optionalEntry(up, 'Parent')?.resolve();
        }
      }
      dict.put('T', this.out.newString(this.uniqueName(this.fullName(parent) || 'field')));
      dict.put('Kids', this.out.newArray());
      field = this.out.addObject(dict);
      if (key >= 0) this.made.set(key, field);
      list.push(field);
    }
    copy.put('Parent', field);
    field.resolve().get('Kids').push(ref);
  }
}

/**
 * Everything a copied page needs besides its content, in one object per edit or extract: its comments and markup, its form
 * fields, and its links. Create one with the graft map of the edit, call `carry` after each page is grafted, and let it go.
 */
export class PageCarrier {
  private readonly forms: FormCarry | undefined;

  /** `withForms` false is for Split, which flattens the fields first. */
  constructor(
    private readonly out: Mu.PDFDocument,
    private readonly src: Mu.PDFDocument,
    private readonly map: Mu.PDFGraftMap,
    withForms = true,
  ) {
    this.forms = withForms ? new FormCarry(out, src, map) : undefined;
  }

  /** Carries the comments, markup and form fields of source page `srcIndex` onto the page now at `outIndex`. */
  carry(srcIndex: number, outIndex: number): void {
    copyPageAnnotations(this.out, this.map, this.src.findPage(srcIndex), this.out.findPage(outIndex), this.forms);
  }

  /**
   * Rebuilds the links of source page `srcIndex` on the page at `outIndex`. Call it AFTER every page of the copy is in place: an
   * internal link names its target page by number, and the page has to exist. `newIndexOf` maps a source page index to its
   * index in the output, or null when that page is not there (the link is removed).
   */
  carryLinks(srcIndex: number, outIndex: number, newIndexOf: (sourceIndex: number) => number | null): void {
    const srcPage = this.src.loadPage(srcIndex);
    const outPage = this.out.loadPage(outIndex);
    try {
      carryLinks(this.src, srcPage, outPage, newIndexOf);
      outPage.update();
    } finally {
      outPage.destroy();
      srcPage.destroy();
    }
  }
}
