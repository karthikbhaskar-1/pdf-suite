/**
 * Keeps the document catalog and the accessibility tags through the page edits that go through MuPDF's rearrangePages
 * (Delete, Move, Reverse). Ticket 1.5.9, docs/milestone-1.5/structtree-ruling.md.
 *
 * Why this exists: the WASM binding of `rearrangePages` builds a NEW catalog that keeps only /Pages, /Outlines,
 * /OCProperties and /Names/Dests, and it drops the structure tree. So one page delete used to take away the form
 * definition (/AcroForm), the metadata, the language, /MarkInfo, the JavaScript and attachment name trees, the viewer
 * preferences, the permissions and the tags, and Undo did not bring them back.
 *
 * What is done here, around the call:
 *  1. (guard) one journaled write to the old catalog, so the journal holds the whole old catalog and Undo restores it;
 *  2. rearrangePages;
 *  3. every catalog entry MuPDF dropped is put back (journaled writes, so Undo and Redo move them with the pages);
 *  4. page labels are restored (Move, Reverse) or shifted (Delete);
 *  5. Delete only: what the delete took away is found by comparing the pages before and after (a page object, annotation or
 *     ParentTree key that no remaining page uses). The structure tree, the form's field tree, the name trees that name pages
 *     and the catalog's page references are pruned of it, so the saved file holds no object of a deleted page.
 *
 * Every function must run inside one journal operation (editCore.ts opens it). Nothing here edits a stream.
 */
import type * as Mu from 'mupdf';

/**
 * What the delete took away, found by comparing the pages before and after MuPDF ran: a page object, an annotation object
 * or a ParentTree key is gone only when no page that is left uses it. So an annotation MuPDF removed from a page that stays
 * (a link to a deleted page) counts as gone, and a key or widget that a kept page still has never does.
 */
export interface GoneFacts {
  pages: Set<number>;
  annots: Set<number>;
  treeKeys: Set<number>;
  /** The annotation objects on the pages that are left. */
  remainingAnnots: Set<number>;
}

/** The page objects, annotation objects and ParentTree keys of all pages at one moment. */
interface PageScan {
  pages: Set<number>;
  annots: Set<number>;
  keys: Set<number>;
}

/** Catalog keys that are not put back as they were: MuPDF rebuilds /Outlines, and /Names and /PageLabels are handled apart. */
const NOT_RESTORED_AS_IS = new Set(['Names', 'Outlines', 'PageLabels']);

/** The entry under `key`, or undefined when the dictionary has none (a lookup of a missing key is not a clean null in MuPDF). */
function opt(dict: Mu.PDFObject, key: string): Mu.PDFObject | undefined {
  let present = false;
  dict.forEach((_value, name) => {
    if (String(name) === key) present = true;
  });
  return present ? dict.get(key) : undefined;
}

function keysOf(dict: Mu.PDFObject): string[] {
  const keys: string[] = [];
  dict.forEach((_value, name) => keys.push(String(name)));
  return keys;
}

/** The object number of an indirect reference, or null for a direct object or a missing one. */
function numOf(obj: Mu.PDFObject | undefined): number | null {
  return obj !== undefined && obj.isIndirect() ? obj.asIndirect() : null;
}

/** The resolved array under `key`, or null. */
function arrayOf(dict: Mu.PDFObject, key: string): Mu.PDFObject | null {
  const entry = opt(dict, key)?.resolve();
  return entry && entry.isArray() ? entry : null;
}

function rootOf(pdf: Mu.PDFDocument): Mu.PDFObject {
  return pdf.getTrailer().get('Root');
}

// ---- What goes -----------------------------------------------------------------------------------------------------

