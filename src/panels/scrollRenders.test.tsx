import { Profiler } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../app/services', () => ({ fileService: {}, documentRegistry: { get: () => undefined } }));
vi.mock('../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../ui/thumbnails/useThumbnail', () => ({ useThumbnail: () => null }));
vi.mock('../ui/viewer/scrollVelocity', () => ({ useFastScrolling: () => false }));
vi.mock('../ui/topbar/CommandButton', () => ({ CommandButton: ({ label }: { label: string }) => <button type="button">{label}</button> }));
vi.mock('../ui/topbar/pageGroups', () => ({ MenuCommand: ({ children }: { children: string }) => <button type="button">{children}</button> }));
vi.mock('../ui/menus/pageMenuItems', () => ({ pagesMenuItems: () => [] }));

import { useDocumentsStore } from '../core/stores/documentsStore';
import { useWorkspaceStore } from '../core/stores/workspaceStore';
import { BookmarksPanel } from './bookmarks/BookmarksPanel';
import { PropertiesPanel } from './properties/PropertiesPanel';
import { ThumbnailsPanel } from './thumbnails/ThumbnailsPanel';

const DOC = 'doc-1';
const pages = Array.from({ length: 10 }, (_, i) => ({ id: `${DOC}:${i}`, docId: DOC, srcIndex: i, rotation: 0 as const, crop: null }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  useDocumentsStore.setState({
    docs: { [DOC]: { docId: DOC, name: 'doc.pdf', pageCount: 10, pages, sizes: pages.map(() => ({ width: 100, height: 100, rotation: 0 })), byteSize: 1 } },
  } as never);
  useWorkspaceStore.setState({
    tabs: [{ id: 'tab1', title: 'doc.pdf', origin: { kind: 'path', path: 'C:\doc.pdf' }, status: { kind: 'ready' }, panes: [{ id: 'pane1', docId: DOC, view: { pageId: `${DOC}:3`, zoom: 1, fit: 'none', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('side panels do not draw again for a scroll within a page', () => {
  for (const [name, Panel] of [['thumbnails', ThumbnailsPanel], ['properties', PropertiesPanel], ['bookmarks', BookmarksPanel]] as const) {
    it(`${name}: 100 setView calls, no commit`, () => {
      let commits = 0;
      render(
        <Profiler id={name} onRender={() => (commits += 1)}>
          <Panel />
        </Profiler>,
      );
      // Let the mount effects (outline and metadata reads) settle before counting.
      act(() => undefined);
      const before = commits;
      for (let i = 1; i <= 100; i++) act(() => useWorkspaceStore.getState().setView('pane1', { offset: i / 200 } as never));
      expect(commits).toBe(before);
    });
  }
});
