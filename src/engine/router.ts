/**
 * Chooses the engine for each document. MuPDF is the default. An XFA form goes to pdf.js, which reads XFA.
 * A file MuPDF calls corrupt gets one try in pdf.js, which repairs some damage differently.
 *
 * A dev/test override forces one engine. Set localStorage key `pdfsuite.engine` or the URL parameter
 * `?engine=` to `mupdf` or `pdfjs`. With `mupdf` forced, XFA routing and the pdf.js fallback are off too.
 */
import { readDesktopFile } from '../platform/desktop/bridge';
import { isPdfOpenError } from './errors';
import { precheckBytes } from './precheck';
import { openMupdf, type MupdfSession } from './mupdf/mupdfDocument';
import { compileMuPdf, workerPool } from './mupdf/pool';
import type { XfaFacts } from './mupdf/protocol';
import { pdfjsEngine, pdfjsXfaEngine } from './pdfjs/pdfjsEngine';
import type { DocumentSource, EngineDocument, OpenOptions, PdfEngine } from './types';

export type EngineName = 'mupdf' | 'pdfjs';

export const ENGINE_OVERRIDE_KEY = 'pdfsuite.engine';

/**
 * True for a document that pdf.js must render: the catalog asks for XFA rendering, or it has an XFA
 * form with no AcroForm fields to fall back to.
 */
export function isXfaDocument(facts: XfaFacts): boolean {
  return facts.needsRendering || (facts.xfaPresent && facts.fieldCount === 0);
}

export function parseEngineName(value: unknown): EngineName | undefined {
  return value === 'mupdf' || value === 'pdfjs' ? value : undefined;
}

/** The dev/test override, from the URL parameter first and then localStorage. Undefined means no override. */
export function readEngineOverride(): EngineName | undefined {
  try {
    const fromUrl = parseEngineName(new URLSearchParams(window.location.search).get('engine'));
    if (fromUrl) return fromUrl;
    return parseEngineName(window.localStorage.getItem(ENGINE_OVERRIDE_KEY));
  } catch {
    // No window or no storage (tests, private windows): no override.
    return undefined;
  }
}

export interface RouterDeps {
  readBytes: (source: DocumentSource) => Promise<Uint8Array>;
  openMupdf: (bytes: Uint8Array, options: OpenOptions) => Promise<MupdfSession>;
  pdfjs: PdfEngine;
  pdfjsXfa: PdfEngine;
  override: () => EngineName | undefined;
}

export function createRouter(deps: RouterDeps): PdfEngine {
  return {
    async open(source: DocumentSource, options: OpenOptions): Promise<EngineDocument> {
      const override = deps.override();
      const bytes = await deps.readBytes(source);
      // Empty and non-PDF files get the same answer from every engine, so they are checked here first.
      const precheck = precheckBytes(bytes);
      if (precheck) throw precheck;

      const byPdfjs = () => deps.pdfjs.open({ kind: 'bytes', name: source.name, bytes }, options);
      if (override === 'pdfjs') return byPdfjs();

      let session: MupdfSession;
      try {
        session = await deps.openMupdf(bytes, options);
      } catch (error) {
        // A wrong or missing password is the answer, not a reason to try again elsewhere.
        if (override === 'mupdf' || (isPdfOpenError(error) && error.kind !== 'Corrupt')) throw error;
        return byPdfjs();
      }

      if (override !== 'mupdf' && isXfaDocument(session.xfa)) {
        session.discard();
        return deps.pdfjsXfa.open({ kind: 'bytes', name: source.name, bytes: new Uint8Array(session.bytes) }, options);
      }
      return session.document();
    },
  };
}

/** The engine the app uses. */
export const routerEngine: PdfEngine = createRouter({
  readBytes: (source) => (source.kind === 'path' ? readDesktopFile(source.path) : Promise.resolve(source.bytes)),
  openMupdf,
  pdfjs: pdfjsEngine,
  pdfjsXfa: pdfjsXfaEngine,
  override: readEngineOverride,
});

/** Compiles the WASM and starts the spare worker, so the first open does not wait for either. No-op without Worker. */
export function prewarmEngine(): void {
  if (typeof Worker === 'undefined') return;
  void compileMuPdf().catch(() => undefined);
  workerPool.prewarm();
}