/** Every page's object number, its annotations' object numbers, and the ParentTree keys the pages and annotations use. */
function scanPages(pdf: Mu.PDFDocument): PageScan {
  const scan: PageScan = { pages: new Set(), annots: new Set(), keys: new Set() };
  const total = pdf.countPages();
  for (let i = 0; i < total; i++) {
    const page = pdf.findPage(i);
    const pageNum = numOf(page);
    if (pageNum !== null) scan.pages.add(pageNum);
    const parents = opt(page, 'StructParents');
    if (parents && parents.isNumber()) scan.keys.add(parents.asNumber());
    const list = arrayOf(page, 'Annots');
    if (!list) continue;
    for (let j = 0; j < list.length; j++) {
      const annot = list.get(j);
      const annotNum = numOf(annot);
      if (annotNum !== null) scan.annots.add(annotNum);
      const dict = annot.resolve();
      if (!dict.isDictionary()) continue;
      const key = opt(dict, 'StructParent');
      if (key && key.isNumber()) scan.keys.add(key.asNumber());
    }
  }
  return scan;
}

function difference<T>(from: ReadonlySet<T>, minus: ReadonlySet<T>): Set<T> {
  const out = new Set<T>();
  for (const item of from) if (!minus.has(item)) out.add(item);
  return out;
}

/** What is in `before` and in no page of `after`. */
function goneFacts(before: PageScan, after: PageScan): GoneFacts {
  return {
    pages: difference(before.pages, after.pages),
    annots: difference(before.annots, after.annots),
    treeKeys: difference(before.keys, after.keys),
    remainingAnnots: after.annots,
  };
}

// ---- Page labels ---------------------------------------------------------------------------------------------------

export interface LabelRange {
  /** The page position (0-based) where the range starts. */
  at: number;
  dict: Mu.PDFObject;
}

/** The (key, value) pairs of a number tree, flattened. Reads /Nums and walks /Kids without recursion; a cycle is walked once. */
function numberTreeEntries(root: Mu.PDFObject): Array<[number, Mu.PDFObject]> {
  const out: Array<[number, Mu.PDFObject]> = [];
  const seen = new Set<number>();
  const todo = [root];
  while (todo.length > 0) {
    const node = todo.pop()!;
    const id = numOf(node);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const dict = node.resolve();
    if (!dict.isDictionary()) continue;
    const nums = arrayOf(dict, 'Nums');
    if (nums) {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const key = nums.get(i);
        if (key.isNumber()) out.push([key.asNumber(), nums.get(i + 1)]);
      }
    }
    const kids = arrayOf(dict, 'Kids');
    if (kids) for (let i = kids.length - 1; i >= 0; i--) todo.push(kids.get(i));
  }
  return out;
}

/** The ranges of a /PageLabels number tree, in page order. */
function labelRanges(node: Mu.PDFObject): LabelRange[] {
  return numberTreeEntries(node).map(([at, dict]) => ({ at, dict }));
}

function writeLabelRanges(pdf: Mu.PDFDocument, root: Mu.PDFObject, ranges: readonly LabelRange[]): void {
  if (ranges.length === 0) return;
  const nums = pdf.newArray();
  for (const range of ranges) {
    nums.push(pdf.newInteger(range.at));
    nums.push(range.dict);
  }
  const tree = pdf.newDictionary();
  tree.put('Nums', nums);
  root.put('PageLabels', tree);
}

/**
 * The ranges after pages were deleted: each range starts at the first kept page it had, counted in the new list, and keeps
 * its own style, prefix and start number, so the numbering of the pages that stay runs on without a gap. A range whose
 * pages were all deleted is dropped.
 */
export function shiftedLabelRanges(ranges: readonly LabelRange[], keep: readonly number[]): LabelRange[] {
  const sorted = [...ranges].sort((a, b) => a.at - b.at);
  const out: LabelRange[] = [];
  for (let r = 0; r < sorted.length; r++) {
    const from = sorted[r]!.at;
    const to = r + 1 < sorted.length ? sorted[r + 1]!.at : Infinity;
    const first = keep.findIndex((old) => old >= from && old < to);
    if (first < 0) continue;
    const previous = out[out.length - 1];
    if (previous && previous.at === first) out.pop();
    out.push({ at: first, dict: sorted[r]!.dict });
  }
  return out;
}

// ---- The catalog ---------------------------------------------------------------------------------------------------

