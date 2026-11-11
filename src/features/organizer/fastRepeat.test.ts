// @vitest-environment node
// A key pressed again while an edit is still running (Ctrl+D held down) is never dropped without a word: it is refused
// with the plain message the Undo and Redo guards use, and the edit that was running finishes as it would have.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apply } = vi.hoisted(() => ({ apply: vi.fn() }));

vi.mock('../../app/services', () => ({ fileService: {} }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: apply,
  attachSourceLogged: vi.fn(),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { useUiStore } from '../../core/stores/uiStore';
import { BUSY_MESSAGE, runEdits } from './actions';

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

const messages = () => useUiStore.getState().toasts.map((t) => t.message);

describe('repeated presses while an edit runs', () => {
  it('refuses the press with a message, and the running edit still completes', async () => {
    let finish!: (changed: boolean) => void;
    apply.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const first = runEdits('doc', [{ op: 'duplicate', uids: ['0'] }]);
    // Three more presses arrive before the first edit is done.
    const later = await Promise.all([1, 2, 3].map(() => runEdits('doc', [{ op: 'duplicate', uids: ['0'] }])));
    expect(later).toEqual([false, false, false]);
    expect(messages().filter((m) => m === BUSY_MESSAGE)).toHaveLength(3);
    expect(apply).toHaveBeenCalledTimes(1);
    finish(true);
    await expect(first).resolves.toBe(true);
    expect(messages()).toContain('Duplicated 1 page');
  });

  it('takes the next press normally once the edit is done', async () => {
    apply.mockResolvedValue(true);
    await runEdits('doc', [{ op: 'duplicate', uids: ['0'] }]);
    await runEdits('doc', [{ op: 'duplicate', uids: ['0'] }]);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(messages().filter((m) => m === BUSY_MESSAGE)).toHaveLength(0);
  });

  it('says the same words as the Undo and Redo guard', () => {
    expect(BUSY_MESSAGE).toBe('Wait for the current change to finish.');
  });
});
