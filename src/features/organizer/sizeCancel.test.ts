// @vitest-environment node
// Orchestrator ruling (1.2.2, item 6): when a running Page size resize is cancelled, the side sheet stays open with the
// user's values, so they can adjust them and try again. 1.5.5 C5 supersedes the "says nothing" part: a cancel now says
// "Cancelled. The document was not changed."
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apply, cancelOp } = vi.hoisted(() => ({ apply: vi.fn(), cancelOp: vi.fn() }));

vi.mock('../../app/services', () => ({ fileService: {}, documentRegistry: { get: () => undefined } }));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: class {} }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: apply,
  attachSourceLogged: vi.fn(),
  cancelOperation: cancelOp,
  settleEdits: vi.fn(async () => undefined),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { useSheetStore, type SizeDraft } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { applySheet, cancelSheet, useApplyStore } from './sheetActions';

const draft: SizeDraft = {
  kind: 'size',
  docId: 'doc',
  uids: ['0', '1'],
  size: 'custom',
  custom: { width: 7.25, height: 10.5 },
  unit: 'in',
  fit: 'center',
  scope: 'selected',
};

const abort = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
  useSheetStore.getState().close();
  useSheetStore.getState().open({ ...draft });
});

describe('Page size sheet: a cancelled resize', () => {
  it('leaves the sheet open with the values the user typed, and says it was cancelled', async () => {
    apply.mockRejectedValueOnce(abort());
    const closed = await applySheet(useSheetStore.getState().sheet!);
    expect(closed).toBe(false);
    expect(useSheetStore.getState().sheet).toEqual(draft);
    // 1.5.5 C5: a cancelled page change says so (the 1.2.2 ruling "a cancel says nothing" is reversed).
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['Cancelled. The document was not changed.']);
  });

  it('lets the user change a value and apply again', async () => {
    apply.mockRejectedValueOnce(abort());
    await applySheet(useSheetStore.getState().sheet!);
    useSheetStore.getState().update({ custom: { width: 8, height: 11 } });
    apply.mockResolvedValueOnce(true);
    const closed = await applySheet(useSheetStore.getState().sheet!);
    expect(closed).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(useSheetStore.getState().sheet).toBeNull();
  });

  it('an edit that finished before the cancel arrived closes the sheet, as a normal Apply does', async () => {
    apply.mockResolvedValueOnce(true);
    expect(await applySheet(useSheetStore.getState().sheet!)).toBe(true);
    expect(useSheetStore.getState().sheet).toBeNull();
  });
});

describe("Page size sheet: the sheet's own Cancel on a running resize (1.5.5 C5)", () => {
  it('stops the change, waits for the roll-back, then closes the sheet; says it was cancelled', async () => {
    let reject!: (error: Error) => void;
    apply.mockImplementationOnce(() => new Promise((_resolve, rej) => (reject = rej)));
    const running = applySheet(useSheetStore.getState().sheet!);
    expect(useApplyStore.getState().applying).toBe(true);
    cancelSheet();
    expect(cancelOp).toHaveBeenCalledWith('doc');
    expect(useApplyStore.getState().closeRequested).toBe(true);
    // The sheet stays until the roll-back is confirmed.
    expect(useSheetStore.getState().sheet).not.toBeNull();
    reject(abort());
    expect(await running).toBe(false);
    expect(useSheetStore.getState().sheet).toBeNull();
    expect(useApplyStore.getState()).toMatchObject({ applying: false, closeRequested: false });
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['Cancelled. The document was not changed.']);
  });

  it('a change that had already finished counts as a successful Apply: the sheet closes with the normal toast', async () => {
    let resolve!: (changed: boolean) => void;
    apply.mockImplementationOnce(() => new Promise((res) => (resolve = res)));
    const running = applySheet(useSheetStore.getState().sheet!);
    cancelSheet();
    resolve(true);
    expect(await running).toBe(true);
    expect(useSheetStore.getState().sheet).toBeNull();
    expect(useUiStore.getState().toasts[0]?.message).toBe('Resized 2 pages');
  });
});

describe('an abort that is not a Cancel (1.5.5 review)', () => {
  it('a document closed or replaced under the edit says nothing, and leaves the sheet', async () => {
    apply.mockRejectedValueOnce(Object.assign(new Error('The document was closed or replaced.'), { name: 'DocumentGone' }));
    expect(await applySheet(useSheetStore.getState().sheet!)).toBe(false);
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});

describe('the outcome of an earlier edit is forgotten when Apply starts', () => {
  it('an Apply that fails before reaching the engine is not read as a cancel', async () => {
    apply.mockRejectedValueOnce(abort());
    await applySheet(useSheetStore.getState().sheet!);
    useSheetStore.getState().update({ custom: { width: 0, height: 0 } });
    expect(await applySheet(useSheetStore.getState().sheet!)).toBe(false);
    expect(useApplyStore.getState().focusApply).toBe(false);
  });
});
