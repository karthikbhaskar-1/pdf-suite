import { describe, expect, it } from 'vitest';
import { SizedLru, selectEvictions } from './lru';

describe('SizedLru eviction', () => {
  it('evicts the least recently used entries first when over capacity', () => {
    const evicted: string[] = [];
    const cache = new SizedLru<string>(100, (key) => evicted.push(key));
    cache.set('a', 'A', 40);
    cache.set('b', 'B', 40);
    cache.get('a'); // a is now the most recently used
    cache.set('c', 'C', 40); // total 120, so one entry goes

    expect(evicted).toEqual(['b']);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.bytes).toBe(80);
  });

  it('always keeps the newest entry, even when it alone exceeds capacity', () => {
    const cache = new SizedLru<number>(10);
    cache.set('big', 1, 50);
    expect(cache.has('big')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('updates the size when a key is overwritten', () => {
    const cache = new SizedLru<number>(100);
    cache.set('x', 1, 30);
    cache.set('x', 2, 60);
    expect(cache.bytes).toBe(60);
    expect(cache.get('x')).toBe(2);
  });
});

describe('selectEvictions', () => {
  it('chooses the oldest entries until the rest fit', () => {
    const entries = [
      { key: 'old', size: 60, lastUsed: 1 },
      { key: 'mid', size: 60, lastUsed: 2 },
      { key: 'new', size: 60, lastUsed: 3 },
    ];
    expect(selectEvictions(entries, 130)).toEqual(['old']);
    expect(selectEvictions(entries, 100)).toEqual(['old', 'mid']);
  });

  it('evicts nothing when everything fits', () => {
    expect(selectEvictions([{ key: 'a', size: 10, lastUsed: 1 }], 100)).toEqual([]);
  });
});

describe('SizedLru releases what it drops', () => {
  it('closes a value that is replaced by another value under the same key', () => {
    const released: string[] = [];
    const lru = new SizedLru<string>(100, (_key, value) => released.push(value));
    lru.set('k', 'old', 10);
    lru.set('k', 'new', 10);
    expect(released).toEqual(['old']);
    expect(lru.get('k')).toBe('new');
  });

  it('does not release a value that is set again as the same value', () => {
    const released: string[] = [];
    const lru = new SizedLru<string>(100, (_key, value) => released.push(value));
    const value = 'same';
    lru.set('k', value, 10);
    lru.set('k', value, 10);
    expect(released).toEqual([]);
  });

  it('deleteWhere removes the matching entries through the eviction callback', () => {
    const released: string[] = [];
    const lru = new SizedLru<string>(100, (key) => released.push(key));
    lru.set('a1', 'x', 10);
    lru.set('b1', 'x', 10);
    lru.set('a2', 'x', 10);
    lru.deleteWhere((key) => key.startsWith('a'));
    expect(released.sort()).toEqual(['a1', 'a2']);
    expect(lru.size).toBe(1);
    expect(lru.bytes).toBe(10);
  });
});

describe('SizedLru pins', () => {
  it('never evicts a pinned value, even over capacity', () => {
    const evicted: string[] = [];
    const lru = new SizedLru<string>(100, (key) => evicted.push(key));
    lru.set('a', 'A', 60);
    lru.pin('A');
    lru.set('b', 'B', 60);
    expect(evicted).toEqual([]);
    expect(lru.has('a')).toBe(true);
    expect(lru.bytes).toBe(120);
  });

  it('trims once the last pin is released', () => {
    const evicted: string[] = [];
    const lru = new SizedLru<string>(100, (key) => evicted.push(key));
    lru.set('a', 'A', 60);
    lru.pin('A');
    lru.set('b', 'B', 60);
    lru.unpin('A');
    expect(evicted).toEqual(['a']);
    expect(lru.bytes).toBe(60);
  });

  it('counts pins, so a value held twice is released only after both holders let go', () => {
    const released: string[] = [];
    const lru = new SizedLru<string>(10, (_key, value) => released.push(value));
    lru.set('k', 'V', 5);
    lru.pin('V');
    lru.pin('V');
    lru.set('k', 'W', 5);
    expect(released).toEqual([]);
    lru.unpin('V');
    expect(released).toEqual([]);
    lru.unpin('V');
    expect(released).toEqual(['V']);
  });

  it('a value replaced under its key while pinned is held, not closed, until released', () => {
    const released: string[] = [];
    const lru = new SizedLru<string>(100, (_key, value) => released.push(value));
    lru.set('k', 'old', 10);
    lru.pin('old');
    lru.set('k', 'new', 10);
    expect(released).toEqual([]);
    expect(lru.get('k')).toBe('new');
    lru.unpin('old');
    expect(released).toEqual(['old']);
  });

  it('deleteWhere leaves a pinned entry in place', () => {
    const lru = new SizedLru<string>(100);
    lru.set('x', 'X', 10);
    lru.pin('X');
    lru.deleteWhere((key) => key === 'x');
    expect(lru.has('x')).toBe(true);
  });
});

describe('deleteWhere on a pinned entry (ticket 1.2.1 review, item 4)', () => {
  it('keeps it while pinned and removes and releases it when the last pin goes', () => {
    const released: string[] = [];
    const lru = new SizedLru<{ n: string }>(100, (_k, v) => released.push(v.n));
    const a = { n: 'a' };
    lru.set('k', a, 1);
    lru.pin(a);
    lru.pin(a);
    lru.deleteWhere(() => true);
    expect(lru.has('k')).toBe(true);
    lru.unpin(a);
    expect(lru.has('k')).toBe(true);
    lru.unpin(a);
    expect(lru.has('k')).toBe(false);
    expect(released).toEqual(['a']);
    expect(lru.bytes).toBe(0);
  });

  it('does not remove a different value that took the key meanwhile', () => {
    const lru = new SizedLru<{ n: string }>(100);
    const a = { n: 'a' };
    const b = { n: 'b' };
    lru.set('k', a, 1);
    lru.pin(a);
    lru.deleteWhere(() => true);
    lru.set('k', b, 1);
    lru.unpin(a);
    expect(lru.get('k')).toBe(b);
  });
});
