import 'pdfjs-dist/web/pdf_viewer.css';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { abortError } from '../renderScheduler';
import { parsePdfDate } from '../fileInfo';
import { cleanOutlineTitle } from '../outlineTitle';
import type { DocumentCapabilities, DocumentMetadata, EngineDocument, OutlineItem, PageSize, RenderOptions, TextRun } from '../types';
import { loadPdfjs } from './loader';
import { isFontRegistered, measureAdvances, proportionalBoxes } from './charBoxes';
import { xfaTextRuns, type XfaNode } from './xfaText';
import { XFA_INERT_LINKS } from './xfaRoute';

/** Scale used to render a page once so its fonts load. Small, because only the font loading matters. */
const FONT_LOAD_SCALE = 0.01;

/** Canvas size cap: 16 megapixels. Larger renders are scaled down. */
export const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * Pages whose pdf.js resources (parsed objects, fonts, operator lists) stay loaded. Pages that
 * fall out of this most-recently-used window are released with page.cleanup(). It is larger than
 * the viewer's visible range plus overscan, so pages on screen are not released.
 */
export const LIVE_PAGE_WINDOW = 24;

/** Wraps a pdf.js proxy in the engine-neutral interface. Nothing else sees pdf.js types. */
/** How an XFA document is opened. Both parts are optional: a plain pdf.js document needs neither. */
export interface PdfjsDocumentOptions {
  /** The document was opened with XFA support: dynamic XFA pages get an HTML layer. */
  xfa?: boolean;
  /**
   * The same file opened without XFA. Its page is drawn on the canvas, so a page shows the fallback content
   * under the HTML layer, and is never blank when the HTML layer cannot be built.
   */
  fallback?: PDFDocumentProxy | null;
}

export class PdfjsDocument implements EngineDocument {
  /**
   * pdf.js documents are read-only: XFA forms and the corrupt-file retry are opened here, and cannot be edited.
   * An XFA document has an HTML layer.
   */
  readonly capabilities: DocumentCapabilities;
  /** Page indexes in the order they were last used, most recent last. */
  private readonly recent: number[] = [];
  private destroyed = false;
  /** Font names seen in each page's text, from the last pageText read. */
  private readonly pageFontNames = new Map<number, string[]>();
  /** Font loads in progress or done, per page. */
  private readonly fontRenders = new Map<number, Promise<void>>();
  /** Font names a load was already tried for. A font is tried once per document, not once per page. */
  private readonly fontsTried = new Set<string>();

  constructor(
    private readonly pdf: PDFDocumentProxy,
    readonly isEncrypted: boolean,
    private readonly options: PdfjsDocumentOptions = {},
  ) {
    this.capabilities = { canEdit: false, htmlLayer: options.xfa === true };
  }

  get pageCount(): number {
    return this.pdf.numPages;
  }

  /** Marks a page as used and releases the pdf.js resources of the page that fell out of the window. */
  private touch(index: number): void {
    const at = this.recent.indexOf(index);
    if (at >= 0) this.recent.splice(at, 1);
    this.recent.push(index);
    while (this.recent.length > LIVE_PAGE_WINDOW) {
      const released = this.recent.shift();
      if (released !== undefined) void this.releasePage(released);
    }
  }

  /**
   * Frees a page's cached pdf.js resources. The page proxy itself is already cached by pdf.js, so
   * this does not parse anything. cleanup() waits until a render of that page has finished.
   */
  private async releasePage(index: number): Promise<void> {
    if (this.destroyed) return;
    try {
      const page = await this.pdf.getPage(index + 1);
      page.cleanup();
    } catch {
      // The document was destroyed or the page is gone. Nothing to release.
    }
  }

