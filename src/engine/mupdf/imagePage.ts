/**
 * Pictures as PDF pages for Combine (blueprint B2).
 *
 *  - JPEG, PNG, GIF and BMP are read with `mu.Image` (the first frame of a GIF). A TIFF is opened as a document, one page per
 *    frame (probe D6), and each frame's image is taken from a device's `fillImage`. A WebP is decoded by the caller (the job
 *    worker uses `createImageBitmap`) and handed on as PNG.
 *  - A JPEG is not re-encoded: the PDF image keeps the file's own bytes (probe D2).
 *  - Size: 50 megapixels at most, for each frame. A page is the picture's own size (pixels x 72 / DPI; a DPI outside 36-2400 counts
 *    as unstated, 96) or A4 / Letter with 36 pt margins, the picture fitted and centred, the page turned to landscape for a wide
 *    picture. EXIF orientation (all eight values) is applied in the content stream's matrix.
 *
 * `placePicture` is pure and tested on its own. The builders need MuPDF.
 */
import type * as Mu from 'mupdf';
import { pictureFormat, pictureOrientation, type Orientation, type PictureFormat } from './exif';
import { JobFault, type PageDims } from './jobProtocol';

type MuModule = typeof Mu;

export const MAX_PICTURE_PIXELS = 50_000_000;
export const PICTURE_MARGIN = 36;
/** A PDF page larger than this on a side is not shown right by many readers: a huge low-DPI picture is scaled to fit. */
export const MAX_PAGE_POINTS = 14400;
export const DEFAULT_DPI = 96;

export interface PicturePlacement {
  mediaBox: [number, number, number, number];
  /** The matrix of `cm` that draws the unit square of the image where it belongs. */
  matrix: [number, number, number, number, number, number];
}

/** A stated DPI outside 36-2400 counts as unstated. */
export function usableDpi(dpi: number): number {
  return Number.isFinite(dpi) && dpi >= 36 && dpi <= 2400 ? dpi : DEFAULT_DPI;
}

/**
 * Where a picture goes on its page. `widthPx` and `heightPx` are the stored pixels; `orientation` is the EXIF value that turns
 * the stored picture upright (5 to 8 swap width and height). With `target` 'image' the page is the picture's size; with a page
 * size the picture is fitted into it inside the margins and centred.
 */
export function placePicture(
  picture: { widthPx: number; heightPx: number; xDpi: number; yDpi: number; orientation: Orientation },
  target: 'image' | PageDims,
): PicturePlacement {
  const swap = picture.orientation >= 5;
  let dw = (picture.widthPx * 72) / usableDpi(picture.xDpi);
  let dh = (picture.heightPx * 72) / usableDpi(picture.yDpi);
  if (swap) [dw, dh] = [dh, dw];
  let pageW: number;
  let pageH: number;
  let w: number;
  let h: number;
  if (target === 'image') {
    const shrink = Math.min(1, MAX_PAGE_POINTS / Math.max(dw, dh));
    w = dw * shrink;
    h = dh * shrink;
    pageW = w;
    pageH = h;
  } else {
    // The page turns landscape when the picture is wider than tall.
    const landscape = dw > dh;
    pageW = landscape ? Math.max(target.width, target.height) : Math.min(target.width, target.height);
    pageH = landscape ? Math.min(target.width, target.height) : Math.max(target.width, target.height);
    const boxW = pageW - 2 * PICTURE_MARGIN;
    const boxH = pageH - 2 * PICTURE_MARGIN;
    const scale = Math.min(boxW / dw, boxH / dh);
    w = dw * scale;
    h = dh * scale;
  }
  const ox = (pageW - w) / 2;
  const oy = (pageH - h) / 2;
  // Where the stored unit square (s right, t up; the stored top row is t = 1) lands in display space (X right, Y down, 0..1).
  const toDisplay = (s: number, t: number): [number, number] => {
    const u = s;
    const v = 1 - t;
    switch (picture.orientation) {
      case 2: return [1 - u, v];
      case 3: return [1 - u, 1 - v];
      case 4: return [u, 1 - v];
      case 5: return [v, u];
      case 6: return [1 - v, u];
      case 7: return [1 - v, 1 - u];
      case 8: return [v, 1 - u];
      default: return [u, v];
    }
  };
  const at = (s: number, t: number): [number, number] => {
    const [X, Y] = toDisplay(s, t);
    return [ox + w * X, oy + h * (1 - Y)];
  };
  const [x0, y0] = at(0, 0);
  const [x1, y1] = at(1, 0);
  const [x2, y2] = at(0, 1);
  return { mediaBox: [0, 0, pageW, pageH], matrix: [x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0] };
}

const round = (n: number) => String(Math.round(n * 10000) / 10000);

// ---- Reading a picture file -----------------------------------------------------------------------------------------------------

export interface PictureFrame {
  widthPx: number;
  heightPx: number;
  xDpi: number;
  yDpi: number;
  orientation: Orientation;
  /**
   * Runs `fn` with the image of this frame. A frame of a multi-page TIFF is decoded for the call and let go right after it (so a long
   * fax is never held decoded all at once); the one image of any other format lives until `dispose`.
   */
  use<T>(fn: (image: Mu.Image) => T): T;
}

export interface Picture {
  format: PictureFormat;
  frames: PictureFrame[];
  dispose(): void;
}

/** A WebP decoder supplied by the caller (the job worker passes one built on createImageBitmap). Returns the picture as PNG. */
export type WebpDecoder = (bytes: Uint8Array) => Promise<{ width: number; height: number; png: Uint8Array }>;

