// Builds small picture files for the Combine tests: PNG, BMP, GIF, TIFF (one or several pages), and JPEG (with an optional EXIF
// orientation and DPI). Pure Node, no app. Pixel (x, y) of a test picture is `colourAt(x, y, w, h, seed)`, so a test can say what
// every corner should look like after the picture has been placed on a PDF page.
import { deflateSync } from 'node:zlib';

/** A colour that depends on the position: red grows to the right, green downwards, blue is the seed. Every corner differs. */
export function colourAt(x, y, w, h, seed = 0) {
  return [Math.round((255 * x) / Math.max(1, w - 1)), Math.round((255 * y) / Math.max(1, h - 1)), seed & 255];
}

/** Raw RGB rows (top to bottom) of a w x h test picture. */
export function rgbPixels(w, h, seed = 0) {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.set(colourAt(x, y, w, h, seed), (y * w + x) * 3);
  }
  return out;
}

function crc32(bytes) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < bytes.length; n++) {
    c = (crc ^ bytes[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A PNG (8-bit RGB). `dpi` writes a pHYs chunk. */
export function makePng(w, h, seed = 0, dpi = 0) {
  const chunks = [];
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    chunks.push(head, data, crcBuf);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk('IHDR', ihdr);
  if (dpi > 0) {
    const phys = Buffer.alloc(9);
    const perMetre = Math.round(dpi / 0.0254);
    phys.writeUInt32BE(perMetre, 0);
    phys.writeUInt32BE(perMetre, 4);
    phys[8] = 1;
    chunk('pHYs', phys);
  }
  const px = rgbPixels(w, h, seed);
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    Buffer.from(px.buffer, y * w * 3, w * 3).copy(raw, y * (1 + w * 3) + 1);
  }
  chunk('IDAT', deflateSync(raw));
  chunk('IEND', Buffer.alloc(0));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]));
}

/** A 24-bit BMP. */
export function makeBmp(w, h, seed = 0) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const data = Buffer.alloc(54 + rowBytes * h);
  data.write('BM', 0, 'latin1');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(w, 18);
  data.writeInt32LE(h, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(rowBytes * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colourAt(x, y, w, h, seed);
      const at = 54 + (h - 1 - y) * rowBytes + x * 3;
      data[at] = b;
      data[at + 1] = g;
      data[at + 2] = r;
    }
  }
  return new Uint8Array(data);
}

/** A GIF with a 256-colour palette (one palette entry per distinct colour is not needed: colours are quantised to 3-3-2 bits). */
export function makeGif(w, h, seed = 0) {
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    palette[i * 3] = Math.round(((i >> 5) & 7) * 255 / 7);
    palette[i * 3 + 1] = Math.round(((i >> 2) & 7) * 255 / 7);
    palette[i * 3 + 2] = Math.round((i & 3) * 255 / 3);
  }
  const index = (x, y) => {
    const [r, g, b] = colourAt(x, y, w, h, seed);
    return (Math.round((r * 7) / 255) << 5) | (Math.round((g * 7) / 255) << 2) | Math.round((b * 3) / 255);
  };
  // LZW with 8-bit symbols and a clear code every 254 symbols: the code width stays 9 bits.
  const bits = [];
  let acc = 0;
  let nbits = 0;
  const put = (code) => {
    acc |= code << nbits;
    nbits += 9;
    while (nbits >= 8) {
      bits.push(acc & 255);
      acc >>>= 8;
      nbits -= 8;
    }
  };
  let count = 0;
  put(256);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (count === 250) {
        put(256);
        count = 0;
      }
      put(index(x, y));
      count += 1;
    }
  }
  put(257);
  if (nbits > 0) bits.push(acc & 255);
  const blocks = [];
  for (let i = 0; i < bits.length; i += 255) {
    const part = bits.slice(i, i + 255);
    blocks.push(part.length, ...part);
  }
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1');
  head.writeUInt16LE(w, 6);
  head.writeUInt16LE(h, 8);
  head[10] = 0xf7;
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(w, 5);
  desc.writeUInt16LE(h, 7);
  return new Uint8Array(Buffer.concat([head, palette, desc, Buffer.from([8]), Buffer.from(blocks), Buffer.from([0, 0x3b])]));
}

/**
 * A little-endian TIFF with one uncompressed RGB page per entry of `pages` ({ w, h, seed, dpi?, orientation? }).
 * `dpi` writes XResolution and YResolution (inch); `orientation` writes the Orientation tag.
 */
