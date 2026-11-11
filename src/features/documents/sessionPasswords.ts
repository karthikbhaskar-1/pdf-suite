/**
 * The password a document was opened with, kept in memory for the life of the open document only. A save reopens the
 * saved bytes in a fresh worker, and an encrypted file needs its password there too. The password is never written to
 * disk, the recovery log or the recent list, and it is dropped when the document closes.
 */
const passwords = new Map<string, string>();

/** Remembers the password a document opened with. An empty or missing password is not kept. */
export function rememberSessionPassword(docId: string, password: string | undefined): void {
  if (password === undefined || password === '') return;
  passwords.set(docId, password);
}

/** The password a document opened with, or undefined when it opened without one. */
export function sessionPasswordOf(docId: string): string | undefined {
  return passwords.get(docId);
}

/** Moves the password to a new docId (Save As re-keys the document). */
export function moveSessionPassword(oldId: string, newId: string): void {
  const password = passwords.get(oldId);
  if (password === undefined) return;
  passwords.delete(oldId);
  passwords.set(newId, password);
}

/** Forgets the password of a document that closed. */
export function forgetSessionPassword(docId: string): void {
  passwords.delete(docId);
}
