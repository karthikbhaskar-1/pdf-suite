// @vitest-environment node
// 1.3.2 memory ceiling (blueprint section 1): the job's memory stays within 2.5 x the input + 96 MB while a 73 MB file with many
// big images is split into parts that are built, saved, sent and destroyed one at a time. Measured as the WASM heap's high-water
// mark (HEAPU8.buffer.byteLength, which never shrinks) from before the job to its end, so a part that is not released shows. It was
// the process's resident memory before: that counts other test files in the same process and the timing of garbage collection, so
// it was the wrong measurement (orchestrator-approved change; the ceiling is unchanged). See combineMemory.test.ts.
// Skipped when the corpus file is absent.
import { describe, expect, it, vi } from 'vitest';

// MuPDF fills this object with its Emscripten module (HEAPU8) when it loads: it must exist before `mupdf` is imported.
const wasm = vi.hoisted(() => {
  const holder = {} as { HEAPU8?: Uint8Array };
  (globalThis as unknown as { $libmupdf_wasm_Module: unknown }).$libmupdf_wasm_Module = holder;
  return holder;
});
import * as mu from 'mupdf';
import fs from 'node:fs';
import { JobSession } from './jobCore';
import type { FromJob } from './jobProtocol';

const brochure = new URL('../../../tests/engine/corpus/brochure-images/brochure.pdf', import.meta.url);

describe.skipIf(!fs.existsSync(brochure))('job memory ceiling', () => {
  it('splitting the 73 MB brochure in parts of 2 pages stays under 2.5 x input + 96 MB over where it started', async () => {
    const bytes = new Uint8Array(fs.readFileSync(brochure));
    const mb = (n: number) => Math.round(n / (1024 * 1024));
    const counts = mu.Document.openDocument(bytes.slice(), 'application/pdf').countPages();
    const parts: Array<{ from: number; to: number; leafName: string }> = [];
    for (let from = 1; from <= counts; from += 2) parts.push({ from, to: Math.min(counts, from + 1), leafName: `B - ${String(parts.length + 1).padStart(2, '0')}.pdf` });

    let peak = 0;
    let sent = 0;
    const session: JobSession = new JobSession(mu, (message: FromJob) => {
      peak = Math.max(peak, wasm.HEAPU8!.buffer.byteLength);
      if (message.t === 'chunk') {
        sent += message.bytes.byteLength;
        queueMicrotask(() => session.handle({ t: 'ack', id: message.id, file: message.file, seq: message.seq }));
      }
    });
    const start = wasm.HEAPU8!.buffer.byteLength;
    peak = start;
    session.handle({ t: 'probe', id: 1, kind: 'pdf', bytes: bytes.slice().buffer as ArrayBuffer });
    await session.idle();
    session.handle({ t: 'start', id: 2, spec: { kind: 'split', baseName: 'B', plan: { by: 'ranges', parts } } });
    await session.idle();
    session.dispose();
    const growth = peak - start;
    const ceiling = 2.5 * bytes.length + 96 * 1024 * 1024;
    console.log(`brochure ${counts} pages, ${mb(bytes.length)} MB in; ${parts.length} parts, ${mb(sent)} MB out; heap growth ${mb(growth)} MB; ceiling ${mb(ceiling)} MB`);
    expect(sent).toBeGreaterThan(0);
    expect(growth).toBeLessThanOrEqual(ceiling);
  }, 120_000);
});
