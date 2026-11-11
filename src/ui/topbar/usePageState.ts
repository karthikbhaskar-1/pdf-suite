import { indexOfPage } from '../../core/model/pageList';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';

const SEP = '\u0001';

/**
 * The active pane, its document and the page it shows, as values that only change when the user's page changes.
 * The viewer writes the scroll position into the pane's view on every scroll frame, so a component must not read the whole
 * pane: it would draw again on each frame. This hook reads one string made of the pane id, the document id and the page
 * id, and the page list. It re-renders when the page, the document or an edit changes it, and not for a scroll within a page.
 */
export function useActivePage(): { paneId: string | null; docId: string | null; index: number; total: number } {
  const key = useWorkspaceStore((s) => {
    const pane = selectPane(s, s.activePaneId);
    return pane ? `${pane.id}${SEP}${pane.docId}${SEP}${pane.view.pageId ?? ''}` : '';
  });
  const [paneId, docId, pageId] = key ? key.split(SEP) : [null, null, ''];
  const pages = useDocumentsStore((s) => (docId ? s.docs[docId]?.pages : undefined));
  const index = pages && pageId ? indexOfPage(pages, pageId) : -1;
  return { paneId: paneId ?? null, docId: docId ?? null, index, total: pages?.length ?? 0 };
}
