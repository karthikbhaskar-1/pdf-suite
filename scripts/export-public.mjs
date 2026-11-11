// Builds the public source tree from the committed files of the current branch (HEAD), into a NEW folder.
// Usage: node scripts/export-public.mjs <target-folder>
// The target must not exist or must be empty. This script does NOT run `git init`, create a repository or push:
// the owner does that after reading the printed list (see docs/release/PUBLISHING.md).
// Why an export: the local git history contains unscrubbed working notes, so the public repository is created from a
// fresh one-commit copy of the files, never from this repository's history.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Local working notes that are kept in this repository but never published. */
export const EXCLUDED = [
  'docs/TRACKER.md', // project status board with local test-machine details
  'docs/OWNER-DELEGATE.md', // internal agent-process note
  'docs/ORCHESTRATION-RULES.md', // internal agent-process note
];

/**
 * The only files under docs/ that are published (owner, 2026-11-11: no working docs in public). Everything else under docs/
 * (milestone plans and rulings, decision records, requirements, testing rules, publishing notes, the file list) stays local.
 * A path ending in "/" keeps that whole folder.
 */
export const PUBLIC_DOCS = ['docs/user-guide/', 'docs/release/RELEASE-NOTES-0.1.0.md', 'docs/release/CODE-SIGNING-POLICY.md'];

/** True when a committed file under docs/ is published. Files outside docs/ are not affected. */
export function isPublicDoc(rel) {
  if (!rel.startsWith('docs/')) return true;
  return PUBLIC_DOCS.some((k) => (k.endsWith('/') ? rel.startsWith(k) : rel === k));
}

const PLACEHOLDERS = ['[OWNER NAME]', '[OWNER CONTACT]', '[REPOSITORY URL]', '[MUPDF SOURCE URL]'];
// Files that only talk about the placeholders.
const PLACEHOLDER_SKIP = new Set(['scripts/export-public.mjs', 'docs/release/PUBLISHING.md']);

function pruneEmptyDirs(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, p));
    else out.push(p);
  }
  return out;
}

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
}

function main() {
  const target = process.argv[2];
  if (!target || target.startsWith('--')) {
    console.error('Usage: node scripts/export-public.mjs <target-folder>   (the folder must not exist, or must be empty)');
    process.exit(2);
  }
  if (!existsSync(join(repoRoot, '.publish-patterns.local.json'))) {
    console.error('Cannot export: the local file .publish-patterns.local.json is missing from the repository root.');
    console.error('It holds the personal patterns the publish check must look for. Create it (it is git-ignored) and run again.');
    process.exit(2);
  }
  const dest = resolve(target);
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory() || readdirSync(dest).length > 0) {
      console.error(`Refusing to export: ${dest} exists and is not an empty folder.`);
      process.exit(2);
    }
  } else {
    mkdirSync(dest, { recursive: true });
  }

  // `git archive` writes a tar of the committed files only: untracked and ignored files are never included.
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repoRoot, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-xf', '-'], { cwd: dest, input: tar, maxBuffer: 1 << 30 }); // cwd, not -C: GNU tar reads a drive letter as a host name

  const removed = [];
  for (const rel of EXCLUDED) {
    const p = join(dest, rel);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(rel);
    }
  }
  if (existsSync(join(dest, 'docs'))) {
    for (const f of listFiles(dest, 'docs')) {
      if (!isPublicDoc(f)) {
        rmSync(join(dest, f), { force: true });
        removed.push(f);
      }
    }
    pruneEmptyDirs(join(dest, 'docs'));
  }
  console.log(`Excluded from the export (${removed.length}):`);
  for (const r of removed) console.log('  - ' + r);

  // Check the export itself; --write-list refreshes docs/release/FILE-LIST.md in this repository from the export.
  const check = join(repoRoot, 'scripts', 'publish-check.mjs');
  let failed = false;
  try {
    execFileSync(process.execPath, [check, dest, ...process.argv.slice(3)], { stdio: 'inherit' });
  } catch {
    failed = true;
  }
  // Warn (not fail) about placeholders the owner still has to fill in.
  console.log('Placeholders still to fill in (the owner does this before publishing):');
  let found = 0;
  for (const f of listFiles(dest)) {
    if (PLACEHOLDER_SKIP.has(f) || statSync(join(dest, f)).size > 5 * 1024 * 1024) continue;
    const buf = readFileSync(join(dest, f));
    if (buf.subarray(0, 8000).includes(0)) continue;
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      for (const ph of PLACEHOLDERS) if (line.includes(ph)) { console.log(`  WARNING ${f}:${i + 1}: ${ph}`); found++; }
    });
  }
  if (!found) console.log('  none');
  console.log(`Export folder: ${dest}`);
  console.log(`Final file count: ${countFiles(dest)}`);
  if (failed) {
    console.error('EXPORT CHECK FAILED: do not publish this folder. Fix the hits above (or add the file to EXCLUDED).');
    process.exit(1);
  }
  console.log('Export check passed. Nothing was published: no repository was created and nothing was pushed.');
}

main();
