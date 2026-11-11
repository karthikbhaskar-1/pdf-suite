// @vitest-environment node
// TESTING-RULES §3: every app launch in tests passes its own temp --user-data-dir, because test-mode close
// deletes every recovery log in the profile it runs in. This fails if a launch call site omits it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'corpus') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs|ts)$/.test(name)) out.push(p);
  }
  return out;
};

// A launch is electron.launch(...), _electron.launch(...), or spawn(EXE, ...) of the app binary.
const LAUNCH = /\b_?electron\.launch\s*\(|\bspawn\s*\(\s*EXE\b/g;

export function findLaunchSites(text) {
  const sites = [];
  for (const m of text.matchAll(LAUNCH)) {
    // The call text: from the match to the end of the balanced parentheses.
    let depth = 0;
    let i = m.index + m[0].indexOf('(');
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    sites.push({ line: text.slice(0, m.index).split('\n').length, call: text.slice(start, i + 1) });
  }
  return sites;
}

describe('test app launches pass their own --user-data-dir', () => {
  it('detects a launch without it', () => {
    expect(findLaunchSites('await electron.launch({ executablePath: EXE, args })')[0].call).not.toContain('--user-data-dir');
  });

  it('every launch call site in tests/ passes --user-data-dir', () => {
    const files = walk(join(root, 'tests'));
    const bad = [];
    let total = 0;
    for (const f of files.filter((x) => !x.endsWith('launch-user-data-dir.test.mjs'))) {
      for (const s of findLaunchSites(readFileSync(f, 'utf8'))) {
        total++;
        if (!s.call.includes('--user-data-dir')) bad.push(`${relative(root, f).split(sep).join('/')}:${s.line}`);
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
