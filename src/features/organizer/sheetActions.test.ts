import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  generation: 1,
  version: 0,
  undo: vi.fn(),
  run: vi.fn(async () => true),
  settle: vi.fn(async () => undefined as void),
  cancelOp: vi.fn(),
  outcome: 'done' as 'done' | 'cancelled' | 'failed',
  saving: false,
}));

vi.mock('../../engine/mupdf/mupdfDocument', () => ({
  MupdfDocument: class {
    get version() {
      return state.version;
    }
    get generation() {
      return state.generation;
    }
  },
}));
vi.mock('../../app/services', async () => {
  const { MupdfDocument } = await import('../../engine/mupdf/mupdfDocument');
  return { documentRegistry: { get: () => ({ doc: new (MupdfDocument as unknown as new () => object)() }) } };
});
vi.mock('../documents/editOps', () => ({ settleEdits: state.settle, cancelOperation: state.cancelOp }));
vi.mock('./actions', () => ({
  orderOf: () => ['0', '1'],
  deletePages: vi.fn(),
  runEdits: state.run,
  lastEditOutcome: () => state.outcome,
  resetEditOutcome: vi.fn(),
  BUSY_MESSAGE: 'Wait for the current change to finish.',
  undoEdit: vi.fn(),
  // Cancel takes the preview back with no redo left (discardLastEdit), not with a plain undo.
  discardLastEdit: state.undo,
}));

import { useEditStore } from '../../core/stores/editStore';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { applySheet, autoCropFromSheet, cancelSheet, useApplyStore } from './sheetActions';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function openCrop(): void {
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
}

describe('Crop sheet Cancel (ticket 1.2.1 review, item 2)', () => {
  beforeEach(() => {
    state.undo.mockClear();
    state.version = 3;
    useSheetStore.getState().close();
  });

  it('undoes the auto-crop preview while the document is still at the version it produced', async () => {
    openCrop();
    state.version = 4;
    await autoCropFromSheet();
    cancelSheet();
    expect(useSheetStore.getState().sheet).toBeNull();
    await flush();
    expect(state.undo).toHaveBeenCalledTimes(1);
    expect(useSheetStore.getState().sheet).toBeNull();
  });

  it('leaves the document alone when anything else changed it since the preview', async () => {
    openCrop();
    state.version = 4;
    await autoCropFromSheet();
    state.version = 5; // another edit, or an undo, made after the preview
    cancelSheet();
    await flush();
    expect(state.undo).not.toHaveBeenCalled();
    expect(useSheetStore.getState().sheet).toBeNull();
  });

  it('does not undo when the sheet never applied an auto-crop', () => {
    openCrop();
    cancelSheet();
    expect(state.undo).not.toHaveBeenCalled();
  });
});

describe('Crop sheet Cancel while an Undo is running (1.5.5 C6)', () => {
  it('closes at once, waits for the running change, then checks again: nothing is undone when the undo moved the version on', async () => {
    state.undo.mockClear();
    state.generation = 1;
    useSheetStore.getState().close();
    openCrop();
    state.version = 4;
    await autoCropFromSheet();
    let finish!: () => void;
    state.settle.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    cancelSheet();
    expect(useSheetStore.getState().sheet).toBeNull();
    await flush();
    expect(state.undo).not.toHaveBeenCalled();
    state.version = 3; // the running Ctrl+Z finished and took the preview back
    finish();
    await flush();
    expect(state.undo).not.toHaveBeenCalled();
  });
});

describe('Crop sheet Cancel while Auto-crop runs, and during a save (1.5.5 review)', () => {
  it('stops Auto-crop, and the sheet closes once it is rolled back', async () => {
    state.undo.mockClear();
    state.cancelOp.mockClear();
    state.generation = 1;
    useSheetStore.getState().close();
    openCrop();
    let finish!: (ok: boolean) => void;
    state.run.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    state.outcome = 'cancelled';
    const running = autoCropFromSheet();
    expect(useApplyStore.getState().applying).toBe(true);
    cancelSheet();
    expect(state.cancelOp).toHaveBeenCalledWith('doc');
    expect(useSheetStore.getState().sheet).not.toBeNull();
    finish(false);
    await running;
    expect(useSheetStore.getState().sheet).toBeNull();
    expect(state.undo).not.toHaveBeenCalled();
    state.outcome = 'done';
  });

  it('waits for a running save before it takes the preview back', async () => {
    state.undo.mockClear();
    state.generation = 1;
    useSheetStore.getState().close();
    openCrop();
    state.version = 4;
    await autoCropFromSheet();
    useEditStore.setState({ saving: { doc: true } } as never);
    cancelSheet();
    await flush();
    expect(state.undo).not.toHaveBeenCalled();
    useEditStore.setState({ saving: {} } as never);
    await flush();
    expect(state.undo).toHaveBeenCalledTimes(1);
  });
});

describe('one Apply per document (1.5.5 follow-up)', () => {
  it('a second Apply or Auto-crop while one runs for the same document says so; another document is not refused', async () => {
    state.generation = 1;
    useSheetStore.getState().close();
    useUiStore.setState({ toasts: [] });
    openCrop();
    useApplyStore.setState({ docId: 'doc', applying: true, closeRequested: false, focusApply: false });
    expect(await applySheet(useSheetStore.getState().sheet!)).toBe(false);
    await autoCropFromSheet();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['Wait for the current change to finish.', 'Wait for the current change to finish.']);
    useApplyStore.setState({ docId: 'other', applying: true });
    useUiStore.setState({ toasts: [] });
    useSheetStore.getState().close();
    useSheetStore.getState().open({ kind: 'rotate', docId: 'doc', uids: ['0'], degrees: 0 } as never);
    expect(await applySheet(useSheetStore.getState().sheet!)).toBe(true);
    expect(useUiStore.getState().toasts.map((t) => t.message)).not.toContain('Wait for the current change to finish.');
    useApplyStore.setState({ docId: null, applying: false });
  });

  it('Cancel during Auto-crop does not close a different sheet that opened meanwhile', async () => {
    state.generation = 1;
    useSheetStore.getState().close();
    openCrop();
    let finish!: (ok: boolean) => void;
    state.run.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const running = autoCropFromSheet();
    cancelSheet();
    useSheetStore.getState().close();
    useSheetStore.getState().open({ kind: 'rotate', docId: 'doc', uids: ['0'], degrees: 0 } as never);
    finish(true);
    await running;
    expect(useSheetStore.getState().sheet?.kind).toBe('rotate');
  });
});

describe('Crop sheet Cancel after a save (round 2, minor a)', () => {
  it('does not undo when the version matches but the document was reopened by a save (new generation)', async () => {
    state.undo.mockClear();
    state.generation = 1;
    useSheetStore.getState().close();
    openCrop();
    state.version = 4;
    await autoCropFromSheet();
    state.generation = 2; // a save reopened the document; its version counter restarted and reached the same number
    cancelSheet();
    await flush();
    expect(state.undo).not.toHaveBeenCalled();
  });
});
