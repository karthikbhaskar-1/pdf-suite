import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({
  documentRegistry: { retain: vi.fn(), release: vi.fn(), refCount: vi.fn(() => 1), get: vi.fn() },
}));

import type { Tab } from '../../core/model/types';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { openInSplit } from './splitActions';

const view = { pageId: null, zoom: 1, fit: 'width' as const, offset: 0, rotation: 0 as const };

function readyTab(id: string, paneId: string): Tab {
  return {
    id,
    title: `${id}.pdf`,
    origin: { kind: 'path', path: `C:/docs/${id}.pdf` },
    status: { kind: 'ready' },
    panes: [{ id: paneId, docId: `doc-${id}`, view }],
    split: null,
  };
}

beforeEach(() => {
  useWorkspaceStore.setState({
    tabs: [readyTab('a', 'pa'), readyTab('b', 'pb')],
    activeTabId: 'a',
    activePaneId: 'pa',
  });
});

describe('Open in split on a background tab', () => {
  it('activates that tab and focuses its new pane, so the status bar and viewer agree', () => {
    openInSplit('b');

    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe('b');
    const tabB = state.tabs.find((t) => t.id === 'b');
    expect(tabB?.panes).toHaveLength(2);
    expect(state.activePaneId).toBe(tabB?.panes[1]?.id);
  });

  it('leaves the first tab alone', () => {
    openInSplit('b');
    const tabA = useWorkspaceStore.getState().tabs.find((t) => t.id === 'a');
    expect(tabA?.panes).toHaveLength(1);
    expect(tabA?.split).toBeNull();
  });
});
