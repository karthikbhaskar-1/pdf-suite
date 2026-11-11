// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { A4, LETTER } from './textLayout';
import { MAX_PICTURE_PIXELS, addPicturePage, openPicture, placePicture, usableDpi, type WebpDecoder } from './imagePage';
import type { Orientation } from './exif';
import { JobFault } from './jobProtocol';
import { reread } from '../../../tests/lib/reread.mjs';
import { makeBmp, makeGif, makePng, makeTiff, withExif } from '../../../tests/lib/makeImages.mjs';

describe('placePicture (pure)', () => {
  const base = { widthPx: 144, heightPx: 72, xDpi: 72, yDpi: 72, orientation: 1 as Orientation };

  it('the page is the picture size: pixels x 72 / DPI', () => {
    expect(placePicture({ ...base, xDpi: 144, yDpi: 144 }, 'image').mediaBox).toEqual([0, 0, 72, 36]);
    expect(placePicture(base, 'image').matrix).toEqual([144, 0, 0, 72, 0, 0]);
  });

  it('a stated DPI outside 36-2400 counts as unstated (96)', () => {
    expect(usableDpi(10)).toBe(96);
    expect(usableDpi(5000)).toBe(96);
    expect(usableDpi(0)).toBe(96);
    expect(usableDpi(300)).toBe(300);
    expect(placePicture({ ...base, widthPx: 96, heightPx: 96, xDpi: 5000, yDpi: 5000 }, 'image').mediaBox).toEqual([0, 0, 72, 72]);
  });

  it('orientation 5 to 8 swaps width and height', () => {
    for (const o of [5, 6, 7, 8] as const) expect(placePicture({ ...base, orientation: o }, 'image').mediaBox).toEqual([0, 0, 72, 144]);
    for (const o of [1, 2, 3, 4] as const) expect(placePicture({ ...base, orientation: o }, 'image').mediaBox).toEqual([0, 0, 144, 72]);
  });

  it('on Letter: 36 pt margins, fitted and centred; a wide picture turns the page landscape', () => {
    const tall = placePicture({ ...base, widthPx: 100, heightPx: 400 }, LETTER);
    expect(tall.mediaBox).toEqual([0, 0, 612, 792]);
    const [a, , , d, e, f] = tall.matrix;
    // The 540 x 720 box is filled by height: 720 tall, 180 wide, centred.
    expect(d).toBeCloseTo(720);
    expect(a).toBeCloseTo(180);
    expect(e).toBeCloseTo((612 - 180) / 2);
    expect(f).toBeCloseTo(36);
    const wide = placePicture(base, LETTER);
    expect(wide.mediaBox).toEqual([0, 0, 792, 612]);
    expect(wide.matrix[0]).toBeCloseTo(792 - 72);
    expect(wide.matrix[4]).toBeCloseTo(36);
  });

  it('on A4 the same rules apply', () => {
    const p = placePicture({ ...base, widthPx: 100, heightPx: 100 }, A4);
    expect(p.mediaBox[2]).toBeCloseTo(595.28);
    expect(p.matrix[0]).toBeCloseTo(595.28 - 72);
    expect(p.matrix[5]).toBeCloseTo((841.89 - (595.28 - 72)) / 2);
  });

  it('a huge low-DPI picture is scaled to fit the PDF page limit', () => {
    const p = placePicture({ ...base, widthPx: 40000, heightPx: 100, xDpi: 36, yDpi: 36 }, 'image');
    expect(p.mediaBox[2]).toBeCloseTo(14400);
  });
});

/** The colour at a point of a rendered page, from the pixmap (RGB). */
function sample(pixmap: mu.Pixmap, x: number, y: number): [number, number, number] {
  const px = pixmap.getPixels();
  const n = pixmap.getNumberOfComponents();
  const at = y * pixmap.getStride() + x * n;
  return [px[at]!, px[at + 1]!, px[at + 2]!];
}

function renderFirstPage(bytes: Uint8Array): mu.Pixmap {
  const doc = mu.Document.openDocument(bytes, 'application/pdf');
  return doc.loadPage(0).toPixmap(mu.Matrix.identity, mu.ColorSpace.DeviceRGB, false, true);
}

