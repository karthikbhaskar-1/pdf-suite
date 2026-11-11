// @vitest-environment node
// Typing of job inputs from magic bytes (blueprint section 2).
import { describe, expect, it } from 'vitest';
import { classifyHead } from './sniff';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);
const pad = (head: Uint8Array, length = 64) => {
  const out = new Uint8Array(Math.max(length, head.length));
  out.set(head);
  return out;
};

describe('classifyHead', () => {
  it('knows a PDF by its header, also after leading junk, whatever the name', () => {
    expect(classifyHead(text('%PDF-1.7\n'), 9, 'a.pdf')).toBe('pdf');
    expect(classifyHead(text('junk\n%PDF-1.4'), 13, 'renamed.txt')).toBe('pdf');
  });

  it('knows the six picture formats by their first bytes, not by their name', () => {
    expect(classifyHead(pad(bytes(0xff, 0xd8, 0xff, 0xe0)), 64, 'x.dat')).toBe('image');
    expect(classifyHead(pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 64, 'x.dat')).toBe('image');
    expect(classifyHead(pad(text('GIF89a')), 64, 'x.dat')).toBe('image');
    expect(classifyHead(pad(bytes(0x49, 0x49, 0x2a, 0x00)), 64, 'x.dat')).toBe('image');
    expect(classifyHead(pad(bytes(0x4d, 0x4d, 0x00, 0x2a)), 64, 'x.dat')).toBe('image');
    const webp = pad(text('RIFF\0\0\0\0WEBPVP8 '));
    expect(classifyHead(webp, 64, 'x.dat')).toBe('image');
    const bmp = pad(text('BM'));
    bmp[14] = 40;
    expect(classifyHead(bmp, 64, 'x.dat')).toBe('image');
  });

  it('refuses HEIC, SVG and unknown binaries; calls Office files office', () => {
    expect(classifyHead(pad(bytes(0, 0, 0, 0x18, ...text('ftypheic'))), 64, 'x.heic')).toBe('unsupported');
    expect(classifyHead(text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 80, 'x.svg')).toBe('unsupported');
    expect(classifyHead(pad(bytes(1, 2, 3, 4)), 64, 'x.bin')).toBe('unsupported');
    expect(classifyHead(pad(bytes(0x50, 0x4b, 0x03, 0x04)), 64, 'Report.docx')).toBe('office');
    expect(classifyHead(pad(bytes(0xd0, 0xcf, 0x11, 0xe0)), 64, 'old.xls')).toBe('office');
    expect(classifyHead(pad(bytes(0x50, 0x4b, 0x03, 0x04)), 64, 'archive.zip')).toBe('office');
    expect(classifyHead(new Uint8Array(0), 0, 'empty.pdf')).toBe('unsupported');
    // An empty text file is typed as text: Combine then says it is empty instead of calling it the wrong kind of file.
    expect(classifyHead(new Uint8Array(0), 0, 'empty.txt')).toBe('text');
  });

  it('calls .txt .log .md .csv text, with a UTF-16 byte order mark allowed, and anything with NUL bytes binary', () => {
    for (const name of ['a.txt', 'b.LOG', 'c.md', 'd.csv']) expect(classifyHead(text('hello, world'), 12, name)).toBe('text');
    expect(classifyHead(pad(bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00)), 6, 'u16.txt')).toBe('text');
    expect(classifyHead(pad(bytes(0x68, 0x00, 0x69, 0x00)), 64, 'binary.txt')).toBe('unsupported');
    expect(classifyHead(text('hello'), 5, 'notes.docx')).toBe('office');
    expect(classifyHead(text('hello'), 5, 'notes.dat')).toBe('unsupported');
  });
});
