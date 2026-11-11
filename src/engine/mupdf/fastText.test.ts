// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Mu from 'mupdf';
import { charBoxesOf, findStextModule, readPageRuns, readRunsFast, readRunsWalk } from './fastText';
import type { RunData } from './protocol';

type MuModule = typeof Mu;

let mu: MuModule;
let wasmModule: unknown;

/** Loads the real MuPDF WASM in Node, the same way the worker does in the browser (compiled, then hooked in). */
beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../node_modules/mupdf/dist/mupdf-wasm.wasm', import.meta.url));
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

/** The part of pdfkit this test uses. pdfkit ships without type declarations. */
interface PdfKitLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  font(name: string): PdfKitLike;
  fontSize(size: number): PdfKitLike;
  text(text: string, x: number, y: number, options?: object): PdfKitLike;
  end(): void;
}

/** A one-page PDF with a normal paragraph and a letter-spaced word, built with pdfkit. */
async function sampleBytes(): Promise<Uint8Array> {
  // The specifier is a variable so TypeScript does not look for pdfkit's (absent) type declarations.
  const specifier = 'pdfkit';
  const { default: PDFDocument } = (await import(specifier)) as { default: new (options: object) => PdfKitLike };
  const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk as Buffer));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  doc.font('Helvetica').fontSize(14).text('Hello world, one line of text.', 72, 72);
  doc.fontSize(11).text('Second line with more words here.', 72, 100);
  doc.fontSize(14).text('z e p h y r b l o o m', 72, 140);
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

/** Opens the bytes and returns the first page's structured text, read by the given reader. */
function withStext<T>(bytes: Uint8Array, read: (stext: Mu.StructuredText) => T): T {
  const doc = mu.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(0);
  const stext = page.toStructuredText('');
  try {
    return read(stext);
  } finally {
    stext.destroy();
    page.destroy();
    doc.destroy();
  }
}

/** Compares two run lists. Numbers agree within a thousandth of a point. */
function expectRunsEqual(actual: RunData[], expected: RunData[]): void {
  expect(actual.map((run) => run.text)).toEqual(expected.map((run) => run.text));
  const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-3);
  actual.forEach((run, i) => {
    const want = expected[i]!;
    close(run.origin.x, want.origin.x);
    close(run.origin.y, want.origin.y);
    close(run.along.x, want.along.x);
    close(run.along.y, want.along.y);
    close(run.up.x, want.up.x);
    close(run.up.y, want.up.y);
    const boxes = charBoxesOf(run);
    const wantBoxes = charBoxesOf(want);
    expect(boxes.length).toBe(wantBoxes.length);
    boxes.forEach((box, j) => {
      close(box.start, wantBoxes[j]!.start);
      close(box.end, wantBoxes[j]!.end);
    });
  });
}

