import type { PDFWorker } from 'pdfjs-dist';
import type * as PdfjsModule from 'pdfjs-dist';

/**
 * The pdf.js worker script, emitted as an asset by Vite. Resolved relative to this file
 * so the bundler can follow it. One worker is shared by the whole app.
 */
const WORKER_URL = new URL('../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url);

export type PdfjsLib = typeof PdfjsModule;

let libPromise: Promise<PdfjsLib> | null = null;
let sharedWorker: PDFWorker | null = null;

/** Loads pdf.js on first use so the initial bundle stays small. */
export function loadPdfjs(): Promise<PdfjsLib> {
  libPromise ??= import('pdfjs-dist').then((lib) => {
    if (!lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = WORKER_URL.href;
    }
    return lib;
  });
  return libPromise;
}

export async function getSharedWorker(lib: PdfjsLib): Promise<PDFWorker> {
  if (!sharedWorker || sharedWorker.destroyed) {
    sharedWorker = new lib.PDFWorker();
  }
  return sharedWorker;
}
