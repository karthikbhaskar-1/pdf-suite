import { describe, expect, it } from 'vitest';
import { PathGrants, restorePersistedGrants } from './pathGrants';

const A = 'C:\\docs\\a.pdf';
const B = 'C:\\docs\\b.pdf';

/**
 * What main does when the renderer opens a file the user chose (Open dialog, command line, drop): the path is granted as
 * chosen, then read, then the open is reported.
 */
function openInTab(grants: PathGrants, path: string): boolean {
  grants.grantChosen(path);
  grants.noteRead(path); // files:read succeeded
  return grants.markOpen(path); // files:documentOpened
}

/** A Recent or session-restore open, run by the main process itself (allowOpen) on a path that is only read-granted. */
function openKnownInTab(grants: PathGrants, path: string): boolean {
  grants.allowOpen(path);
  grants.noteRead(path);
  return grants.markOpen(path);
}

describe('write rights follow open documents (ticket 1.2.1 review, item 7, owner ruling)', () => {
  it('a tab restored from the last session saves in place', () => {
    const saved = JSON.parse(JSON.stringify([A])) as unknown;
    const grants = new PathGrants();
    restorePersistedGrants(grants, saved);
    expect(grants.canonicalForWrite(A)).toBeNull(); // restored grants alone are read-only
    expect(openKnownInTab(grants, A)).toBe(true); // the restore opens the tab: allowed by main, read, then reported open
    expect(grants.canonicalForWrite(A)).toBe(A);
  });

  it('a file opened from the Recent list saves in place', () => {
    const grants = new PathGrants();
    grants.grant(A); // recent:list grants read only
    expect(grants.canonicalForWrite(A)).toBeNull();
    expect(openKnownInTab(grants, A)).toBe(true);
    expect(grants.canonicalForWrite('c:\\DOCS\\sub\\..\\a.pdf')).toBe(A);
  });

  it('a persisted path that is not open is refused for writing, and so is a path never read', () => {
    const grants = new PathGrants();
    restorePersistedGrants(grants, [A, B]);
    expect(grants.canonicalForWrite(A)).toBeNull();
    expect(grants.canonicalForWrite(B)).toBeNull();
    // The page cannot open-grant a path it did not read through main.
    expect(grants.markOpen(B)).toBe(false);
    expect(grants.canonicalForWrite(B)).toBeNull();
    // An ungranted path cannot be opened or written at all.
    grants.noteRead('C:\\other\\x.pdf');
    expect(grants.markOpen('C:\\other\\x.pdf')).toBe(false);
  });

  it('after the tab closes, writing to that path is refused', () => {
    const grants = new PathGrants();
    openInTab(grants, A);
    expect(grants.canonicalForWrite(A)).toBe(A);
    grants.markClosed(A);
    expect(grants.canonicalForWrite(A)).toBeNull();
    // Reporting it open again without a new read is not accepted.
    expect(grants.markOpen(A)).toBe(false);
    expect(grants.canonicalForWrite(A)).toBeNull();
  });

  it('a Save dialog path is writable, becomes the open document on Save As, and is revoked on close', () => {
    const grants = new PathGrants();
    openInTab(grants, A);
    expect(grants.grantWrite(B)).toBe(true); // Save As picks B
    expect(grants.canonicalForWrite(B)).toBe(B);
    grants.markClosed(A); // the document is re-keyed from A to B
    expect(grants.markOpen(B)).toBe(true);
    expect(grants.canonicalForWrite(A)).toBeNull();
    expect(grants.canonicalForWrite(B)).toBe(B);
    grants.markClosed(B);
    expect(grants.canonicalForWrite(B)).toBeNull();
  });

  it('a repeated open report (a save reopens the document) keeps the right, and one write grant never covers another file', () => {
    const grants = new PathGrants();
    openInTab(grants, A);
    expect(grants.markOpen(A)).toBe(true);
    expect(grants.canonicalForWrite(A)).toBe(A);
    expect(grants.canonicalForWrite(B)).toBeNull();
    expect(grants.canonicalForWrite('C:\\docs\\..\\Windows\\a.pdf')).toBeNull();
  });

  it('the grant limit still applies: an evicted path loses every right', () => {
    const grants = new PathGrants(1);
    openInTab(grants, A);
    grants.grant(B);
    // A is open in a tab, so it is not the one dropped (see the next tests); an unused grant is.
    expect(grants.canonical(A)).toBe(A);
    grants.markClosed(A);
    grants.grant('C:\\docs\\c.pdf');
    expect(grants.canonical(A)).toBeNull();
    expect(grants.canonicalForWrite(A)).toBeNull();
  });

  it('write rights are not in the saved list', () => {
    const grants = new PathGrants();
    openInTab(grants, A);
    grants.grantWrite(B);
    const restored = new PathGrants();
    restorePersistedGrants(restored, JSON.parse(JSON.stringify(grants.list())) as unknown);
    expect(restored.canonical(A)).toBe(A);
    expect(restored.canonicalForWrite(A)).toBeNull();
    expect(restored.canonicalForWrite(B)).toBeNull();
  });
});

