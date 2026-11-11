// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { exactArrayBuffer } from './exactArrayBuffer';

describe('exactArrayBuffer', () => {
  it('hands over the underlying ArrayBuffer, not a copy, when the Buffer spans all of it', () => {
    const data = Buffer.from(new ArrayBuffer(1024));
    data.fill(7);
    const out = exactArrayBuffer(data);
    expect(out).toBe(data.buffer);
    expect(out.byteLength).toBe(1024);
  });

  it('copies exactly the viewed bytes when the Buffer is a slice of a larger ArrayBuffer', () => {
    const whole = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const slice = Buffer.from(whole.buffer, 2, 3);
    const out = exactArrayBuffer(slice);
    expect(out).not.toBe(whole.buffer);
    expect([...new Uint8Array(out)]).toEqual([3, 4, 5]);
  });

  it('a Buffer that starts at 0 but is shorter than its ArrayBuffer is copied', () => {
    const whole = new Uint8Array([9, 8, 7, 6]);
    const out = exactArrayBuffer(Buffer.from(whole.buffer, 0, 2));
    expect(out.byteLength).toBe(2);
    expect([...new Uint8Array(out)]).toEqual([9, 8]);
  });

  it('an empty Buffer gives an empty ArrayBuffer', () => {
    expect(exactArrayBuffer(Buffer.alloc(0)).byteLength).toBe(0);
  });
});
