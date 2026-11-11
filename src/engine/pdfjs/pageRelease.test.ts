// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  if (!('DOMMatrix' in globalThis)) {
    (globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrixStub {};
  }
});

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { LIVE_PAGE_WINDOW, PdfjsDocument } from './pdfjsDocument';

/**
 * A stand-in pdf.js document. Like pdf.js, it returns the same cached page proxy for each page.
 * `cleanups` counts cleanup() calls per page number (index + 1). Each use of a page already calls
 * cleanup() once in its own finally block, so a page released by the window shows one more.
 */
function fakePdf(pageCount: number) {
  const cleanups = new Map<number, number>();
  const pages = new Map<number, unknown>();
  const pdf = {
    numPages: pageCount,
    getPage: vi.fn(async (number: number) => {
      let page = pages.get(number);
      if (!page) {
        page = {
          rotate: 0,
          getViewport: () => ({ width: 612, height: 792 }),
          cleanup: () => cleanups.set(number, (cleanups.get(number) ?? 0) + 1),
        };
        pages.set(number, page);
      }
      return page;
    }),
    destroy: vi.fn(async () => undefined),
  };
  return { pdf: pdf as unknown as PDFDocumentProxy, cleanups };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('pdf.js page release', () => {
  it('releases the pages that leave the live window and keeps the recent ones', async () => {
    const total = LIVE_PAGE_WINDOW + 6;
    const { pdf, cleanups } = fakePdf(total);
    const doc = new PdfjsDocument(pdf, false);

    for (let i = 0; i < total; i++) await doc.pageSize(i);
    await settle();

    // Indexes 0..5 left the window: their own cleanup plus one release each.
    for (let i = 0; i < 6; i++) expect(cleanups.get(i + 1)).toBe(2);
    // Indexes 6.. are still in the window: only their own cleanup.
    for (let i = 6; i < total; i++) expect(cleanups.get(i + 1)).toBe(1);
  });

  it('a page used again moves to the most recent end and is not the next one released', async () => {
    const { pdf, cleanups } = fakePdf(LIVE_PAGE_WINDOW + 2);
    const doc = new PdfjsDocument(pdf, false);
    for (let i = 0; i < LIVE_PAGE_WINDOW; i++) await doc.pageSize(i);
    await doc.pageSize(0); // index 0 is the most recent again
    await doc.pageSize(LIVE_PAGE_WINDOW); // pushes out index 1, the oldest
    await settle();

    expect(cleanups.get(1)).toBe(2); // index 0: used twice, never released
    expect(cleanups.get(2)).toBe(2); // index 1: released
    expect(cleanups.get(3)).toBe(1); // index 2: kept
  });

  it('does not release anything after the document is destroyed', async () => {
    const total = LIVE_PAGE_WINDOW + 3;
    const { pdf, cleanups } = fakePdf(total);
    const doc = new PdfjsDocument(pdf, false);
    await doc.destroy();
    for (let i = 0; i < total; i++) await doc.pageSize(i).catch(() => undefined);
    await settle();

    expect(cleanups.size).toBe(total);
    for (const count of cleanups.values()) expect(count).toBe(1);
  });
});
