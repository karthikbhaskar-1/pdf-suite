import { describe, expect, it } from 'vitest';
import { PathGrants, grantKey, isGrantablePath } from './pathGrants';

describe('path grants: ungranted paths are refused', () => {
  it('refuses a path nobody granted', () => {
    const grants = new PathGrants();
    expect(grants.canonical('C:\\Docs\\example\\secret.pdf')).toBeNull();
  });

  it('refuses a path granted only by a different file name', () => {
    const grants = new PathGrants();
    grants.grant('C:\\docs\\a.pdf');
    expect(grants.canonical('C:\\docs\\b.pdf')).toBeNull();
  });

  it('refuses a relative path and a NUL in the path when granting, and grants a chosen file of any type', () => {
    const grants = new PathGrants();
    expect(grants.grant('docs\\a.txt')).toBe(false);
    expect(grants.grant('C:\\docs\\a\0.pdf')).toBe(false);
    expect(grants.size).toBe(0);
    expect(grants.grant('C:\\docs\\a.txt')).toBe(true);
    expect(grants.canonical('C:\\docs\\a.txt')).toBe('C:\\docs\\a.txt');
    expect(grants.canonical('C:\\docs\\ungranted.txt')).toBeNull();
  });
});

describe('path grants: granted paths are allowed, and spellings of them are normalized', () => {
  it('allows the granted path itself', () => {
    const grants = new PathGrants();
    expect(grants.grant('C:\\docs\\a.pdf')).toBe(true);
    expect(grants.canonical('C:\\docs\\a.pdf')).toBe('C:\\docs\\a.pdf');
  });

  it('matches case-insensitively, as Windows does', () => {
    const grants = new PathGrants();
    grants.grant('C:\\Docs\\A.PDF');
    expect(grants.canonical('c:\\docs\\a.pdf')).toBe('C:\\Docs\\A.PDF');
  });

  it('resolves path traversal: a path back to a granted file is allowed', () => {
    const grants = new PathGrants();
    grants.grant('C:\\docs\\a.pdf');
    expect(grants.canonical('C:\\docs\\sub\\..\\a.pdf')).toBe('C:\\docs\\a.pdf');
    expect(grants.canonical('C:\\docs\\.\\a.pdf')).toBe('C:\\docs\\a.pdf');
  });

  it('resolves path traversal out of the granted folder: the escaped path is refused', () => {
    const grants = new PathGrants();
    grants.grant('C:\\docs\\a.pdf');
    expect(grants.canonical('C:\\docs\\..\\Windows\\win.pdf')).toBeNull();
    expect(grants.canonical('C:\\docs\\sub\\..\\..\\secret.pdf')).toBeNull();
  });

  it('handles UNC paths: the same share and file is allowed, another share is refused', () => {
    const grants = new PathGrants();
    grants.grant('\\\\nas\\share\\a.pdf');
    expect(grants.canonical('\\\\NAS\\share\\x\\..\\a.pdf')).toBe('\\\\nas\\share\\a.pdf');
    expect(grants.canonical('\\\\nas\\other\\a.pdf')).toBeNull();
  });

  it('keys the same file under forward and back slashes', () => {
    expect(grantKey('C:/docs/a.pdf')).toBe(grantKey('C:\\docs\\a.pdf'));
  });

  it('accepts absolute paths of any file type and bounded length, and nothing else', () => {
    expect(isGrantablePath('C:\\docs\\a.pdf')).toBe(true);
    expect(isGrantablePath('C:\\docs\\notes.txt')).toBe(true);
    expect(isGrantablePath('a.pdf')).toBe(false);
    expect(isGrantablePath(`C:\\${'x'.repeat(5000)}.pdf`)).toBe(false);
    expect(isGrantablePath(42)).toBe(false);
  });
});

describe('path grants: the list is bounded and kept in order', () => {
  it('drops the oldest grant once the limit is passed', () => {
    const grants = new PathGrants(2);
    grants.grant('C:\\a\\1.pdf');
    grants.grant('C:\\a\\2.pdf');
    grants.grant('C:\\a\\3.pdf');
    expect(grants.canonical('C:\\a\\1.pdf')).toBeNull();
    expect(grants.list()).toEqual(['C:\\a\\2.pdf', 'C:\\a\\3.pdf']);
  });

  it('a path granted again becomes the newest, not a duplicate', () => {
    const grants = new PathGrants(2);
    grants.grant('C:\\a\\1.pdf');
    grants.grant('C:\\a\\2.pdf');
    grants.grant('C:\\a\\1.pdf');
    expect(grants.size).toBe(2);
    expect(grants.list()).toEqual(['C:\\a\\2.pdf', 'C:\\a\\1.pdf']);
  });

  it('a saved list grants the same paths when restored', () => {
    const first = new PathGrants();
    first.grant('C:\\a\\x.pdf');
    first.grant('D:\\b\\y.pdf');
    const restored = new PathGrants();
    for (const path of JSON.parse(JSON.stringify(first.list())) as string[]) restored.grant(path);
    expect(restored.canonical('d:\\B\\Y.pdf')).toBe('D:\\b\\y.pdf');
    expect(restored.list()).toEqual(first.list());
  });
});
