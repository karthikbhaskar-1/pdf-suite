/**
 * Copies pages between two PDF documents of one worker with ONE graft map.
 *
 * Why: `PDFDocument.graftPage` makes a fresh map on every call, and a fresh map copies every shared font, image and
 * resource dictionary again (garbage=compact does not merge duplicates). A 50-page extract of a file whose pages share
 * resources came out many times larger than its source. One `PDFGraftMap` remembers what it copied, so a shared
 * object is copied once.
 *
 * Pinned by jobProbes.test.ts: this MuPDF build's graftPage carries content, resources and the page boxes, and does NOT
 * carry /Annots (so no links, comments or widgets). Callers that need annotations carry them themselves (see
 * annotCarry.ts); the callers of this file keep the behaviour they always had.
 *
 * A map must never outlive the edit that made it: an undo removes objects that a kept map would still point at. The
 * helpers here create the map, use it and destroy it.
 */
import type * as Mu from 'mupdf';
import { PageCarrier } from './annotCarry';

/**
 * Grafts the pages `indices` of `src`, in that order, after the last page of `out`. One map for the whole call.
 * With `carry` the pages also bring what graftPage leaves behind (see annotCarry.ts): comments and markup, form fields (merged
 * into the AcroForm of `out`), and links (a link to a page that is among `indices` is renumbered, any other internal link is
 * removed). `withForms` false leaves the form fields out (Split flattens them first).
 */
export function graftPages(
  out: Mu.PDFDocument,
  src: Mu.PDFDocument,
  indices: readonly number[],
  map?: Mu.PDFGraftMap,
  options: { carry?: boolean; withForms?: boolean } = {},
): void {
  const own = map ?? out.newGraftMap();
  try {
    const first = out.countPages();
    const position = new Map<number, number>();
    indices.forEach((index, k) => {
      if (!position.has(index)) position.set(index, first + k);
    });
    for (const index of indices) own.graftPage(out.countPages(), src, index);
    if (options.carry) {
      const carrier = new PageCarrier(out, src, own, options.withForms !== false);
      indices.forEach((index, k) => carrier.carry(index, first + k));
      // Links last: an internal link names its target page by number, so every page has to be there.
      indices.forEach((index, k) => carrier.carryLinks(index, first + k, (target) => position.get(target) ?? null));
    }
  } finally {
    if (!map) own.destroy();
  }
}
