// @vitest-environment jsdom
// The Crop sheet's four margin boxes: each letter sits beside its own box, so all four boxes land in the two wide grid
// columns and are the same width. (Before, the four boxes came first and the letters after, so Top and Left fell in the
// 18 px letter columns and could not be read.)
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../features/organizer/actions', () => ({ attachPickedSource: vi.fn(), orderOf: () => ['0', '1'] }));
vi.mock('../../features/organizer/sheetActions', () => ({ applySheet: vi.fn(), autoCropFromSheet: vi.fn(), cancelSheet: vi.fn(), useApplyStore: (select: (s: unknown) => unknown) => select({ applying: false, closeRequested: false }) }));
vi.mock('../thumbnails/useThumbnail', () => ({ useThumbnail: () => null }));
vi.mock('../../panels/thumbnails/ThumbnailsPanel', () => ({ THUMB_WIDTH_PX: 120 }));

import { useSheetStore } from '../../core/stores/sheetStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { SideSheet } from './SideSheet';

describe('Crop sheet margin boxes', () => {
  it('puts a letter before each of the four boxes, in the order T, B, L, R', () => {
    useWorkspaceStore.setState({
      tabs: [{ id: 't1', title: 'a.pdf', origin: { kind: 'path', path: 'a.pdf' }, status: { kind: 'ready' }, panes: [{ id: 'p1', docId: 'doc', view: { pageId: 'doc:0', zoom: 1, fit: 'width', offset: 0, rotation: 0 } }], split: null }],
      activeTabId: 't1',
      activePaneId: 'p1',
    } as never);
    useSheetStore.getState().open({
      kind: 'crop',
      docId: 'doc',
      uids: ['0'],
      pageId: 'doc:0',
      scope: 'current',
      unit: 'in',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoApplied: false,
    } as never);
    const { container } = render(<SideSheet />);
    const grid = container.querySelector('.side-margins')!;
    const cells = Array.from(grid.children).map((el) => (el.tagName === 'INPUT' ? `input:${el.getAttribute('aria-label')}` : `label:${el.textContent}`));
    expect(cells).toEqual([
      'label:T',
      'input:Top margin',
      'label:B',
      'input:Bottom margin',
      'label:L',
      'input:Left margin',
      'label:R',
      'input:Right margin',
    ]);
  });
});
