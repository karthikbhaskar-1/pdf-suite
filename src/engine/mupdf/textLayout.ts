/**
 * Text files as PDF pages (blueprint B3). Pure: no MuPDF, so it is tested on its own. The page builder is textPage.ts.
 *
 *  - Decoding: a byte order mark (UTF-8, UTF-16 LE or BE), else strict UTF-8, else Windows-1252. Limit 32 MB.
 *  - Layout: Courier 10 pt, 72 pt margins, line height 12 pt, so a line holds floor((page width - 144) / 6) columns. A line wraps
 *    at its last space, and a word longer than a line is broken. Tab stops every 8 columns. A form feed starts a new page.
 *    Line ends (CRLF, CR, LF) are made one.
 *  - Characters: PDF Suite prints Latin, Greek and Cyrillic (the three encodings of a MuPDF simple font). Any other character
 *    becomes "?" and is counted, so the dialog can warn before the run. Control characters and zero-width marks print nothing.
 */
import type { PageDims } from './jobProtocol';

export const MAX_TEXT_BYTES = 32 * 1024 * 1024;
export const TEXT_MARGIN = 72;
export const TEXT_FONT_SIZE = 10;
export const TEXT_LINE_HEIGHT = 12;
/** Courier is 600/1000 of the size wide: 6 pt at 10 pt. */
export const TEXT_CHAR_WIDTH = 6;
export const TAB_COLUMNS = 8;

export const LETTER: PageDims = { width: 612, height: 792 };
export const A4: PageDims = { width: 595.28, height: 841.89 };

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
/** The three simple-font encodings of MuPDF's addSimpleFont. */
export type FontEncoding = 'Latin' | 'Greek' | 'Cyrillic';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
}

/** Decodes a text file by byte order mark, else as strict UTF-8, else as Windows-1252. */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

// ---- The characters the three fonts can print ------------------------------------------------------------------------------------

const LABEL: Record<FontEncoding, string> = { Latin: 'windows-1252', Greek: 'iso-8859-7', Cyrillic: 'koi8-u' };

/** For each encoding, the byte a character is written as (pinned by combineProbes.test.ts, D3). */
let tables: Record<FontEncoding, Map<string, number>> | null = null;

function byteTables(): Record<FontEncoding, Map<string, number>> {
  if (tables) return tables;
  const make = (encoding: FontEncoding): Map<string, number> => {
    const decoder = new TextDecoder(LABEL[encoding]);
    const map = new Map<string, number>();
    for (let b = 32; b < 256; b++) {
      if (b === 127) continue;
      const ch = decoder.decode(Uint8Array.of(b));
      if (ch !== '�' && !map.has(ch)) map.set(ch, b);
    }
    return map;
  };
  tables = { Latin: make('Latin'), Greek: make('Greek'), Cyrillic: make('Cyrillic') };
  return tables;
}

/** The font encoding and byte that print `ch`, or null when no font can. Latin is tried first, then Greek, then Cyrillic. */
export function encodeChar(ch: string): { encoding: FontEncoding; byte: number } | null {
  const t = byteTables();
  for (const encoding of ['Latin', 'Greek', 'Cyrillic'] as const) {
    const byte = t[encoding].get(ch);
    if (byte !== undefined) return { encoding, byte };
  }
  return null;
}

/** Characters that print nothing and are not counted: C0 and C1 controls (tab, line ends and form feed are handled before), zero-width marks, the byte order mark. */
// eslint-disable-next-line no-control-regex
const SILENT = new RegExp(String.raw`^[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u2060\ufeff]$`);

// ---- Layout ------------------------------------------------------------------------------------------------------------------------

export interface TextGrid {
  columns: number;
  linesPerPage: number;
}

export function gridOf(dims: PageDims): TextGrid {
  return {
    columns: Math.max(1, Math.floor((dims.width - 2 * TEXT_MARGIN) / TEXT_CHAR_WIDTH)),
    linesPerPage: Math.max(1, Math.floor((dims.height - 2 * TEXT_MARGIN) / TEXT_LINE_HEIGHT)),
  };
}

