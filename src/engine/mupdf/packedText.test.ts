// @vitest-environment node
// Ticket 1.5.11, packed search text. The worker sends each page's line texts and one transferred Float32Array of character
// boundaries instead of one object per character. These tests prove the result is the same as before: the old reader is kept
// as an oracle (legacyRuns.testutil.ts), and the same pages are searched through both.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Mu from 'mupdf';
import { createPageList } from '../../core/model/pageList';
import { searchDocument, TEXT_CACHE_MAX_BYTES, TextCache, textBytes } from '../../features/search/searchRunner';
import { searchRuns, type SearchOptions } from '../../features/search/textSearch';
import type { TextRun } from '../types';
import { WorkerClient } from './client';
import { charBoxesOf, findStextModule, readPageRuns, type StextModule } from './fastText';
import { legacyReadRunsFast, type LegacyRun } from './legacyRuns.testutil';
import { MupdfDocument, runsBytes } from './mupdfDocument';
import { textTransferList, type PageTextData, type RunData, type WorkerEvent } from './protocol';
import { rotateRun } from './textLayer';

type MuModule = typeof Mu;
let mu: MuModule;
let wasmModule: unknown;

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

beforeAll(async () => {
  const wasmPath = join(ROOT, 'node_modules/mupdf/dist/mupdf-wasm.wasm');
  const compiled = await WebAssembly.compile(readFileSync(wasmPath));
  const host = globalThis as unknown as { $libmupdf_wasm_Module?: unknown };
  host.$libmupdf_wasm_Module = {
    instantiateWasm(imports: WebAssembly.Imports, ready: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(compiled, imports).then((instance) => ready(instance, compiled));
      return {};
    },
  };
  mu = (await import('mupdf')) as MuModule;
  wasmModule = host.$libmupdf_wasm_Module;
}, 60000);

afterAll(() => {
  delete (globalThis as { $libmupdf_wasm_Module?: unknown }).$libmupdf_wasm_Module;
});

interface PdfKitLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  font(name: string): PdfKitLike;
  fontSize(size: number): PdfKitLike;
  text(text: string, ...rest: unknown[]): PdfKitLike;
  addPage(options?: object): PdfKitLike;
  moveDown(lines: number): PdfKitLike;
  end(): void;
}

/** A text-dense file like tests/signoff/heavy-1000.pdf (about 2,500 characters a page, 23 lines), with fewer pages. */
async function heavyBytes(pages: number): Promise<Uint8Array> {
  const specifier = 'pdfkit';
  const { default: PDFDocument } = (await import(specifier)) as { default: new (options: object) => PdfKitLike };
  const doc = new PDFDocument({ size: 'LETTER', autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk as Buffer));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  const para =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ';
  for (let p = 1; p <= pages; p++) {
    doc.addPage({ margin: 54 });
    doc.fontSize(16).text(`Heavy page ${p}`, { align: 'left' });
    doc.moveDown(0.5).fontSize(9.5).text(para.repeat(11), { align: 'justify' });
  }
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

function corpusFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.pdf')) out.push(p);
    }
  };
  // The corpus is not redistributable: without it only the generated files are read.
  if (existsSync(join(ROOT, 'tests/engine/corpus'))) walk(join(ROOT, 'tests/engine/corpus'));
  return out;
}

interface PagePair {
  file: string;
  page: number;
  oldRuns: LegacyRun[];
  newRuns: RunData[];
}

