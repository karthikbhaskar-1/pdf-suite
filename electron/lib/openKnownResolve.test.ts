// 1.5.1 review: no file-system call on the main thread for a path a user action or a restore can reach, and no new grant for a
// spelling that only reaches a granted file. The junction is real (Windows only); the slow file system is a fake.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSpelling, type AsyncRealpath } from './canonicalSpelling';
import { grantChosenPaths } from './chosenGrants';
import { PathGrants } from './pathGrants';
import { ReopenRecord } from './reopenRecord';

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pdfsuite-openknown-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const real = join(root, 'Real Folder');
mkdirSync(real);
const a = join(real, 'a.pdf');
const b = join(real, 'b.pdf');
writeFileSync(a, 'A');
writeFileSync(b, 'B');
const alias = join(root, 'alias');
let junction = false;
try {
  symlinkSync(real, alias, 'junction');
  junction = true;
} catch {
  junction = false;
}
const viaJunction = join(alias, 'a.pdf');
const viaJunctionB = join(alias, 'b.pdf');
const longPath = (path: string): string => `\\\\?\\${path}`;

/** The main process's files:openKnown, as main.ts runs it. */
async function openKnown(grants: PathGrants, record: ReopenRecord, path: string, resolve = (p: string) => canonicalSpelling(p)): Promise<string | null> {
  const granted = await grants.findGranted(path, resolve);
  return granted !== null && record.allowOnce(granted) && grants.allowOpen(granted) ? granted : null;
}

