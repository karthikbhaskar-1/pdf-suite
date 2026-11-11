import { describe, expect, it, vi } from 'vitest';
import { createElectronFileService } from './electronFileService';
import type { PdfSuiteApi } from './desktop/contract';

function fakeBridge(overrides: Partial<PdfSuiteApi['files']> = {}, recent: Partial<PdfSuiteApi['recent']> = {}): PdfSuiteApi {
  return {
    files: {
      pick: vi.fn(async () => ['C:\\docs\\a.pdf', 'C:\\docs\\notes.txt']),
      read: vi.fn(),
      stat: vi.fn(),
      openKnown: vi.fn(async () => null),
      documentOpened: vi.fn(async () => true),
      documentClosed: vi.fn(async () => undefined),
      saveAtomic: vi.fn(),
      saveDialog: vi.fn(async () => null),
      takePending: vi.fn(async () => []),
      onOpenRequested: vi.fn(() => () => undefined),
      takeDroppedPaths: vi.fn(async () => ['D:\\in\\b.pdf']),
      ...overrides,
    },
    recent: {
      list: vi.fn(async () => ['C:\\docs\\a.pdf', 'C:\\docs\\old.pdf']),
      add: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      ...recent,
    },
    clipboard: { writeText: vi.fn(async () => true) },
    session: { onFlushRequested: vi.fn(() => () => undefined), flushed: vi.fn() },
    app: { onCloseRequested: vi.fn(() => () => undefined), onCloseEnded: vi.fn(() => () => undefined), decideClose: vi.fn(async () => true), openLogs: vi.fn(async () => undefined), requestClose: vi.fn(async () => undefined) },
    chrome: { setDark: vi.fn(async () => undefined) },
    jobs: {} as PdfSuiteApi['jobs'],
    recovery: {
      write: vi.fn(async () => true),
      read: vi.fn(async () => null),
      writeStash: vi.fn(async () => true),
      readStash: vi.fn(async () => null),
      list: vi.fn(async () => []),
      clear: vi.fn(async () => true),
      setAside: vi.fn(async () => true),
      clearPrevious: vi.fn(async () => true),
    },
  };
}

describe('desktop file service', () => {
  it('returns a path source for every picked file, whatever its type, and drops only paths that are not absolute', async () => {
    const service = createElectronFileService(fakeBridge({ pick: vi.fn(async () => ['C:\\docs\\a.pdf', 'C:\\docs\\notes.txt', 'relative.png']) }));
    expect(await service.pickPdfs()).toEqual([
      { kind: 'path', path: 'C:\\docs\\a.pdf', name: 'a.pdf' },
      { kind: 'path', path: 'C:\\docs\\notes.txt', name: 'notes.txt' },
    ]);
  });

  it('returns the real paths of dropped files, not the File objects', async () => {
    const service = createElectronFileService(fakeBridge());
    expect(await service.fromFileList(null)).toEqual([{ kind: 'path', path: 'D:\\in\\b.pdf', name: 'b.pdf' }]);
  });

  it('lists recent entries as path entries with the file name', async () => {
    const service = createElectronFileService(fakeBridge());
    const recent = await service.listRecent(1);
    expect(recent).toEqual([{ kind: 'path', key: 'C:\\docs\\a.pdf', name: 'a.pdf', path: 'C:\\docs\\a.pdf' }]);
  });

  it('records only path sources as recently opened', () => {
    const bridge = fakeBridge();
    const service = createElectronFileService(bridge);
    service.noteOpened({ kind: 'path', path: 'C:\\docs\\a.pdf', name: 'a.pdf' });
    service.noteOpened({ kind: 'bytes', name: 'b.pdf', bytes: new Uint8Array(1) });
    expect(bridge.recent.add).toHaveBeenCalledTimes(1);
    expect(bridge.recent.add).toHaveBeenCalledWith('C:\\docs\\a.pdf');
  });
});
