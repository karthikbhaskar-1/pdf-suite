import { describe, expect, it } from 'vitest';
import { reverseScopeOf, wouldEmptyDocument } from './pageMath';

const order = ['a', 'b', 'c'];

describe('wouldEmptyDocument (a delete that would leave no page is refused first)', () => {
  it('is true only when every page is among the targets', () => {
    expect(wouldEmptyDocument(order, ['a', 'b', 'c'])).toBe(true);
    expect(wouldEmptyDocument(order, ['c', 'a', 'b', 'a'])).toBe(true);
    expect(wouldEmptyDocument(order, ['a', 'b'])).toBe(false);
    expect(wouldEmptyDocument(['only'], ['only'])).toBe(true);
    expect(wouldEmptyDocument([], [])).toBe(false);
  });
});

describe('reverseScopeOf (Reverse with no selection applies to all pages, and says so)', () => {
  it('reverses the selected pages in page order when there is a selection', () => {
    expect(reverseScopeOf(order, new Set(['c', 'a']))).toEqual({ uids: ['a', 'c'], all: false });
  });

  it('takes every page when nothing is selected', () => {
    expect(reverseScopeOf(order, new Set())).toEqual({ uids: order, all: true });
  });
});
