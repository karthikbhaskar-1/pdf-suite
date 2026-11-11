import type { PdfEngine, DocumentSource, EngineDocument, OpenOptions } from '../types';
import { classifyPdfjsError } from './classifyPdfjsError';
import { getSharedWorker, loadPdfjs } from './loader';
import { PdfjsDocument } from './pdfjsDocument';
import { chooseXfaRoute, xfaLayerWorks } from './xfaRoute';
import { readDesktopFile } from '../../platform/desktop/bridge';
import { precheckBytes } from '../precheck';

/**
 * Builds a pdf.js engine. `enableXfa` is set only for the XFA route: MuPDF hands XFA forms to pdf.js, which
 * reads them with its XFA support. An XFA form whose HTML layer cannot be built is opened without XFA instead,
 * so its fallback page shows (see xfaRoute.ts). Every other document uses the default engine.
 *
 * Path sources (desktop) are read through the main process first, so the engine always works on bytes. The
 * same precheck runs on the bytes of both kinds of source, so an empty or non-PDF file gets the same message
 * whether it was opened by path or from bytes.
 */
export function createPdfjsEngine(config: { enableXfa: boolean }): PdfEngine {
  return {
    async open(source: DocumentSource, options: OpenOptions): Promise<EngineDocument> {
      const bytes = source.kind === 'path' ? await readDesktopFile(source.path) : source.bytes;
      const precheck = precheckBytes(bytes);
      if (precheck) throw precheck;
      const lib = await loadPdfjs();
      const worker = await getSharedWorker(lib);
      /** Opens the bytes once. Only the first open reports progress. */
      const open = (enableXfa: boolean, reportProgress: boolean) => {
        const task = lib.getDocument({
          // Copy the bytes: pdf.js transfers the buffer to the worker, and the caller keeps its copy.
          data: bytes.slice(),
          password: options.password,
          worker,
          enableXfa,
        });
        if (reportProgress && options.onProgress) {
          const report = options.onProgress;
          task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
            report(total > 0 ? Math.min(1, loaded / total) : 0);
          };
        }
        return task.promise;
      };
      if (options.onProgress) options.onProgress(0);
      try {
        const route = config.enableXfa
          ? await chooseXfaRoute(
              (enableXfa) => open(enableXfa, enableXfa),
              (pdf) => xfaLayerWorks(lib, pdf, () => document.createElement('div')),
            )
          : { pdf: await open(false, true), xfa: false };
        const pdf = route.pdf;
        // pdf.js reports EncryptFilterName (null for unencrypted files) in the document info.
        const info = (await pdf.getMetadata().catch(() => ({ info: {} }))).info as Record<string, unknown> | undefined;
        const encrypted = (info?.EncryptFilterName ?? null) !== null || options.password !== undefined;
        // An XFA document also opens without XFA. Its fallback page is drawn on the canvas under the HTML layer,
        // so a page is never blank. If the fallback cannot open, the XFA document still shows its HTML layer.
        const fallback = route.xfa ? await open(false, false).catch(() => null) : null;
        return new PdfjsDocument(pdf, encrypted, { xfa: route.xfa, fallback });
      } catch (error) {
        throw classifyPdfjsError(error, options.password !== undefined);
      }
    },
  };
}

/** The pdf.js engine. Used as the fallback for a document MuPDF cannot read. */
export const pdfjsEngine: PdfEngine = createPdfjsEngine({ enableXfa: false });

/** pdf.js with XFA support. Used only for XFA forms that MuPDF routes here. */
export const pdfjsXfaEngine: PdfEngine = createPdfjsEngine({ enableXfa: true });