/** True when a destination (an array whose first item is a page) or a GoTo action points at a deleted page. */
function targetsGonePage(obj: Mu.PDFObject, gone: GoneFacts, depth = 0): boolean {
  const dict = obj.resolve();
  if (dict.isArray()) {
    if (dict.length === 0) return false;
    const page = numOf(dict.get(0));
    return page !== null && gone.pages.has(page);
  }
  if (dict.isDictionary() && depth < 4) {
    const dest = opt(dict, 'D');
    if (dest) return targetsGonePage(dest, gone, depth + 1);
  }
  return false;
}

/** The old-style /Dests dictionary and /Threads: what still points at a deleted page is dropped. Other entries stay. */
function pruneRestoredPageReferences(root: Mu.PDFObject, gone: GoneFacts): void {
  const open = opt(root, 'OpenAction');
  if (open && targetsGonePage(open, gone)) root.delete('OpenAction');
  const dests = opt(root, 'Dests')?.resolve();
  if (dests && dests.isDictionary()) {
    for (const key of keysOf(dests)) if (targetsGonePage(dests.get(key), gone)) dests.delete(key);
  }
  const threads = arrayOf(root, 'Threads');
  if (threads) {
    for (let i = threads.length - 1; i >= 0; i--) if (threadTouchesGonePage(threads.get(i), gone)) threads.delete(i);
  }
}

/** True when any bead of an article thread sits on a deleted page. */
function threadTouchesGonePage(thread: Mu.PDFObject, gone: GoneFacts): boolean {
  const dict = thread.resolve();
  if (!dict.isDictionary()) return false;
  const first = opt(dict, 'F');
  if (!first) return false;
  const start = numOf(first);
  let bead = first;
  const seen = new Set<number>();
  for (let guard = 0; guard < 100000; guard++) {
    const id = numOf(bead);
    if (id !== null) {
      if (seen.has(id)) return false;
      seen.add(id);
    }
    const beadDict = bead.resolve();
    if (!beadDict.isDictionary()) return false;
    const page = numOf(opt(beadDict, 'P'));
    if (page !== null && gone.pages.has(page)) return true;
    const next = opt(beadDict, 'N');
    if (!next || (start !== null && numOf(next) === start)) return false;
    bead = next;
  }
  return false;
}

/**
 * rearrangePages with the catalog kept. `order` lists the old page positions in their new order (a full permutation for
 * Move and Reverse, the kept pages for Delete). With `deleting` the structure tree, the form's field tree, the name trees
 * and the catalog's page references are pruned of what the delete took away, and page labels are shifted; otherwise
 * the labels are restored as they were.
 */
export function rearrangeKeepingCatalog(pdf: Mu.PDFDocument, order: readonly number[], deleting: boolean): void {
  const root = rootOf(pdf);
  const before = deleting ? scanPages(pdf) : null;
  const saved = new Map<string, Mu.PDFObject>();
  root.forEach((value, name) => void saved.set(String(name), value));
  const names = opt(root, 'Names')?.resolve();
  const savedNames = new Map<string, Mu.PDFObject>();
  if (names && names.isDictionary()) for (const key of keysOf(names)) savedNames.set(key, names.get(key));
  const labels = opt(root, 'PageLabels');
  const ranges = labels ? labelRanges(labels) : [];

  // A journaled write to the old catalog: the journal now holds the whole old catalog, so Undo gives it back.
  root.put('Type', pdf.newName('Catalog'));
  pdf.rearrangePages([...order]);

  const now = rootOf(pdf);
  const present = new Set(keysOf(now));
  for (const [key, value] of saved) {
    if (NOT_RESTORED_AS_IS.has(key) || present.has(key)) continue;
    now.put(key, value);
  }
  // MuPDF rebuilt /Names/Dests with the valid destinations. Every other name tree (JavaScript, attachments) goes back.
  const restoredNames = [...savedNames].filter(([key]) => key !== 'Dests');
  if (restoredNames.length > 0) {
    let target = opt(now, 'Names')?.resolve();
    if (!target || !target.isDictionary()) {
      target = pdf.newDictionary();
      now.put('Names', target);
    }
    for (const [key, value] of restoredNames) target.put(key, value);
  }
  if (ranges.length > 0) {
    // Move and Reverse: the labels stay with the page positions, as they were. Delete: the ranges shift with the pages.
    writeLabelRanges(pdf, now, deleting ? shiftedLabelRanges(ranges, order) : ranges);
  }
  if (before) {
    const gone = goneFacts(before, scanPages(pdf));
    repointStaleAnnotationPages(pdf, gone);
    pruneRestoredPageReferences(now, gone);
    pruneNamedPages(now, gone);
    pruneStructure(pdf, gone);
    pruneFields(pdf, gone);
  }
}

