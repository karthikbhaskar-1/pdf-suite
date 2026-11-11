import { beforeEach, describe, expect, it } from 'vitest';
import { createPageList, pageIdFor } from '../model/pageList';
import type { Tab, ViewState } from '../model/types';
import { useWorkspaceStore } from './workspaceStore';
import { nextRotation } from '../../features/viewer/rotation';

const DOC = 'docR000000000000000000';

const view = (): ViewState => ({ pageId: pageIdFor(DOC, 0), zoom: 1, fit: 'none', offset: 0, rotation: 0 });

function splitTab(): Tab {
  return {
    id: 'tab-r',
    title: 'r.pdf',
    origin: { kind: 'bytes' },
    status: { kind: 'ready' },
    panes: [
      { id: 'pane-a', docId: DOC, view: view() },
      { id: 'pane-b', docId: DOC, view: view() },
    ],
    split: { orientation: 'vertical', ratio: 0.5, syncScroll: true },
  };
}

describe('view-only rotation', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [splitTab()], activeTabId: 'tab-r', activePaneId: 'pane-a' });
  });

  it('turns one pane without touching the page list or the other pane', () => {
    const pagesBefore = createPageList(DOC, 3);
    const snapshotBefore = JSON.stringify(pagesBefore);

    // What the Rotate view command does: turn the active pane once.
    const pane = useWorkspaceStore.getState().tabs[0]!.panes[0]!;
    useWorkspaceStore.getState().setView(pane.id, { rotation: nextRotation(pane.view.rotation) });

    const [a, b] = useWorkspaceStore.getState().tabs[0]!.panes;
    expect(a!.view.rotation).toBe(90);
    expect(b!.view.rotation).toBe(0);
    // The document's pages keep their own rotation, which is only set by document edits.
    expect(JSON.stringify(createPageList(DOC, 3))).toBe(snapshotBefore);
    expect(pagesBefore.every((p) => p.rotation === 0)).toBe(true);
  });

  it('turns clockwise through all four positions and back to 0', () => {
    let rotation = 0 as ReturnType<typeof nextRotation>;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      rotation = nextRotation(rotation);
      seen.push(rotation);
      useWorkspaceStore.getState().setView('pane-a', { rotation });
    }
    expect(seen).toEqual([90, 180, 270, 0]);
    expect(useWorkspaceStore.getState().tabs[0]!.panes[0]!.view.rotation).toBe(0);
  });
});
