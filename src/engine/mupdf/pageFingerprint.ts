/**
 * A short fingerprint of each page of a PDF, in page order: all five page boxes, its /Rotate, its WHOLE content streams (a
 * hash of every byte of every stream), the facts of its resources (the names in each category, and for each entry the stream
 * length, the BaseFont name or the size of the dictionary) and the facts of its annotations (count, subtype, rect, text, and
 * whether it has an appearance). A save compares the fingerprints of the document on screen with those of the bytes it
 * produced (reopened), so a save that did not write the edits (wrong page count, wrong order, a missing rotation or crop, a
 * dropped image, a swapped font, a lost annotation, a changed byte anywhere in a content stream) is caught before the file on
 * disk is replaced. Object numbers are not used, because a full save renumbers them.
 *
 * Measured in ticket 1.5.3 (L8, tests/perf/save-check-damage.probe.mjs): of 12 kinds of damage the check before this change
 * caught 0, and this one catches 11 in about 100 ms for 1,000 pages of 100 KB each. The one it still misses is an image whose
 * pixels change with its length unchanged (the image data itself is not hashed). A form XObject's or an ExtGState's content
 * is not hashed either.
 */
import type * as Mu from 'mupdf';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function mix(hash: number, value: number): number {
  return Math.imul((hash ^ (value & 0xff)) >>> 0, FNV_PRIME) >>> 0;
}

function mixNumber(hash: number, value: number): number {
  // Rounded to 1/100 pt: a saved file may write 612 as 612.0, and the check is not about float text.
  const n = Math.round(value * 100);
  let h = hash;
  for (let shift = 0; shift < 32; shift += 8) h = mix(h, n >>> shift);
  return h;
}

/** Every byte, and the length. */
function mixBytes(hash: number, bytes: Uint8Array): number {
  let h = mixNumber(hash, bytes.length);
  for (let i = 0; i < bytes.length; i++) h = mix(h, bytes[i]!);
  return h;
}

function mixText(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i++) h = mix(mix(h, text.charCodeAt(i)), text.charCodeAt(i) >>> 8);
  return mix(h, 0x7c);
}

function mixBox(hash: number, box: Mu.PDFObject): number {
  let h = hash;
  try {
    if (box.isNull() || !box.isArray()) return mix(h, 0xee);
    for (let i = 0; i < box.length && i < 4; i++) h = mixNumber(h, box.get(i).asNumber());
  } catch {
    h = mix(h, 0xef);
  }
  return h;
}

function mixContents(hash: number, contents: Mu.PDFObject): number {
  let h = hash;
  try {
    const part = (stream: Mu.PDFObject) => {
      if (!stream.isStream()) return;
      // The buffer lives in the WASM heap: it is given back as soon as it is hashed.
      const raw = stream.readRawStream();
      try {
        h = mixBytes(h, raw.asUint8Array());
      } finally {
        raw.destroy();
      }
    };
    // A stream is only a stream through its indirect reference, so the objects are not resolved here.
    if (contents.isNull()) return mix(h, 0xed);
    if (contents.isArray()) {
      h = mixNumber(h, contents.length);
      for (let i = 0; i < contents.length; i++) part(contents.get(i));
    } else part(contents);
  } catch {
    h = mix(h, 0xec);
  }
  return h;
}

/**
 * The names in each resource category (Font, XObject, ExtGState, ...) and, per entry, what it is: a stream's length, a font's
 * BaseFont name, or a dictionary's number of keys. Sorted by name, so the order a save writes them in does not matter.
 */
function mixResources(hash: number, resources: Mu.PDFObject): number {
  let h = hash;
  try {
    if (resources.isNull() || !resources.isDictionary()) return mix(h, 0xe1);
    const categories: Array<[string, Mu.PDFObject]> = [];
    resources.forEach((value, key) => categories.push([String(key), value]));
    categories.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [category, dict] of categories) {
      h = mixText(h, category);
      const entries = dict.isIndirect() ? dict.resolve() : dict;
      if (!entries.isDictionary()) continue;
      const list: Array<[string, Mu.PDFObject]> = [];
      entries.forEach((value, key) => list.push([String(key), value]));
      list.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      for (const [name, value] of list) {
        h = mixText(h, name);
        const object = value.isIndirect() ? value.resolve() : value;
        if (object.isStream()) {
          const raw = object.readRawStream();
          try {
            h = mixNumber(h, raw.getLength());
          } finally {
            raw.destroy();
          }
        }
        else if (object.isDictionary()) {
          const baseFont = object.get('BaseFont');
          h = mixText(h, baseFont.isName() ? baseFont.asName() : '');
          let keys = 0;
          object.forEach(() => (keys += 1));
          h = mixNumber(h, keys);
        }
      }
    }
  } catch {
    h = mix(h, 0xe2);
  }
  return h;
}

/** The count of the page's annotations, and for each its subtype, rect, text and whether it has an appearance. */
function mixAnnotations(hash: number, annots: Mu.PDFObject): number {
  let h = hash;
  try {
    if (annots.isNull() || !annots.isArray()) return mix(h, 0xa0);
    h = mixNumber(h, annots.length);
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i);
      const subtype = annot.get('Subtype');
      h = mixText(h, subtype.isName() ? subtype.asName() : '');
      h = mixBox(h, annot.get('Rect'));
      const contents = annot.get('Contents');
      h = mixText(h, contents.isString() ? contents.asString() : '');
      h = mix(h, annot.get('AP').isNull() ? 0 : 1);
    }
  } catch {
    h = mix(h, 0xa1);
  }
  return h;
}

/** One 32-bit fingerprint per page, in page order. */
export function pageFingerprints(pdf: Mu.PDFDocument): number[] {
  const out: number[] = [];
  const count = pdf.countPages();
  for (let index = 0; index < count; index++) {
    const page = pdf.findPage(index);
    let h = FNV_OFFSET;
    h = mixBox(h, page.getInheritable('MediaBox'));
    h = mixBox(h, page.getInheritable('CropBox'));
    for (const name of ['TrimBox', 'BleedBox', 'ArtBox']) h = mixBox(h, page.get(name));
    const rotate = page.getInheritable('Rotate');
    h = mixNumber(h, rotate.isNull() ? 0 : (((rotate.asNumber() % 360) + 360) % 360));
    h = mixContents(h, page.get('Contents'));
    h = mixResources(h, page.getInheritable('Resources'));
    h = mixAnnotations(h, page.get('Annots'));
    out.push(h);
  }
  return out;
}

/** The first position where the two lists differ, or -1 when they are the same. */
export function firstMismatch(expected: readonly number[], actual: readonly number[]): number {
  if (expected.length !== actual.length) return Math.min(expected.length, actual.length);
  for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) return i;
  return -1;
}
