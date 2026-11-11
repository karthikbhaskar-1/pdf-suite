/**
 * Split into Files, inside the job worker (blueprint §3, B1, B4, §6).
 *
 * Each part is built in a FRESH document with its own graft map (shared fonts and images are copied once per part), saved
 * once, checked by reopening it, sent out, and destroyed before the next part starts. The source is the in-memory copy that
 * `flattenForms` already flattened. Nothing here touches a file: bytes leave through the sink.
 *
 * Carried into each part: page content, boxes and rotation (graft), comments and markup (annotCarry.ts), web links and the
 * internal links whose target is in the part (annotCarry.ts), the bookmarks that point into the part (outlineCarry.ts), and
 * the Title, Author, Subject and Keywords of the source. Producer is "PDF Suite" and the dates are the time of the split.
 * Dropped: attachments, page labels, tags, scripts, named destinations.
 */
import type * as Mu from 'mupdf';
import { JobFault, MAX_JOB_FILES, type JobNote, type JobPhase } from './jobProtocol';
import { type BookmarkNode, remapBookmarks, writeBookmarks } from './outlineCarry';
import { graftPages } from './pageCopy';
import { firstMismatch, pageFingerprints } from './pageFingerprint';
import { ReachSet, fitPart, guessPageCount } from './partSize';
import { copyOut, extractEncryptedOptions, opensWithPassword } from './saveCore';

type MuModule = typeof Mu;

/** What the split needs from the worker around it. */
export interface SplitSink {
  /** Lets queued messages run, and throws JobFault('Cancelled') when the job was cancelled. Called between parts and chunks. */
  checkCancel(): Promise<void>;
  progress(phase: JobPhase, done: number, total: number, unit: 'files' | 'pages'): void;
  /** Sends one finished file out (file, chunks acknowledged one by one, fileEnd). Resolves when the page has it all. */
  emitFile(leafName: string, bytes: Uint8Array, pages: number): Promise<void>;
}

export interface SplitSource {
  doc: Mu.Document;
  pdf: Mu.PDFDocument;
  pages: number;
  encrypted: boolean;
  /** The bookmarks of the source, read once. */
  bookmarks: readonly BookmarkNode[];
}

export interface PartOptions {
  encrypted: boolean;
  /** The password of an encrypted source. Used only for the save options and the check; never stored or logged. */
  password: string | undefined;
  dropEncryption: boolean;
}

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords'] as const;

/** Removes /StructParents from a page and /StructParent from each of its annotations (tagged-PDF keys with no tree behind them). */
export function stripStructure(page: Mu.PDFObject): void {
  page.delete('StructParents');
  const annots = page.get('Annots');
  if (annots.isNull() || !annots.isArray()) return;
  for (let i = 0; i < annots.length; i++) {
    const annot = annots.get(i).resolve();
    if (annot.isDictionary()) annot.delete('StructParent');
  }
}

