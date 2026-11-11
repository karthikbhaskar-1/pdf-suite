import { create } from 'zustand';
import type { PageList } from '../model/pageList';
import type { DocId } from '../model/types';
import type { PageSize } from '../../engine/pageSizes';

/** Document metadata shared by every tab and pane that shows the same file. */
export interface DocInfo {
  docId: DocId;
  name: string;
  pageCount: number;
  pages: PageList;
  /** Sizes by original page index. Undefined until measured. */
  sizes: (PageSize | undefined)[];
  /** File size in bytes, when known (web files are read into memory; desktop paths may not be). */
  byteSize?: number;
}

interface DocumentsState {
  docs: Record<DocId, DocInfo>;
  putDoc: (info: DocInfo) => void;
  setSizes: (docId: DocId, entries: Array<{ srcIndex: number; size: PageSize }>) => void;
  setPages: (docId: DocId, pages: PageList) => void;
  removeDoc: (docId: DocId) => void;
}

export const useDocumentsStore = create<DocumentsState>()((set) => ({
  docs: {},
  putDoc: (info) => set((s) => ({ docs: { ...s.docs, [info.docId]: info } })),
  setSizes: (docId, entries) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const sizes = [...doc.sizes];
      for (const { srcIndex, size } of entries) sizes[srcIndex] = size;
      return { docs: { ...s.docs, [docId]: { ...doc, sizes } } };
    }),
  setPages: (docId, pages) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      return { docs: { ...s.docs, [docId]: { ...doc, pages, pageCount: pages.length } } };
    }),
  removeDoc: (docId) =>
    set((s) => {
      const { [docId]: _removed, ...rest } = s.docs;
      return { docs: rest };
    }),
}));
