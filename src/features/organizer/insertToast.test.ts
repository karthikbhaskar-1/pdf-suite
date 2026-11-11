// @vitest-environment node
// The toast after an Insert says what was inserted: blank, lined or grid pages (ticket 1.2.2).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apply } = vi.hoisted(() => ({ apply: vi.fn(async () => true) }));

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
import { doneText, runEdits } from './actions';

const SIZE = { width: 612, height: 792 };
const messages = () => useUiStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

describe('the Insert toast', () => {
  it.each([
    ['blank', 1, 'Inserted 1 blank page'],
    ['blank', 2, 'Inserted 2 blank pages'],
    ['lined', 1, 'Inserted 1 lined page'],
    ['lined', 3, 'Inserted 3 lined pages'],
    ['grid', 1, 'Inserted 1 grid page'],
    ['grid', 4, 'Inserted 4 grid pages'],
  ] as const)('%s x %i says "%s"', async (template, count, text) => {
    await runEdits('doc', [{ op: 'insertBlank', afterUid: null, size: SIZE, template, count }]);
    expect(messages()).toEqual([text]);
  });

  it('keeps "blank" when the kind is not known (the text of the old call)', () => {
    expect(doneText('insertBlank', 2)).toBe('Inserted 2 blank pages');
  });
});