async function pageFor(file: Uint8Array, target: 'image' | typeof LETTER = 'image'): Promise<Uint8Array> {
  const picture = await openPicture(mu, file, null);
  try {
    const out = new mu.PDFDocument();
    for (const frame of picture.frames) addPicturePage(mu, out, frame, target);
    return out.saveToBuffer('garbage=compact').asUint8Array().slice();
  } finally {
    picture.dispose();
  }
}

const near = (got: number[], want: number[], tolerance = 40) => got.every((v, i) => Math.abs(v - want[i]!) <= tolerance);

describe('a picture on its page, drawn and read back', () => {
  // The stored picture: red grows to the right, green downwards. Stored corners: TL (0,0), TR (255,0), BL (0,255), BR (255,255).
  const COLOUR = { TL: [0, 0, 7], TR: [255, 0, 7], BL: [0, 255, 7], BR: [255, 255, 7] } as const;
  // Which stored corner shows at the display's top-left and top-right, for each EXIF orientation.
  const TOP_LEFT = { 1: 'TL', 2: 'TR', 3: 'BR', 4: 'BL', 5: 'TL', 6: 'BL', 7: 'BR', 8: 'TR' } as const;
  const TOP_RIGHT = { 1: 'TR', 2: 'TL', 3: 'BL', 4: 'BR', 5: 'BL', 6: 'TL', 7: 'TR', 8: 'BR' } as const;

  for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
    it(`TIFF with EXIF orientation ${o}: the right corners are at the top of the page, and the page has the right shape`, async () => {
      const tiff = makeTiff([{ w: 40, h: 20, seed: 7, dpi: 72, orientation: o }]);
      const pdf = await pageFor(tiff);
      const pixmap = renderFirstPage(pdf);
      const swapped = o >= 5;
      expect([pixmap.getWidth(), pixmap.getHeight()]).toEqual(swapped ? [20, 40] : [40, 20]);
      const w = pixmap.getWidth();
      expect(near(sample(pixmap, 1, 1), [...COLOUR[TOP_LEFT[o]]]), `top-left ${sample(pixmap, 1, 1)}`).toBe(true);
      expect(near(sample(pixmap, w - 2, 1), [...COLOUR[TOP_RIGHT[o]]]), `top-right ${sample(pixmap, w - 2, 1)}`).toBe(true);
    });
  }

  it('JPEG with orientation 6 is turned the same way, and keeps its own bytes (not re-encoded)', async () => {
    const px = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      px.getPixels().set([Math.round((255 * x) / 39), Math.round((255 * y) / 19), 7], (y * 40 + x) * 3);
    }
    const jpeg = withExif(px.asJPEG(95), { orientation: 6, dpi: 72 });
    const pdf = await pageFor(jpeg);
    const pixmap = renderFirstPage(pdf);
    expect([pixmap.getWidth(), pixmap.getHeight()]).toEqual([20, 40]);
    expect(near(sample(pixmap, 1, 1), [...COLOUR.BL], 60)).toBe(true);
    // The picture's stream in the PDF is the JPEG file's own data.
    const doc = new mu.PDFDocument(pdf);
    const xobject = doc.findPage(0).get('Resources').get('XObject').get('Im0');
    expect(String(xobject.get('Filter').asName())).toBe('DCTDecode');
    const stream = xobject.readRawStream().asUint8Array();
    const start = jpeg.findIndex((_b, i) => jpeg[i] === 0xff && jpeg[i + 1] === 0xdb);
    expect(Buffer.from(jpeg).includes(Buffer.from(stream.subarray(0, 2000)))).toBe(true);
    expect(start).toBeGreaterThan(0);
  });

  it('PNG, BMP and GIF each make a page the size of the picture', async () => {
    for (const [name, file] of [['PNG', makePng(30, 20, 7, 72)], ['BMP', makeBmp(30, 20, 7)], ['GIF', makeGif(30, 20, 7)]] as const) {
      const read = await reread(await pageFor(file as Uint8Array));
      expect(read.pages, name).toBe(1);
      expect(read.sizes[0]!.width, name).toBeGreaterThan(5);
    }
  });

  it('a PNG of 150 DPI is a page of 72 x 48 pt when it is 150 x 100 pixels', async () => {
    const read = await reread(await pageFor(makePng(150, 100, 7, 150)));
    expect(read.sizes[0]).toMatchObject({ width: 72, height: 48 });
  });

  it('on Letter the picture is fitted inside the margins and centred, and the page is Letter', async () => {
    const pdf = await pageFor(makePng(100, 100, 7, 72), LETTER);
    const pixmap = renderFirstPage(pdf);
    expect([pixmap.getWidth(), pixmap.getHeight()]).toEqual([612, 792]);
    // The margin is white, the picture is not.
    expect(sample(pixmap, 10, 10)).toEqual([255, 255, 255]);
    expect(sample(pixmap, 306, 396)).not.toEqual([255, 255, 255]);
    expect(sample(pixmap, 36 + 5, 396 - 100 - 5 + 100)).not.toEqual([255, 255, 255]);
  });
});