/** What a page held before its content was replaced in place (Replace page): its object, its annotations, its structure keys. */
export interface ReplacedPage {
  page: number | null;
  annots: Set<number>;
  keys: Set<number>;
}

export function snapshotReplacedPage(page: Mu.PDFObject): ReplacedPage {
  const out: ReplacedPage = { page: numOf(page), annots: new Set(), keys: new Set() };
  const parents = opt(page, 'StructParents');
  if (parents && parents.isNumber()) out.keys.add(parents.asNumber());
  const list = arrayOf(page, 'Annots');
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const annot = list.get(i);
    const id = numOf(annot);
    if (id !== null) out.annots.add(id);
    const dict = annot.resolve();
    const key = dict.isDictionary() ? opt(dict, 'StructParent') : undefined;
    if (key && key.isNumber()) out.keys.add(key.asNumber());
  }
  return out;
}

/**
 * After a page's content was replaced in place: what the old content held is gone, so the form's field tree loses the widgets
 * it had, and the structure tree loses the marked content on the page, the object references to its annotations and their
 * ParentTree keys. Without this the old widgets stay in /Fields as fields with no page, and the old page's annotations and
 * their appearance streams stay in the saved file through the tags. The page itself stays (its object is reused).
 */
export function pruneAfterPageReplace(pdf: Mu.PDFDocument, before: ReplacedPage): void {
  if (before.annots.size === 0 && before.keys.size === 0 && before.page === null) return;
  const left = scanPages(pdf);
  const remaining = left.annots;
  const annots = difference(before.annots, remaining);
  pruneFields(pdf, { pages: new Set(), annots, treeKeys: new Set(), remainingAnnots: remaining });
  // A key that another page (or the page's new content) still uses keeps its ParentTree entry, as in the delete path.
  const treeKeys = difference(before.keys, left.keys);
  pruneStructure(pdf, { pages: before.page !== null ? new Set([before.page]) : new Set(), annots, treeKeys, remainingAnnots: remaining });
}

/** An annotation on a page that stays can still name a deleted page in its /P. That would keep the deleted page in the file. */
function repointStaleAnnotationPages(pdf: Mu.PDFDocument, gone: GoneFacts): void {
  if (gone.pages.size === 0) return;
  const total = pdf.countPages();
  for (let i = 0; i < total; i++) {
    const page = pdf.findPage(i);
    const list = arrayOf(page, 'Annots');
    if (!list) continue;
    for (let j = 0; j < list.length; j++) {
      const annot = list.get(j).resolve();
      if (!annot.isDictionary()) continue;
      const owner = numOf(opt(annot, 'P'));
      if (owner !== null && gone.pages.has(owner)) annot.put('P', page);
    }
  }
}

/** Name trees whose values are pages (or content sets of pages): an entry that names a deleted page goes. */
const PAGE_NAME_TREES = ['Pages', 'Templates', 'IDS', 'URLS'];

function namesGonePage(value: Mu.PDFObject, gone: GoneFacts): boolean {
  const id = numOf(value);
  if (id !== null && gone.pages.has(id)) return true;
  const dict = value.resolve();
  if (dict.isArray()) return dict.length > 0 && targetsGonePage(dict, gone);
  if (!dict.isDictionary()) return false;
  const content = arrayOf(dict, 'O'); // a web-capture content set lists its pages
  if (!content) return false;
  for (let i = 0; i < content.length; i++) {
    const page = numOf(content.get(i));
    if (page !== null && gone.pages.has(page)) return true;
  }
  return false;
}

