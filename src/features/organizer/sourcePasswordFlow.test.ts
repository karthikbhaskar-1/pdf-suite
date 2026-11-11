// @vitest-environment node
// Insert or Replace from a password-protected PDF: the user is asked for the password, a wrong one is said so in plain
// English and asked again, Cancel leaves the document alone, and the password is used for the call only.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { attach, bridge, pickPdfs } = vi.hoisted(() => ({
  attach: vi.fn(),
  pickPdfs: vi.fn(),
  bridge: { files: { read: vi.fn() } },
}));

vi.mock('../../app/services', () => ({ fileService: { pickPdfs } }));
vi.mock('../../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge }));
vi.mock('../documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(),
  attachSourceLogged: attach,
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));
vi.mock('../documents/closeFlow', () => ({ extractWithFeedback: vi.fn() }));

import { PdfOpenError } from '../../engine/errors';
import { useUiStore } from '../../core/stores/uiStore';
import { attachPickedSource } from './actions';
import { answerSourcePassword } from './sourcePassword';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n').buffer;

/** Waits until the prompt is up, so the test can answer it. */
const promptUp = async () => {
  for (let i = 0; i < 50 && useUiStore.getState().sourcePassword === null; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  return useUiStore.getState().sourcePassword;
};

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ sourcePassword: null, toasts: [] });
  pickPdfs.mockResolvedValue([{ kind: 'path', path: 'C:\\locked.pdf', name: 'locked.pdf' }]);
  bridge.files.read.mockResolvedValue({ ok: true, bytes: PDF });
});

describe('a protected PDF picked for Insert or Replace', () => {
  it('asks for the password, then attaches the source with it', async () => {
    attach.mockRejectedValueOnce(new PdfOpenError('PasswordNeeded'));
    attach.mockResolvedValueOnce({ sourceDocId: 'src1', pages: 4 });
    const done = attachPickedSource('doc');
    expect(await promptUp()).toEqual({ name: 'locked.pdf', error: null });
    answerSourcePassword('test123');
    await expect(done).resolves.toEqual({ sourceDocId: 'src1', pages: 4, name: 'locked.pdf' });
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls[0]![2]).toBeUndefined();
    expect(attach.mock.calls[1]![2]).toBe('test123');
    expect(useUiStore.getState().sourcePassword).toBeNull();
    // Nothing said to the user in a toast, and the password is not in the store.
    expect(useUiStore.getState().toasts).toHaveLength(0);
    expect(JSON.stringify(useUiStore.getState())).not.toContain('test123');
  });

  it('says a wrong password is wrong, in plain English, and asks again', async () => {
    attach.mockRejectedValueOnce(new PdfOpenError('PasswordNeeded'));
    attach.mockRejectedValueOnce(new PdfOpenError('WrongPassword'));
    attach.mockResolvedValueOnce({ sourceDocId: 'src1', pages: 4 });
    const done = attachPickedSource('doc');
    await promptUp();
    answerSourcePassword('nope');
    // The prompt opens again, now with the message.
    let prompt = useUiStore.getState().sourcePassword;
    for (let i = 0; i < 50 && prompt === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      prompt = useUiStore.getState().sourcePassword;
    }
    expect(prompt).toEqual({ name: 'locked.pdf', error: 'Wrong password, try again.' });
    answerSourcePassword('test123');
    await expect(done).resolves.toMatchObject({ sourceDocId: 'src1' });
    expect(attach.mock.calls.map((call) => call[2])).toEqual([undefined, 'nope', 'test123']);
  });

  it('Cancel attaches nothing, says nothing, and leaves the document alone', async () => {
    attach.mockRejectedValueOnce(new PdfOpenError('PasswordNeeded'));
    const done = attachPickedSource('doc');
    await promptUp();
    answerSourcePassword(null);
    await expect(done).resolves.toBeNull();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().sourcePassword).toBeNull();
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it('a file that is not protected never opens the prompt', async () => {
    attach.mockResolvedValueOnce({ sourceDocId: 'src1', pages: 2 });
    await expect(attachPickedSource('doc')).resolves.toMatchObject({ pages: 2 });
    expect(useUiStore.getState().sourcePassword).toBeNull();
  });
});
