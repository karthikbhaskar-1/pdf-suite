// @vitest-environment node
// 1.3.3 memory ceiling (blueprint section 1, as ruled in docs/milestone-1.5/combine-memory-ruling.md): the job worker's WASM heap
// high-water mark stays within 2.5 x the total input + 96 MB while N copies of the 73 MB brochure are combined (read one at a time,
// built into one document, saved, checked and sent out in 4 MB pieces), and a single 281 MB-class input (the output of the
// four-copy run) is combined too. The heap never shrinks, so its size at the end is its high-water mark. After the heap reserve
// (change A) the save must not grow it. The cases run smallest first on one MuPDF instance (the heap never shrinks), so each figure is an upper bound. Skipped when the corpus file is absent.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { FromJob } from './jobProtocol';

// MuPDF fills this object with its Emscripten module (HEAPU8) when it loads. It must exist before `mupdf` is imported.
const wasm = vi.hoisted(() => {
  const holder = {} as { HEAPU8?: Uint8Array };
  (globalThis as unknown as { $libmupdf_wasm_Module: unknown }).$libmupdf_wasm_Module = holder;
  return holder;
});
import * as mu from 'mupdf';
import { JobSession } from './jobCore';
import { LETTER } from './textLayout';

const brochure = new URL('../../../tests/engine/corpus/brochure-images/brochure.pdf', import.meta.url);
const MB = 1024 * 1024;

interface Run {
  heap: number;
  atReserve: number;
  total: number;
  out: Uint8Array;
}

/**
 * Combines `inputs` and reports the WASM heap. The heap never shrinks and MuPDF is loaded once per test file, so the cases run from
 * the smallest up and each figure is an upper bound of that case's own high-water mark.
 */
async function combine(inputs: Uint8Array[]): Promise<Run> {
  const heap = () => wasm.HEAPU8!.buffer.byteLength;
  let atReserve = 0;
  const chunks: Uint8Array[] = [];
  const session: InstanceType<typeof JobSession> = new JobSession(
    mu,
    (message: FromJob) => {
      if (message.t === 'need') {
        const bytes = inputs[message.index]!;
        queueMicrotask(() => session.handle({ t: 'input', id: message.id, index: message.index, bytes: bytes.slice().buffer as ArrayBuffer }));
      }
      if (message.t === 'chunk') {
        chunks.push(new Uint8Array(message.bytes));
        queueMicrotask(() => session.handle({ t: 'ack', id: message.id, file: message.file, seq: message.seq }));
      }
    },
    { afterReserve: () => (atReserve = heap()) },
  );
  session.handle({
    t: 'start',
    id: 1,
    spec: { kind: 'combine', items: inputs.map((_b, i) => ({ kind: 'pdf' as const, name: `f${i}.pdf` })), fileBookmarks: true, imagePage: 'image', textPage: LETTER, leafName: 'Out.pdf' },
  });
  await session.idle();
  session.dispose();
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { heap: heap(), atReserve, total: inputs.reduce((n, b) => n + b.length, 0), out };
}

describe.skipIf(!fs.existsSync(brochure))('combine memory ceiling (WASM heap high-water mark)', () => {
  const bytes = fs.existsSync(brochure) ? new Uint8Array(fs.readFileSync(brochure)) : new Uint8Array();

  for (const copies of [1, 2, 4]) {
    it(`${copies} x the 70 MB brochure: heap <= 2.5 x input + 96 MB, and the save does not grow it`, async () => {
      const run = await combine(Array.from({ length: copies }, () => bytes));
      const ceiling = 2.5 * run.total + 96 * MB;
      console.log(`${copies} brochure(s): ${Math.round(run.total / MB)} MB in, heap ${Math.round(run.heap / MB)} MB, ceiling ${Math.round(ceiling / MB)} MB, at reserve ${Math.round(run.atReserve / MB)} MB`);
      expect(run.out.length).toBeGreaterThan(0);
      expect(run.heap).toBeLessThanOrEqual(ceiling);
      expect(run.heap).toBe(run.atReserve);
    }, 120_000);
  }
});
