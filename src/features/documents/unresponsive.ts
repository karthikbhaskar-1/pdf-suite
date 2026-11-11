import { useEditStore } from '../../core/stores/editStore';

/**
 * The page side of the worker silence watchdog (ticket 1.5.1 W1). Each engine document owns one worker (WorkerClient), whose
 * `watchSilence` reports a worker that has stopped answering while requests wait. This turns that report into the
 * document's "stopped responding" bar (Wait or Reopen); nothing is ended here, and nothing without the user's choice.
 *
 * Called for every engine document the app makes for an open document: when it is opened (documentService), and each time it
 * is replaced by a fresh one (a save, a reload, a reopen). The document is named by the id it had when it was watched; a
 * Save As re-keys it, so the id is followed through `currentId`.
 *
 * It reaches the document's client without a method on MupdfDocument (mupdfDocument.ts is held by another branch): when
 * that branch is in, MupdfDocument gets `onUnresponsive(handler)` and this function calls it instead (see the ticket's wiring
 * list). Anything without a client (a pdf.js document, a test double) is skipped.
 */
export function watchUnresponsive(docId: string, doc: unknown, currentId: (id: string) => string = (id) => id): void {
  if (doc === null || typeof doc !== 'object') return;
  const owner = doc as { onUnresponsive?: (h: () => void) => void; client?: { watchSilence?: (h: () => void) => void } };
  const report = (): void => useEditStore.getState().setUnresponsive(currentId(docId), true);
  if (typeof owner.onUnresponsive === 'function') owner.onUnresponsive(report);
  else owner.client?.watchSilence?.(report);
}
