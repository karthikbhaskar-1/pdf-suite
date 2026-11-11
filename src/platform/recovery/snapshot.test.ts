import { describe, expect, it } from 'vitest';
import type { Tab } from '../../core/model/types';
import { buildSnapshot, parseSnapshot } from './snapshot';

const view = (overrides: Partial<Tab['panes'][number]['view']> = {}) => ({
  pageId: 'docA000000000000:3',
  zoom: 1.5,
  fit: 'none' as const,
  offset: 0.25,
  rotation: 90 as const,
  ...overrides,
});

function splitTab(): Tab {
  return {
    id: 'tab-1',
    title: 'report.pdf',
    origin: { kind: 'path', path: 'C:/docs/report.pdf' },
    status: { kind: 'ready' },
    panes: [
      { id: 'pane-1', docId: 'docA000000000000000', view: view() },
      { id: 'pane-2', docId: 'docB000000000000000', view: view({ pageId: 'docB000000000000:7', zoom: 0.75, rotation: 270, fit: 'width', offset: 0.5 }) },
    ],
    split: { orientation: 'horizontal', ratio: 0.35, syncScroll: false },
  };
}

const otherTab: Tab = {
  id: 'tab-2',
  title: 'notes.pdf',
  origin: { kind: 'path', path: 'C:/docs/notes.pdf' },
  status: { kind: 'ready' },
  panes: [{ id: 'pane-3', docId: 'docB000000000000000', view: view({ rotation: 0 }) }],
  split: null,
};

describe('snapshot round trip', () => {
  it('keeps the split layout, each pane view and the sync flag through JSON', () => {
    const tabs = [splitTab(), otherTab];
    const built = buildSnapshot(tabs, 'tab-1');
    const restored = parseSnapshot(JSON.parse(JSON.stringify(built)));

    expect(restored).toEqual(built);
    const split = restored?.tabs[0]?.split;
    expect(split).toBeDefined();
    expect(split?.orientation).toBe('horizontal');
    expect(split?.ratio).toBe(0.35);
    expect(split?.syncScroll).toBe(false);
    expect(split?.second.view).toEqual(view({ pageId: 'docB000000000000:7', zoom: 0.75, rotation: 270, fit: 'width', offset: 0.5 }));
    expect(restored?.tabs[0]?.view.rotation).toBe(90);
    expect(restored?.activeIndex).toBe(0);
  });

  it('takes the second pane file from the tab that shows it', () => {
    const snapshot = buildSnapshot([splitTab(), otherTab], 'tab-1');
    expect(snapshot.tabs[0]?.split?.second.origin).toEqual({ kind: 'path', path: 'C:/docs/notes.pdf' });
    expect(snapshot.tabs[0]?.split?.second.title).toBe('notes.pdf');
  });

  it('leaves the split out when no ready tab shows the second file', () => {
    const lonely = { ...otherTab, id: 'tab-3', panes: [{ id: 'pane-4', docId: 'docC000000000000000', view: view() }] };
    const snapshot = buildSnapshot([splitTab(), lonely].filter((t) => t.id !== 'tab-2'), 'tab-1');
    expect(snapshot.tabs[0]?.split).toBeUndefined();
    expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))?.tabs[0]?.split).toBeUndefined();
  });

  it('drops a damaged split but keeps the tab', () => {
    const parsed = parseSnapshot({
      version: 1,
      activeIndex: 0,
      tabs: [
        {
          title: 'a.pdf',
          origin: { kind: 'path', path: 'C:/a.pdf' },
          view: { pageId: null, zoom: 1, fit: 'width', offset: 0, rotation: 45 },
          split: { orientation: 'diagonal', ratio: 0.5 },
        },
      ],
    });
    expect(parsed?.tabs).toHaveLength(1);
    expect(parsed?.tabs[0]?.split).toBeUndefined();
    expect(parsed?.tabs[0]?.view.rotation).toBe(0);
  });
});
