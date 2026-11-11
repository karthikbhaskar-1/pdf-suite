import { describe, expect, it } from 'vitest';
import { diag, diagEnabled } from './diag';

describe('diagnostics trace', () => {
  it('is not exposed outside test mode, and records nothing', () => {
    expect((window as unknown as { __pdfSuiteDiag?: unknown }).__pdfSuiteDiag).toBeUndefined();
    expect(diagEnabled()).toBe(false);
    expect(() => diag('anything', { a: 1 })).not.toThrow();
    expect(diagEnabled()).toBe(false);
  });
});
