import { addBlockedMessage } from '../../core/fileLimits';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { addedBytesOf } from './addedBytes';
import { fileStampOf, savePathOf, statFile } from './saveDocument';

/**
 * The size of a document as it was last saved or opened: the stamp of its file, else a fresh stat of the file, else the size
 * of the bytes it was opened from. Undefined when none is known. Unsaved edits are not counted.
 */
export async function savedSizeOf(docId: string): Promise<number | undefined> {
  const path = savePathOf(docId);
  if (path) {
    const stamp = fileStampOf(path);
    if (stamp) return stamp.size;
    const now = await statFile(path).catch(() => null);
    if (now) return now.size;
  }
  return useDocumentsStore.getState().docs[docId]?.byteSize;
}

/**
 * Why a source PDF may not be added to this document, or null when it may (Insert from PDF, Replace, Overlay). Run BEFORE the
 * source is read, with the source's size from a stat. The rule (owner's delegate, 2026-11-10): a source over the edit limit is
 * refused, and so is one that would take the document past the limit, estimated as the document's saved size plus the
 * sources attached since (addedBytes.ts) plus the new source's size. The estimate counts the whole source even when only some pages are used: it is the one number known before
 * the work starts, and it is never lower than the truth.
 */
export async function addBlocked(docId: string, sourceBytes: number): Promise<string | null> {
  return addBlockedMessage(await savedSizeOf(docId), sourceBytes, addedBytesOf(docId));
}
