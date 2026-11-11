// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { A4, LETTER, decodeText, encodeChar, gridOf, layoutText, runsOf } from './textLayout';

const enc = (text: string) => new TextEncoder().encode(text);
const utf16 = (text: string, little: boolean): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2);
  out.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = little ? c & 255 : c >> 8;
    out[3 + i * 2] = little ? c >> 8 : c & 255;
  }
  return out;
};

describe('decodeText', () => {
  it('UTF-8 with and without a byte order mark', () => {
    expect(decodeText(enc('Café')).text).toBe('Café');
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('Café')]))).toEqual({ text: 'Café', encoding: 'utf-8' });
  });
  it('UTF-16 LE and BE by byte order mark', () => {
    expect(decodeText(utf16('Αθήνα', true))).toEqual({ text: 'Αθήνα', encoding: 'utf-16le' });
    expect(decodeText(utf16('Москва', false))).toEqual({ text: 'Москва', encoding: 'utf-16be' });
  });
  it('bytes that are not UTF-8 are Windows-1252', () => {
    expect(decodeText(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toEqual({ text: 'Café €', encoding: 'windows-1252' });
  });
});

describe('the grid', () => {
  it('Letter has 78 columns and 54 lines, A4 has 75 and 58', () => {
    expect(gridOf(LETTER)).toEqual({ columns: 78, linesPerPage: 54 });
    expect(gridOf(A4)).toEqual({ columns: 75, linesPerPage: 58 });
  });
});

describe('layoutText', () => {
  it('normalises line ends and does not make an empty last line', () => {
    expect(layoutText('a\r\nb\rc\n', LETTER).pages).toEqual([['a', 'b', 'c']]);
  });
  it('keeps blank lines in the middle', () => {
    expect(layoutText('a\n\nb', LETTER).pages).toEqual([['a', '', 'b']]);
  });
  it('wraps at the last space and drops that space', () => {
    const words = Array.from({ length: 30 }, (_v, i) => `word${i}`).join(' ');
    const { pages } = layoutText(words, LETTER);
    const lines = pages[0]!;
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(78);
      expect(line).not.toMatch(/ $/);
    }
    expect(lines.join(' ')).toBe(words);
  });
  it('breaks a word longer than a line', () => {
    const { pages } = layoutText('x'.repeat(200), LETTER);
    expect(pages[0]!.map((l) => l.length)).toEqual([78, 78, 44]);
  });
  it('tab stops every 8 columns', () => {
    expect(layoutText('a\tb', LETTER).pages[0]![0]).toBe('a       b');
    expect(layoutText('12345678\tb', LETTER).pages[0]![0]).toBe('12345678        b');
  });
  it('a form feed starts a new page, and a trailing one does not leave an empty page', () => {
    expect(layoutText('one\ftwo', LETTER).pages).toEqual([['one'], ['two']]);
    expect(layoutText('one\f', LETTER).pages).toEqual([['one']]);
  });
  it('a long file flows onto more pages: 54 lines to a Letter page', () => {
    const text = Array.from({ length: 120 }, (_v, i) => `line ${i + 1}`).join('\n');
    const { pages } = layoutText(text, LETTER);
    expect(pages.map((p) => p.length)).toEqual([54, 54, 12]);
    expect(layoutText(text, A4).pages.map((p) => p.length)).toEqual([58, 58, 4]);
  });
  it('an empty file is one empty page', () => {
    expect(layoutText('', LETTER).pages).toEqual([[]]);
  });
  it('counts characters no font can print and shows them as "?"', () => {
    const { pages, unprintable } = layoutText('ok 日本語 ok', LETTER);
    expect(pages[0]![0]).toBe('ok ??? ok');
    expect(unprintable).toBe(3);
  });
  it('Latin, Greek and Cyrillic letters, accents and the euro sign are all printable', () => {
    expect(layoutText('Café € Αθήνα Москва', LETTER).unprintable).toBe(0);
  });
  it('control characters and zero-width marks print nothing and are not counted', () => {
    const { pages, unprintable } = layoutText('a\u0001b​c﻿d', LETTER);
    expect(pages[0]![0]).toBe('abcd');
    expect(unprintable).toBe(0);
  });
});

describe('runsOf', () => {
  it('puts each script in its own run, at its column, and keeps spaces inside the run before them', () => {
    const runs = runsOf('ab Αθ cd');
    expect(runs.map((r) => [r.encoding, r.column])).toEqual([
      ['Latin', 0],
      ['Greek', 3],
      ['Latin', 6],
    ]);
    expect(encodeChar('€')?.encoding).toBe('Latin');
  });
  it('trailing spaces print nothing', () => {
    expect(runsOf('ab   ')).toHaveLength(1);
    expect(runsOf('ab   ')[0]!.bytes).toEqual([0x61, 0x62]);
    expect(runsOf('   ')).toEqual([]);
  });
});

describe('decomposed accents', () => {
  it('e followed by a combining acute is one printable character, not "e?"', () => {
    const { pages, unprintable } = layoutText('café Noël', LETTER);
    expect(unprintable).toBe(0);
    expect(pages[0]![0]).toBe('café Noël');
  });
});
