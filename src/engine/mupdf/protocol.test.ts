// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  JobQueue,
  rotationKind,
  type EditBody,
  type PageEdit,
  Priority,
  VersionCounter,
  WorkerFault,
  checkBaseVersion,
  nextRequestId,
  type Request,
  parsePageRef,
} from './protocol';

describe('request ids', () => {
  it('are unique and increasing', () => {
    const ids = Array.from({ length: 1000 }, () => nextRequestId());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
  });
});

describe('JobQueue', () => {
  const job = (id: number, pri: number): Request =>
    ({ id, pri, op: 'outline' }) as unknown as Request;

  it('takes the most urgent job first, and first in first out within a priority', () => {
    const queue = new JobQueue<Request>();
    queue.push(job(1, Priority.Background));
    queue.push(job(2, Priority.Visible));
    queue.push(job(3, Priority.Visible));
    queue.push(job(4, Priority.Prefetch));
    expect([queue.take()?.id, queue.take()?.id, queue.take()?.id, queue.take()?.id]).toEqual([2, 3, 4, 1]);
    expect(queue.take()).toBeUndefined();
  });

  it('cancel removes a queued job so it never runs', () => {
    const queue = new JobQueue<Request>();
    queue.push(job(1, Priority.Visible));
    queue.push(job(2, Priority.Visible));
    expect(queue.cancel(1)?.id).toBe(1);
    expect(queue.size).toBe(1);
    expect(queue.take()?.id).toBe(2);
  });

  it('cancel returns nothing for a job that is not queued', () => {
    const queue = new JobQueue<Request>();
    queue.push(job(5, Priority.Visible));
    expect(queue.cancel(99)).toBeUndefined();
    expect(queue.size).toBe(1);
  });

  it('removeWhere drops every match and keeps the rest in order', () => {
    const queue = new JobQueue<Request>();
    queue.push(job(1, Priority.Background));
    queue.push(job(2, Priority.Visible));
    queue.push(job(3, Priority.Background));
    const removed = queue.removeWhere((j) => j.pri === Priority.Background);
    expect(removed.map((j) => j.id)).toEqual([1, 3]);
    expect(queue.take()?.id).toBe(2);
  });
});

describe('document version', () => {
  it('bumps by one for each edit', () => {
    const version = new VersionCounter();
    expect(version.current).toBe(0);
    expect(version.bump()).toBe(1);
    expect(version.bump()).toBe(2);
    expect(version.current).toBe(2);
  });

  it('accepts an edit with no base version, or one that matches the current version', () => {
    expect(() => checkBaseVersion(3, undefined)).not.toThrow();
    expect(() => checkBaseVersion(3, 3)).not.toThrow();
  });

  it('reports a stale base version as Conflict', () => {
    let thrown: unknown;
    try {
      checkBaseVersion(4, 3);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkerFault);
    expect((thrown as WorkerFault).kind).toBe('Conflict');
  });
});

describe('page edits (1.2.1 union)', () => {
  const uid = (i: number) => String(i);
  const all: PageEdit[] = [
    { op: 'insertBlank', afterUid: uid(0), size: { width: 612, height: 792 }, template: 'lined' },
    { op: 'insertFrom', afterUid: null, sourceDocId: 'doc-b', sourceUids: [uid(2), uid(3)] },
    { op: 'delete', uids: [uid(1)] },
    { op: 'move', uids: [uid(4)], beforeUid: null },
    { op: 'duplicate', uids: [uid(0), uid(1)] },
    { op: 'rotate', uids: [uid(0)], degrees: 90 },
    { op: 'crop', uids: [uid(0)], box: { x: 10, y: 10, width: 300, height: 400 } },
    { op: 'resize', uids: [uid(0)], size: { width: 595, height: 842 }, fit: 'scale' },
    { op: 'replace', uid: uid(0), sourceDocId: 'doc-b', sourceUid: uid(5) },
    { op: 'reverse', uids: [uid(0), uid(1)] },
    { op: 'slice', uids: [uid(0)], cut: 'vertical', at: 0.5, first: 'left' },
    { op: 'overlay', uids: [uid(0)], sourceDocId: 'doc-b', sourceUids: [uid(1)], dx: 0, dy: 0, scale: 1, mode: 'multiply', opacity: 0.5 },
  ];

  /** Names every variant. The `never` check makes this fail to type-check if a variant is added and not handled. */
  function describeEdit(edit: PageEdit): string {
    switch (edit.op) {
      case 'insertBlank':
        return `insert ${edit.template} after ${edit.afterUid ?? 'start'}`;
      case 'insertFrom':
        return `insert ${edit.sourceUids.length} from ${edit.sourceDocId}`;
      case 'delete':
        return `delete ${edit.uids.length}`;
      case 'move':
        return `move ${edit.uids.length} before ${edit.beforeUid ?? 'end'}`;
      case 'duplicate':
        return `duplicate ${edit.uids.length}`;
      case 'rotate':
        return `rotate ${edit.uids.length} by ${edit.degrees}`;
      case 'crop':
        return `crop ${edit.uids.length}`;
      case 'resize':
        return `resize ${edit.uids.length} ${edit.fit}`;
      case 'replace':
        return `replace ${edit.uid} from ${edit.sourceUid}`;
      case 'reverse':
        return `reverse ${edit.uids.length}`;
      case 'slice':
        return `slice ${edit.uids.length} ${edit.cut}`;
      case 'overlay':
        return `overlay ${edit.uids.length} from ${edit.sourceDocId} ${edit.mode}`;
      default: {
        const unreachable: never = edit;
        return String(unreachable);
      }
    }
  }

  it('has one variant for each of the ten 1.2.1 page operations, the 1.3.1 slice and the 1.3.4 overlay, and each one is handled', () => {
    expect(new Set(all.map((edit) => edit.op))).toEqual(
      new Set(['insertBlank', 'insertFrom', 'delete', 'move', 'duplicate', 'rotate', 'crop', 'resize', 'replace', 'reverse', 'slice', 'overlay']),
    );
    expect(all.map(describeEdit)).toHaveLength(12);
  });

  it('an apply carries a base version, so the type requires one', () => {
    const apply: EditBody = { op: 'apply', baseVersion: 3, edits: all };
    expect(apply.op).toBe('apply');
    // @ts-expect-error an apply without a base version does not type-check
    const missing: EditBody = { op: 'apply', edits: all };
    expect(missing).toBeDefined();
  });

  it('rotates by a multiple of 90 natively, and by any other angle as custom', () => {
    expect([0, 90, 180, 270, -90].map(rotationKind)).toEqual(['native', 'native', 'native', 'native', 'native']);
    expect([45, 12.5, 91].map(rotationKind)).toEqual(['custom', 'custom', 'custom']);
  });
});

describe('page refs', () => {
  it('splits uid@rev, and reads a uid that has no rev as no ref', () => {
    expect(parsePageRef('n12@7')).toEqual({ uid: 'n12', rev: 7 });
    expect(parsePageRef('0@0')).toEqual({ uid: '0', rev: 0 });
    expect(parsePageRef('0')).toBeNull();
    expect(parsePageRef('@3')).toBeNull();
    expect(parsePageRef('4@-1')).toBeNull();
  });
});