/** Reads the first `limit` pages of a file through the old reader and the new one. A file MuPDF cannot open gives no pages. */
function readPairs(name: string, bytes: Uint8Array, limit: number): PagePair[] {
  let doc: Mu.PDFDocument | Mu.Document;
  try {
    doc = mu.Document.openDocument(bytes, 'application/pdf');
    if (doc.needsPassword()) return [];
  } catch {
    return [];
  }
  const pairs: PagePair[] = [];
  const module = findStextModule(wasmModule)!;
  try {
    const count = Math.min(limit, doc.countPages());
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      const stext = page.toStructuredText('');
      try {
        pairs.push({ file: name, page: i, oldRuns: legacyReadRunsFast(stext.pointer, module), newRuns: readPageRuns(stext, wasmModule) });
      } finally {
        stext.destroy();
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
  return pairs;
}

/** The old runs with every box rounded to a float, which is what the packed array stores. */
const rounded = (runs: LegacyRun[]): LegacyRun[] =>
  runs.map((run) => ({ ...run, charBoxes: run.charBoxes.map((b) => ({ start: Math.fround(b.start), end: Math.fround(b.end) })) }));

/** A run as the engine hands it to search: a copy, with the packed boundaries. */
const handedOut = (runs: RunData[]): TextRun[] => runs.map((run) => ({ ...run }));

const OPTION_SETS: SearchOptions[] = [
  { matchCase: false, wholeWord: false },
  { matchCase: true, wholeWord: false },
  { matchCase: false, wholeWord: true },
  { matchCase: true, wholeWord: true },
];

/** Queries drawn from the page's own words, plus some fixed ones that hit the 1.5.2 merge rules and letter-joined text. */
function queriesFor(runs: readonly { text: string }[]): string[] {
  const text = runs.map((run) => run.text).join(' ');
  const words = [...new Set(text.match(/\p{L}{3,}/gu) ?? [])];
  const picked = [0, 1, 2, 3, 4, 5].map((k) => words[Math.floor((words.length * k) / 6)]).filter((w): w is string => !!w);
  const phrase = text.match(/\S+ \S+/)?.[0];
  return [...picked, ...(phrase ? [phrase] : []), 'the', 'e', 'th', 'zephyr', 'qwert', 'b c', 'a b c', '1', '.'];
}

describe('packed text equals the old per-character text', () => {
  const pairs: PagePair[] = [];
  let heavyPairs = 0;

  beforeAll(async () => {
    for (const file of corpusFiles()) {
      pairs.push(...readPairs(file.slice(ROOT.length), new Uint8Array(readFileSync(file)), 25));
    }
    const big = join(ROOT, 'tests/fixtures/out/big-1000.pdf');
    pairs.push(...readPairs('big-1000.pdf', new Uint8Array(readFileSync(big)), 120));
    const heavy = readPairs('generated heavy', await heavyBytes(20), 20);
    heavyPairs = heavy.length;
    pairs.push(...heavy);
  }, 120000);

  it('reads pages from the corpus, the generated big file and the generated heavy file', () => {
    const files = new Set(pairs.map((p) => p.file));
    // The six-file minimum holds only with the downloaded corpus present.
    if (existsSync(join(ROOT, 'tests/engine/corpus/irs-fw9/fw9.pdf'))) expect(files.size).toBeGreaterThanOrEqual(6);
    expect(files.has('big-1000.pdf')).toBe(true);
    expect(heavyPairs).toBe(20);
    expect(pairs.filter((p) => p.file === 'generated heavy').every((p) => p.newRuns.reduce((n, r) => n + r.text.length, 0) > 2000)).toBe(true);
  });

  const HAVE_CORPUS = existsSync(join(ROOT, 'tests/engine/corpus/irs-fw9/fw9.pdf'));

  it('gives the same lines, geometry and character boundaries on every page (boundaries as 32-bit floats)', () => {
    let characters = 0;
    for (const { file, page, oldRuns, newRuns } of pairs) {
      const where = `${file} page ${page}`;
      expect(newRuns.map((r) => r.text), where).toEqual(oldRuns.map((r) => r.text));
      newRuns.forEach((run, i) => {
        const old = oldRuns[i]!;
        expect(run.origin, where).toEqual(old.origin);
        expect(run.along, where).toEqual(old.along);
        expect(run.up, where).toEqual(old.up);
        const boxes = charBoxesOf(run);
        expect(boxes, where).toEqual(rounded([old])[0]!.charBoxes);
        // Rounding to a float moves a boundary by less than 1e-4 of a point.
        let worst = 0;
        for (let k = 0; k < boxes.length; k++) {
          worst = Math.max(worst, Math.abs(boxes[k]!.start - old.charBoxes[k]!.start), Math.abs(boxes[k]!.end - old.charBoxes[k]!.end));
        }
        expect(worst, where).toBeLessThan(1e-4);
        characters += run.text.length;
      });
      // All the runs of a page share one array, and it holds exactly their boundaries.
      const shared = newRuns[0]?.bounds;
      if (shared) {
        expect(newRuns.every((r) => r.bounds === shared)).toBe(true);
        expect(shared.length).toBe(newRuns.reduce((n, r) => n + r.text.length + 1, 0));
        expect(shared.buffer.byteLength).toBe(shared.byteLength);
      }
    }
    // The 100,000-character floor holds only with the downloaded corpus present.
    if (HAVE_CORPUS) expect(characters).toBeGreaterThan(100000);
  });

  it('finds the same hits, in the same order, with the same highlight rectangles', () => {
    let hits = 0;
    let searches = 0;
    let rotatedHits = 0;
    for (const { file, page, oldRuns, newRuns } of pairs) {
      const queries = queriesFor(oldRuns);
      const oldRounded = rounded(oldRuns);
      const fresh = handedOut(newRuns);
      for (const options of OPTION_SETS) {
        for (const query of queries) {
          const where = `${file} page ${page} "${query}" ${JSON.stringify(options)}`;
          const want = searchRuns(oldRounded, query, options);
          const got = searchRuns(fresh, query, options);
          // Identical to the old result with the boundaries rounded the way the packed array rounds them.
          expect(got, where).toEqual(want);
          // And within a thousandth of a point of the old result with full-precision boxes.
          const exact = searchRuns(oldRuns, query, options);
          expect(got.map((m) => [m.start, m.end]), where).toEqual(exact.map((m) => [m.start, m.end]));
          let worst = 0;
          got.forEach((m, i) =>
            m.rects.forEach((r, j) => {
              const e = exact[i]!.rects[j]!;
              for (const key of ['x', 'y', 'width', 'height'] as const) worst = Math.max(worst, Math.abs(r[key] - e[key]));
            }),
          );
          expect(worst, where).toBeLessThan(1e-3);
          hits += got.length;
          searches++;
        }
      }
      // A page shown rotated: the same runs, turned.
      if (page < 3) {
        const old90 = oldRounded.map((run) => rotateRun(run, 612, 792, 90));
        const new90 = fresh.map((run) => rotateRun({ ...run }, 612, 792, 90));
        for (const query of queries.slice(0, 4)) {
          const options = OPTION_SETS[0]!;
          const want = searchRuns(old90, query, options);
          expect(searchRuns(new90, query, options), `${file} page ${page} rotated "${query}"`).toEqual(want);
          rotatedHits += want.length;
        }
      }
    }
    console.log(`packed text equivalence: ${pairs.length} pages, ${searches} searches, ${hits} hits, ${rotatedHits} rotated hits, all equal`);
    expect(searches).toBeGreaterThan(5000);
    expect(hits).toBeGreaterThan(2000);
    expect(rotatedHits).toBeGreaterThan(0);
  }, 120000);

  // The letter-spaced file is derived from the corpus (tests/engine/make-engine-fixtures.mjs); skipped when it is absent.
  it.skipIf(!HAVE_CORPUS)('finds letter-joined text on the letter-spaced file, with the same rectangles (needs the corpus)', () => {
    const spaced = pairs.filter((p) => p.file.includes('letter-spaced'));
    expect(spaced.length).toBeGreaterThan(0);
    let joined = 0;
    for (const { oldRuns, newRuns } of spaced) {
      const text = oldRuns.map((r) => r.text).join(' ');
      // A word of the page with its spaces removed is found through the letter-joined pass.
      const letters = text.match(/(?:\p{L} ){3,}\p{L}/u)?.[0];
      if (!letters) continue;
      const query = letters.replace(/ /g, '');
      const options = OPTION_SETS[0]!;
      const want = searchRuns(rounded(oldRuns), query, options);
      const got = searchRuns(handedOut(newRuns), query, options);
      expect(got).toEqual(want);
      joined += got.length;
    }
    expect(joined).toBeGreaterThan(0);
  });

  it('builds no box object for any run during a search', () => {
    const fresh = handedOut(pairs.find((p) => p.file === 'generated heavy')!.newRuns);
    const found = searchRuns(fresh, 'dolor', OPTION_SETS[0]!);
    expect(found.length).toBeGreaterThan(5);
    expect(fresh.every((run) => run.charBoxes === undefined)).toBe(true);
  });
});

/** A StextModule fed from lists of characters, so the readers can be compared on lines no file produces. */
interface FakeChar {
  code: number;
  size: number;
  quad: number[];
}

function fakeModule(lines: FakeChar[][]): StextModule {
  const all = lines.flat();
  const heap = new Float32Array(Math.max(1, all.length) * 8);
  all.forEach((c, i) => heap.set(c.quad, i * 8));
  const lineStart: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineStart.push(at);
    at += line.length;
  }
  const lineOf = (ptr: number) => ptr - 10;
  const charIndex = (ptr: number) => ptr - 1000;
  const lineEnd = (li: number) => (lineStart[li] ?? 0) + (lines[li]?.length ?? 0);
  return {
    HEAPF32: heap,
    _wasm_stext_page_get_first_block: () => 1,
    _wasm_stext_block_get_next: () => 0,
    _wasm_stext_block_get_type: () => 0,
    _wasm_stext_block_get_first_line: () => (lines.length ? 10 : 0),
    _wasm_stext_line_get_next: (line) => (lineOf(line) + 1 < lines.length ? line + 1 : 0),
    _wasm_stext_line_get_first_char: (line) => (lines[lineOf(line)]?.length ? 1000 + lineStart[lineOf(line)]! : 0),
    _wasm_stext_char_get_next: (ch) => {
      const next = charIndex(ch) + 1;
      let li = 0;
      for (let k = 0; k < lineStart.length; k++) if (lineStart[k]! <= charIndex(ch)) li = k;
      return next < lineEnd(li) ? 1000 + next : 0;
    },
    _wasm_stext_char_get_c: (ch) => all[charIndex(ch)]!.code,
    _wasm_stext_char_get_quad: (ch) => charIndex(ch) * 8 * 4,
    _wasm_stext_char_get_size: (ch) => all[charIndex(ch)]!.size,
  };
}

/** A small seeded generator, so a failure repeats. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomLine(rand: () => number): FakeChar[] {
  const n = 1 + Math.floor(rand() * 60);
  const size = 6 + rand() * 10;
  const angle = rand() < 0.3 ? rand() * Math.PI * 2 : 0;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const spacing = rand() < 0.4 ? size * (0.08 + rand() * 0.2) : 0;
  const x0 = rand() * 400;
  const y0 = 50 + rand() * 600;
  const out: FakeChar[] = [];
  let along = 0;
  const quadAt = (from: number, width: number): number[] => {
    // ul, ur, ll, lr in the page's space; the y axis points down, so "up" is minus the normal.
    const px = (d: number, h: number) => [x0 + dx * d + dy * h, y0 + dy * d - dx * h];
    return [...px(from, size), ...px(from + width, size), ...px(from, 0), ...px(from + width, 0)];
  };
  for (let i = 0; i < n; i++) {
    const r = rand();
    const width = size * (0.2 + rand() * 0.6);
    if (r < 0.14) {
      if (spacing > 0 && rand() < 0.7) {
        // A synthetic space in the character spacing: flush against both neighbours.
        out.push({ code: 32, size, quad: quadAt(along - spacing + spacing * 0.1, spacing * 0.8) });
      } else {
        out.push({ code: 32, size, quad: quadAt(along, width * 0.7) });
        along += width * 0.7 + spacing;
      }
      continue;
    }
    let code = 97 + Math.floor(rand() * 26);
    if (r > 0.97) code = 0x1f600 + Math.floor(rand() * 20);
    else if (r > 0.95) code = [-1, 0x110000, 0xd800, 0, 0xfffd, 0xe9, 0x4e2d][Math.floor(rand() * 7)]!;
    // Some glyphs overlap the one before (a negative gap), so the boundaries have to be clamped.
    const back = rand() < 0.05 ? width * 1.5 : 0;
    out.push({ code, size, quad: quadAt(along - back, width) });
    along += width + spacing;
  }
  // A line made only of spaces and a line of one character are valid lines too.
  return out;
}

describe('packed text equals the old text on lines no file produces', () => {
  it('matches the old reader on random lines: letter-spacing, dropped spaces, astral and invalid characters, overlaps, rotations', () => {
    const rand = seeded(20261110);
    let dropped = 0;
    let astral = 0;
    let lines = 0;
    for (let round = 0; round < 200; round++) {
      const page = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => randomLine(rand));
      const module = fakeModule(page);
      const old = legacyReadRunsFast(1, module);
      const fresh = (() => {
        const runs = readPageRuns({ pointer: 1 } as unknown as Mu.StructuredText, module);
        return runs;
      })();
      expect(fresh.map((r) => r.text), `round ${round}`).toEqual(old.map((r) => r.text));
      fresh.forEach((run, i) => {
        const o = old[i]!;
        expect(run.origin).toEqual(o.origin);
        expect(run.along).toEqual(o.along);
        expect(run.up).toEqual(o.up);
        const boxes = charBoxesOf(run);
        // (+ 0 turns the old reader's -0 at a run start into 0; both give the same rectangle.)
        expect(boxes).toEqual(o.charBoxes.map((b) => ({ start: Math.fround(b.start) + 0, end: Math.fround(b.end) + 0 })));
        lines++;
      });
      page.forEach((line, li) => {
        const extraUnits = line.filter((c) => c.code > 0xffff && c.code <= 0x10ffff).length;
        astral += extraUnits;
        if (fresh[li] && fresh[li]!.text.length < line.length + extraUnits) dropped++;
      });
    }
    // The generator must reach the branches it is meant to test.
    expect(lines).toBeGreaterThan(300);
    expect(dropped).toBeGreaterThan(5);
    expect(astral).toBeGreaterThan(3);
  });

  it('keeps an astral character as two units with its box split evenly, and a lone surrogate as one unit', () => {
    const q = (x0: number, x1: number) => [x0, 0, x1, 0, x0, 10, x1, 10];
    const module = fakeModule([
      [
        { code: 0x41, size: 10, quad: q(0, 6) },
        { code: 0x1f600, size: 10, quad: q(6, 18) },
        { code: 0xd800, size: 10, quad: q(18, 24) },
        { code: -5, size: 10, quad: q(24, 30) },
      ],
    ]);
    const [run] = readPageRuns({ pointer: 1 } as unknown as Mu.StructuredText, module);
    expect(run!.text).toBe('A\u{1F600}\uD800�');
    expect(run!.text.length).toBe(5);
    expect([...run!.bounds]).toEqual([0, 6, 12, 18, 24, 30]);
  });
});

describe('the worker reply', () => {
  it('moves one buffer per page, keeps the runs sharing it, and leaves nothing to copy', () => {
    const runs: RunData[] = [];
    const bounds = new Float32Array([0, 1, 2, 0, 3]);
    runs.push(
      { text: 'ab', origin: { x: 0, y: 0 }, along: { x: 2, y: 0 }, up: { x: 0, y: 1 }, bounds, boundsAt: 0 },
      { text: 'c', origin: { x: 0, y: 5 }, along: { x: 3, y: 0 }, up: { x: 0, y: 1 }, bounds, boundsAt: 3 },
    );
    const reply: PageTextData[] = [{ page: 0, runs }, { page: 1, runs: [] }];
    const transfer = textTransferList(reply);
    expect(transfer).toEqual([bounds.buffer]);
    const received = structuredClone(reply, { transfer });
    // The sender's buffer is gone (moved, not copied), and the receiver's runs still share one array.
    expect(bounds.buffer.byteLength).toBe(0);
    expect(received[0]!.runs[0]!.bounds).toBe(received[0]!.runs[1]!.bounds);
    expect([...received[0]!.runs[0]!.bounds]).toEqual([0, 1, 2, 0, 3]);
    expect(charBoxesOf(received[0]!.runs[1]!)).toEqual([{ start: 0, end: 3 }]);
  });
});

describe('the search text cache counts the packed bytes', () => {
  const heavyPage = async (): Promise<{ legacy: LegacyRun[]; packed: RunData[]; chars: number }> => {
    const [first] = readPairs('heavy', await heavyBytes(2), 1);
    const chars = first!.newRuns.reduce((n, r) => n + r.text.length, 0);
    return { legacy: first!.oldRuns, packed: first!.newRuns, chars };
  };

  it('counts 4 bytes a character for the boundaries, plus the text, instead of 32 for a box object', async () => {
    const { legacy, packed, chars } = await heavyPage();
    const lineCount = packed.length;
    expect(chars).toBeGreaterThan(2000);
    expect(textBytes(packed)).toBe(chars * 2 + lineCount * 64 + (chars + lineCount) * 4);
    // The same page with box objects (the old shape) counts 32 bytes a character more.
    expect(textBytes(legacy.map((r) => ({ ...r })))).toBe(chars * 2 + lineCount * 64 + chars * 32);
    expect(textBytes(packed)).toBeLessThan(textBytes(legacy) / 3);
  });

  it('holds all 1,000 text-dense pages under the 24 MB cap, where the old count held about a quarter', async () => {
    const { legacy, packed } = await heavyPage();
    const packedCache = new TextCache();
    const legacyCache = new TextCache();
    for (let i = 0; i < 1000; i++) {
      packedCache.set(`p${i}|0`, handedOut(packed));
      legacyCache.set(`p${i}|0`, legacy.map((r) => ({ ...r })));
    }
    console.log(`1,000 heavy pages: packed cache ${packedCache.size} pages, ${(packedCache.totalBytes / 1048576).toFixed(1)} MB; old count ${legacyCache.size} pages`);
    expect(packedCache.size).toBe(1000);
    expect(packedCache.totalBytes).toBeLessThanOrEqual(TEXT_CACHE_MAX_BYTES);
    expect(legacyCache.size).toBeLessThan(400);
  });

  it('the engine run cache counts the same packed bytes for a page', async () => {
    const { packed, chars } = await heavyPage();
    expect(runsBytes(packed)).toBe(64 + packed.length * (128 + 4) + chars * 6);
  });
});

/** A worker client that answers `text` requests from a prepared page and counts them. Other requests are not used here. */
function fakeClient(page: () => RunData[]): { client: WorkerClient; textCalls: number[]; push: (e: WorkerEvent) => void } {
  const textCalls: number[] = [];
  let handler: ((event: WorkerEvent) => void) | undefined;
  const client = {
    onEvent: (h: (event: WorkerEvent) => void) => {
      handler = h;
    },
    request: async (body: { op: string; from?: number; count?: number }) => {
      if (body.op !== 'text') throw new Error(`unexpected ${body.op}`);
      textCalls.push(body.from ?? -1);
      const pages: PageTextData[] = [];
      for (let i = 0; i < (body.count ?? 0); i++) pages.push({ page: (body.from ?? 0) + i, runs: page() });
      return pages;
    },
    shutdown: async () => undefined,
  } as unknown as WorkerClient;
  return { client, textCalls, push: (e) => handler?.(e) };
}

describe('a second word on a text-dense file re-reads no page', () => {
  it('searches 1,000 heavy pages for two words and sends no text request the second time', async () => {
    const [first] = readPairs('heavy', await heavyBytes(1), 1);
    const template = first!.newRuns;
    const PAGES = 1000;
    // Each reply gets its own copy of the array, as a transfer would give it.
    const { client, textCalls, push } = fakeClient(() => {
      const bounds = template[0]!.bounds.slice();
      return template.map((run) => ({ ...run, bounds }));
    });
    const doc = new MupdfDocument(client, { pages: PAGES, encrypted: false });
    push({ event: 'sizes', from: 0, sizes: Float32Array.from({ length: PAGES * 3 }, (_v, i) => (i % 3 === 0 ? 612 : i % 3 === 1 ? 792 : 0)) });
    const pages = createPageList('d'.repeat(64), PAGES);
    const cache = new TextCache();
    const scan = async (query: string) => {
      let hits = 0;
      let matchedPages = 0;
      await searchDocument({
        doc,
        pages,
        query,
        options: { matchCase: false, wholeWord: false },
        signal: new AbortController().signal,
        cache,
        onPage: ({ matches }) => {
          matchedPages++;
          hits += matches.length;
        },
        onProgress: () => undefined,
      });
      return { hits, matchedPages };
    };
    const one = await scan('dolor');
    const readsAfterFirst = textCalls.length;
    const two = await scan('veniam');
    const three = await scan('qqzzxxkk');
    // 1,000 pages in batches of 16, once.
    expect(readsAfterFirst).toBe(63);
    expect(textCalls.length).toBe(63);
    expect(cache.size).toBe(1000);
    expect(cache.totalBytes).toBeLessThanOrEqual(TEXT_CACHE_MAX_BYTES);
    expect(one.matchedPages).toBe(1000);
    expect(one.hits).toBe(1000 * (first!.newRuns.map((r) => r.text).join(' ').match(/dolor/gi)?.length ?? 0));
    expect(two.matchedPages).toBe(1000);
    expect(three.hits).toBe(0);
    // No run was ever turned into per-character boxes.
    for (const runs of cache.values()) expect(runs.every((r) => r.charBoxes === undefined)).toBe(true);
    await doc.destroy();
  }, 60000);
});
