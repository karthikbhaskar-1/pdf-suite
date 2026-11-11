import { describe, expect, it } from 'vitest';
import { createPageList } from '../../core/model/pageList';
import type { EngineDocument, TextRun } from '../../engine/types';
import { pruneTextCache, searchDocument, TEXT_CACHE_MAX_BYTES, TextCache, textBytes, textCacheKey } from './searchRunner';

const DOC = 'd'.repeat(64);
const PAGES = 30;

/** Busy-waits, the way a dense page's text extraction keeps the main thread busy. */
function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

/** A document whose every page takes `ms` of synchronous work to read, and has one match. */
function slowDoc(ms: number): EngineDocument {
  const runs: TextRun[] = [
    { text: 'needle', origin: { x: 0, y: 0 }, along: { x: 40, y: 0 }, up: { x: 0, y: 10 } },
  ];
  return {
    pageCount: PAGES,
    pageSize: async () => ({ width: 612, height: 792 }),
    renderBitmap: async () => {
      throw new Error('not used');
    },
    renderTextLayer: async () => () => undefined,
    pageText: async () => {
      busy(ms);
      return runs;
    },
    outline: async () => [],
    metadata: async () => ({}),
    isEncrypted: false,
    capabilities: { canEdit: false, htmlLayer: false },
    destroy: async () => undefined,
  };
}

describe('search runner', () => {
  it('lets a timer that was due during the scan run before the scan ends', async () => {
    const pages = createPageList(DOC, PAGES);
    let scannedWhenTimerRan = -1;
    let scanned = 0;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        scannedWhenTimerRan = scanned;
        resolve();
      }, 0),
    );

    await searchDocument({
      doc: slowDoc(3),
      pages,
      query: 'needle',
      options: { matchCase: false, wholeWord: false },
      signal: new AbortController().signal,
      cache: new Map(),
      onPage: () => undefined,
      onProgress: (n) => {
        scanned = n;
      },
    });
    await timer;

    // 30 pages at about 3 ms each is about 90 ms of work. The timer must not wait for all of it.
    expect(scannedWhenTimerRan).toBeGreaterThan(0);
    expect(scannedWhenTimerRan).toBeLessThan(PAGES);
  });

  it('stops at once when the signal aborts', async () => {
    const controller = new AbortController();
    let scanned = 0;
    await searchDocument({
      doc: slowDoc(2),
      pages: createPageList(DOC, PAGES),
      query: 'needle',
      options: { matchCase: false, wholeWord: false },
      signal: controller.signal,
      cache: new Map(),
      onPage: () => undefined,
      onProgress: (n) => {
        scanned = n;
        if (n === 3) controller.abort();
      },
    });
    expect(scanned).toBe(3);
  });
});

describe('the text cache names a page by its content, not its position', () => {
  it('after an edit puts another page at the same position, the text of the old page is not reused', async () => {
    // Two versions of a three-page document: page "b" is cut in half, so position 1 holds "b-left" and position 2 "b-right".
    const text: Record<string, string> = { a: 'alpha', b: 'both halves', 'b-left': 'both', 'b-right': 'halves', c: 'gamma' };
    const read: string[] = [];
    const doc = {
      ...slowDoc(0),
      pageCount: 4,
      pageText: async (index: number) => {
        const name = current[index]!;
        read.push(name);
        return [{ text: text[name]!, origin: { x: 0, y: 0 }, along: { x: 40, y: 0 }, up: { x: 0, y: 10 } }] as TextRun[];
      },
    } as EngineDocument;
    const refs = (names: string[]) => names.map((name, i) => ({ id: `d:${name}`, docId: 'd', srcIndex: i, rotation: 0 as const, crop: null, content: `${name}@0` }));
    let current = ['a', 'b', 'c'];
    const cache = new Map<string, TextRun[]>();
    const hits: string[] = [];
    const scan = async (names: string[], query: string) => {
      current = names;
      hits.length = 0;
      await searchDocument({
        doc, pages: refs(names), query, options: { matchCase: false, wholeWord: false }, signal: new AbortController().signal, cache,
        onPage: (page) => void hits.push(page.pageId), onProgress: () => undefined,
      });
      return [...hits];
    };
    expect(await scan(['a', 'b', 'c'], 'halves')).toEqual(['d:b']);
    // After the cut, only the right half holds "halves": one hit, on the right half, and the old "b" is not read again.
    expect(await scan(['a', 'b-left', 'b-right', 'c'], 'halves')).toEqual(['d:b-right']);
    expect(read.filter((name) => name === 'b')).toHaveLength(1);
    expect(read).toContain('b-left');
    // Pages that did not change keep their cached text.
    expect(read.filter((name) => name === 'a')).toHaveLength(1);
  });
});