describe('findGranted: text first, one asynchronous resolution only when nothing matches', () => {
  it('a path that matches a grant by text never calls the resolver, however many grants there are', async () => {
    const grants = new PathGrants();
    for (let i = 0; i < 500; i++) grants.grant(`C:\\many\\${i}.pdf`);
    const resolve = vi.fn(async (p: string) => p);
    expect(await grants.findGranted('c:\\MANY\\250.pdf', resolve)).toBe('C:\\many\\250.pdf');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a path that matches no grant is resolved ONCE (not once per stored grant), and the stored grants are never resolved', async () => {
    const grants = new PathGrants();
    for (let i = 0; i < 500; i++) grants.grant(`C:\\many\\${i}.pdf`);
    const resolve = vi.fn(async (p: string) => p);
    expect(await grants.findGranted('C:\\other\\x.pdf', resolve)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('C:\\other\\x.pdf');
  });

  it('a resolver that fails finds nothing, and a path that is not grantable is not resolved', async () => {
    const grants = new PathGrants();
    grants.grant('C:\\a.pdf');
    expect(await grants.findGranted('C:\\b.pdf', async () => Promise.reject(new Error('offline')))).toBeNull();
    const resolve = vi.fn(async (p: string) => p);
    expect(await grants.findGranted('relative.pdf', resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('while a slow file system resolves a path, the event loop keeps ticking (the main thread is not blocked)', async () => {
    const grants = new PathGrants();
    grants.grant('C:\\nas\\a.pdf');
    const slow = (path: string) => new Promise<string>((resolve) => setTimeout(() => resolve(path.replace('alias', 'nas')), 300));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    expect(await grants.findGranted('C:\\alias\\a.pdf', slow)).toBe('C:\\nas\\a.pdf');
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(10);
  });
});

describe('1.5.8 review B1: a page cannot make the main process touch a host the user never named', () => {
  const spy = () => vi.fn(async (p: string) => p);

  it('a UNC path on a server and share that no grant names is never resolved (no SMB connection, no thread-pool wait)', async () => {
    const grants = new PathGrants();
    grants.grant('C:\\a.pdf');
    grants.grant('\\\\nas\\docs\\a.pdf');
    const resolve = spy();
    expect(await grants.findGranted('\\\\evil-host\\share\\x.pdf', resolve)).toBeNull();
    expect(await grants.findGranted('\\\\nas\\other-share\\x.pdf', resolve)).toBeNull();
    expect(await grants.findGranted('//evil-host/share/x.pdf', resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a UNC path on a share that a grant already names is resolved (a spelling of a granted file still finds it)', async () => {
    const grants = new PathGrants();
    grants.grant('\\\\NAS\\Docs\\a.pdf');
    const resolve = vi.fn(async () => '\\\\nas\\docs\\a.pdf');
    expect(await grants.findGranted('\\\\nas\\docs\\other\\a-alias.pdf', resolve)).toBe('\\\\NAS\\Docs\\a.pdf');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('device and long-path spellings are never resolved, even when they name a drive or a granted share', async () => {
    const grants = new PathGrants();
    grants.grant('C:\\a.pdf');
    grants.grant('\\\\nas\\docs\\a.pdf');
    const resolve = spy();
    for (const path of [
      '\\\\.\\C:\\b.pdf',
      '\\\\?\\UNC\\nas\\docs\\b.pdf',
      '\\\\?\\UNC\\evil-host\\share\\b.pdf',
      '\\\\.\\pipe\\evil',
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x.pdf',
      '\\\\?\\Volume{ZZZZZZZZ-ZZZZ}\\x.pdf',
    ]) {
      expect(await grants.findGranted(path, resolve), path).toBeNull();
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('the long-path spelling of a drive path is still resolved: it is that drive path and reaches no host', async () => {
    const grants = new PathGrants();
    grants.grant('C:\\real\\a.pdf');
    const resolve = vi.fn(async () => 'C:\\real\\a.pdf');
    expect(await grants.findGranted('\\\\?\\C:\\alias\\a.pdf', resolve)).toBe('C:\\real\\a.pdf');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a path with no drive letter and no UNC root (root-relative, drive-relative) is never resolved', async () => {
    const grants = new PathGrants();
    grants.grant('C:\\a.pdf');
    const resolve = spy();
    expect(await grants.findGranted('\\Windows\\x.pdf', resolve)).toBeNull();
    expect(await grants.findGranted('C:x.pdf', resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a path with a drive letter is still resolved, with either slash', async () => {
    const grants = new PathGrants();
    grants.grant('C:\\real\\a.pdf');
    const resolve = vi.fn(async () => 'C:\\real\\a.pdf');
    expect(await grants.findGranted('D:\\alias\\a.pdf', resolve)).toBe('C:\\real\\a.pdf');
    expect(await grants.findGranted('d:/alias/a.pdf', resolve)).toBe('C:\\real\\a.pdf');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe('openKnown through a junction or the long-path spelling', () => {
  it.skipIf(!junction)('finds the existing grant, answers ITS spelling, and grants nothing new for the page\'s spelling', async () => {
    const grants = new PathGrants();
    grants.grant(a);
    const record = new ReopenRecord();
    record.restore([a]);
    expect(await openKnown(grants, record, viaJunction)).toBe(a);
    // No grant for the junction spelling: it cannot be read or written, so a save goes to the directory entry the user chose.
    expect(grants.canonical(viaJunction)).toBeNull();
    grants.noteRead(a);
    expect(grants.markOpen(a)).toBe(true);
    expect(grants.canonicalForWrite(a)).toBe(a);
    expect(grants.canonicalForWrite(viaJunction)).toBeNull();
  });

  it.skipIf(!junction)('once per file, whatever the spelling, and a refused path does not use the time up', async () => {
    const grants = new PathGrants();
    grants.grant(a);
    const record = new ReopenRecord();
    record.restore([a]);
    expect(await openKnown(grants, record, viaJunctionB)).toBeNull();
    expect(await openKnown(grants, record, viaJunction)).toBe(a);
    expect(await openKnown(grants, record, longPath(a))).toBeNull();
    expect(await openKnown(grants, record, a)).toBeNull();
  });

  it('a file granted by its plain path is found through the long-path spelling', async () => {
    const grants = new PathGrants();
    grants.grant(a);
    const record = new ReopenRecord(() => [a]);
    expect(await openKnown(grants, record, longPath(a))).toBe(a);
  });

  it('a file that was never granted is refused even when it lies in the same folder', async () => {
    const grants = new PathGrants();
    grants.grant(a);
    const record = new ReopenRecord(() => [a, b]);
    expect(await openKnown(grants, record, b)).toBeNull();
  });
});

describe('ReopenRecord.allowOnce makes no file-system call', () => {
  it('it answers at once for any path text, including one on a share that cannot be reached', () => {
    const record = new ReopenRecord(() => ['\\\\offline-nas\\share\\a.pdf']);
    record.restore(['\\\\offline-nas\\share\\b.pdf']);
    const started = performance.now();
    expect(record.allowOnce('\\\\offline-nas\\share\\a.pdf')).toBe(true);
    expect(record.allowOnce('\\\\OFFLINE-NAS\\share\\a.pdf')).toBe(false);
    expect(record.allowOnce('\\\\offline-nas\\share\\b.pdf')).toBe(true);
    expect(record.allowOnce('\\\\offline-nas\\share\\c.pdf')).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('grantChosenPaths: parallel, non-blocking, and no resolution for the Recent list', () => {
  it('five files on a slow share are resolved at the same time (all five started before the first one ends) without blocking the event loop', async () => {
    const grants = new PathGrants();
    // A fake file system with its own call order instead of a wall clock: a resolution ends only when the test lets it.
    const events: string[] = [];
    const releases: Array<() => void> = [];
    const fs: AsyncRealpath = {
      realpath: (path) =>
        new Promise((done) => {
          events.push(`start ${path}`);
          releases.push(() => {
            events.push(`end ${path}`);
            done(path);
          });
        }),
    };
    const resolve = (path: string) => canonicalSpelling(path, fs);
    const granting = grantChosenPaths(grants, Array.from({ length: 5 }, (_v, i) => `C:\\nas\\f${i}.pdf`), {}, resolve);
    // The event loop is free while the share is slow: this wait runs timers, and all five resolutions are under way together.
    await vi.waitFor(() => expect(releases).toHaveLength(5));
    expect(events.every((e) => e.startsWith('start '))).toBe(true);
    for (const release of releases) release();
    const granted = await granting;
    expect(granted).toHaveLength(5);
    expect(events.slice(0, 5).every((e) => e.startsWith('start '))).toBe(true);
  });

  it('a read-only grant (the Recent list) resolves nothing, however many entries and however often', async () => {
    const grants = new PathGrants();
    const resolve = vi.fn(async (p: string) => p);
    const paths = Array.from({ length: 10 }, (_v, i) => `C:\\recent\\${i}.pdf`);
    for (let i = 0; i < 20; i++) await grantChosenPaths(grants, paths, { readOnly: true }, resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(grants.canonicalForWrite(paths[0]!)).toBeNull();
  });

  it('a chosen path is granted chosen (openable for writing), a write pick is writable, and each is answered in the resolved spelling', async () => {
    const grants = new PathGrants();
    const resolve = async (p: string) => p.replace('alias', 'Real');
    expect(await grantChosenPaths(grants, ['C:\\alias\\a.pdf'], {}, resolve)).toEqual(['C:\\Real\\a.pdf']);
    grants.noteRead('C:\\Real\\a.pdf');
    expect(grants.markOpen('C:\\Real\\a.pdf')).toBe(true);
    expect(await grantChosenPaths(grants, ['C:\\alias\\new.pdf'], { write: true }, resolve)).toEqual(['C:\\Real\\new.pdf']);
    expect(grants.canonicalForWrite('C:\\Real\\new.pdf')).toBe('C:\\Real\\new.pdf');
  });
});