function pruneNamedPages(root: Mu.PDFObject, gone: GoneFacts): void {
  const names = opt(root, 'Names')?.resolve();
  if (!names || !names.isDictionary()) return;
  for (const key of PAGE_NAME_TREES) {
    const tree = opt(names, key);
    if (!tree) continue;
    const seen = new Set<number>();
    const todo = [tree];
    while (todo.length > 0) {
      const node = todo.pop()!;
      const id = numOf(node);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const dict = node.resolve();
      if (!dict.isDictionary()) continue;
      const pairs = arrayOf(dict, 'Names');
      if (pairs) {
        for (let i = pairs.length - 2; i >= 0; i -= 2) {
          if (!namesGonePage(pairs.get(i + 1), gone)) continue;
          pairs.delete(i + 1);
          pairs.delete(i);
        }
      }
      const kids = arrayOf(dict, 'Kids');
      if (kids) for (let i = 0; i < kids.length; i++) todo.push(kids.get(i));
    }
  }
}

// ---- Structure tree ------------------------------------------------------------------------------------------------

/** One structure element being pruned: the position it has reached in its kids (counted down) and what it lost and kept. */
interface Frame {
  elem: Mu.PDFObject;
  elemPg: number | null;
  list: Mu.PDFObject | null;
  single: Mu.PDFObject | null;
  i: number;
  lost: number;
  left: number;
}

/**
 * Removes from the structure tree what belonged to the deleted pages: marked-content references and object references on
 * them, the /Pg that names them, structure elements left with no content, and the ParentTree entries of their keys. The
 * elements of the pages that stay are not touched, so their tags and marked-content ids stay valid. The walk keeps its own
 * stack, so a very deep tree cannot overflow the call stack, and an element reached twice (a cycle) is visited once.
 */
export function pruneStructure(pdf: Mu.PDFDocument, gone: GoneFacts): void {
  const treeRef = opt(rootOf(pdf), 'StructTreeRoot');
  const tree = treeRef?.resolve();
  if (!treeRef || !tree || !tree.isDictionary()) return;
  const seen = new Set<number>();
  const pageGone = (pg: number | null): boolean => pg !== null && gone.pages.has(pg);

  const open = (ref: Mu.PDFObject): Frame | null => {
    const id = numOf(ref);
    if (id !== null) {
      if (seen.has(id)) return null;
      seen.add(id);
    }
    const elem = ref.resolve();
    if (!elem.isDictionary()) return null;
    const elemPg = numOf(opt(elem, 'Pg'));
    const k = opt(elem, 'K');
    if (!k) {
      if (pageGone(elemPg)) elem.delete('Pg');
      return null;
    }
    const resolved = k.resolve();
    const list = resolved.isArray() ? resolved : null;
    return { elem, elemPg, list, single: list ? null : k, i: (list ? list.length : 1) - 1, lost: 0, left: 0 };
  };
  const settle = (frame: Frame, drop: boolean): void => {
    if (drop) {
      frame.lost++;
      if (frame.list) frame.list.delete(frame.i);
      else frame.elem.delete('K');
    } else frame.left++;
    frame.i--;
  };

  const rootFrame = open(treeRef);
  const stack: Frame[] = rootFrame ? [rootFrame] : [];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.i < 0) {
      if (pageGone(frame.elemPg)) frame.elem.delete('Pg');
      const emptied = frame.lost > 0 && frame.left === 0;
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) settle(parent, emptied);
      continue;
    }
    const kid = frame.list ? frame.list.get(frame.i) : frame.single!;
    const kidDict = kid.resolve();
    if (kidDict.isNumber()) {
      settle(frame, pageGone(frame.elemPg)); // a marked-content id on the element's page
      continue;
    }
    if (!kidDict.isDictionary()) {
      settle(frame, false);
      continue;
    }
    const type = opt(kidDict, 'Type');
    const typeName = type && type.isName() ? type.asName() : '';
    const pg = numOf(opt(kidDict, 'Pg')) ?? frame.elemPg;
    if (typeName === 'MCR' || (typeName === '' && opt(kidDict, 'MCID') !== undefined)) {
      settle(frame, pageGone(pg));
    } else if (typeName === 'OBJR' || (typeName === '' && opt(kidDict, 'Obj') !== undefined)) {
      const target = numOf(opt(kidDict, 'Obj'));
      settle(frame, pageGone(pg) || (target !== null && gone.annots.has(target)));
    } else {
      const child = open(kid);
      if (child) stack.push(child); // the parent waits at this kid; the child's result settles it
      else settle(frame, false);
    }
  }

  const parentTree = opt(tree, 'ParentTree');
  if (parentTree && gone.treeKeys.size > 0) {
    const all = numberTreeEntries(parentTree);
    const entries = all.filter(([key]) => !gone.treeKeys.has(key));
    if (entries.length !== all.length) {
      entries.sort((a, b) => a[0] - b[0]);
      const nums = pdf.newArray();
      for (const [key, value] of entries) {
        nums.push(pdf.newInteger(key));
        nums.push(value);
      }
      const fresh = pdf.newDictionary();
      fresh.put('Nums', nums);
      tree.put('ParentTree', pdf.addObject(fresh));
    }
  }
}

