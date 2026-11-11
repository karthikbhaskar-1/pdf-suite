import { basename } from 'node:path';
import { isValidLeafName } from '../../src/platform/desktop/contract';

/**
 * The path a Save dialog's answer becomes. A saved file is always a .pdf, so ".pdf" is added to a name typed without it ("x.txt"
 * becomes "x.txt.pdf"). The dialog only asked about replacing the name the user typed, so when ".pdf" was added and a file with the
 * resulting name exists, it is not replaced silently: the user is asked, and No leaves it alone. Pure apart from the two injected
 * questions, so it is unit tested.
 */
export type SavePath = { kind: 'path'; path: string } | { kind: 'cancelled' } | { kind: 'bad-name' };

export interface SavePathDeps {
  exists(path: string): Promise<boolean>;
  /** Asks "x.txt.pdf already exists. Do you want to replace it?". True to replace. */
  confirmReplace(path: string): Promise<boolean>;
}

export async function finalSavePath(chosen: string, deps: SavePathDeps, options: { checkLeaf?: boolean } = {}): Promise<SavePath> {
  const path = /\.pdf$/i.test(chosen) ? chosen : `${chosen}.pdf`;
  // Combine's output name is created by main under the job rules (200 characters, no device names): refuse a name it would refuse later.
  if (options.checkLeaf && !isValidLeafName(basename(path))) return { kind: 'bad-name' };
  if (path !== chosen && (await deps.exists(path)) && !(await deps.confirmReplace(path))) return { kind: 'cancelled' };
  return { kind: 'path', path };
}
