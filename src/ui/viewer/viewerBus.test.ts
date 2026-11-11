import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushViewerRequest, registerViewer, remapPageId, requestViewer, resetViewerBus } from './viewerBus';

beforeEach(() => resetViewerBus());

describe('viewer bus', () => {
  it('delivers a request straight to a ready viewer', () => {
    const seen: unknown[] = [];
    registerViewer('p1', (r) => (seen.push(r), true));
    expect(requestViewer('p1', { kind: 'goto', index: 99 })).toBe(true);
    expect(seen).toEqual([{ kind: 'goto', index: 99 }]);
  });

  it('keeps a request sent while no viewer is mounted and delivers it on mount', () => {
    expect(requestViewer('p1', { kind: 'goto', index: 99 })).toBe(false);
    const seen: unknown[] = [];
    registerViewer('p1', (r) => (seen.push(r), true));
    expect(seen).toEqual([{ kind: 'goto', index: 99 }]);
  });

  it('keeps only the latest queued request per pane', () => {
    requestViewer('p1', { kind: 'scrollScreen', direction: 1 });
    requestViewer('p1', { kind: 'goto', index: 4 });
    requestViewer('p1', { kind: 'goto', index: 99 });
    const seen: unknown[] = [];
    registerViewer('p1', (r) => (seen.push(r), true));
    expect(seen).toEqual([{ kind: 'goto', index: 99 }]);
  });

  it('keeps queues separate per pane', () => {
    requestViewer('p1', { kind: 'goto', index: 1 });
    requestViewer('p2', { kind: 'goto', index: 2 });
    const seenBy: Record<string, unknown[]> = { p1: [], p2: [] };
    registerViewer('p1', (r) => (seenBy.p1?.push(r), true));
    registerViewer('p2', (r) => (seenBy.p2?.push(r), true));
    expect(seenBy).toEqual({ p1: [{ kind: 'goto', index: 1 }], p2: [{ kind: 'goto', index: 2 }] });
  });

  it('holds a request while the viewer is not ready, and delivers it when it becomes ready', () => {
    let ready = false;
    const handler = vi.fn(() => ready);
    registerViewer('p1', handler);
    requestViewer('p1', { kind: 'goto', index: 99 });
    expect(handler).toHaveBeenCalledTimes(1);

    ready = true;
    flushViewerRequest('p1');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith({ kind: 'goto', index: 99 });

    flushViewerRequest('p1');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('drops an older queued request when a newer one is delivered directly', () => {
    requestViewer('p1', { kind: 'goto', index: 4 });
    const seen: unknown[] = [];
    registerViewer('p1', (r) => (seen.push(r), true));
    requestViewer('p1', { kind: 'goto', index: 7 });
    expect(seen).toEqual([{ kind: 'goto', index: 4 }, { kind: 'goto', index: 7 }]);
    const later: unknown[] = [];
    registerViewer('p1', (r) => (later.push(r), true));
    expect(later).toEqual([]);
  });
});

describe('a page remap after a document is replaced', () => {
  const from = ['d:0', 'd:n1', 'd:1', 'd:2', 'd:3'];
  const to = ['d:0', 'd:1', 'd:2', 'd:3', 'd:4'];

  it('moves a page id to the id at the same position, so page 3 stays page 3', () => {
    expect(remapPageId('d:1', from, to)).toBe('d:2');
    expect(remapPageId('d:n1', from, to)).toBe('d:1');
  });

  it('clamps to the last page when the new list is shorter, and leaves an unknown id alone', () => {
    expect(remapPageId('d:3', from, ['d:0', 'd:1'])).toBe('d:1');
    expect(remapPageId('other:1', from, to)).toBeUndefined();
    expect(remapPageId(null, from, to)).toBeUndefined();
  });

  it('is never queued: a viewer that mounts later reads its page from the store instead', () => {
    expect(requestViewer('p1', { kind: 'remapPages', from, to })).toBe(false);
    const seen: unknown[] = [];
    registerViewer('p1', (r) => (seen.push(r), true));
    expect(seen).toEqual([]);
  });
});