  async pageSize(index: number): Promise<PageSize> {
    this.touch(index);
    const page = await this.pdf.getPage(index + 1);
    try {
      const viewport = page.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height, rotation: page.rotate };
    } finally {
      page.cleanup();
    }
  }

  async renderBitmap(index: number, options: RenderOptions): Promise<ImageBitmap> {
    this.touch(index);
    // The canvas draws the fallback document when there is one: dynamic XFA pages draw nothing with XFA on.
    const source = this.options.fallback ?? this.pdf;
    const page = await source.getPage(index + 1);
    try {
      return await renderPage(page, options);
    } finally {
      page.cleanup();
    }
  }

  async renderHtmlLayer(
    index: number,
    container: HTMLElement,
    options: { scale: number; rotation: number },
  ): Promise<(() => void) | null> {
    if (!this.options.xfa) return null;
    this.touch(index);
    const lib = await loadPdfjs();
    const page = await this.pdf.getPage(index + 1);
    try {
      const xfaHtml = await page.getXfa();
      if (!xfaHtml) return null;
      const viewport = page.getViewport({ scale: options.scale, rotation: this.rotationFor(page, options.rotation) });
      const div = document.createElement('div');
      container.append(div);
      try {
        await lib.XfaLayer.render({
          viewport: viewport.clone({ dontFlip: true }),
          div,
          // The pdf.js XFA tree is typed loosely by the library; it is passed through unchanged.
          xfaHtml: xfaHtml as never,
          linkService: XFA_INERT_LINKS as never,
          intent: 'display',
        });
      } catch (error) {
        div.remove();
        throw error;
      }
      return () => div.remove();
    } finally {
      page.cleanup();
    }
  }

  async renderTextLayer(
    index: number,
    container: HTMLElement,
    options: { scale: number; rotation: number },
  ): Promise<() => void> {
    // An XFA page's text is in its HTML layer already, so a text layer on top would duplicate it.
    if (this.options.xfa) return () => undefined;
    this.touch(index);
    const lib = await loadPdfjs();
    const page = await this.pdf.getPage(index + 1);
    try {
      const viewport = page.getViewport({ scale: options.scale, rotation: this.rotationFor(page, options.rotation) });
      const layer = new lib.TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      });
      await layer.render();
      return () => {
        layer.cancel();
        container.replaceChildren();
      };
    } finally {
      page.cleanup();
    }
  }

  async pageText(index: number, rotation: number): Promise<TextRun[]> {
    this.touch(index);
    const page = await this.pdf.getPage(index + 1);
    try {
      const viewport = page.getViewport({ scale: 1, rotation: this.rotationFor(page, rotation) });
      // An XFA page's text comes from its XFA tree, which has the positions that getTextContent leaves out.
      if (this.options.xfa) {
        const tree = await page.getXfa().catch(() => null);
        if (tree) {
          this.pageFontNames.set(index, []);
          return xfaTextRuns(tree as XfaNode);
        }
      }
      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      const fonts = new Set<string>();
      for (const item of content.items) {
        if (!isTextItem(item) || item.str.length === 0) continue;
        fonts.add(item.fontName);
        runs.push(toTextRun(item, viewport.transform, content.styles));
      }
      this.pageFontNames.set(index, [...fonts]);
      return runs;
    } finally {
      page.cleanup();
    }
  }

  /**
   * Makes the fonts of a page's text usable for measuring. The first call for a page that uses a font not yet
   * registered renders it once at a tiny scale, which loads the font; later calls return at once.
   */
  async fontsReady(index: number): Promise<void> {
    const names = this.pageFontNames.get(index) ?? [];
    const missing = names.filter((name) => !this.fontsTried.has(name) && !isFontRegistered(name));
    if (missing.length === 0) return;
    for (const name of missing) this.fontsTried.add(name);
    let ready = this.fontRenders.get(index);
    if (!ready) {
      ready = this.loadFontsByRender(index);
      this.fontRenders.set(index, ready);
    }
    await ready;
  }

  private async loadFontsByRender(index: number): Promise<void> {
    if (this.destroyed) return;
    try {
      const page = await this.pdf.getPage(index + 1);
      try {
        const viewport = page.getViewport({ scale: FONT_LOAD_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        if (context) await page.render({ canvasContext: context, viewport, canvas }).promise;
      } finally {
        page.cleanup();
      }
    } catch {
      // The page's text is then measured with the fallback font.
    }
  }

  async outline(): Promise<OutlineItem[]> {
    const raw = await this.pdf.getOutline();
    const convert = async (items: NonNullable<typeof raw>): Promise<OutlineItem[]> =>
      Promise.all(
        items.map(async (item) => ({
          title: cleanOutlineTitle(item.title),
          pageIndex: await this.destinationPage(item.dest),
          children: await convert(item.items),
        })),
      );
    return raw ? convert(raw) : [];
  }

  async metadata(): Promise<DocumentMetadata> {
    const { info } = await this.pdf.getMetadata();
    const data = (info ?? {}) as Record<string, unknown>;
    const text = (key: string): string | undefined => {
      const value = data[key];
      return typeof value === 'string' && value.trim() !== '' ? value : undefined;
    };
    return {
      title: text('Title'),
      author: text('Author'),
      subject: text('Subject'),
      keywords: text('Keywords'),
      creator: text('Creator'),
      producer: text('Producer'),
      created: parsePdfDate(text('CreationDate')),
      modified: parsePdfDate(text('ModDate')),
      pdfVersion: text('PDFFormatVersion'),
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.recent.length = 0;
    await Promise.all([this.pdf.destroy(), this.options.fallback?.destroy()]);
  }

  private rotationFor(page: PDFPageProxy, extra: number): number {
    return (((page.rotate + extra) % 360) + 360) % 360;
  }

  private async destinationPage(dest: unknown): Promise<number | null> {
    try {
      const resolved = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!Array.isArray(resolved) || resolved[0] === undefined) return null;
      return await this.pdf.getPageIndex(resolved[0]);
    } catch {
      return null;
    }
  }
}

/** pdf.js text content item (the non-marked-content variant), derived from the library's own types. */
type TextItem = Extract<Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number], { str: string }>;

