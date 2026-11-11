import { beforeEach, describe, expect, it } from 'vitest';
import type { Tab } from '../model/types';
import { useWorkspaceStore } from './workspaceStore';

const loadingTab = (id: string): Tab => ({
  id,
  title: `${id}.pdf`,
  origin: { kind: 'bytes' },
  status: { kind: 'loading', progress: 0 },
  panes: [],
  split: null,
});

const pane = (id: string) => ({
  id,
  docId: 'doc',
  view: { pageId: null, zoom: 1, fit: 'width' as const, offset: 0, rotation: 0 as const },
});

describe('workspace store: active pane of a newly opened tab', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null });
  });

  it('makes the first pane active once the tab gets its pane, without a tab click', () => {
    const store = useWorkspaceStore.getState();
    store.addTab(loadingTab('t1'));
    expect(useWorkspaceStore.getState().activePaneId).toBeNull();

    store.patchTab('t1', { status: { kind: 'ready' }, panes: [pane('p1')], split: null });

    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe('t1');
    expect(state.activePaneId).toBe('p1');
  });

  it('keeps the focused pane when a patch touches a tab that does not have focus', () => {
    const store = useWorkspaceStore.getState();
    store.addTab(loadingTab('t1'));
    store.patchTab('t1', { status: { kind: 'ready' }, panes: [pane('p1')] });
    store.addTab(loadingTab('t2'));
    store.patchTab('t2', { status: { kind: 'ready' }, panes: [pane('p2')] });
    store.patchTab('t1', { title: 'renamed.pdf' });
    expect(useWorkspaceStore.getState().activePaneId).toBe('p2');
  });
});