// ---- Form fields ---------------------------------------------------------------------------------------------------

/** Deeper field trees than this are not real; the walk leaves them alone rather than recurse without bound. */
const MAX_FIELD_DEPTH = 256;

/** The appearance states a widget can show (the keys of /AP /N other than Off). */
function statesOf(widget: Mu.PDFObject): string[] {
  const dict = widget.resolve();
  if (!dict.isDictionary()) return [];
  const ap = opt(dict, 'AP')?.resolve();
  const normal = ap && ap.isDictionary() ? opt(ap, 'N')?.resolve() : undefined;
  return normal && normal.isDictionary() ? keysOf(normal).filter((key) => key !== 'Off') : [];
}

function statesOfAll(kids: Mu.PDFObject): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < kids.length; i++) for (const state of statesOf(kids.get(i))) out.add(state);
  return out;
}

/**
 * Takes the widgets of deleted pages out of the form's field tree (/Fields and /CO), and the fields left with no widget.
 * A widget that is still on a page that stays is kept, whatever its /P says. A radio group whose chosen button was on a
 * deleted page is set back to Off.
 */
export function pruneFields(pdf: Mu.PDFDocument, gone: GoneFacts): void {
  const acro = opt(rootOf(pdf), 'AcroForm')?.resolve();
  if (!acro || !acro.isDictionary() || gone.annots.size + gone.pages.size === 0) return;
  /** Fields taken out of /Fields, so /CO drops them too. */
  const dead = new Set<number>();
  let seen = new Set<number>();
  const widgetGone = (id: number | null, field: Mu.PDFObject): boolean => {
    if (id !== null && gone.annots.has(id)) return true;
    if (id !== null && gone.remainingAnnots.has(id)) return false;
    const page = numOf(opt(field, 'P'));
    return page !== null && gone.pages.has(page);
  };
  const walk = (list: Mu.PDFObject, depth: number): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const ref = list.get(i);
      const id = numOf(ref);
      if (id !== null) {
        if (dead.has(id)) {
          list.delete(i);
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const field = ref.resolve();
      if (!field.isDictionary()) continue;
      const kids = arrayOf(field, 'Kids');
      if (kids && kids.length > 0) {
        if (depth >= MAX_FIELD_DEPTH) continue;
        walk(kids, depth + 1);
        if (kids.length === 0) {
          if (id !== null) dead.add(id);
          list.delete(i);
        } else {
          // A radio group or checkbox set to the state of a button that is gone: no button left can show it, so the group
          // goes back to Off. (MuPDF may already have dropped the button before this runs, so the kids are all that is read.)
          const value = opt(field, 'V');
          const chosen = value && value.isName() ? value.asName() : '';
          if (chosen !== '' && chosen !== 'Off') {
            const states = statesOfAll(kids);
            if (states.size > 0 && !states.has(chosen)) field.put('V', pdf.newName('Off'));
          }
        }
      } else if (widgetGone(id, field)) {
        if (id !== null) dead.add(id);
        list.delete(i);
      }
    }
  };
  for (const key of ['Fields', 'CO']) {
    const list = arrayOf(acro, key);
    if (!list) continue;
    seen = new Set();
    walk(list, 0);
  }
}
