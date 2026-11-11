import { describe, expect, it } from 'vitest';
import type { TextRun } from '../../engine/types';
import { findMatches, indexRuns, rectsForRange, searchRuns } from './textSearch';

/** A horizontal run starting at (x, y), 10 pt per character, 12 pt tall. */
function run(text: string, x: number, y: number): TextRun {
  return {
    text,
    origin: { x, y },
    along: { x: text.length * 10, y: 0 },
    up: { x: 0, y: -12 },
  };
}

const opts = (matchCase = false, wholeWord = false) => ({ matchCase, wholeWord });

describe('findMatches', () => {
  it('ignores case unless match case is on', () => {
    expect(findMatches('Alpha alpha ALPHA', 'alpha', opts())).toHaveLength(3);
    expect(findMatches('Alpha alpha ALPHA', 'alpha', opts(true))).toEqual([{ start: 6, end: 11 }]);
  });

  it('matches whole words only when asked', () => {
    const text = 'cat concatenate cats cat.';
    expect(findMatches(text, 'cat', opts())).toHaveLength(4);
    expect(findMatches(text, 'cat', opts(false, true))).toEqual([
      { start: 0, end: 3 },
      { start: 21, end: 24 },
    ]);
  });

  it('treats letters outside ASCII as word characters', () => {
    expect(findMatches('café', 'caf', opts(false, true))).toHaveLength(0);
    expect(findMatches('café', 'café', opts(false, true))).toHaveLength(1);
  });

  it('escapes the query so symbols match literally', () => {
    expect(findMatches('a+b (c) a.b', 'a+b', opts())).toEqual([{ start: 0, end: 3 }]);
    expect(findMatches('a+b (c) a.b', '(c)', opts())).toEqual([{ start: 4, end: 7 }]);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches('anything', '', opts())).toEqual([]);
  });
});

describe('searchRuns', () => {
  it('finds a match inside one run and places its box on that run', () => {
    const runs = [run('hello world', 100, 200)];
    const [match] = searchRuns(runs, 'world', opts());
    expect(match).toBeDefined();
    const rect = match!.rects[0]!;
    // "world" starts at character 6, so x = 100 + 60 and it is 50 wide.
    expect(rect.x).toBeCloseTo(160);
    expect(rect.width).toBeCloseTo(50);
    expect(rect.y).toBeCloseTo(188);
    expect(rect.height).toBeCloseTo(12);
  });

  it('matches a phrase that spans two runs, with one box per run', () => {
    const runs = [run('quick brown', 0, 0), run('fox jumps', 0, 20)];
    const [match] = searchRuns(runs, 'brown fox', opts());
    expect(match).toBeDefined();
    expect(match!.rects).toHaveLength(2);
    // The first box covers "brown" at the end of the first run.
    expect(match!.rects[0]!.x).toBeCloseTo(60);
    expect(match!.rects[0]!.width).toBeCloseTo(50);
    // The second box covers "fox" at the start of the second run.
    expect(match!.rects[1]!.x).toBeCloseTo(0);
    expect(match!.rects[1]!.width).toBeCloseTo(30);
  });

  it('does not match across a run boundary when the words are not adjacent', () => {
    const runs = [run('ab', 0, 0), run('cd', 0, 20)];
    expect(searchRuns(runs, 'abcd', opts())).toHaveLength(0);
  });

  it('places boxes in the page orientation of a rotated run', () => {
    // Text that runs straight down the page: along = +y, up = -x.
    const rotated: TextRun = { text: 'abc', origin: { x: 50, y: 0 }, along: { x: 0, y: 30 }, up: { x: -12, y: 0 } };
    const index = indexRuns([rotated]);
    const [rect] = rectsForRange(index, 0, 3);
    expect(rect).toBeDefined();
    expect(rect!.x).toBeCloseTo(38);
    expect(rect!.width).toBeCloseTo(12);
    expect(rect!.y).toBeCloseTo(0);
    expect(rect!.height).toBeCloseTo(30);
  });
});

