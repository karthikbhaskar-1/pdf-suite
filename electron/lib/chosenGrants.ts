import { canonicalSpelling } from './canonicalSpelling';
import type { PathGrants } from './pathGrants';

/**
 * Grants paths the user chose and returns each in the one spelling the page must use (see canonicalSpelling). The paths are
 * resolved IN PARALLEL and without blocking the main thread, so several files, or one on a sleeping network share, never freeze
 * the app. `readOnly` is for the Recent list: those paths are already in the page's spelling (the page only ever added canonical
 * ones), so nothing is resolved and no file-system call is made, however many entries the menu lists and however often.
 */
export async function grantChosenPaths(
  grants: PathGrants,
  paths: string[],
  options: { write?: boolean; readOnly?: boolean } = {},
  resolve: (path: string) => Promise<string> = (path) => canonicalSpelling(path),
): Promise<string[]> {
  const spelled = options.readOnly === true ? paths : await Promise.all(paths.map((path) => resolve(path)));
  const granted = spelled.filter((path) => (options.write === true ? grants.grantWrite(path) : options.readOnly === true ? grants.grant(path) : grants.grantChosen(path)));
  return granted.map((path) => grants.canonical(path) ?? path);
}
