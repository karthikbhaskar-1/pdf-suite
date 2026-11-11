import { describe, expect, it } from 'vitest';
import { middleTruncate } from './middleTruncate';

describe('middleTruncate', () => {
  it('keeps the last 12 characters, with the extension', () => {
    const { head, end } = middleTruncate('Quarterly report draft for the board 2026 v1.pdf');
    expect(end).toBe('e board 2026 v1.pdf'.slice(-12));
    expect(end).toHaveLength(12);
    expect(head + end).toBe('Quarterly report draft for the board 2026 v1.pdf');
  });

  it('tells two long names that differ at the end apart', () => {
    const a = middleTruncate('Quarterly report draft for the board 2026 v1.pdf');
    const b = middleTruncate('Quarterly report draft for the board 2026 v2.pdf');
    expect(a.end).not.toBe(b.end);
  });

  it('leaves a short name whole', () => {
    expect(middleTruncate('a.pdf')).toEqual({ head: '', end: 'a.pdf' });
    expect(middleTruncate('123456789.pdf')).toEqual({ head: '1', end: '23456789.pdf' });
  });

  it('does not split a surrogate pair', () => {
    const name = `${'x'.repeat(5)}😀${'y'.repeat(11)}`;
    const { head, end } = middleTruncate(name);
    expect(head + end).toBe(name);
    expect(end.startsWith('😀')).toBe(true);
  });
});

describe('the window title name', () => {
  it('cuts a long name so that its end and extension stay in view', () => {
    const { head, end } = middleTruncate('Quarterly financial results for the board 2024.pdf');
    expect(head.startsWith('Quarterly')).toBe(true);
    expect(end.endsWith('2024.pdf')).toBe(true);
    expect(head + end).toBe('Quarterly financial results for the board 2024.pdf');
  });

  it('handles an empty name', () => {
    expect(middleTruncate('')).toEqual({ head: '', end: '' });
  });
});
