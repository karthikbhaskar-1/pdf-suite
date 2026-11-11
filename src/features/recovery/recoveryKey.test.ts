// @vitest-environment node
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath, canonicalRecoveryKey, legacyRecoveryKey, recoveryKeysFor } from './recoveryKey';

/** The comparison key the main process uses for its grants (electron/lib/pathGrants.ts grantKey). */
const grantKey = (path: string) => win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();

describe('the recovery key follows the canonical path (1.5.1 R10)', () => {
  const SPELLINGS = [
    'C:\\Docs\\Report.pdf',
    'c:\\docs\\report.pdf',
    'C:/Docs/Report.pdf',
    'C:\\Docs\\\\Report.pdf',
    'C:\\Docs\\.\\Report.pdf',
    'C:\\Docs\\Other\\..\\Report.pdf',
    'C:\\Docs\\Report.pdf\\',
  ];

  it('gives one key for every spelling of one file', async () => {
    const keys = await Promise.all(SPELLINGS.map(canonicalRecoveryKey));
    expect(new Set(keys).size).toBe(1);
  });

  it('matches the main process grant key for the same paths (so the two never disagree about "the same file")', () => {
    const more = ['\\\\server\\share\\a\\..\\b.pdf', 'D:\\x\\y.pdf', 'C:\\a\\..\\..\\b.pdf', '\\\\server\\share\\x.pdf'];
    for (const path of [...SPELLINGS, ...more]) expect(canonicalPath(path), path).toBe(grantKey(path));
  });

  it('different files give different keys', async () => {
    expect(await canonicalRecoveryKey('C:\\Docs\\a.pdf')).not.toBe(await canonicalRecoveryKey('C:\\Docs\\b.pdf'));
  });

  it("lists the earlier version's key (the path as typed) after the canonical one, when they differ", async () => {
    const [canonical, legacy] = await recoveryKeysFor('C:\\Docs\\Report.pdf');
    expect(canonical).toBe(await canonicalRecoveryKey('C:\\Docs\\Report.pdf'));
    expect(legacy).toBe(await legacyRecoveryKey('C:\\Docs\\Report.pdf'));
    expect(canonical).not.toBe(legacy);
    // A path that is already canonical has one key.
    expect(await recoveryKeysFor('c:\\docs\\report.pdf')).toHaveLength(1);
  });
});
