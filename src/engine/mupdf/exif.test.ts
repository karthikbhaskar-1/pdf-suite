// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { pictureFormat, pictureOrientation } from './exif';
import { makeBmp, makeGif, makePng, makeTiff, withExif } from '../../../tests/lib/makeImages.mjs';

const jpeg = (): Uint8Array => {
  const px = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  px.clear(90);
  return px.asJPEG(80);
};

describe('pictureFormat', () => {
  it('names each format from its first bytes', () => {
    expect(pictureFormat(jpeg())).toBe('jpeg');
    expect(pictureFormat(makePng(4, 4))).toBe('png');
    expect(pictureFormat(makeGif(4, 4))).toBe('gif');
    expect(pictureFormat(makeBmp(4, 4))).toBe('bmp');
    expect(pictureFormat(makeTiff([{ w: 4, h: 4 }]))).toBe('tiff');
    expect(pictureFormat(Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'), (c) => c.charCodeAt(0)))).toBe('webp');
    expect(pictureFormat(new TextEncoder().encode('hello'))).toBe('unknown');
  });
});

describe('pictureOrientation: all eight values', () => {
  for (const value of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
    it(`JPEG with orientation ${value}`, () => {
      expect(pictureOrientation(withExif(jpeg(), { orientation: value }), 'jpeg')).toBe(value);
    });
    it(`TIFF with orientation ${value}`, () => {
      expect(pictureOrientation(makeTiff([{ w: 6, h: 4, orientation: value }]), 'tiff')).toBe(value);
    });
  }

  it('is 1 for a JPEG without EXIF, a PNG, and garbage', () => {
    expect(pictureOrientation(jpeg(), 'jpeg')).toBe(1);
    expect(pictureOrientation(makePng(4, 4), 'png')).toBe(1);
    expect(pictureOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]), 'jpeg')).toBe(1);
    expect(pictureOrientation(new Uint8Array(3), 'tiff')).toBe(1);
  });

  it('each frame of a TIFF has its own orientation', () => {
    const tiff = makeTiff([
      { w: 6, h: 4, orientation: 6 },
      { w: 6, h: 4 },
      { w: 6, h: 4, orientation: 3 },
    ]);
    expect([0, 1, 2, 3].map((n) => pictureOrientation(tiff, 'tiff', n))).toEqual([6, 1, 3, 1]);
  });

  it('a JPEG with orientation and DPI together reads both without confusing them', () => {
    const file = withExif(jpeg(), { orientation: 8, dpi: 300 });
    expect(pictureOrientation(file, 'jpeg')).toBe(8);
    expect(new mu.Image(file).getXResolution()).toBe(300);
  });
});

describe('webpSize reads the header of the three WebP kinds', () => {
  const riff = (chunk: string, body: number[]) => {
    const out = new Uint8Array(30 + body.length);
    out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    out.set([...chunk].map((c) => c.charCodeAt(0)), 12);
    return Object.assign(out, {}) && (() => { out.set(body, 20); return out; })();
  };
  it('lossy (VP8), lossless (VP8L) and extended (VP8X)', async () => {
    const { webpSize } = await import('./exif');
    // VP8: frame tag (3 bytes), start code 9d 01 2a, width and height as 16-bit values (14 used).
    const lossy = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x1f, 0xb8, 0x0b]);
    expect(webpSize(lossy)).toEqual({ width: 8000, height: 3000 });
    // VP8L: signature 0x2f then 14 bits of (width - 1) and 14 bits of (height - 1).
    const w = 7999;
    const h = 2999;
    const bits = (w & 0x3fff) | ((h & 0x3fff) << 14);
    const lossless = riff('VP8L', [0, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
    lossless.set([0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255], 20);
    expect(webpSize(lossless)).toEqual({ width: 8000, height: 3000 });
    // VP8X: canvas width - 1 and height - 1 as 24-bit values at 24 and 27.
    const ext = riff('VP8X', []);
    ext.set([7999 & 255, 7999 >> 8, 0, 2999 & 255, 2999 >> 8, 0], 24);
    expect(webpSize(ext)).toEqual({ width: 8000, height: 3000 });
    expect(webpSize(new Uint8Array(40))).toBeNull();
    // The 1 x 1 lossy file of the other tests.
    const tiny = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'), (c) => c.charCodeAt(0));
    expect(webpSize(tiny)).toEqual({ width: 1, height: 1 });
  });
});
