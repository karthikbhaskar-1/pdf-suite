import { describe, expect, it } from 'vitest';
import { cleanOutlineTitle } from './outlineTitle';

describe('cleanOutlineTitle', () => {
  it('removes NUL and other control characters, as the XFA outline titles contain', () => {
    expect(cleanOutlineTitle('Part\u0000 I\u0000')).toBe('Part I');
    expect(cleanOutlineTitle('\u001bSection\u007f 2')).toBe('Section 2');
  });

  it('keeps ordinary text and non-ASCII letters', () => {
    expect(cleanOutlineTitle('Résumé — Chapter 1')).toBe('Résumé — Chapter 1');
  });
});
