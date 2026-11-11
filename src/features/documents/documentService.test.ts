import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({
  documentRegistry: {
    acquire: vi.fn(),
    release: vi.fn(),
    retain: vi.fn(),
    refCount: vi.fn(() => 0),
    get: vi.fn(),
    sameFileId: (id: string) => id,
    isSuspended: () => false,
  },
  fileService: { noteOpened: vi.fn() },
}));
vi.mock('../../platform/recovery/fileCache', () => ({ putFile: vi.fn(async () => undefined) }));

import { documentRegistry } from '../../app/services';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useUiStore } from '../../core/stores/uiStore';
import type { DocumentSource } from '../../engine/types';
import { openSource, OPEN_TIMEOUT_MS } from './documentService';

const source: DocumentSource = { kind: 'path', path: 'C:/docs/stalled.pdf', name: 'stalled.pdf' };
const acquire = vi.mocked(documentRegistry.acquire);
const release = vi.mocked(documentRegistry.release);

function fakeHandle(docId: string) {
  return { docId, doc: {} as never, pageCount: 1 };
}

beforeEach(() => {
  vi.useFakeTimers();
  acquire.mockReset();
  release.mockReset();
  useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null });
  useUiStore.setState({ passwordTabId: null });
});

describe('opening a file that never answers', () => {
  it('shows an inline message in its tab after the open timeout, instead of staying on "Opening"', async () => {
    acquire.mockImplementation(() => new Promise(() => undefined));
    const opening = openSource(source);

    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    const tabId = await opening;

    const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.status).toEqual({ kind: 'error', message: 'This file could not be read.' });
  });

  it('gives back the reference of an open that finishes after the timeout, and keeps the error', async () => {
    let finish: (value: ReturnType<typeof fakeHandle>) => void = () => undefined;
    acquire.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const opening = openSource(source);

    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    const tabId = await opening;
    finish(fakeHandle('doc-late'));
    await vi.advanceTimersByTimeAsync(0);

    expect(release).toHaveBeenCalledWith('doc-late');
    const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.status.kind).toBe('error');
  });

  it('a file that opens in time is not touched by the timeout', async () => {
    acquire.mockResolvedValue(fakeHandle('doc-ok'));
    const tabId = await openSource(source);
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS * 2);

    const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
    expect(tab?.status.kind).toBe('ready');
    expect(release).not.toHaveBeenCalled();
  });
});
