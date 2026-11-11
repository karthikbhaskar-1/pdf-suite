/**
 * The bytes of the sources attached to each document since it was last saved or reloaded (Insert from PDF, Replace, Overlay
 * Add, and the sources a recovery replay attaches). The size check of an add counts them: the file on disk is only the size
 * the document had when it was saved, and two inserts of 90 MB each into a 400 MB document make it about 580 MB, which cannot be
 * saved. A source that was attached and not used (a cancelled sheet) still counts, and an undo does not take it back: both err
 * on the safe side. A save, a reload from disk and a Discard start the count again. A leaf file with no imports, so the save
 * and the edit code can both use it.
 */
const added = new Map<string, number>();

export function addedBytesOf(docId: string): number {
  return added.get(docId) ?? 0;
}

export function noteAdded(docId: string, bytes: number): void {
  added.set(docId, addedBytesOf(docId) + bytes);
}

export function resetAdded(docId: string): void {
  added.delete(docId);
}

/** Save As gave the document a new id. */
export function rekeyAdded(oldId: string, newId: string): void {
  const bytes = added.get(oldId);
  if (bytes === undefined || oldId === newId) return;
  added.delete(oldId);
  added.set(newId, bytes);
}