describe('a cancelled read is never cached', () => {
  const refs = createPageList(DOC, 2);
  const run = (doc: EngineDocument, cache: Map<string, TextRun[]>, hits: string[], signal = new AbortController().signal) =>
    searchDocument({
      doc, pages: refs, query: 'needle', options: { matchCase: false, wholeWord: false }, signal, cache,
      onPage: (page) => void hits.push(page.pageId), onProgress: () => undefined,
    });
  const failing = (name: string) => {
    let fail = true;
    const doc = {
      ...slowDoc(0),
      pageCount: 2,
      pageText: async () => {
        if (fail) {
          fail = false;
          const error = new Error('cancelled');
          error.name = name;
          throw error;
        }
        return [{ text: 'needle', origin: { x: 0, y: 0 }, along: { x: 40, y: 0 }, up: { x: 0, y: 10 } }] as TextRun[];
      },
    } as EngineDocument;
    return doc;
  };

  for (const name of ['AbortError', 'Cancelled']) {
    it(`a ${name} on page 1 leaves nothing in the cache, so the next scan finds the hit on that page`, async () => {
      const cache = new Map<string, TextRun[]>();
      const doc = failing(name);
      const first: string[] = [];
      await run(doc, cache, first);
      expect(first).toEqual([refs[1]!.id]);
      expect(cache.size).toBe(1);
      expect(cache.has(`${refs[1]!.content ?? 1}|${refs[1]!.rotation}`)).toBe(true);
      const second: string[] = [];
      await run(doc, cache, second);
      expect(second).toContain(refs[0]!.id);
    });
  }

  it('a read that fails for another reason is still cached as "no text" (the page has no hits, and is not read again)', async () => {
    const cache = new Map<string, TextRun[]>();
    const doc = failing('Corrupt');
    await run(doc, cache, []);
    expect(cache.size).toBe(2);
    expect([...cache.values()][0]).toEqual([]);
  });
});

describe('a RangeError read is never cached as "no text"', () => {
  it('fails once with a RangeError, then the next search reads the page again and finds the hit', async () => {
    const refs = createPageList(DOC, 1);
    let calls = 0;
    const doc = {
      ...slowDoc(0),
      pageCount: 1,
      pageText: async () => {
        if (calls++ === 0) throw new RangeError('Array buffer allocation failed');
        return [{ text: 'needle', origin: { x: 0, y: 0 }, along: { x: 40, y: 0 }, up: { x: 0, y: 10 } }] as TextRun[];
      },
    } as EngineDocument;
    const cache = new Map<string, TextRun[]>();
    const scan = async () => {
      const hits: string[] = [];
      await searchDocument({
        doc, pages: refs, query: 'needle', options: { matchCase: false, wholeWord: false }, signal: new AbortController().signal, cache,
        onPage: (page) => void hits.push(page.pageId), onProgress: () => undefined,
      });
      return hits;
    };
    expect(await scan()).toEqual([]);
    expect(cache.size).toBe(0);
    expect(await scan()).toEqual([refs[0]!.id]);
    expect(calls).toBe(2);
  });

  it('a page that is cancelled mid-read and then read again is counted once', async () => {
    const refs = createPageList(DOC, 1);
    let calls = 0;
    const doc = {
      ...slowDoc(0),
      pageCount: 1,
      pageText: async () => {
        if (calls++ === 0) throw Object.assign(new Error('x'), { name: 'AbortError' });
        return [{ text: 'A B C D', origin: { x: 0, y: 0 }, along: { x: 70, y: 0 }, up: { x: 0, y: 10 } }] as TextRun[];
      },
    } as EngineDocument;
    const cache = new Map<string, TextRun[]>();
    let total = 0;
    for (let i = 0; i < 2; i++) {
      await searchDocument({
        doc, pages: refs, query: 'B C', options: { matchCase: false, wholeWord: false }, signal: new AbortController().signal, cache,
        onPage: (page) => void (total += page.matches.length), onProgress: () => undefined,
      });
    }
    expect(total).toBe(1);
  });
});

describe('an edited page is not counted twice', () => {
  it('after an edit renames the page, one scan reports the new text once and the old text not at all', async () => {
    const text: Record<string, string> = { 'p@0': 'A B C D', 'p@1': 'A B C D B C' };
    const cache = new Map<string, TextRun[]>();
    const count = async (content: string) => {
      const doc = {
        ...slowDoc(0),
        pageCount: 1,
        pageText: async () => [{ text: text[content]!, origin: { x: 0, y: 0 }, along: { x: 110, y: 0 }, up: { x: 0, y: 10 } }] as TextRun[],
      } as EngineDocument;
      let total = 0;
      await searchDocument({
        doc, pages: [{ id: 'd:p', docId: 'd', srcIndex: 0, rotation: 0 as const, crop: null, content }], query: 'B C',
        options: { matchCase: false, wholeWord: false }, signal: new AbortController().signal, cache,
        onPage: (page) => void (total += page.matches.length), onProgress: () => undefined,
      });
      return total;
    };
    expect(await count('p@0')).toBe(1);
    expect(await count('p@1')).toBe(2);
    expect(await count('p@1')).toBe(2);
  });
});

