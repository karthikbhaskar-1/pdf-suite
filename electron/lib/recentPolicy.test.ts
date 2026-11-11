// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mayWriteWindowsRecent } from './recentPolicy';

describe('mayWriteWindowsRecent', () => {
  it('allows the Windows Recent list in a normal launch', () => {
    expect(mayWriteWindowsRecent({})).toBe(true);
    expect(mayWriteWindowsRecent({ PDFSUITE_E2E: '0' })).toBe(true);
    expect(mayWriteWindowsRecent({ PDFSUITE_E2E: '' })).toBe(true);
  });
  it('blocks it in test mode, with or without the close prompts', () => {
    expect(mayWriteWindowsRecent({ PDFSUITE_E2E: '1' })).toBe(false);
    expect(mayWriteWindowsRecent({ PDFSUITE_E2E: '1', PDFSUITE_E2E_PROMPTS: '1' })).toBe(false);
  });
});
