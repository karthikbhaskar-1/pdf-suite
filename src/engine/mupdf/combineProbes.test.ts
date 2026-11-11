// @vitest-environment node
// Appendix D "verify first" probes for 1.3.3, pinned as tests (MuPDF 1.28.6 WASM). Combine builds on these facts.
//   D2  mu.Image decodes PNG, TIFF, GIF, BMP and JPEG in this build (WebP is another matter: see below)
//   D3  new mu.Font('Courier') with addSimpleFont for Latin, Greek and Cyrillic
//   D6  Document.openDocument(bytes, 'image/tiff') gives one page per frame, and a device's fillImage receives each frame
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { reread } from '../../../tests/lib/reread.mjs';
import { makeBmp, makeGif, makePng, makeTiff, withExif } from '../../../tests/lib/makeImages.mjs';

describe('D2: which picture formats mu.Image decodes', () => {
  const formats: Array<[string, () => Uint8Array]> = [
    ['PNG', () => makePng(20, 10)],
    ['BMP', () => makeBmp(20, 10)],
    ['GIF', () => makeGif(20, 10)],
    ['TIFF', () => makeTiff([{ w: 20, h: 10 }])],
    ['JPEG', () => {
      const px = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 20, 10], false);
      px.clear(200);
      return px.asJPEG(80);
    }],
  ];
  for (const [name, make] of formats) {
    it(`${name} decodes to the right size`, () => {
      const image = new mu.Image(make());
      expect(image.getWidth()).toBe(20);
      expect(image.getHeight()).toBe(10);
      const pixmap = image.toPixmap();
      expect(pixmap.getWidth()).toBe(20);
      pixmap.destroy();
      image.destroy();
    });
  }

  it('reads the DPI of a PNG with pHYs, a TIFF and a JPEG with EXIF', () => {
    expect(new mu.Image(makePng(20, 10, 0, 150)).getXResolution()).toBe(150);
    expect(new mu.Image(makeTiff([{ w: 20, h: 10, dpi: 200 }])).getXResolution()).toBe(200);
    const px = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 20, 10], false);
    px.clear(50);
    const jpeg = withExif(px.asJPEG(80), { dpi: 300 });
    expect(new mu.Image(jpeg).getXResolution()).toBe(300);
  });

  it('a PDF image made from a JPEG keeps the JPEG bytes (it is not re-encoded)', () => {
    const px = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 40, 40], false);
    px.clear(120);
    const jpeg = px.asJPEG(80);
    const pdf = new mu.PDFDocument();
    const ref = pdf.addImage(new mu.Image(jpeg));
    const filter = ref.resolve().get('Filter');
    expect(String(filter.asName?.() ?? filter)).toContain('DCTDecode');
  });

  it('WebP is not decoded by MuPDF in this build, so it goes through createImageBitmap in the job worker', () => {
    // RIFF....WEBPVP8 (a 1x1 lossy file).
    const webp = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'), (c) => c.charCodeAt(0));
    expect(() => new mu.Image(webp)).toThrow();
  });
});

describe('D3: Courier with addSimpleFont for Latin, Greek and Cyrillic', () => {
  // The byte of each character in the encoding MuPDF uses for a simple font: Latin is WinAnsi (Windows-1252), Greek is
  // ISO 8859-7 and Cyrillic is KOI8-U.
  const LABEL: Record<mu.FontSimpleEncoding, string> = { Latin: 'windows-1252', Greek: 'iso-8859-7', Cyrillic: 'koi8-u' };
  const byteOf = (encoding: mu.FontSimpleEncoding): Map<string, number> => {
    const decoder = new TextDecoder(LABEL[encoding]);
    const map = new Map<string, number>();
    for (let b = 32; b < 256; b++) {
      const ch = decoder.decode(Uint8Array.of(b));
      if (ch !== '�' && !map.has(ch)) map.set(ch, b);
    }
    return map;
  };
  const cases: Array<[mu.FontSimpleEncoding, string]> = [
    ['Latin', 'Café naïve € 100'],
    ['Greek', 'Αθήνα Ωμέγα'],
    ['Cyrillic', 'Москва Язык'],
  ];

  for (const [encoding, text] of cases) {
    it(`${encoding}: the glyphs exist, they are drawn, and pdf.js and MuPDF read the text back`, async () => {
      const courier = new mu.Font('Courier');
      for (const ch of text) if (ch !== ' ') expect(courier.encodeCharacter(ch), `${encoding} ${ch}`).toBeGreaterThan(0);
      const map = byteOf(encoding);
      const hex = [...text].map((ch) => (map.get(ch) ?? 63).toString(16).padStart(2, '0')).join('');
      expect([...text].every((ch) => map.has(ch))).toBe(true);
      const pdf = new mu.PDFDocument();
      const fonts = pdf.newDictionary();
      fonts.put('F1', pdf.addSimpleFont(courier, encoding));
      const resources = pdf.addObject(pdf.newDictionary());
      resources.put('Font', fonts);
      pdf.insertPage(-1, pdf.addPage([0, 0, 300, 100], 0, resources, `BT /F1 20 Tf 10 40 Td <${hex}> Tj ET`));
      const saved = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();

      const read = await reread(saved);
      expect(read.text[0]).toBe(text);

      const doc = mu.Document.openDocument(saved, 'application/pdf');
      const page = doc.loadPage(0);
      expect(page.toStructuredText('preserve-whitespace').asText().trim()).toBe(text);
      const pixmap = page.toPixmap(mu.Matrix.scale(1, 1), mu.ColorSpace.DeviceGray, false, true);
      let ink = 0;
      for (const v of pixmap.getPixels()) if (v < 128) ink += 1;
      expect(ink).toBeGreaterThan(150);
    });
  }
});

describe('D6: a multi-page TIFF opens as a document', () => {
  it('has one page per frame, and fillImage receives each frame with its own size', () => {
    const tiff = makeTiff([
      { w: 30, h: 20, seed: 1, dpi: 100 },
      { w: 10, h: 40, seed: 2, dpi: 100 },
      { w: 25, h: 25, seed: 3 },
    ]);
    const doc = mu.Document.openDocument(tiff, 'image/tiff');
    expect(doc.countPages()).toBe(3);
    const sizes: Array<[number, number]> = [];
    for (let i = 0; i < 3; i++) {
      const page = doc.loadPage(i);
      const seen: Array<[number, number]> = [];
      const device = new mu.Device({
        fillImage(image: mu.Image) {
          seen.push([image.getWidth(), image.getHeight()]);
        },
      });
      page.run(device, mu.Matrix.identity);
      device.close();
      expect(seen).toHaveLength(1);
      sizes.push(seen[0]!);
    }
    expect(sizes).toEqual([[30, 20], [10, 40], [25, 25]]);
  });
});
