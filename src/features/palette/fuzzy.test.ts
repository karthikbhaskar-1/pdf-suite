import { describe, expect, it } from 'vitest';
import { filterEntries, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches characters in order, not necessarily adjacent', () => {
    expect(fuzzyScore('sr', 'Split right')).not.toBeNull();
    expect(fuzzyScore('rs', 'Split right')).toBeNull();
  });

  it('scores word starts and runs higher', () => {
    expect(fuzzyScore('sp', 'Split')!).toBeGreaterThan(fuzzyScore('sp', 'Pan-zoom split')!);
  });

  it('treats a blank query as matching everything', () => {
    expect(fuzzyScore('  ', 'anything')).toBe(0);
  });
});

describe('filterEntries', () => {
  it('keeps matches best first and preserves order among ties', () => {
    const entries = [
      { id: 'a', label: 'Find next' },
      { id: 'b', label: 'Find previous' },
      { id: 'c', label: 'Close tab' },
    ];
    expect(filterEntries(entries, 'find').map((e) => e.id)).toEqual(['a', 'b']);
    expect(filterEntries(entries, 'zzz')).toEqual([]);
  });
});
