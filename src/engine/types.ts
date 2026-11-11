/**
 * Engine-neutral interfaces. Nothing outside src/engine/pdfjs/ may import pdf.js types.
 * The desktop build will supply a PDFium-backed engine behind the same interfaces.
 *
 * PAGE INDEX CONTRACT (read before writing an engine adapter, such as the MuPDF one in 1.2):
 * - Every method on EngineDocument takes an ENGINE page index: zero-based, in the order of the
 *   original file, as the engine itself numbers its pages.
 * - The UI keeps a PageRef per page of the page list, and PageRef.srcIndex is that engine index.
 *   A page list may reorder, rotate or drop pages, so a list position is not an engine index.
 * - The only conversion from a PageRef to an engine index is engineIndexOf() in ./pageRef.ts.
 *   UI code must call it, and must not read PageRef.srcIndex directly.
 * - Sizes, outline mapping and render caches are keyed by the same engine index.
 */

import type { OverlayArgs } from './mupdf/protocol';

/** Where a document comes from. The web build produces 'bytes'; the desktop shell produces 'path'. */
export type DocumentSource =
  | { kind: 'path'; path: string; name: string }
  | { kind: 'bytes'; name: string; bytes: Uint8Array };

export interface OpenOptions {
  password?: string;
  onProgress?: (fraction: number) => void;
}

/** Page size in PDF points, including the page's own rotation. */
export interface PageSize {
  width: number;
  height: number;
  /** The page's own /Rotate in degrees (0, 90, 180 or 270). Already applied to width and height. */
  rotation?: number;
}

export interface OutlineItem {
  title: string;
  /** Zero-based page index, or null when the target is not a page in this file. */
  pageIndex: number | null;
  children: OutlineItem[];
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** Raw PDF date text converted to a readable local form, when present and parseable. */
  created?: string;
  modified?: string;
  /** PDF format version, such as "1.7". */
  pdfVersion?: string;
}

/** A rectangle inside a page, in PDF points, in the page's displayed orientation (top-left origin). */
export interface PageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Pixels per point. 1 = 72 dpi. */
  scale: number;
  /** Extra rotation in degrees, on top of the page's own rotation. */
  rotation: number;
  signal: AbortSignal;
  /** Render only this part of the page (used by the loupe). Defaults to the whole page. */
  region?: PageRegion;
  /** Compare view (1.3.4): a page of an attached source laid over this page, in the same bitmap. Only the MuPDF engine uses it. */
  overlay?: OverlayArgs;
}

/**
 * One run of text from a page, in points, in the displayed orientation. The run starts at
 * `origin`, advances along `along` and is `up` tall. Each vector is the full length of the run.
 */
export interface TextRun {
  text: string;
  origin: { x: number; y: number };
  along: { x: number; y: number };
  up: { x: number; y: number };
  /**
   * Optional per-character advance boxes, one per UTF-16 unit of `text`: where that character starts
   * and ends along the run, in points from `origin`. The boxes are contiguous and cover the run.
   * Without them a character is assumed to take an equal share of the run. An engine with exact glyph
   * metrics (MuPDF in 1.2) supplies them through this field.
   */
  charBoxes?: Array<{ start: number; end: number }>;
  /**
   * Computes `charBoxes` on demand, for a run that a match needs. Search calls it only for matched runs,
   * so an engine can measure glyphs lazily. Returns undefined when the boxes cannot be measured.
   */
  measureCharBoxes?: () => Array<{ start: number; end: number }> | undefined;
  /**
   * Packed character boundaries (an engine with exact metrics that keeps a whole page's boundaries in one Float32Array):
   * `text.length + 1` values from `boundsAt`, where unit i spans bounds[i] to bounds[i + 1], in points from `origin`.
   * Search reads the two edges of a match from it and never builds a box object per character.
   */
  bounds?: Float32Array;
  /** Index in `bounds` of this run's first boundary. */
  boundsAt?: number;
}

/**
 * What an open document supports. The UI reads it to decide which actions to offer. A MuPDF document can be
 * edited (1.2.1). A document that pdf.js opened (an XFA form, or a file MuPDF called corrupt) cannot.
 */
export interface DocumentCapabilities {
  canEdit: boolean;
  /**
   * True when the file is over the edit limit (core/fileLimits.ts): it opened for viewing only. canEdit is false too, so every
   * guard on canEdit holds; this flag only says why, so the tooltip, the bar and the messages name the size and not a form.
   */
  viewOnly?: boolean;
  /**
   * The document's page content can be shown as an HTML layer above the canvas (dynamic XFA forms). The canvas
   * then holds the fallback page underneath, so a page is never blank.
   */
  htmlLayer: boolean;
}

/** One open document. Pages are addressed by zero-based index in the original file. */
export interface EngineDocument {
  readonly pageCount: number;
  readonly capabilities: DocumentCapabilities;
  pageSize(index: number): Promise<PageSize>;
  renderBitmap(index: number, options: RenderOptions): Promise<ImageBitmap>;
  /** Builds selectable text into `container`. Returns a function that removes it. */
  renderTextLayer(index: number, container: HTMLElement, options: { scale: number; rotation: number }): Promise<() => void>;
  /**
   * Builds the page's HTML layer into `container` when the document has one (see capabilities.htmlLayer).
   * Resolves with the cleanup, or null when this page has no HTML layer. Rejects when the layer cannot be built.
   */
  renderHtmlLayer?(index: number, container: HTMLElement, options: { scale: number; rotation: number }): Promise<(() => void) | null>;
  /** Text runs of one page, for search. `rotation` is the extra rotation the page is shown with. */
  pageText(index: number, rotation: number): Promise<TextRun[]>;
  /**
   * Resolves when the fonts of a page's text are ready, so measured glyph boxes match the real font. An
   * engine with exact metrics does not need it.
   */
  fontsReady?(index: number): Promise<void>;
  outline(): Promise<OutlineItem[]>;
  metadata(): Promise<DocumentMetadata>;
  /**
   * True when the file is encrypted: it has an encryption dictionary, or it needed a password to open.
   * Read once when the document opens.
   */
  readonly isEncrypted: boolean;
  destroy(): Promise<void>;
}

/** Opens files. Throws PdfOpenError for the typed failures. */
export interface PdfEngine {
  open(source: DocumentSource, options: OpenOptions): Promise<EngineDocument>;
}
