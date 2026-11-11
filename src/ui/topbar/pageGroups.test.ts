import { describe, expect, it } from 'vitest';
import { targetLineFor } from './pageGroups';

describe('the Delete and Rotate tooltip target line (1.5.5 D5)', () => {
  it('names the selected pages', () => {
    expect(targetLineFor(3, 1)).toBe('Acts on the 3 selected pages.');
    expect(targetLineFor(1, 2)).toBe('Acts on the selected page (page 2).');
  });

  it('is one line only with no such selection', () => {
    expect(targetLineFor(0, 1)).toBeNull();
  });
});
