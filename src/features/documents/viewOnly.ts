import { documentRegistry } from '../../app/services';
import { VIEW_ONLY_REASON } from '../../core/fileLimits';

/**
 * True when the document opened view-only because its file is over the edit limit (core/fileLimits.ts). Such a document has
 * no edits, no save and no recovery log: the command guards turn every editing command off with VIEW_ONLY_REASON, and the
 * functions below (apply an edit, attach a source, save) refuse it too, so no path can change it.
 */
export function isViewOnly(docId: string | undefined): boolean {
  if (!docId) return false;
  return documentRegistry.get(docId)?.doc?.capabilities?.viewOnly === true;
}

/** Throws the view-only reason when the document is view-only. */
export function refuseViewOnly(docId: string): void {
  if (isViewOnly(docId)) throw new Error(VIEW_ONLY_REASON);
}