describe('a multi-page TIFF (probe D6)', () => {
  const tiff = makeTiff([
    { w: 30, h: 20, seed: 1, dpi: 72 },
    { w: 10, h: 40, seed: 2, dpi: 72 },
    { w: 25, h: 25, seed: 3, dpi: 72, orientation: 6 },
  ]);

  it('has one frame per page, with each frame its own size and orientation', async () => {
    const picture = await openPicture(mu, tiff, null);
    try {
      expect(picture.frames.map((f) => [f.widthPx, f.heightPx, f.orientation])).toEqual([[30, 20, 1], [10, 40, 1], [25, 25, 6]]);
    } finally {
      picture.dispose();
    }
  });

  it('every frame becomes a page, in order, at its own size', async () => {
    const read = await reread(await pageFor(tiff));
    expect(read.pages).toBe(3);
    expect(read.sizes.map((s) => [s.width, s.height])).toEqual([[30, 20], [10, 40], [25, 25]]);
  });
});

describe('limits and damage', () => {
  it('a picture over 50 megapixels is ImageTooLarge, with the row', async () => {
    // A PNG header that says 8000 x 8000 (64 megapixels) is enough: the size is read before anything is decoded.
    const big = makePng(8, 8);
    const view = Buffer.from(big);
    view.writeUInt32BE(8000, 16);
    view.writeUInt32BE(8000, 20);
    await expect(openPicture(mu, new Uint8Array(view), null, 4)).rejects.toMatchObject({ kind: 'ImageTooLarge', item: 4 });
    expect(8000 * 8000).toBeGreaterThan(MAX_PICTURE_PIXELS);
  });

  it('a damaged picture is Damaged', async () => {
    await expect(openPicture(mu, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), null)).rejects.toBeInstanceOf(JobFault);
    await expect(openPicture(mu, new Uint8Array([1, 2, 3, 4]), null)).rejects.toMatchObject({ kind: 'Damaged' });
  });

  it('WebP goes through the supplied decoder, as PNG; without one it is Damaged', async () => {
    const decode: WebpDecoder = async () => ({ width: 30, height: 20, png: makePng(30, 20, 5, 72) });
    const webp = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'), (c) => c.charCodeAt(0));
    const picture = await openPicture(mu, webp, decode);
    try {
      expect(picture.frames).toHaveLength(1);
      const out = new mu.PDFDocument();
      addPicturePage(mu, out, picture.frames[0]!, 'image');
      expect(out.countPages()).toBe(1);
    } finally {
      picture.dispose();
    }
    await expect(openPicture(mu, webp, null)).rejects.toMatchObject({ kind: 'Damaged' });
    const huge: WebpDecoder = async () => ({ width: 9000, height: 9000, png: new Uint8Array() });
    await expect(openPicture(mu, webp, huge)).rejects.toMatchObject({ kind: 'ImageTooLarge' });
  });
});
