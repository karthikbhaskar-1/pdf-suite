// Repeat guard of the test queue: refuses a suite run when the code it would test did not change since a passing run.
// Pure functions only (no fs, no git), so they are unit-tested in tests/lib/testq-repeat-guard.test.mjs.

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

const CODE_PREFIXES = ['src/', 'electron/', 'tests/', 'scripts/'];
const CODE_FILES = new Set(['package.json', 'package-lock.json', 'vite.config.ts', 'electron-builder.config.cjs', 'index.html']);

export function isCodePath(p) {
  const n = norm(p);
  if (CODE_FILES.has(n)) return true;
  if (/^tsconfig[^/]*\.json$/.test(n)) return true;
  return CODE_PREFIXES.some((x) => n.startsWith(x)) && !n.endsWith('.md');
}

const HEAVY_PREFIXES = ['src/engine/', 'src/ui/viewer/', 'src/ui/thumbnails/', 'tests/perf/'];
const HEAVY_FILES = new Set(['tests/signoff2/perf.probe.mjs', 'package.json', 'package-lock.json']);

export function isHeavyPath(p) {
  const n = norm(p);
  if (HEAVY_FILES.has(n)) return true;
  if (HEAVY_PREFIXES.some((x) => n.startsWith(x))) return true;
  return (n.startsWith('src/') || n.startsWith('electron/')) && /worker|cache/i.test(n);
}

/** @returns {{allow: boolean, reason: string}} */
export function decide({ suite, lastPass, changedPaths }) {
  const lp = lastPass ?? {};
  const cp = changedPaths ?? {};
  const half = (name, test) => {
    const last = lp[name];
    const changed = cp[name];
    if (!last || !Array.isArray(changed)) return { refuse: false };
    if (changed.some(test)) return { refuse: false };
    return { refuse: true, id: last.id };
  };
  const core = half('core', isCodePath);
  const heavy = half('heavy', isHeavyPath);
  const coreWhy = (id) => `core already passed on identical code in job ${id}; nothing under src/electron/tests changed since`;
  const heavyWhy = (id) => `heavy already passed in job ${id}; no engine, viewer, thumbnail, worker, cache or perf code changed since`;
  if (suite === 'core') return core.refuse ? { allow: false, reason: coreWhy(core.id) } : { allow: true, reason: 'ok' };
  if (suite === 'heavy') return heavy.refuse ? { allow: false, reason: heavyWhy(heavy.id) } : { allow: true, reason: 'ok' };
  if (suite === 'full') {
    if (core.refuse && heavy.refuse) return { allow: false, reason: `${coreWhy(core.id)}; ${heavyWhy(heavy.id)}` };
    if (heavy.refuse) return { allow: false, reason: `${heavyWhy(heavy.id)}; use --suite core instead of full` };
    if (core.refuse) return { allow: false, reason: `${coreWhy(core.id)}; use --suite heavy instead of full` };
  }
  return { allow: true, reason: 'ok' };
}