describe('the text cache is pruned to the current page list', () => {
  const ref = (content: string, rotation: 0 | 90 = 0) => ({ id: `d:${content}`, docId: 'd', srcIndex: 0, rotation, crop: null, content });
  const runs = [] as TextRun[];

  it('keeps the entries of the pages that are still in the list and drops every other key', () => {
    const cache = new Map<string, TextRun[]>();
    const before = [ref('a@0@0'), ref('b@0@0'), ref('c@0@0')];
    for (const page of before) cache.set(textCacheKey(page), runs);
    // An edit: "b" is now "b@1@0", "c" is gone, "d" is new. A save: all the names get another generation.
    const after = [ref('a@0@0'), ref('b@1@0'), ref('d@0@0')];
    pruneTextCache(cache, after);
    expect([...cache.keys()].sort()).toEqual([textCacheKey(after[0]!)]);
    for (const page of after) cache.set(textCacheKey(page), runs);
    pruneTextCache(cache, [ref('a@0@1'), ref('b@1@1')]);
    expect(cache.size).toBe(0);
  });

  it('a rotated page has its own key, so a rotation drops the old text', () => {
    const cache = new Map<string, TextRun[]>();
    cache.set(textCacheKey(ref('a@0@0', 0)), runs);
    pruneTextCache(cache, [ref('a@0@0', 90)]);
    expect(cache.size).toBe(0);
  });

  it('does not grow over many edits and saves: one entry per current page', () => {
    const cache = new Map<string, TextRun[]>();
    for (let revision = 0; revision < 50; revision++) {
      const pages = [ref(`a@${revision}@0`), ref(`b@0@${revision}`)];
      pruneTextCache(cache, pages);
      for (const page of pages) cache.set(textCacheKey(page), runs);
    }
    expect(cache.size).toBe(2);
  });
});

describe('the text cache is capped by bytes (S4)', () => {
  const dense = (i: number): TextRun[] => [
    { text: `page${i} ` + 'lorem ipsum '.repeat(1500), origin: { x: 0, y: 0 }, along: { x: 40, y: 0 }, up: { x: 0, y: 10 } },
  ];
  const makeDoc = (n: number, reads: number[]) =>
    ({ ...slowDoc(0), pageCount: n, pageText: async (i: number) => (reads.push(i), dense(i)) }) as EngineDocument;
  const scan = (doc: EngineDocument, n: number, query: string, cache: Map<string, TextRun[]>) => {
    const hits: number[] = [];
    return searchDocument({
      doc, pages: createPageList(DOC, n), query, options: { matchCase: false, wholeWord: false }, signal: new AbortController().signal, cache,
      onPage: (p) => void hits.push(p.pageIndex), onProgress: () => undefined,
    }).then(() => hits);
  };

  it('holds the cap on a 1,000-page dense document and gives the same hits as an uncapped cache', async () => {
    const capped = new TextCache();
    const hitsCapped = await scan(makeDoc(1000, []), 1000, 'page777', capped);
    const hitsPlain = await scan(makeDoc(1000, []), 1000, 'page777', new Map());
    expect(capped.totalBytes).toBeLessThanOrEqual(TEXT_CACHE_MAX_BYTES);
    expect(capped.size).toBeLessThan(1000);
    expect(hitsCapped).toEqual(hitsPlain);
    expect(hitsCapped).toEqual([777]);
  });

  it('evicts the least recently used page first, and an evicted page is read again correctly', async () => {
    const reads: number[] = [];
    const small = new TextCache(textBytes(dense(0)) * 3 + 10);
    const doc = makeDoc(5, reads);
    await scan(doc, 5, 'page0', small);
    expect(small.size).toBe(3);
    const keys = createPageList(DOC, 5).map(textCacheKey);
    expect(small.has(keys[0]!)).toBe(false);
    expect(small.has(keys[4]!)).toBe(true);
    reads.length = 0;
    expect(await scan(doc, 5, 'page0', small)).toEqual([0]);
    expect(reads).toContain(0);
  });

  it('keeps the byte count exact through delete and clear', () => {
    const cache = new TextCache();
    cache.set('a', dense(1));
    cache.set('b', dense(2));
    cache.delete('a');
    expect(cache.totalBytes).toBe(textBytes(dense(2)));
    cache.clear();
    expect(cache.totalBytes).toBe(0);
  });
});
