/**
 * Bookmarks for a Split part (blueprint B1: "Split gives each part the bookmarks that point into it. A bookmark to a
 * left-out page is dropped").
 *
 * The tree is read from the source with `Document.loadOutline`, cut to the part's pages and renumbered (pure functions, no
 * document), and written into the part as outline objects. They are written directly: this MuPDF build's
 * `outlineIterator().insert` only builds a flat list (after an insert `down()` does not move, see jobProbes.test.ts), and
 * nesting is part of the carry.
 *
 * A bookmark whose own page is left out but which has children inside the part is dropped and its children take its place.
 */
import type * as Mu from 'mupdf';
import { cleanOutlineTitle } from '../outlineTitle';

/** A bookmark with a 0-based page of the document it was read from. `view` is the destination's position, when known. */
export interface BookmarkNode {
  title: string;
  page: number | null;
  open: boolean;
  /** Left and top in page space, and the zoom (null for "keep"), from the source destination. */
  view?: { x: number | null; y: number | null; zoom: number | null };
  children: BookmarkNode[];
}

type OutlineItem = NonNullable<ReturnType<Mu.Document['loadOutline']>>[number];

/** The `zoom=z,x,y` part of a MuPDF destination URI, as numbers (NaN and missing parts become null). */
export function viewOfUri(uri: string | undefined): BookmarkNode['view'] | undefined {
  const match = /zoom=([^&]*)/.exec(uri ?? '');
  if (!match) return undefined;
  const [zoom, x, y] = match[1]!.split(',').map((text) => {
    const value = Number(text);
    return text === '' || !Number.isFinite(value) ? null : value;
  });
  return { zoom: zoom ?? null, x: x ?? null, y: y ?? null };
}

/** The outline of a document as a tree. Page numbers are 0-based; a target outside the document is null. */
export function readBookmarks(doc: Mu.Document, pageCount: number): BookmarkNode[] {
  const convert = (items: OutlineItem[] | null | undefined): BookmarkNode[] =>
    (items ?? []).map((item) => {
      const page = typeof item.page === 'number' && item.page >= 0 && item.page < pageCount ? item.page : null;
      const view = viewOfUri(item.uri);
      return {
        title: cleanOutlineTitle(item.title ?? ''),
        page,
        open: item.open === true,
        ...(view ? { view } : {}),
        children: convert(item.down),
      };
    });
  return convert(doc.loadOutline());
}

/** The top-level bookmarks that point into the document, in order, with 1-based pages (for Split by bookmarks). */
export function topLevelEntries(tree: readonly BookmarkNode[]): Array<{ title: string; page: number }> {
  const out: Array<{ title: string; page: number }> = [];
  for (const node of tree) if (node.page !== null) out.push({ title: node.title, page: node.page + 1 });
  return out;
}

/**
 * The bookmarks that point into pages `from..to` (0-based, inclusive), with their pages renumbered so `from` becomes 0.
 * A parent outside the range is replaced by its children that are inside.
 */
export function remapBookmarks(tree: readonly BookmarkNode[], from: number, to: number): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  for (const node of tree) {
    const children = remapBookmarks(node.children, from, to);
    if (node.page !== null && node.page >= from && node.page <= to) {
      out.push({ ...node, page: node.page - from, children });
    } else {
      out.push(...children);
    }
  }
  return out;
}

/**
 * The bookmarks whose page is in the output, renumbered by `newIndexOf` (a 0-based source page to its 0-based page in the output,
 * or null when the page is not there). For Combine, where a file contributes chosen pages, maybe not in a run. A parent whose page
 * is not there is replaced by its children that are.
 */
export function remapBookmarksBy(tree: readonly BookmarkNode[], newIndexOf: (page: number) => number | null): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  for (const node of tree) {
    const children = remapBookmarksBy(node.children, newIndexOf);
    const mapped = node.page === null ? null : newIndexOf(node.page);
    if (mapped !== null) out.push({ ...node, page: mapped, children });
    else out.push(...children);
  }
  return out;
}