describe('fastText accessors', () => {
  it('finds the accessors in the loaded module', () => {
    expect(findStextModule(wasmModule)).not.toBeNull();
    expect(findStextModule({})).toBeNull();
  });

  it('reads the same runs as the public walk() API', async () => {
    const bytes = await sampleBytes();
    const fast = withStext(bytes, (stext) => readRunsFast(stext.pointer, findStextModule(wasmModule)!));
    const walked = withStext(bytes, (stext) => readRunsWalk(stext));
    expect(fast.length).toBeGreaterThanOrEqual(3);
    expectRunsEqual(fast, walked);
  });

  it('gives one run per line, with charBoxes that are contiguous and cover the run', async () => {
    const runs = withStext(await sampleBytes(), (stext) => readPageRuns(stext, wasmModule));
    expect(runs.map((run) => run.text)).toEqual(['Hello world, one line of text.', 'Second line with more words here.', 'z e p h y r b l o o m']);
    for (const run of runs) {
      const boxes = charBoxesOf(run);
      expect(boxes).toHaveLength(run.text.length);
      expect(run.bounds.length).toBeGreaterThanOrEqual(run.boundsAt + run.text.length + 1);
      expect(boxes[0]!.start).toBeCloseTo(0, 3);
      boxes.forEach((box, i) => {
        expect(box.end).toBeGreaterThanOrEqual(box.start);
        if (i > 0) expect(box.start).toBeCloseTo(boxes[i - 1]!.end, 6);
      });
      const length = Math.hypot(run.along.x, run.along.y);
      expect(boxes.at(-1)!.end).toBeCloseTo(length, 3);
    }
  });

  it('puts the run origin at the first glyph and the height vector above it', async () => {
    const [first] = withStext(await sampleBytes(), (stext) => readPageRuns(stext, wasmModule));
    // The first line starts at x = 72 with its baseline below the top margin, so `up` points up the page.
    expect(first!.origin.x).toBeCloseTo(72, 1);
    expect(first!.up.y).toBeLessThan(0);
    expect(first!.up.x).toBeCloseTo(0, 3);
    expect(first!.along.x).toBeGreaterThan(0);
  });

  it('treats a module missing one accessor as having none, so the fast path is not used', () => {
    const partial = { ...(wasmModule as Record<string, unknown>), _wasm_stext_char_get_quad: undefined };
    expect(findStextModule(partial)).toBeNull();
  });

  it('falls back to walk() and gives the same runs when one accessor is missing', async () => {
    const bytes = await sampleBytes();
    const partial = { ...(wasmModule as Record<string, unknown>), _wasm_stext_char_get_size: undefined };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const viaFallback = withStext(bytes, (stext) => readPageRuns(stext, partial));
      const viaWalk = withStext(bytes, (stext) => readRunsWalk(stext));
      expectRunsEqual(viaFallback, viaWalk);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to walk() when the accessors are missing, and logs that once', async () => {
    const bytes = await sampleBytes();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const runs = withStext(bytes, (stext) => readPageRuns(stext, {}));
      const again = withStext(bytes, (stext) => readPageRuns(stext, {}));
      expect(runs.map((run) => run.text)).toEqual(again.map((run) => run.text));
      expect(runs.map((run) => run.text)[0]).toBe('Hello world, one line of text.');
      expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('letter-spaced text on a page', () => {
  it('reads each letter of a spaced word as its own character, so search can collapse the spaces', async () => {
    const runs = withStext(await sampleBytes(), (stext) => readPageRuns(stext, wasmModule));
    const spaced = runs.find((run) => run.text.startsWith('z'))!;
    expect(spaced.text.replace(/ /g, '')).toBe('zephyrbloom');
  });
});

/** One page of Helvetica text with the given character spacing, built with pdfkit. */
async function spacedBytes(text: string, characterSpacing: number): Promise<Uint8Array> {
  const specifier = 'pdfkit';
  const { default: PDFDocument } = (await import(specifier)) as { default: new (options: object) => PdfKitLike };
  const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk as Buffer));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  doc.font('Helvetica').fontSize(12).text(text, 72, 72, { characterSpacing, lineBreak: false });
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

describe('synthetic spaces from wide character spacing', () => {
  it('does not split a word that has no space in the document', async () => {
    const bytes = await spacedBytes('Letters spaced apart qwertarget done', 1.5);
    const [run] = withStext(bytes, (stext) => readPageRuns(stext, wasmModule));
    expect(run!.text).toContain('apart');
    expect(run!.text).toContain('qwertarget');
    expect(run!.text).not.toMatch(/apar t|qwer target/);
  });

  it('keeps the real word spaces of the same line', async () => {
    const bytes = await spacedBytes('Letters spaced apart qwertarget done', 1.5);
    const [run] = withStext(bytes, (stext) => readPageRuns(stext, wasmModule));
    expect(run!.text.replace(/\s+/g, ' ')).toBe('Letters spaced apart qwertarget done');
  });

  it('keeps charBoxes contiguous after a synthetic space is dropped', async () => {
    const bytes = await spacedBytes('Letters spaced apart qwertarget done', 1.5);
    const [run] = withStext(bytes, (stext) => readPageRuns(stext, wasmModule));
    const boxes = charBoxesOf(run!);
    expect(boxes).toHaveLength(run!.text.length);
    boxes.forEach((box, i) => {
      if (i > 0) expect(box.start).toBeCloseTo(boxes[i - 1]!.end, 6);
    });
  });
});

/**
 * A one-page PDF whose content stream is written by hand, so the text operators (Tz, Tw, Tc) are exact.
 * Helvetica is the only font. `content` is a PDF content stream, without parentheses inside its strings.
 */
function rawPdf(content: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

/** Lines of text at 12 pt, starting at 72 pt from the left and 72 pt from the top (y = 720 in PDF space). */
function linesPdf(lines: string[], operators: string): Uint8Array {
  const shows = lines.map((line, i) => `1 0 0 1 72 ${720 - i * 20} Tm (${line}) Tj`).join('\n');
  return rawPdf(`BT /F1 12 Tf ${operators}\n${shows}\nET`);
}

describe('synthetic spaces against real spaces', () => {
  const readLines = (bytes: Uint8Array) => withStext(bytes, (stext) => readPageRuns(stext, wasmModule).map((run) => run.text));

  it('keeps every word apart in a condensed font (horizontal scale 70)', () => {
    const lines = readLines(linesPdf(['Condensed text keeps every word apart here'], '70 Tz'));
    expect(lines).toEqual(['Condensed text keeps every word apart here']);
  });

  it('keeps every word apart in a strongly condensed font (horizontal scale 50)', () => {
    // A 50 % Helvetica space is 1.67 pt. MuPDF reports the size as 8.49 pt, so a 0.2 em width rule drops it.
    const lines = readLines(linesPdf(['Condensed text keeps every word apart here'], '50 Tz'));
    expect(lines).toEqual(['Condensed text keeps every word apart here']);
  });

  it('keeps the words of a justified line with negative word spacing', () => {
    // Tw -1.5 leaves a 1.8 pt space at 12 pt (0.15 em) with no letter spacing around it.
    const lines = readLines(linesPdf(['Justified words packed tight across the line'], '-1.5 Tw'));
    expect(lines).toEqual(['Justified words packed tight across the line']);
  });

  it('still drops the synthetic spaces of a letter-spaced line (character spacing 1.5)', () => {
    const lines = readLines(linesPdf(['Letters spaced apart qwertarget done'], '1.5 Tc'));
    expect(lines).toEqual(['Letters spaced apart qwertarget done']);
  });

  it('keeps the real spaces of a letter-spaced line that also has negative word spacing', () => {
    const lines = readLines(linesPdf(['Letters spaced apart qwertarget done'], '1.5 Tc -3 Tw'));
    expect(lines[0]!.replace(/\s+/g, ' ')).toBe('Letters spaced apart qwertarget done');
    expect(lines[0]).not.toMatch(/apar t|qwer target/);
  });

  it('copies the same text for a condensed line and a justified line as the source wrote it', () => {
    const condensed = readLines(linesPdf(['Condensed text keeps every word apart here'], '70 Tz'))[0]!;
    const justified = readLines(linesPdf(['Justified words packed tight across the line'], '-1.5 Tw'))[0]!;
    expect(condensed.split(' ')).toHaveLength(7);
    expect(justified.split(' ')).toHaveLength(7);
  });
});