export function makeTiff(pages) {
  const parts = [];
  let offset = 8;
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  parts.push(header);
  let firstIfd = 0;
  pages.forEach((page, i) => {
    const strip = Buffer.from(rgbPixels(page.w, page.h, page.seed ?? i));
    const entries = [
      [256, 4, 1, page.w],
      [257, 4, 1, page.h],
      [258, 3, 3, 'bps'],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 4, 1, 'strip'],
      [277, 3, 1, 3],
      [278, 4, 1, page.h],
      [279, 4, 1, strip.length],
    ];
    if (page.dpi) entries.push([282, 5, 1, 'xres'], [283, 5, 1, 'yres'], [296, 3, 1, 2]);
    if (page.orientation) entries.push([274, 3, 1, page.orientation]);
    entries.sort((a, b) => a[0] - b[0]);
    const ifdAt = offset + strip.length;
    if (i === 0) firstIfd = ifdAt;
    const ifdSize = 2 + 12 * entries.length + 4;
    const extraAt = ifdAt + ifdSize;
    const extraBuf = Buffer.alloc(6 + (page.dpi ? 16 : 0));
    extraBuf.writeUInt16LE(8, 0);
    extraBuf.writeUInt16LE(8, 2);
    extraBuf.writeUInt16LE(8, 4);
    if (page.dpi) {
      extraBuf.writeUInt32LE(page.dpi, 6);
      extraBuf.writeUInt32LE(1, 10);
      extraBuf.writeUInt32LE(page.dpi, 14);
      extraBuf.writeUInt32LE(1, 18);
    }
    const ifd = Buffer.alloc(ifdSize);
    ifd.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], k) => {
      const at = 2 + k * 12;
      ifd.writeUInt16LE(tag, at);
      ifd.writeUInt16LE(type, at + 2);
      ifd.writeUInt32LE(count, at + 4);
      if (value === 'bps') ifd.writeUInt32LE(extraAt, at + 8);
      else if (value === 'strip') ifd.writeUInt32LE(offset, at + 8);
      else if (value === 'xres') ifd.writeUInt32LE(extraAt + 6, at + 8);
      else if (value === 'yres') ifd.writeUInt32LE(extraAt + 14, at + 8);
      else if (type === 3) ifd.writeUInt16LE(value, at + 8);
      else ifd.writeUInt32LE(value, at + 8);
    });
    const next = extraAt + extraBuf.length;
    const nextPage = pages[i + 1];
    ifd.writeUInt32LE(nextPage ? next + nextPage.w * nextPage.h * 3 : 0, ifdSize - 4);
    parts.push(strip, ifd, extraBuf);
    offset = next;
  });
  header.writeUInt32LE(firstIfd, 4);
  return new Uint8Array(Buffer.concat(parts));
}

/** A JPEG made by MuPDF's encoder, with an EXIF segment (orientation and DPI) put after the start marker. */
export function withExif(jpeg, { orientation = 0, dpi = 0 } = {}) {
  if (!orientation && !dpi) return jpeg;
  const entries = [];
  if (orientation) entries.push([0x0112, 3, 1, orientation]);
  if (dpi) entries.push([0x011a, 5, 1, 'xres'], [0x011b, 5, 1, 'yres'], [0x0128, 3, 1, 2]);
  entries.sort((a, b) => a[0] - b[0]);
  const tiffHead = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const extraAt = tiffHead + ifdSize;
  const body = Buffer.alloc(tiffHead + ifdSize + (dpi ? 16 : 0));
  body.write('MM', 0, 'latin1');
  body.writeUInt16BE(42, 2);
  body.writeUInt32BE(8, 4);
  body.writeUInt16BE(entries.length, 8);
  entries.forEach(([tag, type, count, value], k) => {
    const at = 10 + k * 12;
    body.writeUInt16BE(tag, at);
    body.writeUInt16BE(type, at + 2);
    body.writeUInt32BE(count, at + 4);
    if (value === 'xres') body.writeUInt32BE(extraAt, at + 8);
    else if (value === 'yres') body.writeUInt32BE(extraAt + 8, at + 8);
    else if (type === 3) body.writeUInt16BE(value, at + 8);
    else body.writeUInt32BE(value, at + 8);
  });
  if (dpi) {
    body.writeUInt32BE(dpi, extraAt);
    body.writeUInt32BE(1, extraAt + 4);
    body.writeUInt32BE(dpi, extraAt + 8);
    body.writeUInt32BE(1, extraAt + 12);
  }
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), body]);
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1;
  marker.writeUInt16BE(app1.length + 2, 2);
  return new Uint8Array(Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), marker, app1, Buffer.from(jpeg.subarray(2))]));
}

/**
 * A multi-page bilevel TIFF compressed with PackBits (a fax: big when decoded, small on disk). Each page is white with a black
 * stripe of `stripe` rows at the top, so a page is not empty. Decoded, a frame is about w x h bytes; the file is a few KB a page.
 */
export function makePackBitsFax(frames, w, h, stripe = 8) {
  const rowBytes = Math.ceil(w / 8);
  const packRow = (value) => {
    const out = [];
    let left = rowBytes;
    while (left > 0) {
      const n = Math.min(128, left);
      out.push((257 - n) & 0xff, value);
      left -= n;
    }
    return out;
  };
  const white = packRow(0);
  const black = packRow(0xff);
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(y < stripe ? black : white);
  const data = Buffer.from(rows.flat());
  const parts = [];
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  parts.push(header);
  let offset = 8;
  let first = 0;
  for (let i = 0; i < frames; i++) {
    // Photometric 0: white is zero. Compression 32773: PackBits.
    const entries = [[256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, 1], [259, 3, 1, 32773], [262, 3, 1, 0], [273, 4, 1, offset], [277, 3, 1, 1], [278, 4, 1, h], [279, 4, 1, data.length]];
    const ifdAt = offset + data.length;
    if (i === 0) first = ifdAt;
    const size = 2 + 12 * entries.length + 4;
    const ifd = Buffer.alloc(size);
    ifd.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], k) => {
      const at = 2 + k * 12;
      ifd.writeUInt16LE(tag, at);
      ifd.writeUInt16LE(type, at + 2);
      ifd.writeUInt32LE(count, at + 4);
      if (type === 3) ifd.writeUInt16LE(value, at + 8);
      else ifd.writeUInt32LE(value, at + 8);
    });
    const next = ifdAt + size;
    ifd.writeUInt32LE(i + 1 < frames ? next + data.length : 0, size - 4);
    parts.push(data, ifd);
    offset = next;
  }
  header.writeUInt32LE(first, 4);
  return new Uint8Array(Buffer.concat(parts));
}
