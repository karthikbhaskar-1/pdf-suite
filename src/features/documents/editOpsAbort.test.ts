// @vitest-environment node
// 1.5.5 review: an abort is the user's Cancel only when cancelOperation ran. A document that was closed, or replaced by a
// reopen after a hang, rejects the pending edit with an abort too; that must not read as "Cancelled. The document was not changed."
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeDoc, doc } = vi.hoisted(() => {
  class FakeDoc {
    version = 0;
    onProgress = vi.fn(() => () => undefined);
    applyEdits = vi.fn(async (_edits: unknown, _version: number, _options?: { signal?: AbortSignal }): Promise<unknown> => ({ version: 1, history: {}, changed: true, uidSeed: 1 }));
  }
  return { FakeDoc, doc: new FakeDoc() };
});

vi.mock('../../app/services', () => ({ documentRegistry: { get: () => ({ doc }), replaceDocument: vi.fn() } }));
vi.mock('../../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeDoc, openMupdf: vi.fn() }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));

import { useUiStore } from '../../core/stores/uiStore';
import { runEdits } from '../organizer/actions';
import { applyPageEdits, cancelOperation } from './editOps';

const DOC = 'path:C:\\a.pdf';
const rotate = { op: 'rotate' as const, uids: ['0'], degrees: 90 };
const abort = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  useUiStore.setState({ toasts: [] });
});

describe('an abort that cancelOperation did not cause', () => {
  it('is DocumentGone, and runEdits says nothing', async () => {
    doc.applyEdits.mockRejectedValueOnce(abort());
    await expect(applyPageEdits(DOC, [rotate])).rejects.toMatchObject({ name: 'DocumentGone' });
    doc.applyEdits.mockRejectedValueOnce(abort());
    expect(await runEdits(DOC, [rotate])).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it('after cancelOperation it stays an AbortError, and runEdits says the document was not changed', async () => {
    doc.applyEdits.mockImplementationOnce(
      (_edits, _version, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(abort()))),
    );
    const running = runEdits(DOC, [rotate]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelOperation(DOC);
    expect(await running).toBe(false);
    expect(toasts()).toEqual(['Cancelled. The document was not changed.']);
  });
});