function isTextItem(item: unknown): item is TextItem {
  return typeof item === 'object' && item !== null && 'str' in item;
}

/** Multiplies two affine matrices in pdf.js's [a, b, c, d, e, f] layout. */
function multiply(m1: readonly number[], m2: readonly number[]): number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** pdf.js text style of a font name (its generic or embedded family). */
type TextStyles = Awaited<ReturnType<PDFPageProxy['getTextContent']>>['styles'];

/** Converts one pdf.js text item into a run in viewport points, with per-character advance boxes. */
function toTextRun(item: TextItem, viewportTransform: readonly number[], styles: TextStyles): TextRun {
  // Glyph boxes are measured only when a match needs this run (see boxesOf in features/search).
  const m = multiply(viewportTransform, item.transform);
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = m;
  // Scale from user space to the viewport (rotation does not change it).
  const scale = Math.hypot(viewportTransform[0] ?? 1, viewportTransform[1] ?? 0);
  const lenA = Math.hypot(a, b) || 1;
  const lenU = Math.hypot(c, d) || 1;
  const length = item.width * scale;
  const run: TextRun = {
    text: item.str,
    origin: { x: e, y: f },
    along: { x: (a / lenA) * length, y: (b / lenA) * length },
    up: { x: (c / lenU) * item.height * scale, y: (d / lenU) * item.height * scale },
  };
  const family = styles[item.fontName]?.fontFamily;
  run.measureCharBoxes = () => {
    const advances = measureAdvances(item.str, item.fontName, family);
    return advances ? proportionalBoxes(advances, length) : undefined;
  };
  return run;
}

async function renderPage(page: PDFPageProxy, options: RenderOptions): Promise<ImageBitmap> {
  const { signal, region } = options;
  if (signal.aborted) throw abortError();

  const rotation = (((page.rotate + options.rotation) % 360) + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const area = region ? region.width * region.height : base.width * base.height;
  const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, area));
  const scale = Math.min(options.scale, maxScale);
  const viewport = region
    ? page.getViewport({ scale, rotation, offsetX: -region.x * scale, offsetY: -region.y * scale })
    : page.getViewport({ scale, rotation });

  const sized = region ?? { x: 0, y: 0, width: base.width, height: base.height };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(sized.width * scale));
  canvas.height = Math.max(1, Math.floor(sized.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');

  const task = page.render({ canvasContext: context, viewport, canvas });
  const onAbort = () => task.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await task.promise;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw abortError();
  return createImageBitmap(canvas);
}