describe('rectsForRange with per-character boxes', () => {
  // "iii" is narrow and "WWW" is wide. Each character box is given, and the run is 60 pt long.
  const shaped: TextRun = {
    text: 'iiiWWW',
    origin: { x: 100, y: 200 },
    along: { x: 60, y: 0 },
    up: { x: 0, y: -12 },
    charBoxes: [
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 },
      { start: 9, end: 30 },
      { start: 30, end: 51 },
      { start: 51, end: 60 },
    ],
  };

  it('places a match on the characters it covers, not on an equal share of the run', () => {
    const index = indexRuns([shaped]);
    // The "WWW" part starts at 9 pt and ends at 60 pt.
    const [rect] = rectsForRange(index, 3, 6);
    expect(rect?.x).toBeCloseTo(100 + 9, 6);
    expect(rect?.width).toBeCloseTo(51, 6);
  });

  it('uses the same boxes when a range crosses from one run to the next', () => {
    // Text is "iiiWWW ab": range [5, 9) covers the last "W" of the first run and the "ab" run.
    const index = indexRuns([shaped, run('ab', 300, 200)]);
    const rects = rectsForRange(index, 5, 9);
    expect(rects).toHaveLength(2);
    expect(rects[0]?.x).toBeCloseTo(100 + 51, 6);
    expect(rects[0]?.width).toBeCloseTo(9, 6);
  });

  it('falls back to equal shares when the boxes do not match the text', () => {
    const wrong: TextRun = { ...shaped, charBoxes: [{ start: 0, end: 60 }] };
    const [rect] = rectsForRange(indexRuns([wrong]), 3, 6);
    expect(rect?.x).toBeCloseTo(100 + 30, 6);
    expect(rect?.width).toBeCloseTo(30, 6);
  });
});

describe('lazy glyph boxes', () => {
  it('measures a run only when a match touches it, and only once', () => {
    let calls = 0;
    const measured: TextRun = {
      ...run('alpha', 0, 0),
      measureCharBoxes: () => {
        calls++;
        return [0, 1, 2, 3, 4].map((i) => ({ start: i * 10, end: i * 10 + 10 }));
      },
    };
    const other: TextRun = { ...run('omega', 200, 0), measureCharBoxes: () => { calls += 100; return undefined; } };
    const index = indexRuns([measured, other]);
    rectsForRange(index, 0, 5);
    expect(calls).toBe(1);
    rectsForRange(index, 1, 3);
    expect(calls).toBe(1);
  });
});

describe('letter-spaced text', () => {
  it('finds a word whose letters are each followed by a space', () => {
    expect(findMatches('z e p h y r b l o o m', 'zephyrbloom', opts())).toEqual([{ start: 0, end: 21 }]);
  });

  it('finds the word inside a line of normal text, with positions in the original text', () => {
    expect(findMatches('the z e p h y r word', 'zephyr', opts())).toEqual([{ start: 4, end: 15 }]);
  });

  it('does not join two letters, which are an ordinary pair of words', () => {
    expect(findMatches('a b', 'ab', opts())).toEqual([]);
  });

  it('still respects whole-word matching on the collapsed text', () => {
    expect(findMatches('z e p h y r s', 'zephyr', opts(false, true))).toEqual([]);
  });

  it('keeps normal text matching exactly as before', () => {
    expect(findMatches('Hello world', 'hello', opts())).toEqual([{ start: 0, end: 5 }]);
  });

  it('gives the rectangles of a letter-spaced match over its letters', () => {
    const runs = [run('z e p h y r', 100, 200)];
    const [match] = searchRuns(runs, 'zephyr', opts());
    expect(match).toBeDefined();
    const rect = match!.rects[0]!;
    // Eleven characters at 10 pt each: the match covers all of them, so it is 110 pt wide.
    expect(rect.x).toBeCloseTo(100);
    expect(rect.width).toBeCloseTo(110);
  });
});

describe('spaced query', () => {
  it('finds letter-spaced text when the query is spaced the same way', () => {
    expect(findMatches('qwerty spaced', 'q w e r t', opts())).toEqual([{ start: 0, end: 5 }]);
  });

  it('finds spaced text when the query is not spaced', () => {
    expect(findMatches('q w e r t y literal', 'qwert', opts())).toEqual([{ start: 0, end: 9 }]);
  });
});