describe('an open is accepted only for a path the user handed over this session (1.5.1 M6, register F1)', () => {
  it('a saved grant that is read, then reported open, is refused and stays read-only', () => {
    const grants = new PathGrants();
    restorePersistedGrants(grants, [A]);
    grants.noteRead(A); // a compromised page asks the main process to read it
    expect(grants.markOpen(A)).toBe(false);
    expect(grants.canonicalForWrite(A)).toBeNull();
  });

  it('a Recent-list grant that is read, then reported open, is refused and stays read-only', () => {
    const grants = new PathGrants();
    grants.grant(A); // recent:list
    grants.noteRead(A);
    expect(grants.markOpen(A)).toBe(false);
    expect(grants.canonicalForWrite(A)).toBeNull();
  });

  it('an Open dialog, command-line or drop path is accepted, and the same path read again after it closed is not', () => {
    const grants = new PathGrants();
    expect(openInTab(grants, A)).toBe(true);
    grants.markClosed(A);
    grants.noteRead(A);
    expect(grants.markOpen(A)).toBe(false);
  });

  it('a Recent or restore open the main process runs itself (allowOpen) is accepted; allowOpen on a path never granted is not', () => {
    const grants = new PathGrants();
    expect(grants.allowOpen(A)).toBe(false);
    grants.grant(A);
    expect(openKnownInTab(grants, A)).toBe(true);
  });
});

describe('the grant limit never takes the write right of an open document (1.5.1 M7, register F2)', () => {
  it('the 501st grant does not remove an open path, and the unused oldest one goes instead', () => {
    const grants = new PathGrants(500);
    expect(openInTab(grants, A)).toBe(true); // the oldest grant, and open
    for (let i = 0; i < 499; i++) grants.grant(`C:\\many\\${i}.pdf`);
    expect(grants.size).toBe(500);
    grants.grant('C:\\many\\the-501st.pdf');
    expect(grants.size).toBe(500);
    expect(grants.canonicalForWrite(A)).toBe(A);
    expect(grants.canonical('C:\\many\\0.pdf')).toBeNull();
  });

  it('a Save dialog pick keeps its right too, and the one path not in use is the one dropped', () => {
    const grants = new PathGrants(2);
    openInTab(grants, A);
    grants.grantWrite(B);
    grants.grant('C:\\docs\\c.pdf');
    grants.grant('C:\\docs\\d.pdf');
    expect(grants.canonicalForWrite(A)).toBe(A);
    expect(grants.canonicalForWrite(B)).toBe(B);
    // The oldest path not in use goes; the newest grant stays.
    expect(grants.canonical('C:\\docs\\c.pdf')).toBeNull();
    expect(grants.canonical('C:\\docs\\d.pdf')).not.toBeNull();
  });

  it('when every path is in use the list passes the limit rather than evict one', () => {
    const grants = new PathGrants(1);
    openInTab(grants, A);
    openInTab(grants, B);
    expect(grants.size).toBe(2);
    expect(grants.canonicalForWrite(A)).toBe(A);
    expect(grants.canonicalForWrite(B)).toBe(B);
  });
});

describe('one path length limit (1.5.1 M7, register F3)', () => {
  it('pathGrants uses the contract constant', async () => {
    const contract = await import('../../src/platform/desktop/contract');
    expect(contract.MAX_PATH_LENGTH).toBe(4096);
    const grants = new PathGrants();
    expect(grants.grant(`C:\\${'x'.repeat(contract.MAX_PATH_LENGTH - 3)}`)).toBe(true);
    expect(grants.grant(`C:\\${'x'.repeat(contract.MAX_PATH_LENGTH - 2)}`)).toBe(false);
  });
});
