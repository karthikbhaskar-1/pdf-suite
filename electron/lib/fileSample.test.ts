// @vitest-environment node
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_BYTES, sampleOfBytes, sampleOfFile } from './fileSample';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pdfsuite-sample-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const pattern = (length: number, seed = 1): Uint8Array => Uint8Array.from({ length }, (_v, i) => (i * 31 + seed) & 255);

describe('the content sample (1.5.1 M9)', () => {
  it('the sample of a file on disk equals the sample of its bytes, for small, edge-size and large files', async () => {
    for (const length of [1, 100, SAMPLE_BYTES, SAMPLE_BYTES + 1, 2 * SAMPLE_BYTES - 1, 2 * SAMPLE_BYTES, 2 * SAMPLE_BYTES + 1, 1_000_000]) {
      const bytes = pattern(length);
      const path = join(dir, `f${length}.bin`);
      await fs.writeFile(path, bytes);
      expect(await sampleOfFile(path), `length ${length}`).toBe(sampleOfBytes(bytes));
    }
  });

  it('a change in the first or last 64 KB changes the sample; a change in the middle of a long file does not (the sample is cheap on purpose)', () => {
    const base = pattern(1_000_000);
    const original = sampleOfBytes(base);
    const head = base.slice();
    head[10] = head[10]! ^ 1;
    const tail = base.slice();
    tail[tail.length - 10] = tail[tail.length - 10]! ^ 1;
    const middle = base.slice();
    middle[500_000] = middle[500_000]! ^ 1;
    expect(sampleOfBytes(head)).not.toBe(original);
    expect(sampleOfBytes(tail)).not.toBe(original);
    expect(sampleOfBytes(middle)).toBe(original);
  });

  it('a different length with the same ends gives a different sample', () => {
    expect(sampleOfBytes(pattern(300_000))).not.toBe(sampleOfBytes(pattern(300_001)));
  });

  it('a missing file rejects', async () => {
    await expect(sampleOfFile(join(dir, 'nope.bin'))).rejects.toThrow();
  });
});

describe('reading the sample (review)', () => {
  it('keeps reading when a read returns fewer bytes than asked, and fails when the file ends early', async () => {
    const path = join(dir, 'short.bin');
    await fs.writeFile(path, pattern(300_000));
    // A handle whose reads return at most 1000 bytes at a time, as a slow or network file may.
    const slowOpen = async (target: string, flags: 'r') => {
      const handle = await fs.open(target, flags);
      const original = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      (handle as unknown as { read: unknown }).read = (buffer: Buffer, offset: number, length: number, position: number) =>
        original(buffer, offset, Math.min(length, 1000), position);
      return handle;
    };
    expect(await sampleOfFile(path, slowOpen)).toBe(sampleOfBytes(pattern(300_000)));
    // A file that ends before its sample is read (it shrank meanwhile) is an error, not a short sample.
    const shrinking = async (target: string, flags: 'r') => {
      const handle = await fs.open(target, flags);
      (handle as unknown as { read: unknown }).read = async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) });
      return handle;
    };
    await expect(sampleOfFile(path, shrinking)).rejects.toThrow(/ended before/);
  });
});
