// @vitest-environment node
// Repeat guard of the test queue (scripts/testq/lib/repeat-guard.mjs). Pure rules, no git, no queue.
import { describe, expect, it } from 'vitest';
import { decide, isCodePath, isHeavyPath } from '../../scripts/testq/lib/repeat-guard.mjs';

const P = (id) => ({ id });
const docs = ['docs/TRACKER.md', 'README.md', 'src/notes.md'];

describe('isCodePath', () => {
  it('accepts code and build files', () => {
    for (const p of ['src/a.ts', 'electron/main.cjs', 'tests/x.test.mjs', 'scripts/testq/submit.mjs', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'electron-builder.config.cjs', 'index.html', 'src\\a.ts']) expect(isCodePath(p), p).toBe(true);
  });
  it('rejects docs', () => {
    for (const p of [...docs, 'docs/x.txt', 'LICENSE']) expect(isCodePath(p), p).toBe(false);
  });
});

describe('isHeavyPath', () => {
  it('accepts engine, viewer, thumbnails, worker, cache, perf and package files', () => {
    for (const p of ['src/engine/a.ts', 'src/ui/viewer/V.tsx', 'src/ui/thumbnails/T.ts', 'src/lib/PageCache.ts', 'electron/thumbWorker.cjs', 'tests/perf/a.mjs', 'tests/signoff2/perf.probe.mjs', 'package.json', 'package-lock.json']) expect(isHeavyPath(p), p).toBe(true);
  });
  it('rejects the rest', () => {
    for (const p of ['src/ui/menu/Menu.tsx', 'tests/e2e/open.mjs', 'docs/cache.md', 'scripts/worker-notes.mjs', 'electron/main.cjs']) expect(isHeavyPath(p), p).toBe(false);
  });
});

describe('decide', () => {
  const both = { core: P('c1'), heavy: P('h1') };
  it('core: refuses with no code change, names the job', () => {
    const r = decide({ suite: 'core', lastPass: both, changedPaths: { core: docs, heavy: docs } });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('c1');
  });
  it('core: allows on a code change or no earlier pass', () => {
    expect(decide({ suite: 'core', lastPass: both, changedPaths: { core: ['src/a.ts'], heavy: [] } }).allow).toBe(true);
    expect(decide({ suite: 'core', lastPass: { core: null, heavy: null }, changedPaths: { core: [], heavy: [] } }).allow).toBe(true);
  });
  it('heavy: refuses when only non-heavy code changed', () => {
    const r = decide({ suite: 'heavy', lastPass: both, changedPaths: { core: ['src/ui/menu/M.tsx'], heavy: ['src/ui/menu/M.tsx'] } });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('h1');
  });
  it('heavy: allows on a heavy change', () => {
    expect(decide({ suite: 'heavy', lastPass: both, changedPaths: { core: [], heavy: ['src/engine/x.ts'] } }).allow).toBe(true);
  });
  it('full: refuses when both halves are refused', () => {
    const r = decide({ suite: 'full', lastPass: both, changedPaths: { core: docs, heavy: docs } });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('c1');
    expect(r.reason).toContain('h1');
  });
  it('full: only heavy needed suggests --suite heavy', () => {
    const r = decide({ suite: 'full', lastPass: both, changedPaths: { core: docs, heavy: ['src/engine/x.ts'] } });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('--suite heavy');
  });
  it('full: only core needed suggests --suite core', () => {
    const r = decide({ suite: 'full', lastPass: both, changedPaths: { core: ['src/a.ts'], heavy: ['src/a.ts'] } });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('--suite core');
  });
  it('full: allows when both halves are needed', () => {
    expect(decide({ suite: 'full', lastPass: both, changedPaths: { core: ['src/engine/a.ts'], heavy: ['src/engine/a.ts'] } }).allow).toBe(true);
  });
  it('unknown history always allows', () => {
    for (const suite of ['core', 'heavy', 'full']) {
      expect(decide({ suite, lastPass: both, changedPaths: { core: null, heavy: null } }).allow, suite).toBe(true);
    }
    expect(decide({ suite: 'full', lastPass: both, changedPaths: { core: null, heavy: null } }).allow).toBe(true);
  });
});
