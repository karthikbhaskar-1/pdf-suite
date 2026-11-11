import * as path from 'node:path';
import { isAbsolutePath, isOpenablePath } from '../../src/platform/desktop/contract';

/**
 * File paths named on a command line, in the order given. Flags and the "." and ".." tokens are
 * ignored. Any other argument is a file the user named, whatever its extension: the engine reports
 * the ones that are not PDFs. Relative paths are resolved against `cwd`, the working directory of the
 * launching process. Duplicates (same file, any letter case on Windows) appear once. Existence is not
 * checked here; the main process drops directories.
 */
export function pdfPathsFromArgv(argv: readonly string[], cwd: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const arg = raw.trim().replace(/^"(.*)"$/, '$1');
    if (arg.length === 0 || arg.startsWith('-') || arg === '.' || arg === '..') continue;
    const full = isAbsolutePath(arg) ? path.normalize(arg) : path.resolve(cwd, arg);
    if (!isOpenablePath(full)) continue;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(full);
  }
  return found;
}
