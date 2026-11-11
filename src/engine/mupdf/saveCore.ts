/**
 * Save decisions for an open MuPDF document. Pure, apart from the encryption check, so the choice can be tested without
 * a document.
 *
 * An incremental save appends the changes to the original bytes, so the file keeps its old content. It is used only
 * when every condition holds. Otherwise the save is full, with garbage=compact, which drops the objects no page uses.
 */
import type * as Mu from 'mupdf';

export type SaveMode = 'incremental' | 'full';

export interface SaveFacts {
  /** The target is the file the document was opened from. */
  samePath: boolean;
  /** MuPDF says the document can be saved incrementally. */
  canBeSavedIncrementally: boolean;
  /** MuPDF repaired the file when it opened it. A repaired file is rewritten in full. */
  wasRepaired: boolean;
  /** The file on disk still has the size and modified time it had when it was opened. */
  diskUnchanged: boolean;
  /** An edit since open removed or replaced pages. */
  removesPages: boolean;
}

export interface SaveDecision {
  mode: SaveMode;
  /** The first condition that failed, for the log. Null for an incremental save. */
  reason: string | null;
}

/** Chooses incremental only when every condition holds. The order of the checks sets the reason reported. */
export function decideSave(facts: SaveFacts): SaveDecision {
  if (!facts.samePath) return { mode: 'full', reason: 'different path' };
  if (!facts.canBeSavedIncrementally) return { mode: 'full', reason: 'MuPDF cannot save incrementally' };
  if (facts.wasRepaired) return { mode: 'full', reason: 'file was repaired' };
  if (!facts.diskUnchanged) return { mode: 'full', reason: 'file changed on disk' };
  if (facts.removesPages) return { mode: 'full', reason: 'pages were deleted or replaced' };
  return { mode: 'incremental', reason: null };
}

/**
 * The MuPDF save options. A full save compacts the file. An encrypted file keeps its encryption (encrypt=keep), so the
 * saved file asks for the same password. An incremental save keeps the encryption already in the file.
 */
export function saveOptions(mode: SaveMode, encrypted: boolean): string {
  if (mode === 'incremental') return 'incremental';
  return encrypted ? 'garbage=compact,encrypt=keep' : 'garbage=compact';
}

/** The bytes of a MuPDF buffer as an array of their own, and the buffer destroyed (its memory is in the WASM heap). */
export function copyOut(buffer: Mu.Buffer): Uint8Array {
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

/**
 * True when the saved bytes are still encrypted: they need a password to open, or they carry an encryption entry.
 * Reopens the bytes to check, so nothing the page holds is used.
 */
export function encryptionKept(mu: Pick<typeof Mu, 'Document'>, bytes: Uint8Array): boolean {
  const doc = mu.Document.openDocument(bytes, 'application/pdf');
  try {
    if (doc.needsPassword()) return true;
    const encryption = doc.getMetaData('encryption');
    return encryption !== undefined && encryption !== '' && encryption !== 'None';
  } finally {
    doc.destroy();
  }
}

/**
 * The MuPDF save options for the extracted pages of an encrypted file: AES-256 with the password the file was opened
 * with, as both the user and the owner password, so the extract asks for the same password. Null when that cannot be
 * written (MuPDF's option text cannot hold a comma), and the caller then asks the user. The password only lives in this
 * string for the call: it is never stored or logged.
 */
export function extractEncryptedOptions(password: string): string | null {
  if (password.includes(',')) return null;
  return `garbage=compact,encrypt=aes-256,owner-password=${password},user-password=${password}`;
}

/** True when the bytes open with `password` (or, for an empty one, open without a password) and are encrypted. */
export function opensWithPassword(mu: Pick<typeof Mu, 'Document'>, bytes: Uint8Array, password: string): boolean {
  const doc = mu.Document.openDocument(bytes, 'application/pdf');
  try {
    if (doc.needsPassword()) return password !== '' && doc.authenticatePassword(password) > 0;
    const encryption = doc.getMetaData('encryption');
    return encryption !== undefined && encryption !== '' && encryption !== 'None';
  } finally {
    doc.destroy();
  }
}
