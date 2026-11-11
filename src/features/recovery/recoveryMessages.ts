/**
 * The words of the crash-recovery bars (ticket 1.5.1), in plain English, word for word from docs/milestone-1.5/1.5.5-ui-spec.md
 * section 6. They live here so the bar, the code that raises it and the tests all use one text. The buttons are in DocumentBars.
 */

/** Recovery is off because an edit uses a password-protected PDF. The bar stays until the file is saved. */
export const RECOVERY_OFF_MESSAGE = 'Crash recovery is off for this file until you save it, because it now includes pages from a password-protected PDF.';

/** The recovery copy could not be written (a refused or failed write). The bar stays until the file is saved. */
export const RECOVERY_FAILED_MESSAGE =
  'Crash recovery has stopped for this file, because PDF Suite could not write its recovery copy. Your latest changes are not protected until you save.';

/** An earlier session's edits were not restored because the file is no longer the one they were made on. */
export const NOT_RESTORED_CHANGED_MESSAGE =
  'Unsaved edits from an earlier session were not restored, because this file has changed since then. You are seeing the file as it is on disk.';

/** An earlier session's edits could not be restored (damaged log, missing copy, a step that failed, or an old format). */
export const NOT_RESTORED_FAILED_MESSAGE =
  'Unsaved edits from an earlier session could not be restored. You are seeing the file as it is on disk.';

/** Added to the "Recovered unsaved edits" bar when the log says recording stopped before the session ended. */
export const RECOVERED_STOPPED_SENTENCE = 'Edits made after crash recovery stopped could not be recovered.';

/** The bar for a document whose engine stopped answering (W1). */
export const UNRESPONSIVE_MESSAGE = 'This document has stopped responding.';
/** Asked before Reopen when crash recovery has stopped for the document: edits made since then are not in the recovery copy. */
export const REOPEN_LOSS_QUESTION = 'Edits made after crash recovery stopped will be lost if you reopen. Reopen anyway?';
/**
 * Asked before Reopen when the file changed on disk since the document was opened: the recovery copy belongs to the file as it
 * was, so after a reopen it is not put back (it is kept aside, not deleted).
 */
export const REOPEN_CHANGED_QUESTION = 'This file changed on disk, so your unsaved edits cannot be restored if you reopen. Reopen anyway?';
/** What the Reopen button does; it never runs without the user pressing it. */
export const REOPEN_TIP = 'Closes this document and opens it again with your unsaved edits.';