function tooLarge(width: number, height: number, item?: number, frame?: number): JobFault {
  return new JobFault('ImageTooLarge', `${width} x ${height} pixels`, { ...(item !== undefined ? { item } : {}), ...(frame !== undefined ? { page: frame + 1 } : {}) });
}

/**
 * Opens a picture file. Throws ImageTooLarge (over 50 megapixels, for any frame) or Damaged (MuPDF cannot read it). `item` is the
 * list row, carried into the error.
 */
export async function openPicture(mu: MuModule, bytes: Uint8Array, decodeWebp: WebpDecoder | null, item?: number): Promise<Picture> {
  const format = pictureFormat(bytes);
  const keep: Array<{ destroy(): void }> = [];
  const dispose = () => {
    for (const thing of keep.splice(0)) {
      try {
        thing.destroy();
      } catch {
        // Already released.
      }
    }
  };
  try {
    if (format === 'webp') {
      if (!decodeWebp) throw new JobFault('Damaged', 'WebP cannot be read here');
      let decoded: { width: number; height: number; png: Uint8Array };
      try {
        decoded = await decodeWebp(bytes);
      } catch (error) {
        if (error instanceof JobFault) throw error;
        throw new JobFault('Damaged', 'The WebP picture could not be decoded', item !== undefined ? { item } : {});
      }
      if (decoded.width * decoded.height > MAX_PICTURE_PIXELS) throw tooLarge(decoded.width, decoded.height, item);
      let image: Mu.Image | null = null;
      return {
        format,
        // createImageBitmap has applied the orientation already.
        frames: [
          {
            widthPx: decoded.width,
            heightPx: decoded.height,
            xDpi: DEFAULT_DPI,
            yDpi: DEFAULT_DPI,
            orientation: 1,
            use: (fn) => {
              if (!image) {
                image = new mu.Image(decoded.png);
                keep.push(image);
              }
              return fn(image);
            },
          },
        ],
        dispose,
      };
    }
    if (format === 'tiff') {
      let doc: Mu.Document;
      try {
        doc = mu.Document.openDocument(bytes, 'image/tiff');
      } catch {
        throw new JobFault('Damaged', 'The TIFF picture could not be read', item !== undefined ? { item } : {});
      }
      keep.push(doc);
      const count = doc.countPages();
      if (!(count > 0)) throw new JobFault('Damaged', 'The TIFF picture has no frames', item !== undefined ? { item } : {});
      const frames: PictureFrame[] = [];
      for (let n = 0; n < count; n++) {
        // Only the size, the resolution and the orientation of each frame are kept; the frame is decoded again when it is used.
        const info = tiffFrameImage(mu, doc, n, (image) => ({ w: image.getWidth(), h: image.getHeight(), x: image.getXResolution(), y: image.getYResolution() }));
        if (info.w * info.h > MAX_PICTURE_PIXELS) throw tooLarge(info.w, info.h, item, n);
        frames.push({
          widthPx: info.w,
          heightPx: info.h,
          xDpi: info.x,
          yDpi: info.y,
          orientation: pictureOrientation(bytes, 'tiff', n),
          use: (fn) => tiffFrameImage(mu, doc, n, fn),
        });
      }
      return { format, frames, dispose };
    }
    if (format === 'unknown') throw new JobFault('Damaged', 'Not a picture PDF Suite can read', item !== undefined ? { item } : {});
    let image: Mu.Image;
    try {
      image = new mu.Image(bytes);
    } catch {
      throw new JobFault('Damaged', 'The picture could not be read', item !== undefined ? { item } : {});
    }
    keep.push(image);
    const w = image.getWidth();
    const h = image.getHeight();
    if (w * h > MAX_PICTURE_PIXELS) throw tooLarge(w, h, item);
    return {
      format,
      frames: [{ widthPx: w, heightPx: h, xDpi: image.getXResolution(), yDpi: image.getYResolution(), orientation: pictureOrientation(bytes, format), use: (fn) => fn(image) }],
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Runs `fn` with the image of frame `n` of a TIFF document, taken from the device that draws the page; the frame is released after. */
function tiffFrameImage<T>(mu: MuModule, doc: Mu.Document, n: number, fn: (image: Mu.Image) => T): T {
  const page = doc.loadPage(n);
  let found: Mu.Image | null = null;
  const device = new mu.Device({
    fillImage(image: Mu.Image) {
      found ??= image;
    },
  });
  try {
    page.run(device, mu.Matrix.identity);
  } finally {
    device.close();
    device.destroy();
    page.destroy();
  }
  const image = found as Mu.Image | null;
  if (!image) throw new JobFault('Damaged', 'The TIFF frame has no picture');
  try {
    return fn(image);
  } finally {
    image.destroy();
    // The decoded pixels of the frame may sit in MuPDF's cache: let them go before the next frame.
    mu.shrinkStore(0);
  }
}

// ---- Adding pages ----------------------------------------------------------------------------------------------------------------

/** Adds one page for a frame of a picture after the last page of `out`. */
export function addPicturePage(mu: MuModule, out: Mu.PDFDocument, frame: PictureFrame, target: 'image' | PageDims): void {
  const place = placePicture(frame, target);
  const image = frame.use((picture) => out.addImage(picture));
  const xobjects = out.newDictionary();
  xobjects.put('Im0', image);
  const resources = out.addObject(out.newDictionary());
  resources.put('XObject', xobjects);
  const [a, b, c, d, e, f] = place.matrix;
  const contents = `q ${round(a)} ${round(b)} ${round(c)} ${round(d)} ${round(e)} ${round(f)} cm /Im0 Do Q`;
  out.insertPage(-1, out.addPage(place.mediaBox, 0, resources, contents));
  void mu;
}
