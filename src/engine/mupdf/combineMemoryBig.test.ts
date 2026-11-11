// @vitest-environment node
// 1.3.3 memory ceiling for ONE big input (docs/milestone-1.5/combine-memory-ruling.md): a single 281 MB PDF (four brochures combined,
// made in a child process so this test starts with an empty WASM heap) is combined; the heap high-water mark stays within
// 2.5 x input + 96 MB, and the save does not grow it after the reserve. Skipped when the corpus file is absent.
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const wasm = vi.hoisted(() => {
  const holder = {} as { HEAPU8?: Uint8Array };
  (globalThis as unknown as { $libmupdf_wasm_Module: unknown }).$libmupdf_wasm_Module = holder;
  return holder;
});
import * as mu from 'mupdf';
import { JobSession } from './jobCore';
import { LETTER } from './textLayout';
import type { FromJob } from './jobProtocol';

const brochure = new URL('../../../tests/engine/corpus/brochure-images/brochure.pdf', import.meta.url);
const entry = new URL('../../../tests/lib/makeBigInput.entry.ts', import.meta.url);
const MB = 1024 * 1024;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfsuite-big-'));
// The bundle sits inside the project (not the temp folder) so that `mupdf` resolves from the project's node_modules; it is removed after.
const bundle = path.join(new URL('../../../tests/lib/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), `makeBigInput.${process.pid}.tmp.mjs`);
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(bundle, { force: true });
});

describe.skipIf(!fs.existsSync(brochure))('combine memory ceiling, one 281 MB input', () => {
  it('heap <= 2.5 x input + 96 MB, and the save does not grow it', async () => {
    buildSync({ entryPoints: [new URL(entry).pathname.replace(/^\/([A-Za-z]:)/, '$1')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, external: ['mupdf'], logLevel: 'silent' });
    const bigPath = path.join(work, 'big.pdf');
    const made = spawnSync(process.execPath, [bundle, new URL(brochure).pathname.replace(/^\/([A-Za-z]:)/, '$1'), bigPath], { cwd: new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const big = new Uint8Array(fs.readFileSync(bigPath));

    let atReserve = 0;
    const heap = () => wasm.HEAPU8!.buffer.byteLength;
    const session: JobSession = new JobSession(
      mu,
      (message: FromJob) => {
        if (message.t === 'need') queueMicrotask(() => session.handle({ t: 'input', id: message.id, index: message.index, bytes: big.slice().buffer as ArrayBuffer }));
        if (message.t === 'chunk') queueMicrotask(() => session.handle({ t: 'ack', id: message.id, file: message.file, seq: message.seq }));
      },
      { afterReserve: () => (atReserve = heap()) },
    );
    session.handle({ t: 'start', id: 1, spec: { kind: 'combine', items: [{ kind: 'pdf', name: 'big.pdf' }], fileBookmarks: true, imagePage: 'image', textPage: LETTER, leafName: 'Out.pdf' } });
    await session.idle();
    session.dispose();
    const ceiling = 2.5 * big.length + 96 * MB;
    console.log(`one input: ${Math.round(big.length / MB)} MB in, heap ${Math.round(heap() / MB)} MB, ceiling ${Math.round(ceiling / MB)} MB`);
    expect(atReserve).toBeGreaterThan(0);
    expect(heap()).toBeLessThanOrEqual(ceiling);
    expect(heap()).toBe(atReserve);
  }, 240_000);
});