/** A PDF date string, "D:YYYYMMDDHHmmSSZ". */
export function pdfDate(now: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `D:${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

export interface BuiltPartBytes {
  bytes: Uint8Array;
  /** Combine: the saved file as a MuPDF buffer (in WASM memory). When set, the check opens it directly instead of making a copy of `bytes`. */
  buffer?: Mu.Buffer;
  pages: number;
  /** Fingerprints of the part's pages before it was saved, for the check. */
  fingerprints: number[];
}

/** The save options of a part: plain, or the source's password kept (AES-256). Throws CannotKeepPassword when it cannot be. */
export function partSaveOptions(options: PartOptions): string {
  if (!options.encrypted || options.dropEncryption) return 'garbage=compact';
  const saved = extractEncryptedOptions(options.password ?? '');
  if (saved === null) throw new JobFault('CannotKeepPassword', 'The password cannot be written as a save option');
  return saved;
}

/**
 * Builds pages `from..to` (0-based, inclusive) of the source as a new document and saves it once. The part document and its
 * graft map are destroyed before this returns.
 */
export function buildPart(
  mu: MuModule,
  source: SplitSource,
  from: number,
  to: number,
  options: PartOptions,
  onPhase?: (phase: 'copying' | 'saving') => void,
): BuiltPartBytes {
  const saveAs = partSaveOptions(options);
  const out = new mu.PDFDocument();
  const map = out.newGraftMap();
  try {
    onPhase?.('copying');
    const indices: number[] = [];
    for (let i = from; i <= to; i++) indices.push(i);
    // Form fields were flattened when the file was read, so only comments, markup and links are carried.
    graftPages(out, source.pdf, indices, map, { carry: true, withForms: false });
    // The source's structure tree is not carried, so the keys that point into it would dangle: they are removed. The document
    // language is kept.
    for (let k = 0; k < indices.length; k++) stripStructure(out.findPage(k));
    // The catalog's own /Lang text is copied (MuPDF's getLanguage shortens "de-DE" to "de").
    const lang = source.pdf.getTrailer().get('Root').get('Lang');
    if (lang.isString()) out.getTrailer().get('Root').put('Lang', out.newString(lang.asString()));
    writeBookmarks(mu, out, remapBookmarks(source.bookmarks, from, to));
    for (const key of INFO_KEYS) {
      const value = source.doc.getMetaData(`info:${key}`);
      if (value !== undefined && value.trim() !== '') out.setMetaData(`info:${key}`, value);
    }
    out.setMetaData('info:Producer', 'PDF Suite');
    const now = pdfDate(new Date());
    out.setMetaData('info:CreationDate', now);
    out.setMetaData('info:ModDate', now);
    const fingerprints = pageFingerprints(out);
    onPhase?.('saving');
    // A part is saved once. A second save would renumber objects under the graft map.
    const bytes = copyOut(out.saveToBuffer(saveAs));
    return { bytes, pages: indices.length, fingerprints };
  } finally {
    map.destroy();
    out.destroy();
  }
}

/**
 * Reopens the saved part and compares it with what was built: it opens (with the password when it has one), it was not
 * repaired, it has the same page count and the same page fingerprints. Throws CheckFailed otherwise.
 */
export function verifyPart(mu: MuModule, part: BuiltPartBytes, options: PartOptions): void {
  let doc: Mu.Document | null = null;
  try {
    const keepsPassword = options.encrypted && !options.dropEncryption;
    if (keepsPassword && !opensWithPassword(mu, part.bytes, options.password ?? '')) throw new JobFault('CheckFailed', 'The part lost its password');
    doc = mu.Document.openDocument(part.buffer ?? part.bytes, 'application/pdf');
    if (doc.needsPassword()) {
      if (!keepsPassword || !doc.authenticatePassword(options.password ?? '')) throw new JobFault('CheckFailed', 'The part does not open with its password');
    } else if (keepsPassword) {
      // Encrypted with an empty user password: it opens without one, and the encryption entry is checked above.
    }
    const pdf = doc.asPDF();
    if (!pdf) throw new JobFault('CheckFailed', 'The part is not a PDF');
    if (pdf.wasRepaired()) throw new JobFault('CheckFailed', 'The part needed repair');
    if (pdf.countPages() !== part.pages) throw new JobFault('CheckFailed', `The part has ${pdf.countPages()} pages, expected ${part.pages}`);
    const wrongAt = firstMismatch(part.fingerprints, pageFingerprints(pdf));
    if (wrongAt >= 0) throw new JobFault('CheckFailed', `Page ${wrongAt + 1} of the part differs from what was built`);
  } catch (error) {
    if (error instanceof JobFault) throw error;
    throw new JobFault('CheckFailed', error instanceof Error ? error.message : String(error));
  } finally {
    doc?.destroy();
  }
}

export interface SplitResult {
  files: number;
  pages: number;
  notes: JobNote[];
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** The name of part `n` of a size split: "<name> - part 01.pdf". */
export function sizePartName(baseName: string, n: number, width: number): string {
  return `${baseName} - part ${pad(n, Math.max(2, width))}.pdf`;
}

/** Splits by ranges the page planned (page count, blank pages, bookmarks). Ranges are 1-based and inclusive. */
export async function splitByRanges(
  mu: MuModule,
  source: SplitSource,
  parts: ReadonlyArray<{ from: number; to: number; leafName: string }>,
  options: PartOptions,
  sink: SplitSink,
): Promise<SplitResult> {
  if (parts.length === 0) throw new JobFault('Internal', 'No parts to make');
  if (parts.length > MAX_JOB_FILES) throw new JobFault('Internal', 'Too many files');
  let pages = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!(part.from >= 1 && part.to >= part.from && part.to <= source.pages)) throw new JobFault('Internal', `Part ${i + 1} is outside the document`);
    await sink.checkCancel();
    sink.progress('copying', i, parts.length, 'files');
    const built = buildPart(mu, source, part.from - 1, part.to - 1, options, (phase) => {
      if (phase === 'saving') sink.progress('saving', i, parts.length, 'files');
    });
    sink.progress('checking', i, parts.length, 'files');
    verifyPart(mu, built, options);
    sink.progress('writing', i, parts.length, 'files');
    await sink.emitFile(part.leafName, built.bytes, built.pages);
    pages += built.pages;
    mu.shrinkStore(100);
  }
  return { files: parts.length, pages, notes: [] };
}

/**
 * Splits by size: every part's saved bytes are measured and are at most `maxBytes`, except a page that alone is over it
 * (accepted and reported in `notes`).
 */
export async function splitBySize(
  mu: MuModule,
  source: SplitSource,
  baseName: string,
  maxBytes: number,
  nameWidth: number,
  options: PartOptions,
  sink: SplitSink,
): Promise<SplitResult> {
  let from = 0;
  let number = 0;
  let pages = 0;
  const notes: JobNote[] = [];
  while (from < source.pages) {
    await sink.checkCancel();
    number += 1;
    if (number > MAX_JOB_FILES) throw new JobFault('Internal', 'Too many files');
    sink.progress('copying', from, source.pages, 'pages');
    const guess = guessPageCount(new ReachSet(source.pdf), from, source.pages, maxBytes);
    const fit = await fitPart<BuiltPartBytes>({
      from,
      pages: source.pages,
      maxBytes,
      guess,
      build: async (start, k) => {
        await sink.checkCancel();
        const built = buildPart(mu, source, start, start + k - 1, options);
        return { size: built.bytes.length, keep: built };
      },
    });
    sink.progress('checking', from, source.pages, 'pages');
    verifyPart(mu, fit.keep, options);
    sink.progress('writing', from, source.pages, 'pages');
    await sink.emitFile(sizePartName(baseName, number, nameWidth), fit.keep.bytes, fit.keep.pages);
    if (fit.oversize) notes.push({ kind: 'oversizePage', file: number, page: from + 1, limitBytes: maxBytes });
    pages += fit.keep.pages;
    from += fit.k;
    mu.shrinkStore(100);
  }
  return { files: number, pages, notes };
}