describe('search correctness (1.5.2): the page text and the letter-joined text, merged', () => {
  const span = (text: string, q: string, o = opts()) => findMatches(text, q, o).map((m) => text.slice(m.start, m.end));
  const at = (text: string, q: string, o = opts()) => findMatches(text, q, o);

  it('finds "B C" in "A B C D"', () => expect(at('A B C D', 'B C')).toEqual([{ start: 2, end: 5 }]));
  it('finds "A B" in "A B C D"', () => expect(at('A B C D', 'A B')).toEqual([{ start: 0, end: 3 }]));
  it('finds "y z" in "w x y z"', () => expect(at('w x y z', 'y z')).toEqual([{ start: 4, end: 7 }]));
  it('finds "a b" in "a b c d"', () => expect(at('a b c d', 'a b')).toEqual([{ start: 0, end: 3 }]));
  it('finds whole-word "B" in "A B C D"', () => expect(at('A B C D', 'B', opts(false, true))).toEqual([{ start: 2, end: 3 }]));
  it('finds "BC" in "A B C" without whole-word, on purpose: the same rule that finds "ph" in "z e p h y r"', () => {
    expect(at('A B C', 'BC')).toEqual([{ start: 2, end: 5 }]);
  });
  it('does not find "BC" in "A B C" with whole-word on (the text cannot tell it from two separate letters)', () => {
    expect(at('A B C', 'BC', opts(false, true))).toEqual([]);
  });
  it('still finds a word inside letter-spaced text', () => {
    expect(span('z e p h y r', 'ph')).toEqual(['p h']);
    expect(span('z e p h y r', 'zephyr', opts(false, true))).toEqual(['z e p h y r']);
    expect(span('z e p h y r', 'z e p h y r')).toEqual(['z e p h y r']);
  });
  it('still finds a letter-spaced query in joined text', () => expect(at('qwert', 'q w e r t')).toEqual([{ start: 0, end: 5 }]));
  it('does not return the same spot twice when both texts match it', () => {
    expect(at('A B C D', 'B C')).toHaveLength(1);
    expect(at('qwert qwert', 'qwert')).toHaveLength(2);
    expect(at('a b c d x a b c d', 'a b c d')).toHaveLength(2);
  });
  it('merges hits from both texts, in page order', () => {
    // "B C" is literal on the first line; "ph" exists only once the second line is joined.
    const text = 'A B C D ; z e p h y r';
    expect(at(text, 'B C').map((m) => m.start)).toEqual([2]);
    expect(span(text, 'ph')).toEqual(['p h']);
    const both = at('x BC y ; B C d e f', 'BC');
    expect(both.map((m) => m.start)).toEqual([2, 9]);
  });
  it('honours case on and off', () => {
    expect(at('A B C D', 'b c')).toHaveLength(1);
    expect(at('A B C D', 'b c', opts(true))).toEqual([]);
    expect(at('z e p h y r', 'PH')).toHaveLength(1);
    expect(at('z e p h y r', 'PH', opts(true))).toEqual([]);
  });
  it('honours whole-word on and off for plain words', () => {
    expect(at('cat concat', 'cat')).toHaveLength(2);
    expect(at('cat concat', 'cat', opts(false, true))).toEqual([{ start: 0, end: 3 }]);
  });
  it('highlights land on the right characters for merged hits', () => {
    // Run 1 "A B C D" at x=0, run 2 "z e p h y r" at x=300; 10 pt a character.
    const runs = [run('A B C D', 0, 0), run('z e p h y r', 300, 0)];
    const hits = searchRuns(runs, 'B C', opts());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rects[0]!.x).toBeCloseTo(20);
    expect(hits[0]!.rects[0]!.width).toBeCloseTo(30);
    const joined = searchRuns(runs, 'ph', opts());
    expect(joined).toHaveLength(1);
    // "p h" is characters 4..7 of run 2.
    expect(joined[0]!.rects[0]!.x).toBeCloseTo(340);
    expect(joined[0]!.rects[0]!.width).toBeCloseTo(30);
  });
  it('single letters, initials and variables are found as typed', () => {
    expect(at('J. R. R. Tolkien', 'R. R.')).toHaveLength(1);
    expect(at('x y z = 1', 'y z')).toHaveLength(1);
    expect(at('α β γ δ', 'β γ')).toHaveLength(1);
  });
});

describe('findMatches merge: speed and equivalence', () => {
  it('merges in linear time on a 20k-character letter-spaced page with many hits', () => {
    const text = ('a b c d e f g h ' + 'o '.repeat(4) + 'word ').repeat(250).slice(0, 20000);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      findMatches(text, 'o', opts());
      findMatches(text, ' ', opts());
    }
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('on random text: hits never overlap, stay in order, and every old-style hit is still found', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 200; n++) {
      const text = Array.from({ length: 40 }, () => 'ab c '[Math.floor(rnd() * 5)]).join('');
      const q = ['a', 'b c', 'ab', 'a b', 'c'][Math.floor(rnd() * 5)]!;
      const hits = findMatches(text, q, opts());
      for (let i = 1; i < hits.length; i++) expect(hits[i]!.start).toBeGreaterThanOrEqual(hits[i - 1]!.end);
      const literal = [...text.matchAll(new RegExp(q.replace(/ /g, ' '), 'giu'))];
      for (const m of literal) expect(hits.some((h) => h.start < m.index! + m[0].length && m.index! < h.end)).toBe(true);
    }
  });
});
