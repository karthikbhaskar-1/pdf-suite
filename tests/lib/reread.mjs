// Re-reads a produced PDF with pdf.js (a second engine, not MuPDF): page count, sizes, rotation, text, outline, annotations.
// Used by unit tests (vitest) and e2e tests (node). Pure ESM, no app.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Flattens pdf.js outline nodes to [{ title, depth, page }] (page is 1-based, or null when the destination cannot be resolved). */
async function flattenOutline(doc, nodes, depth, out) {
  for (const node of nodes ?? []) {
    let page = null;
    try {
      let dest = node.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest[0] !== null && typeof dest[0] === 'object') page = (await doc.getPageIndex(dest[0])) + 1;
      else if (Array.isArray(dest) && Number.isInteger(dest[0])) page = dest[0] + 1;
    } catch {
      page = null;
    }
    out.push({ title: node.title, depth, page });
    await flattenOutline(doc, node.items, depth + 1, out);
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {{ password?: string }} [options]
 * @returns {Promise<{ pages: number, sizes: Array<{ width: number, height: number, rotate: number }>, text: string[], outline: Array<{title:string,depth:number,page:number|null}>, annotations: Array<{ page: number, subtype: string, url?: string }> }>}
 */
export async function reread(bytes, options = {}) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), password: options.password, useSystemFonts: false, verbosity: 0, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const sizes = [];
    const text = [];
    const annotations = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      sizes.push({ width: Math.round(view.width * 100) / 100, height: Math.round(view.height * 100) / 100, rotate: page.rotate });
      const content = await page.getTextContent();
      text.push(content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim());
      for (const a of await page.getAnnotations()) annotations.push({ page: n, subtype: a.subtype, ...(a.url ? { url: a.url } : {}) });
      page.cleanup();
    }
    const outline = [];
    await flattenOutline(doc, await doc.getOutline(), 0, outline);
    return { pages: doc.numPages, sizes, text, outline, annotations };
  } finally {
    await doc.destroy();
  }
}
