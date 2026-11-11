// Run by combineMemoryBig.test.ts in a child process (bundled with esbuild): combines four copies of a PDF into one file, on a MuPDF
// instance of its own, so the test that measures the big input starts with an empty heap. Usage: node <bundle> <in.pdf> <out.pdf>
import fs from 'node:fs';
import * as mu from 'mupdf';
import { JobSession } from '../../src/engine/mupdf/jobCore';
import { LETTER } from '../../src/engine/mupdf/textLayout';

const [input, output] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(input!));
const chunks: Uint8Array[] = [];
const session: JobSession = new JobSession(mu, (m) => {
  if (m.t === 'need') queueMicrotask(() => session.handle({ t: 'input', id: m.id, index: m.index, bytes: bytes.slice().buffer as ArrayBuffer }));
  if (m.t === 'chunk') {
    chunks.push(new Uint8Array(m.bytes));
    queueMicrotask(() => session.handle({ t: 'ack', id: m.id, file: m.file, seq: m.seq }));
  }
  if (m.t === 'error') throw new Error(m.kind);
});
session.handle({ t: 'start', id: 1, spec: { kind: 'combine', items: [0, 1, 2, 3].map((i) => ({ kind: 'pdf' as const, name: `f${i}.pdf` })), fileBookmarks: true, imagePage: 'image', textPage: LETTER, leafName: 'Out.pdf' } });
await session.idle();
fs.writeFileSync(output!, Buffer.concat(chunks));
process.exit(0);
