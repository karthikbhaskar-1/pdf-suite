// @vitest-environment node
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pdfPathsFromArgv } from './argv';

// Paths are built with path.resolve so the expectations hold on any platform.
const CWD = path.resolve('/work/cwd');
const abs = (name: string) => path.resolve(CWD, name);

describe('pdfPathsFromArgv (single-instance and command-line open)', () => {
  it('returns an absolute PDF path as given', () => {
    const file = path.resolve('/docs/report.pdf');
    expect(pdfPathsFromArgv([file], CWD)).toEqual([path.normalize(file)]);
  });

  it('skips flags; callers pass only the arguments after the executable path', () => {
    const file = path.resolve('/docs/a.pdf');
    expect(pdfPathsFromArgv(['--inspect=5858', file], CWD)).toEqual([path.normalize(file)]);
  });

  it('resolves relative PDF paths against the launching process working directory', () => {
    expect(pdfPathsFromArgv(['notes.pdf'], CWD)).toEqual([abs('notes.pdf')]);
  });

  it('keeps files of any type, and ignores "." and ".." tokens', () => {
    expect(pdfPathsFromArgv(['readme.txt', '.', 'image.png', '..'], CWD)).toEqual([abs('readme.txt'), abs('image.png')]);
  });

  it('accepts the .PDF extension in any letter case', () => {
    expect(pdfPathsFromArgv(['LOUD.PDF'], CWD)).toEqual([abs('LOUD.PDF')]);
  });

  it('removes surrounding quotes, as Explorer passes them for paths with spaces', () => {
    expect(pdfPathsFromArgv(['"my file.pdf"'], CWD)).toEqual([abs('my file.pdf')]);
  });

  it('keeps the order given and drops duplicates', () => {
    expect(pdfPathsFromArgv(['b.pdf', 'a.pdf', 'b.pdf'], CWD)).toEqual([abs('b.pdf'), abs('a.pdf')]);
  });

  it('treats the same file in a different letter case as a duplicate', () => {
    expect(pdfPathsFromArgv(['Doc.pdf', 'doc.PDF'], CWD)).toEqual([abs('Doc.pdf')]);
  });

  it('returns nothing for an empty argument list', () => {
    expect(pdfPathsFromArgv([], CWD)).toEqual([]);
  });
});
