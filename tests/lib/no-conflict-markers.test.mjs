// Fails when a merge left conflict markers in a tracked source, style, test or doc file.
// Added 2026-11-11 after a merge committed organizer.css with a "=======" / ">>>>>>> main" pair that the build accepted.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MARKER = /^(<{7} |={7}$|>{7} )/m;
const CHECKED = /\.(ts|tsx|js|mjs|cjs|css|html|json|md|yml)$/;

// A source export (no .git folder) has no tracked-file list, so there is nothing to check.
describe.skipIf(!existsSync('.git'))('no merge conflict markers', () => {
  it('no tracked file holds a conflict marker line', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => CHECKED.test(f));
    const hits = files.filter((f) => {
      try { return MARKER.test(readFileSync(f, 'utf8')); } catch { return false; }
    });
    expect(hits).toEqual([]);
  });
});
