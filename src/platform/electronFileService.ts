import type { DocumentSource } from '../engine/types';
import type { FileService, RecentFile } from './fileService';
import { isOpenablePath } from './desktop/contract';
import type { PdfSuiteApi } from './desktop/contract';
import { fileNameOf, pathSource } from './desktop/bridge';

/**
 * Desktop (Electron) file service. Every source is a path, so files are never copied into the
 * app. Bytes are read in the engine only when a document opens.
 */
export function createElectronFileService(bridge: PdfSuiteApi): FileService {
  return {
    async pickPdfs(): Promise<DocumentSource[]> {
      const paths = await bridge.files.pick();
      return paths.filter(isOpenablePath).map(pathSource);
    },
    async fromFileList(): Promise<DocumentSource[]> {
      // The preload captured the real paths during the drop event. The File objects themselves
      // have no path once they reach the renderer, so the list argument is not needed here.
      return (await bridge.files.takeDroppedPaths()).filter(isOpenablePath).map(pathSource);
    },
    async listRecent(limit: number): Promise<RecentFile[]> {
      const paths = await bridge.recent.list();
      return paths.slice(0, limit).map((path) => ({ kind: 'path' as const, key: path, name: fileNameOf(path), path }));
    },
    noteOpened(source: DocumentSource): void {
      if (source.kind === 'path') void bridge.recent.add(source.path).catch(() => undefined);
    },
  };
}
