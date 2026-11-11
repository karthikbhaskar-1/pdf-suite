/**
 * The file-size limits and every message built from them (owner's delegate ruling, 2026-11-10, "Largest supported file").
 * The two numbers live in platform/desktop/contract.ts, because the main process uses them too. The words are final
 * (1.5.7 wording pass, docs/milestone-1.5/strings-final.md).
 *
 *   up to 500 MB   edit and save (MAX_EDIT_BYTES)
 *   500 MB - 1 GB  opens view-only (viewing, search and scrolling work; every editing command is off)
 *   over 1 GB      refused (MAX_VIEW_BYTES)
 */
import { MAX_EDIT_BYTES, MAX_VIEW_BYTES } from '../platform/desktop/contract';

export { MAX_EDIT_BYTES, MAX_VIEW_BYTES };

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A limit in words: "500 MB", "1 GB". */
export function limitLabel(bytes: number): string {
  if (bytes >= GB && bytes % GB === 0) return `${bytes / GB} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

/** The size of one file in a message: "420 MB", "1.2 GB", "12 KB". */
export function sizeLabel(bytes: number): string {
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const EDIT_LIMIT_TEXT = limitLabel(MAX_EDIT_BYTES);
export const VIEW_LIMIT_TEXT = limitLabel(MAX_VIEW_BYTES);

export type SizeClass = 'editable' | 'view-only' | 'too-large';

/** What a file of this many bytes may be used for. */
export function classifySize(bytes: number): SizeClass {
  if (bytes > MAX_VIEW_BYTES) return 'too-large';
  return bytes > MAX_EDIT_BYTES ? 'view-only' : 'editable';
}

/** The bar that stays under the tabs of a view-only document. */
export const VIEW_ONLY_NOTICE = `This file is over ${EDIT_LIMIT_TEXT}, so it is open for viewing only. You can read and search it, but you cannot edit or save it.`;

/** The tooltip, menu and toast reason of every editing command (and Save) on a view-only document. */
export const VIEW_ONLY_REASON = `This file is over ${EDIT_LIMIT_TEXT}, so it can be viewed but not edited.`;

/** A file over the view limit is not opened. */
export const TOO_LARGE_TO_OPEN = `This file is too large to open (the limit is ${VIEW_LIMIT_TEXT}).`;

/** A save or extract whose result is over the edit limit. */
export const TOO_LARGE_TO_SAVE = `This file is too large to save (the limit is ${EDIT_LIMIT_TEXT}). The file on disk is unchanged and your edits are still open. Remove the pages or content that made it larger, then save again.`;

/** Asked before a save whose estimated size is over the edit limit (the estimate can count pages that were deleted since). */
export const MAY_BE_TOO_LARGE_QUESTION = `This document may be larger than ${EDIT_LIMIT_TEXT}, the most PDF Suite can save. If it is, the save will not finish and these changes can no longer be undone. Save anyway?`;

/** An extract whose file would be over the edit limit. */
export const TOO_LARGE_TO_EXTRACT = `The extracted file is too large to save (the limit is ${EDIT_LIMIT_TEXT}). Nothing was written.`;

/** A save that failed because the engine ran out of memory (the measured cause of every failed save above about 550 MB). */
export const SAVE_OUT_OF_MEMORY = 'The file could not be saved, because PDF Suite did not have enough memory. The file on disk is unchanged and your edits are still open. Close other tabs and try again.';

/** A save the engine could not finish, with no reason known. */
export const SAVE_ENGINE_FAILED = 'The file could not be saved, because something went wrong. The file on disk is unchanged and your edits are still open. If it happens again, Help ▸ Open Logs Folder has the details.';

/** A source PDF (Insert, Replace, Overlay) over the edit limit on its own. */
export const SOURCE_TOO_LARGE = `That PDF is too large to add (the limit is ${EDIT_LIMIT_TEXT}). Nothing was changed.`;

/** Combine: the inputs together are over the limit (the same constant as an edit). */
export const COMBINE_TOO_LARGE = `These files are too large to combine at once (the limit is ${EDIT_LIMIT_TEXT} in total).`;

/**
 * The estimate of a document after adding a source to it (Insert from PDF, Replace, Overlay Add): the document's size as last
 * saved, plus the sources already attached since (`addedBytes`, see features/documents/addedBytes.ts), plus the new source's
 * size. Unsaved edits are not otherwise counted: this is what is always known, and it is never lower than the truth.
 */
export function estimatedSizeAfterAdd(savedBytes: number, addedBytes: number, sourceBytes: number): number {
  return savedBytes + addedBytes + sourceBytes;
}

/**
 * The message when adding a source would take the document past the edit limit, or null when it fits. `savedBytes` is
 * undefined when the document's saved size is not known (then the sources already added and the new one are counted alone).
 */
export function addBlockedMessage(savedBytes: number | undefined, sourceBytes: number, addedBytes = 0): string | null {
  if (sourceBytes > MAX_EDIT_BYTES) return SOURCE_TOO_LARGE;
  if (savedBytes === undefined && addedBytes === 0) return null;
  const now = (savedBytes ?? 0) + addedBytes;
  if (estimatedSizeAfterAdd(savedBytes ?? 0, addedBytes, sourceBytes) <= MAX_EDIT_BYTES) return null;
  return `That PDF is too large to add to this document: together they would be over the ${EDIT_LIMIT_TEXT} limit (the document is about ${sizeLabel(now)} and the PDF is ${sizeLabel(sourceBytes)}). Nothing was changed.`;
}
