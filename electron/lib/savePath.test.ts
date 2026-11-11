import { describe, expect, it } from 'vitest';
import { finalSavePath } from './savePath';

const deps = (existing: string[], answer: boolean) => {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      exists: async (p: string) => existing.includes(p),
      confirmReplace: async (p: string) => {
        asked.push(p);
        return answer;
      },
    },
  };
};

describe('the path a Save dialog answer becomes', () => {
  it('a name that already ends in .pdf is used as the dialog confirmed it, with no extra question', async () => {
    const d = deps(['C:/a/x.pdf'], false);
    expect(await finalSavePath('C:/a/x.pdf', d.deps)).toEqual({ kind: 'path', path: 'C:/a/x.pdf' });
    expect(await finalSavePath('C:/a/X.PDF', d.deps)).toEqual({ kind: 'path', path: 'C:/a/X.PDF' });
    expect(d.asked).toEqual([]);
  });

  it('.pdf is added to a name without it; a free name is used', async () => {
    const d = deps([], false);
    expect(await finalSavePath('C:/a/x.txt', d.deps)).toEqual({ kind: 'path', path: 'C:/a/x.txt.pdf' });
    expect(d.asked).toEqual([]);
  });

  it('an existing file with the resulting name is not replaced silently: the user is asked, and No keeps it', async () => {
    const no = deps(['C:/a/x.txt.pdf'], false);
    expect(await finalSavePath('C:/a/x.txt', no.deps)).toEqual({ kind: 'cancelled' });
    expect(no.asked).toEqual(['C:/a/x.txt.pdf']);
    const yes = deps(['C:/a/x.txt.pdf'], true);
    expect(await finalSavePath('C:/a/x.txt', yes.deps)).toEqual({ kind: 'path', path: 'C:/a/x.txt.pdf' });
  });

  it('Combine\'s output name is checked: over 200 characters or a device name is refused before anything starts', async () => {
    const d = deps([], true);
    expect(await finalSavePath(`C:/a/${'n'.repeat(201)}.pdf`, d.deps, { checkLeaf: true })).toEqual({ kind: 'bad-name' });
    expect(await finalSavePath('C:/a/con.pdf', d.deps, { checkLeaf: true })).toEqual({ kind: 'bad-name' });
    expect(await finalSavePath(`C:/a/${'n'.repeat(196)}.pdf`, d.deps, { checkLeaf: true })).toEqual({ kind: 'path', path: `C:/a/${'n'.repeat(196)}.pdf` });
    // Without the check (Save As) a long name is the dialog's business.
    expect((await finalSavePath(`C:/a/${'n'.repeat(250)}.pdf`, d.deps)).kind).toBe('path');
  });
});
