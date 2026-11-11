/**
 * Chooses how an XFA document is opened. The document is opened with XFA, and its HTML layer is checked once:
 * if pdf.js cannot build the layer for the first page, the file is reopened without XFA, so its fallback page
 * is shown. A page is never left blank because of the XFA layer.
 */

/** Link handling for XFA HTML. The layer is read-only, so links are inert: nothing is navigated or run. */
export const XFA_INERT_LINKS = {
  eventBus: { dispatch: () => undefined, on: () => undefined, off: () => undefined },
  getDestinationHash: () => '#',
  getAnchorUrl: () => '#',
  addLinkAttributes: (link: HTMLAnchorElement, url: string) => {
    link.href = url;
  },
  executeNamedAction: () => undefined,
  executeSetOCGState: () => undefined,
  goToDestination: () => undefined,
};

/** The part of the pdf.js library the XFA layer uses. */
export interface XfaLibrary {
  XfaLayer: { render(parameters: object): unknown };
}

/** The part of a pdf.js document the layer check uses. */
export interface XfaCheckedDocument {
  getPage(pageNumber: number): Promise<{
    getXfa(): Promise<unknown>;
    getViewport(parameters: { scale: number }): { clone(options: { dontFlip: boolean }): unknown };
  }>;
}

/**
 * True when the XFA HTML of the first page can be built. A page with no XFA content counts as working, since the
 * fallback is then the content. Any failure, including a thrown error from pdf.js, counts as not working.
 */
export async function xfaLayerWorks(lib: XfaLibrary, pdf: XfaCheckedDocument, makeDiv: () => HTMLElement): Promise<boolean> {
  try {
    const page = await pdf.getPage(1);
    const xfaHtml = await page.getXfa();
    if (!xfaHtml) return true;
    const viewport = page.getViewport({ scale: 1 });
    await lib.XfaLayer.render({
      viewport: viewport.clone({ dontFlip: true }),
      div: makeDiv(),
      xfaHtml,
      linkService: XFA_INERT_LINKS,
      intent: 'display',
    });
    return true;
  } catch {
    return false;
  }
}

export interface XfaRoute<P> {
  pdf: P;
  /** True when the document is kept with XFA (its HTML layer can be shown). */
  xfa: boolean;
}

/**
 * Opens with XFA. If the HTML layer works, that document is kept. Otherwise it is closed and the file is opened
 * again without XFA. The second open's failure is the caller's error, as for any file.
 */
export async function chooseXfaRoute<P extends { destroy(): Promise<void> }>(
  open: (enableXfa: boolean) => Promise<P>,
  layerWorks: (pdf: P) => Promise<boolean>,
): Promise<XfaRoute<P>> {
  const xfaPdf = await open(true);
  if (await layerWorks(xfaPdf)) return { pdf: xfaPdf, xfa: true };
  await xfaPdf.destroy().catch(() => undefined);
  return { pdf: await open(false), xfa: false };
}