export interface LaidOutText {
  /** Pages, each a list of lines (already wrapped, tabs expanded, unprintable characters replaced by "?"). Always at least one page. */
  pages: string[][];
  /** How many characters were replaced by "?". */
  unprintable: number;
}

/** Wraps one logical line to `columns` characters (code points). Works with offsets, so a huge single line stays linear. */
function wrapLine(chars: string[], columns: number): string[] {
  if (chars.length <= columns) return [chars.join('')];
  const out: string[] = [];
  let start = 0;
  while (chars.length - start > columns) {
    let at = -1;
    for (let i = start + columns; i > start; i--) {
      if (chars[i] === ' ') {
        at = i;
        break;
      }
    }
    if (at < 0) {
      out.push(chars.slice(start, start + columns).join(''));
      start += columns;
    } else {
      out.push(chars.slice(start, at).join('').replace(/ +$/, ''));
      start = at + 1;
      while (chars[start] === ' ') start += 1;
    }
  }
  out.push(chars.slice(start).join(''));
  return out;
}

/** Lays decoded text out on pages of `dims`. */
export function layoutText(text: string, dims: PageDims): LaidOutText {
  const { columns, linesPerPage } = gridOf(dims);
  const pages: string[][] = [[]];
  let unprintable = 0;
  const push = (line: string) => {
    let page = pages[pages.length - 1]!;
    if (page.length >= linesPerPage) {
      page = [];
      pages.push(page);
    }
    page.push(line);
  };
  // Decomposed accents (e and a combining mark) are made one character, or each would print as "?".
  const normalised = text.normalize('NFC').replace(/\r\n?/g, '\n');
  const sheets = normalised.split('\f');
  sheets.forEach((sheet, sheetNumber) => {
    if (sheetNumber > 0) pages.push([]);
    const lines = sheet === '' ? [] : sheet.split('\n');
    // A final line break does not make an empty last line.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (const source of lines) {
      const chars: string[] = [];
      for (const ch of source) {
        if (ch === '\t') {
          const to = Math.ceil((chars.length + 1) / TAB_COLUMNS) * TAB_COLUMNS;
          while (chars.length < to) chars.push(' ');
        } else if (SILENT.test(ch)) {
          continue;
        } else if (encodeChar(ch) === null) {
          chars.push('?');
          unprintable += 1;
        } else {
          chars.push(ch);
        }
      }
      for (const line of wrapLine(chars, columns)) push(line);
    }
  });
  // A form feed at the very end leaves an empty last page: drop it, but keep a single empty page for an empty file.
  while (pages.length > 1 && pages[pages.length - 1]!.length === 0) pages.pop();
  return { pages, unprintable };
}

/** A line as runs of one encoding each: [{ encoding, bytes, column }], for the page builder. */
export function runsOf(line: string): Array<{ encoding: FontEncoding; bytes: number[]; column: number }> {
  const runs: Array<{ encoding: FontEncoding; bytes: number[]; column: number }> = [];
  let column = 0;
  for (const ch of line) {
    const hit = encodeChar(ch) ?? encodeChar('?')!;
    const last = runs[runs.length - 1];
    // A space prints in whichever font the run already uses, so a space does not split a run.
    if (ch === ' ' && last) {
      last.bytes.push(0x20);
    } else if (last && last.encoding === hit.encoding) {
      last.bytes.push(hit.byte);
    } else {
      runs.push({ encoding: hit.encoding, bytes: [hit.byte], column });
    }
    column += 1;
  }
  // Trailing spaces print nothing.
  const tail = runs[runs.length - 1];
  if (tail) {
    while (tail.bytes.length > 0 && tail.bytes[tail.bytes.length - 1] === 0x20) tail.bytes.pop();
    if (tail.bytes.length === 0) runs.pop();
  }
  return runs;
}
