/**
 * Opens a PDF file a job reads (Split's source, a Combine input) and learns what the job needs to know about it: its pages,
 * whether it is encrypted, whether it is an XFA form, what its form fields would lose, and its layers and attachments. The
 * copy in memory is flattened (formFlatten.ts) and is never written back anywhere. Shared by the job worker's `probe` and by
 * Combine's run, which reads each input again when it starts.
 */
import type * as Mu from 'mupdf';
import { readXfaFacts } from './core';
import { flattenForms } from './formFlatten';
import { JobFault, MAX_TOTAL_INPUT_BYTES } from './jobProtocol';

type MuModule = typeof Mu;

export interface PdfInput {
  doc: Mu.Document;
  pdf: Mu.PDFDocument;
  pages: number;
  encrypted: boolean;
  password: string | undefined;
  byteLength: number;
  fields: number;
  /** False when flattening would lose what is filled in. */
  formValuesKept: boolean;
  xfa: boolean;
  layers: boolean;
  attachments: number;
}

/**
 * Opens `bytes` as a PDF. Throws TotalTooLarge, Damaged, PasswordNeeded or WrongPassword. With `flatten` false (a preview) the
 * form fields are left alone and `fields` is 0. The caller owns `doc` and destroys it.
 */
export function openPdfInput(
  mu: MuModule,
  bytes: ArrayBuffer | Uint8Array,
  password: string | undefined,
  options: { flatten: boolean; /** Read the bytes through a stream, so they stay in JS and never enter the WASM heap (Combine's run; the caller keeps `bytes` alive until the document is destroyed). */ stream?: boolean },
): PdfInput {
  if (bytes.byteLength > MAX_TOTAL_INPUT_BYTES) throw new JobFault('TotalTooLarge', 'The file is over the limit');
  let doc: Mu.Document;
  try {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (options.stream) {
      const stream = new mu.Stream({
        fileSize: () => view.byteLength,
        read: (memory, offset, size, position) => {
          const n = Math.max(0, Math.min(size, view.byteLength - position));
          if (n > 0) memory.set(view.subarray(position, position + n), offset);
          return n;
        },
        close: () => undefined,
      });
      try {
        doc = mu.Document.openDocument(stream, 'application/pdf');
      } finally {
        // The document keeps its own reference to the stream.
        stream.destroy();
      }
    } else {
      doc = mu.Document.openDocument(view, 'application/pdf');
    }
  } catch {
    throw new JobFault('Damaged', 'MuPDF could not open the file');
  }
  try {
    const needed = doc.needsPassword();
    if (needed) {
      if (password === undefined) throw new JobFault('PasswordNeeded');
      if (!doc.authenticatePassword(password)) throw new JobFault('WrongPassword');
    }
    const pdf = doc.asPDF();
    const pages = doc.countPages();
    if (!pdf || !(pages > 0)) throw new JobFault('Damaged', 'The file has no pages');
    const encryption = doc.getMetaData('encryption');
    const encrypted = needed || (encryption !== undefined && encryption !== '' && encryption !== 'None');
    const xfa = readXfaFacts(pdf);
    // Orchestrator ruling (1.3.3): a job treats inputs as the app does. A file the app cannot edit (canEdit false: an XFA form, hybrid
    // forms such as fw9.pdf included; see MupdfDocument.capabilities) is refused, never flattened. (Not imported from the router: it
    // pulls the page's engines into this worker.)
    const isXfa = xfa.xfaPresent || xfa.needsRendering;
    const form = isXfa || !options.flatten ? { fields: 0, formValuesKept: true } : flattenForms(mu, pdf);
    let layers = false;
    let attachments = 0;
    try {
      layers = pdf.countLayers() > 0;
    } catch {
      layers = false;
    }
    try {
      attachments = Object.keys(pdf.getEmbeddedFiles()).length;
    } catch {
      attachments = 0;
    }
    return { doc, pdf, pages, encrypted, password, byteLength: bytes.byteLength, fields: form.fields, formValuesKept: form.formValuesKept, xfa: isXfa, layers, attachments };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