/** The number of bookmarks in a tree. */
export function countBookmarks(tree: readonly BookmarkNode[]): number {
  return tree.reduce((sum, node) => sum + 1 + countBookmarks(node.children), 0);
}

/**
 * Writes `tree` as the outline of `pdf`. Page numbers are 0-based positions in `pdf`. Does nothing for an empty tree.
 * Each item gets /Title, /Parent, /Prev, /Next, /First, /Last, /Count and a /Dest [page /XYZ x y zoom].
 */
export function writeBookmarks(mu: Pick<typeof Mu, 'Matrix'>, pdf: Mu.PDFDocument, tree: readonly BookmarkNode[]): void {
  if (tree.length === 0) return;
  const outlines = pdf.createObject();
  const built = build(mu, pdf, tree, outlines)!;
  const dict = pdf.newDictionary();
  dict.put('Type', pdf.newName('Outlines'));
  dict.put('First', built.first);
  dict.put('Last', built.last);
  dict.put('Count', built.total);
  outlines.writeObject(dict);
  pdf.getTrailer().get('Root').put('Outlines', outlines);
}

interface Built {
  first: Mu.PDFObject;
  last: Mu.PDFObject;
  /** Items created in this level and below. */
  total: number;
}

/** Creates the items of one level under `parent`. Null for an empty level. */
function build(mu: Pick<typeof Mu, 'Matrix'>, pdf: Mu.PDFDocument, level: readonly BookmarkNode[], parent: Mu.PDFObject): Built | null {
  if (level.length === 0) return null;
  const refs = level.map(() => pdf.createObject());
  let total = 0;
  level.forEach((node, i) => {
    const dict = pdf.newDictionary();
    dict.put('Title', pdf.newString(node.title));
    dict.put('Parent', parent);
    if (i > 0) dict.put('Prev', refs[i - 1]!);
    if (i < level.length - 1) dict.put('Next', refs[i + 1]!);
    const dest = pdf.newArray();
    dest.push(pdf.findPage(Math.max(0, node.page ?? 0)));
    const pos = node.view === undefined ? null : userSpaceView(mu, pdf, Math.max(0, node.page ?? 0), node.view);
    if (pos) {
      dest.push(pdf.newName('XYZ'));
      dest.push(pdf.newReal(pos.x));
      dest.push(pdf.newReal(pos.y));
      dest.push(pos.zoom === null ? pdf.newNull() : pdf.newReal(pos.zoom));
    } else {
      dest.push(pdf.newName('Fit'));
    }
    dict.put('Dest', dest);
    const below = build(mu, pdf, node.children, refs[i]!);
    if (below) {
      dict.put('First', below.first);
      dict.put('Last', below.last);
      dict.put('Count', node.open ? below.total : -below.total);
    }
    refs[i]!.writeObject(dict);
    total += 1 + (below?.total ?? 0);
  });
  return { first: refs[0]!, last: refs[refs.length - 1]!, total };
}

/**
 * The position of a destination as /XYZ wants it. MuPDF reports `zoom=Z,X,Y` in ITS page space (y down from the top of the
 * displayed page, after /Rotate and the crop origin) with the zoom in percent. PDF wants the user space of the page (y up, the
 * page's own coordinates) and a zoom factor. So the point goes back through the inverse of the page's transform, and the zoom is
 * divided by 100 (not a number or not positive: null, keep the viewer's zoom). Null when the position is not known.
 */
export function userSpaceView(
  mu: Pick<typeof Mu, 'Matrix'>,
  pdf: Mu.PDFDocument,
  pageIndex: number,
  view: NonNullable<BookmarkNode['view']>,
): { x: number; y: number; zoom: number | null } | null {
  if (view.x === null || view.y === null) return null;
  const page = pdf.loadPage(pageIndex);
  try {
    const [a, b, c, d, e, f] = mu.Matrix.invert(page.getTransform());
    const zoom = view.zoom !== null && Number.isFinite(view.zoom) && view.zoom > 0 ? view.zoom / 100 : null;
    return { x: a * view.x + c * view.y + e, y: b * view.x + d * view.y + f, zoom };
  } finally {
    page.destroy();
  }
}
