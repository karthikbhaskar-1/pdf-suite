/**
 * Picture orientation for Combine (blueprint B2: "Orientation comes from our own EXIF reader, all eight values"). MuPDF does
 * not apply it (pinned by combineProbes.test.ts: a TIFF with Orientation 6 still reaches a device unturned), so the reader
 * lives here, is pure, and reads only the few bytes it needs.
 *
 *  - JPEG: the EXIF block in an APP1 segment.
 *  - TIFF: the Orientation tag of the frame's own directory (each frame has one).
 *  - PNG: the eXIf chunk.
 * Everything else, and anything that cannot be read, is orientation 1 (upright). Never throws.
 */

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type PictureFormat = 'jpeg' | 'png' | 'gif' | 'bmp' | 'tiff' | 'webp' | 'unknown';

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** What a picture file is, from its first bytes. */
export function pictureFormat(b: Uint8Array): PictureFormat {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'tiff';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 0, 'BM')) return 'bmp';
  return 'unknown';
}

function asOrientation(value: number): Orientation {
  return value >= 1 && value <= 8 ? (value as Orientation) : 1;
}

/** The Orientation tag (274) of directory number `frame` (0-based) of a TIFF structure that starts at `base` in `b`. */
function tiffOrientation(b: Uint8Array, base: number, frame: number): Orientation {
  if (b.length < base + 8) return 1;
  const little = b[base] === 0x49 && b[base + 1] === 0x49;
  if (!little && !(b[base] === 0x4d && b[base + 1] === 0x4d)) return 1;
  const u16 = (at: number) => (at + 2 <= b.length ? (little ? b[at]! | (b[at + 1]! << 8) : (b[at]! << 8) | b[at + 1]!) : 0);
  const u32 = (at: number) => (at + 4 <= b.length ? (little ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0 : ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0) : 0);
  if (u16(base + 2) !== 42) return 1;
  let ifd = u32(base + 4);
  for (let n = 0; n <= frame; n++) {
    const at = base + ifd;
    if (ifd === 0 || at + 2 > b.length) return 1;
    const count = u16(at);
    if (n === frame) {
      for (let i = 0; i < count; i++) {
        const entry = at + 2 + i * 12;
        if (entry + 12 > b.length) return 1;
        if (u16(entry) === 274) return asOrientation(u16(entry + 8));
      }
      return 1;
    }
    ifd = u32(at + 2 + count * 12);
  }
  return 1;
}

function jpegOrientation(b: Uint8Array): Orientation {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return 1;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Start of scan or end of image: no EXIF after this.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = (b[at + 2]! << 8) | b[at + 3]!;
    if (length < 2) return 1;
    if (marker === 0xe1 && ascii(b, at + 4, 'Exif\0\0')) return tiffOrientation(b, at + 10, 0);
    at += 2 + length;
  }
  return 1;
}

function pngOrientation(b: Uint8Array): Orientation {
  let at = 8;
  while (at + 12 <= b.length) {
    const length = ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    if (ascii(b, at + 4, 'eXIf')) return tiffOrientation(b, at + 8, 0);
    at += 12 + length;
  }
  return 1;
}

/** The orientation of picture `frame` (0-based; only TIFF has more than one) of a file. */
export function pictureOrientation(bytes: Uint8Array, format: PictureFormat, frame = 0): Orientation {
  try {
    if (format === 'jpeg') return jpegOrientation(bytes);
    if (format === 'tiff') return tiffOrientation(bytes, 0, frame);
    if (format === 'png') return pngOrientation(bytes);
  } catch {
    return 1;
  }
  return 1;
}

/**
 * The pixel size of a WebP picture, read from its header without decoding it (so the 50 megapixel limit is checked first). Handles
 * the three kinds: lossy (VP8), lossless (VP8L) and extended (VP8X). Null when the header is not one of them.
 */
export function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (pictureFormat(b) !== 'webp' || b.length < 30) return null;
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  const u24 = (at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
  if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  return null;
}
