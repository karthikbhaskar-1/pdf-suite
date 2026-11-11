// The classification of test files (tests/testq-manifest.json) and what the named suites contain.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

export const SUITES = ['unit', 'core', 'heavy', 'full'];
export const MANIFEST_PATH = join('tests', 'testq-manifest.json');

/** Reads the manifest of a worktree (its own branch decides its classification). */
export function loadManifest(worktree, fallbackRoot) {
  for (const root of [worktree, fallbackRoot]) {
    if (!root) continue;
    const p = join(root, MANIFEST_PATH);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  return { version: 1, files: {} };
}

const norm = (f) => f.split(sep).join('/').replace(/^\.\//, '');

/** Entry for a file; a file the manifest does not know is exclusive (nothing proves it may share the machine). */
export function entryFor(manifest, file) {
  const key = norm(file);
  const e = manifest.files?.[key];
  if (e) return { file: key, known: true, ...e };
  const script = !/\.(e2e|unit)\.mjs$/.test(key);
  return { file: key, known: false, class: 'exclusive', minutes: 5, kind: 'other', runner: script ? 'script' : 'node-test' };
}

/** Files of a named suite, in manifest order, functional first. */
export function suiteFiles(manifest, suite) {
  const all = Object.entries(manifest.files ?? {}).map(([file, e]) => ({ file, ...e }));
  const pick = (f) => all.filter(f).map((e) => e.file);
  const unit = pick((e) => e.kind === 'unit');
  const core = pick((e) => e.kind === 'e2e' && e.class === 'functional');
  const heavy = pick((e) => e.class === 'exclusive' && e.suite !== false && (e.kind === 'e2e' || e.kind === 'probe'));
  switch (suite) {
    case 'unit':
      return unit;
    case 'core':
      return core;
    case 'heavy':
      return heavy;
    case 'full':
      return [...unit, ...core, ...heavy];
    default:
      throw new Error(`unknown suite "${suite}" (use ${SUITES.join(', ')})`);
  }
}

/** Resolves a list of user-given paths (relative to the worktree, or absolute inside it) to manifest keys. */
export function normaliseFiles(worktree, files) {
  return files.map((f) => {
    const abs = resolve(worktree, f);
    const rel = relative(worktree, abs);
    if (rel.startsWith('..')) throw new Error(`file is outside the worktree: ${f}`);
    return norm(rel);
  });
}
