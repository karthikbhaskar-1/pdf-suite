// @vitest-environment node
// The job worker is bundled by itself. Whatever it imports (directly or not) ends up in that bundle and runs with no DOM, so it
// must not reach the page's engines, the platform bridge, the features, the stores or React. This walks the real imports.
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)) out.push(match[1]!);
  for (const match of text.matchAll(/import\('(\.[^']+)'\)/g)) out.push(match[1]!);
  return out;
}

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const target = normalize(join(dirname(file), spec));
      for (const candidate of [`${target}.ts`, `${target}.tsx`, join(target, 'index.ts')]) {
        try {
          readFileSync(candidate);
          stack.push(candidate);
          break;
        } catch {
          // Not this one.
        }
      }
    }
  }
  return seen;
}

describe('the job worker bundle', () => {
  it('reaches only engine files that run without a DOM', () => {
    const files = [...closure(join(root, 'engine', 'mupdf', 'jobWorker.ts'))].map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
    expect(files).toContain('engine/mupdf/jobCore.ts');
    expect(files).toContain('engine/mupdf/splitCore.ts');
    // engine/overlayPlacement.ts (1.3.4) is pure maths with no imports; MupdfCore uses it, and the job worker reaches MupdfCore.
    const outside = files.filter((f) => !f.startsWith('engine/mupdf/') && f !== 'engine/outlineTitle.ts' && f !== 'engine/overlayPlacement.ts');
    expect(outside).toEqual([]);
    // And inside engine/mupdf, nothing that talks to the page.
    const page = files.filter((f) => /client\.ts|pool\.ts|mupdfDocument\.ts|worker\.ts$/.test(f) && f !== 'engine/mupdf/jobWorker.ts');
    expect(page).toEqual([]);
  });
});
