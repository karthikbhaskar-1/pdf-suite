import { pageListFromPages } from '../../core/model/pageList';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { measureInBackground, type PageSize } from '../../engine/pageSizes';
import type { EngineDocument } from '../../engine/types';

/**
 * The page list the panes read (the viewer, thumbnails, Properties, the loupe and the overview) follows the worker's
 * page list. An open, edit, undo or redo reports the list; this copies it into the documents store, with each page's
 * "uid@rev" and its size, so every reader sees the same pages.
 */
export interface PageListEvent {
  uids: readonly string[];
  revs: readonly number[];
  /** Width, height and the page's own rotation per page, three numbers each. Absent when the sizes did not change. */
  sizes?: Float32Array;
}

/** The sizes from a page-list event, by position. */
export function sizeEntries(sizes: Float32Array): Array<{ srcIndex: number; size: PageSize }> {
  const entries: Array<{ srcIndex: number; size: PageSize }> = [];
  for (let i = 0; i * 3 < sizes.length; i++) {
    entries.push({
      srcIndex: i,
      size: { width: sizes[i * 3] ?? 0, height: sizes[i * 3 + 1] ?? 0, rotation: sizes[i * 3 + 2] ?? 0 },
    });
  }
  return entries;
}

/** Copies a page-list event into the documents store. A document the store has not adopted yet is left to adoption. */
export function mirrorPageEvent(docId: string, event: PageListEvent, generation?: number): void {
  const store = useDocumentsStore.getState();
  if (!store.docs[docId]) return;
  store.setPages(docId, pageListFromPages(docId, event.uids, event.revs, generation));
  if (event.sizes) store.setSizes(docId, sizeEntries(event.sizes));
}

/**
 * A document replaced by a different file state (Discard on the recovery bar reloads the file from disk) has other page
 * sizes than the one it replaces, and the new document's open event carries none. The stored sizes are therefore cleared
 * and measured again from the new document, exactly as a first open does, so the viewer and the thumbnails lay out the
 * pages of the file as it is. `isAlive` says whether `doc` is still the document of `docId`.
 */
export function remeasurePages(docId: string, doc: EngineDocument, isAlive: () => boolean): void {
  const store = useDocumentsStore.getState();
  const info = store.docs[docId];
  if (!info) return;
  store.putDoc({ ...info, sizes: Array.from({ length: doc.pageCount }, (): PageSize | undefined => undefined) });
  void measureInBackground(doc, doc.pageCount, isAlive, (entries) => useDocumentsStore.getState().setSizes(docId, entries));
}
