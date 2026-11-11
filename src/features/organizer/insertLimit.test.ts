// @vitest-environment node
// 1.5.5 C7: the Insert sheet and the engine read one constant, and the two messages show before anything is sent to the engine.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apply } = vi.hoisted(() => ({ apply: vi.fn() }));

vi.mock('../../app/services', () => ({ fileService: {}, documentRegistry: { get: () => undefined } }));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: class {} }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: apply,
  attachSourceLogged: vi.fn(),
  cancelOperation: vi.fn(),
  settleEdits: vi.fn(),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { useSheetStore } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { applySheet, MAX_INSERT_COUNT } from './sheetActions';

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
  useSheetStore.getState().close();
});

const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

describe('pages per insert', () => {
  it('the limit is 1,000, and the messages name it', () => {
    expect(MAX_INSERT_COUNT).toBe(1000);
  });

  it('a count of 1001 shows the message and sends nothing', async () => {
    useSheetStore.getState().open({ kind: 'insert', docId: 'd', template: 'blank', size: 'letter', custom: { width: 8, height: 11 }, unit: 'in', count: 1001, position: 'after', at: 1, pageIndex: 0 });
    expect(await applySheet(useSheetStore.getState().sheet!)).toBe(false);
    expect(toasts()).toEqual(['Enter a number of pages from 1 to 1,000.']);
    expect(apply).not.toHaveBeenCalled();
  });

  it('a range of 1,500 pages shows the second message and sends nothing', async () => {
    useSheetStore.getState().open({ kind: 'from', docId: 'd', pageIndex: 0, sourceDocId: 's', sourceName: 'big.pdf', sourcePages: 1500, range: '1-1500', position: 'after', at: 1 });
    expect(await applySheet(useSheetStore.getState().sheet!)).toBe(false);
    expect(toasts()).toEqual(['You can insert up to 1,000 pages at a time. Choose a shorter page range.']);
    expect(apply).not.toHaveBeenCalled();
  });
});
