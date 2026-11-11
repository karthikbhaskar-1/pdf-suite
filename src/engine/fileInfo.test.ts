import { describe, expect, it } from 'vitest';
import { parsePdfDate } from './fileInfo';

describe('parsePdfDate', () => {
  it('converts a full PDF date to a readable local form', () => {
    expect(parsePdfDate("D:20210314123045+01'00'")).toBe('2021-03-14 12:30:45');
  });

  it('fills missing parts with their first value', () => {
    expect(parsePdfDate('D:2020')).toBe('2020-01-01 00:00:00');
  });

  it('returns undefined for text that is not a PDF date', () => {
    expect(parsePdfDate('yesterday')).toBeUndefined();
    expect(parsePdfDate(undefined)).toBeUndefined();
  });
});
