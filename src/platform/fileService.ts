import type { DocumentSource } from '../engine/types';
import { listRecentFiles } from './recovery/fileCache';

/**
 * A recently used file. Desktop entries are paths. Web entries point at the IndexedDB cache.
 */
export type RecentFile =
  | { kind: 'path'; key: string; name: string; path: string }
  | { kind: 'cache'; key: string; name: string; docId: string };

/**
 * Everything the app needs from the host to get files in. Sources are path-aware: the web
 * build produces byte sources, and the desktop build produces path sources (no byte copy).
 */
export interface FileService {
  pickPdfs(): Promise<DocumentSource[]>;
  fromFileList(list: FileList | null | undefined): Promise<DocumentSource[]>;
  /** Recently used files, newest first. */
  listRecent(limit: number): Promise<RecentFile[]>;
  /** Called after a file opened successfully, from a user action. Desktop records it in the recent list. */
  noteOpened(source: DocumentSource): void;
}

async function fromFile(file: File): Promise<DocumentSource> {
  return { kind: 'bytes', name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export function createWebFileService(): FileService {
  return {
    pickPdfs() {
      return new Promise<DocumentSource[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf,.pdf';
        input.multiple = true;
        let settled = false;
        const finish = (files: FileList | null) => {
          if (settled) return;
          settled = true;
          input.remove();
          resolve(files ? Promise.all(Array.from(files, fromFile)) : []);
        };
        input.addEventListener('change', () => finish(input.files));
        input.addEventListener('cancel', () => finish(null));
        input.style.display = 'none';
        document.body.appendChild(input);
        input.click();
      });
    },
    async fromFileList(list) {
      return list ? Promise.all(Array.from(list, fromFile)) : [];
    },
    async listRecent(limit) {
      const files = await listRecentFiles(limit);
      return files.map((f) => ({ kind: 'cache' as const, key: f.docId, name: f.name, docId: f.docId }));
    },
    noteOpened() {
      // The web build keeps recent files in the byte cache, which putFile fills on open.
    },
  };
}
