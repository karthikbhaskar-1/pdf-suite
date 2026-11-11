import { describe, expect, it } from 'vitest';
import { PathGrants } from './pathGrants';
import { ReopenRecord } from './reopenRecord';

const A = 'C:\\docs\\a.pdf';
const B = 'C:\\docs\\b.pdf';

/** What main does for files:documentOpened. */
function open(grants: PathGrants, record: ReopenRecord, path: string): boolean {
  grants.grantChosen(path);
  grants.noteRead(path);
  const ok = grants.markOpen(path);
  if (ok) record.noteOpen(path);
  return ok;
}

/** What main does for files:documentClosed. */
function close(grants: PathGrants, record: ReopenRecord, path: string): void {
  grants.markClosed(path);
  record.noteClosed(path);
}

/** What main does for files:openKnown. */
function openKnown(grants: PathGrants, record: ReopenRecord, path: string): boolean {
  return record.allowOnce(path) && grants.allowOpen(path);
}

/** The next run: the saved lists are loaded (grants read-only, the record from the main process's own file). */
function nextSession(grants: PathGrants, record: ReopenRecord, recent: string[] = []): { grants: PathGrants; record: ReopenRecord } {
  const saved = JSON.parse(JSON.stringify(record.list())) as unknown;
  const g = new PathGrants();
  for (const path of grants.list()) g.grant(path);
  const r = new ReopenRecord(() => recent);
  r.restore(saved);
  return { grants: g, record: r };
}

describe('ReopenRecord: only the last session\'s tabs and the Recent list, each once (ruling 8, 1.5.1 review)', () => {
  it('a path opened and closed in an earlier session is refused', () => {
    const grants = new PathGrants();
    const record = new ReopenRecord();
    open(grants, record, A);
    open(grants, record, B);
    close(grants, record, A); // closed before the session ended
    const next = nextSession(grants, record);
    expect(openKnown(next.grants, next.record, A)).toBe(false);
    next.grants.noteRead(A);
    expect(next.grants.markOpen(A)).toBe(false);
    expect(next.grants.canonicalForWrite(A)).toBeNull();
    // B was open when the session ended, so it is allowed (below).
    expect(openKnown(next.grants, next.record, B)).toBe(true);
  });

  it('a restored tab is accepted once, in any spelling, and then writable; a second use is refused', () => {
    const grants = new PathGrants();
    const record = new ReopenRecord();
    open(grants, record, A);
    const next = nextSession(grants, record);
    expect(openKnown(next.grants, next.record, 'c:/DOCS/a.pdf')).toBe(true);
    next.grants.noteRead(A);
    expect(next.grants.markOpen(A)).toBe(true);
    expect(next.grants.canonicalForWrite(A)).toBe(A);
    expect(openKnown(next.grants, next.record, A)).toBe(false);
  });

  it('a Recent entry is accepted once; a path not in the Recent list is refused', () => {
    const grants = new PathGrants();
    grants.grant(A);
    grants.grant(B);
    const record = new ReopenRecord(() => [A]);
    expect(openKnown(grants, record, B)).toBe(false);
    expect(openKnown(grants, record, A)).toBe(true);
    expect(openKnown(grants, record, A)).toBe(false);
  });

  it('only the first 10 Recent entries count', () => {
    const paths = Array.from({ length: 12 }, (_v, i) => `C:\\docs\\r${i}.pdf`);
    const grants = new PathGrants();
    for (const path of paths) grants.grant(path);
    const record = new ReopenRecord(() => paths);
    expect(openKnown(grants, record, paths[9]!)).toBe(true);
    expect(openKnown(grants, record, paths[10]!)).toBe(false);
  });

  it('the saved list is what is open now, so it follows closes; once quitting begins, the closes of quit do not empty it', () => {
    const grants = new PathGrants();
    const record = new ReopenRecord();
    open(grants, record, A);
    open(grants, record, B);
    close(grants, record, A);
    expect(record.list()).toEqual([B]);
    open(grants, record, A);
    record.freeze();
    close(grants, record, A);
    close(grants, record, B);
    expect([...record.list()].sort()).toEqual([A, B]);
  });

  it('only main writes it: a restored list takes paths only, and nothing from the page can add to it', () => {
    const record = new ReopenRecord();
    expect(record.restore([A, 42, 'relative.pdf', null, B])).toBe(2);
    expect(record.restore('not a list')).toBe(0);
    expect(record.list()).toEqual([]); // loading the last session's tabs does not make them "open now"
    const grants = new PathGrants();
    grants.grant(A);
    expect(openKnown(grants, record, A)).toBe(true);
  });

  it('a path that was granted (saved or Recent) but never opened and not in either source is refused', () => {
    const grants = new PathGrants();
    grants.grant(B);
    const record = new ReopenRecord(() => []);
    expect(openKnown(grants, record, B)).toBe(false);
    grants.noteRead(B);
    expect(grants.markOpen(B)).toBe(false);
  });
});

describe('PathGrants: recent:add only for a path that is open now, and an open path keeps its spelling', () => {
  it('isOpen is true only between markOpen and markClosed', () => {
    const grants = new PathGrants();
    const record = new ReopenRecord();
    expect(grants.isOpen(A)).toBe(false);
    open(grants, record, A);
    expect(grants.isOpen('c:\\DOCS\\a.pdf')).toBe(true);
    grants.markClosed(A);
    expect(grants.isOpen(A)).toBe(false);
  });

  it('granting an open path again under another spelling does not change the stored spelling', () => {
    const grants = new PathGrants();
    const record = new ReopenRecord();
    open(grants, record, A);
    grants.grant('C:/DOCS/A.PDF');
    expect(grants.canonical(A)).toBe(A);
    expect(grants.canonicalForWrite('c:\\docs\\a.pdf')).toBe(A);
    grants.grant(B);
    grants.grant('C:/DOCS/B.PDF');
    expect(grants.canonical(B)).toBe('C:\\DOCS\\B.PDF');
  });
});
