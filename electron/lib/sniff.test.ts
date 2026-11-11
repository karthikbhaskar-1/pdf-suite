// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SNIFF_WINDOW_BYTES, sniffFile, sniffHead, type SniffHandle } from './sniff';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sniffHead', () => {
  it('finds the header at offset 0', () => {
    expect(sniffHead(enc('%PDF-1.7\n'), 9)).toBe('pdf');
  });

  it('accepts leading junk within the first 1 KB, as PDF readers do', () => {
    const junk = new Uint8Array(500).fill(0x20);
    const bytes = new Uint8Array([...junk, ...enc('%PDF-1.4')]);
    expect(sniffHead(bytes, bytes.length)).toBe('pdf');
  });

  it('rejects a header that only appears after the 1 KB window', () => {
    const junk = new Uint8Array(SNIFF_WINDOW_BYTES).fill(0x20);
    const bytes = new Uint8Array([...junk, ...enc('%PDF-1.4')]);
    expect(sniffHead(bytes, bytes.length)).toBe('not-pdf');
  });

  it('rejects a PNG', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(sniffHead(png, 1000)).toBe('not-pdf');
  });

  it('reports 0 bytes as empty', () => {
    expect(sniffHead(new Uint8Array(0), 0)).toBe('empty');
  });
});

/** A fake file of `size` bytes that records every read it is asked for. */
function fakeFile(size: number, head: string) {
  const reads: number[] = [];
  let closed = false;
  const content = enc(head);
  const handle: SniffHandle = {
    stat: async () => ({ size }),
    read: async (buffer, offset, length, position) => {
      reads.push(length);
      const n = Math.max(0, Math.min(length, content.length - position));
      buffer.set(content.subarray(position, position + n), offset);
      return { bytesRead: n };
    },
    close: async () => {
      closed = true;
    },
  };
  return { open: async () => handle, reads, isClosed: () => closed };
}

describe('sniffFile', () => {
  it('reads only the first 1 KB of a large file, not the whole of it', async () => {
    const fake = fakeFile(1_000_000_000, 'not a pdf at all');
    const result = await sniffFile('C:\disc.iso', fake.open);
    expect(result).toEqual({ kind: 'not-pdf', size: 1_000_000_000 });
    expect(fake.reads).toEqual([SNIFF_WINDOW_BYTES]);
    expect(fake.isClosed()).toBe(true);
  });

  it('does not read at all for an empty file', async () => {
    const fake = fakeFile(0, '');
    expect(await sniffFile('C:\empty.pdf', fake.open)).toEqual({ kind: 'empty', size: 0 });
    expect(fake.reads).toEqual([]);
  });

  it('recognises a PDF header in the first window', async () => {
    const fake = fakeFile(4000, '%PDF-1.7 rest of file');
    expect((await sniffFile('C:\a.pdf', fake.open)).kind).toBe('pdf');
  });
});
