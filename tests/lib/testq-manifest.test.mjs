// @vitest-environment node
// The test queue manifest (tests/testq-manifest.json) must list every e2e file, and only files that exist.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { entryFor, suiteFiles } from '../../scripts/testq/lib/manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'tests', 'testq-manifest.json'), 'utf8'));

describe('testq manifest', () => {
  it('lists every tests/e2e/*.e2e.mjs file', () => {
    const onDisk = readdirSync(join(root, 'tests', 'e2e')).filter((n) => n.endsWith('.e2e.mjs')).map((n) => `tests/e2e/${n}`);
    expect(onDisk.filter((f) => !manifest.files[f])).toEqual([]);
  });

  it('lists only files that exist (the vitest entry is a command, not a file)', () => {
    const missing = Object.keys(manifest.files).filter((f) => f !== 'vitest' && !existsSync(join(root, f)));
    expect(missing).toEqual([]);
  });

  it('gives every entry a class and expected minutes, and a reason for every exclusive one', () => {
    for (const [file, e] of Object.entries(manifest.files)) {
      expect(['functional', 'exclusive'], file).toContain(e.class);
      expect(e.minutes, file).toBeGreaterThan(0);
      expect(['unit', 'e2e', 'probe'], file).toContain(e.kind);
      if (e.class === 'exclusive') expect(e.why, file).toBeTruthy();
    }
  });

  it('keeps timing and memory files exclusive', () => {
    for (const f of ['tests/e2e/bigfile.e2e.mjs', 'tests/e2e/stress-edit.e2e.mjs', 'tests/signoff2/perf.probe.mjs', 'tests/perf/mem-soak.probe.mjs']) {
      expect(entryFor(manifest, f).class, f).toBe('exclusive');
    }
  });

  it('builds the suites: core is the functional e2e files, heavy the exclusive ones, full all of them', () => {
    const core = suiteFiles(manifest, 'core');
    const heavy = suiteFiles(manifest, 'heavy');
    expect(core.every((f) => manifest.files[f].class === 'functional' && manifest.files[f].kind === 'e2e')).toBe(true);
    expect(heavy.every((f) => manifest.files[f].class === 'exclusive')).toBe(true);
    expect(heavy).toContain('tests/signoff2/perf.probe.mjs');
    expect(heavy).not.toContain('tests/perf/mem-median.probe.mjs');
    expect(suiteFiles(manifest, 'unit')).toContain('vitest');
    expect(suiteFiles(manifest, 'full').length).toBe(suiteFiles(manifest, 'unit').length + core.length + heavy.length);
  });

  it('treats a file the manifest does not know as exclusive', () => {
    expect(entryFor(manifest, 'tests/e2e/new-thing.e2e.mjs')).toMatchObject({ class: 'exclusive', known: false });
  });
});
