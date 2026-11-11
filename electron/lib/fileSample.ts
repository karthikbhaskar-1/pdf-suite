import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

/**
 * A cheap content sample of a file: a SHA-256 of its first and last 64 KB (the whole file when it is shorter than 128 KB),
 * with its size mixed in. A recovery log names pages by position, so it must only be replayed onto the file its edits were
 * made on; size and modified time alone cannot tell two files apart that share both. The sample catches a swapped file at the
 * cost of reading at most 128 KB, or of nothing at all when the bytes are already in memory (a read for an open).
 */

/** Bytes taken from each end. */
export const SAMPLE_BYTES = 64 * 1024;

/** The sample of bytes already in memory. */
export function sampleOfBytes(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(String(bytes.byteLength));
  hash.update(bytes.subarray(0, SAMPLE_BYTES));
  if (bytes.byteLength > SAMPLE_BYTES) hash.update(bytes.subarray(Math.max(SAMPLE_BYTES, bytes.byteLength - SAMPLE_BYTES)));
  return hash.digest('hex');
}

/** Reads exactly `buffer.length` bytes at `position`; a file that ends sooner (it shrank while being read) is an error. */
async function readFully(handle: fs.FileHandle, buffer: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < buffer.length) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done);
    if (bytesRead === 0) throw new Error('The file ended before its sample was read.');
    done += bytesRead;
  }
}

/** The sample of a file on disk, read from its two ends only. It equals sampleOfBytes of the same file. */
export async function sampleOfFile(path: string, open: (path: string, flags: 'r') => Promise<fs.FileHandle> = fs.open): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
    await readFully(handle, head, 0);
    const hash = createHash('sha256');
    hash.update(String(size));
    hash.update(head);
    if (size > SAMPLE_BYTES) {
      const start = Math.max(SAMPLE_BYTES, size - SAMPLE_BYTES);
      const tail = Buffer.alloc(size - start);
      await readFully(handle, tail, start);
      hash.update(tail);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
