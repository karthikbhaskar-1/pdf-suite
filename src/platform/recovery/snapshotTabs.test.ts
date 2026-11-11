import { describe, expect, it } from 'vitest';
import type { Tab } from '../../core/model/types';
import { buildSnapshot } from './snapshot';

const view = { pageId: null, zoom: 1, fit: 'width' as const, offset: 0, rotation: 0 as const };

describe('buildSnapshot keeps the tabs that should come back', () => {
  it('keeps a path tab whose file failed to open, so a deleted file stays as a tab', () => {
    const missing: Tab = {
      id: 't1',
      title: 'gone.pdf',
      origin: { kind: 'path', path: 'C:/docs/gone.pdf' },
      status: { kind: 'error', message: 'This file was moved, renamed or deleted.' },
      panes: [],
      split: null,
    };
    const snapshot = buildSnapshot([missing], 't1');
    expect(snapshot.tabs).toHaveLength(1);
    expect(snapshot.tabs[0]).toMatchObject({ title: 'gone.pdf', origin: { kind: 'path', path: 'C:/docs/gone.pdf' } });
  });

  it('keeps a path tab that is still loading', () => {
    const loading: Tab = {
      id: 't1',
      title: 'slow.pdf',
      origin: { kind: 'path', path: 'C:/docs/slow.pdf' },
      status: { kind: 'loading', progress: 0.2 },
      panes: [],
      split: null,
    };
    expect(buildSnapshot([loading], 't1').tabs).toHaveLength(1);
  });

  it('drops a byte tab that is not open, since it cannot be restored without its pane', () => {
    const notOpen: Tab = {
      id: 't1',
      title: 'bytes.pdf',
      origin: { kind: 'bytes' },
      status: { kind: 'loading', progress: 0 },
      panes: [],
      split: null,
    };
    expect(buildSnapshot([notOpen], 't1').tabs).toHaveLength(0);
  });

  it('keeps the active index pointing at the active tab among the kept tabs', () => {
    const a: Tab = {
      id: 'a',
      title: 'a.pdf',
      origin: { kind: 'path', path: 'C:/a.pdf' },
      status: { kind: 'error', message: 'x' },
      panes: [],
      split: null,
    };
    const b: Tab = {
      id: 'b',
      title: 'b.pdf',
      origin: { kind: 'path', path: 'C:/b.pdf' },
      status: { kind: 'ready' },
      panes: [{ id: 'pb', docId: 'docB', view }],
      split: null,
    };
    expect(buildSnapshot([a, b], 'b').activeIndex).toBe(1);
  });
});
