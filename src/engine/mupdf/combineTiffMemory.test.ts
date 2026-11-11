// @vitest-environment node
// 1.3.3 review fix: a long multi-page TIFF (a fax: PackBits, bilevel) is decoded one frame at a time, never all at once. 240 frames of
// 2550 x 3300 are about 2 GB decoded, which failed with a malloc error before; now the WASM heap stays within the memory ceiling
// (2.5 x the file + 96 MB) at probe time and at run time, and every frame becomes a page. Own file: the heap is measured, and it
// never shrinks.
import { describe, expect, it, vi } from 'vitest';
import type { FromJob } from './jobProtocol';

const wasm = vi.hoisted(() => {
  const holder = {} as { HEAPU8?: Uint8Array };
  (globalThis as unknown as { $libmupdf_wasm_Module: unknown }).$libmupdf_wasm_Module = holder;
  return holder;
});
import * as mu from 'mupdf';
import { JobSession } from './jobCore';
import { LETTER } from './textLayout';
import { reread } from '../../../tests/lib/reread.mjs';
import { makePackBitsFax } from '../../../tests/lib/makeImages.mjs';

const MB = 1024 * 1024;

describe('a long fax TIFF', () => {
  it('240 frames: probe and run stay inside 2.5 x file + 96 MB of heap, and every frame is a page', async () => {
    const FRAMES = 240;
    const tiff = makePackBitsFax(FRAMES, 2550, 3300);
    const ceiling = 2.5 * tiff.length + 96 * MB;
    const heap = () => wasm.HEAPU8!.buffer.byteLength;
    const chunks: Uint8Array[] = [];
    const messages: FromJob[] = [];
    const session: JobSession = new JobSession(mu, (m: FromJob) => {
      messages.push(m);
      if (m.t === 'need') queueMicrotask(() => session.handle({ t: 'input', id: m.id, index: m.index, bytes: tiff.slice().buffer as ArrayBuffer }));
      if (m.t === 'chunk') {
        chunks.push(new Uint8Array(m.bytes));
        queueMicrotask(() => session.handle({ t: 'ack', id: m.id, file: m.file, seq: m.seq }));
      }
    });
    session.handle({ t: 'probe', id: 1, kind: 'image', bytes: tiff.slice().buffer as ArrayBuffer, item: 1, imagePage: 'image' });
    await session.idle();
    const probed = messages.find((m) => m.t === 'probed');
    expect(probed).toMatchObject({ pages: FRAMES });
    const afterProbe = heap();
    // A preview of a frame in the middle is made from that frame alone.
    session.handle({ t: 'thumb', id: 2, item: 1, page: 120, maxPx: 100 });
    await session.idle();
    expect(messages.some((m) => m.t === 'thumbed')).toBe(true);
    session.handle({ t: 'start', id: 3, spec: { kind: 'combine', items: [{ kind: 'image', name: 'fax.tif' }], fileBookmarks: true, imagePage: 'image', textPage: LETTER, leafName: 'Out.pdf' } });
    await session.idle();
    session.dispose();
    console.log(`fax: ${FRAMES} frames, ${Math.round(tiff.length / MB)} MB file, heap after probe ${Math.round(afterProbe / MB)} MB, after run ${Math.round(heap() / MB)} MB, ceiling ${Math.round(ceiling / MB)} MB`);
    expect(messages.find((m) => m.t === 'error')).toBeUndefined();
    expect(afterProbe).toBeLessThanOrEqual(ceiling);
    expect(heap()).toBeLessThanOrEqual(ceiling);
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    expect((await reread(out)).pages).toBe(FRAMES);
  }, 240_000);
});
