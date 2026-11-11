# Saving, recovery and file safety

## Save

- **Save:** **Ctrl+S**, File ▸ **Save**, or the Save button. The changes are written into the same file.
- **Save As…:** **Ctrl+Shift+S**, or File ▸ **Save As…**. The changes are written to a new file. The original is not changed.

When you reopen a file from Recent or after a restart, Save writes straight back to that file. You do not need to choose the file again.

The tab and the title show a dot (•) while there are unsaved changes. The dot goes away after a save.

Before the app writes to a file, it checks the file on disk. If another program has changed the file, the save stops. You see the choice described below.

Editing and undo are paused while a save is running.

### Permission to write

PDF Suite only writes to:

- files open in a tab right now, and
- files you chose in a Save dialog during this session.

Closing a tab ends PDF Suite's permission to write to that file. When you open it again from Recent, or it comes back after a restart, Save works as before. This works once per file in each session: if you close the file and open it from Recent again, its first Save asks you to choose the file in the Save dialog. Opening the file with File ▸ **Open…** always gives the permission back.

## When a file changes on disk

If another program changes the file while it is open in PDF Suite, a bar appears under the tabs:

**This file changed on disk.** [Reload] [Keep my version]

- **Reload:** loads the new version from disk. Your unsaved changes are lost.
- **Keep my version:** keeps your changes. When you save, your version replaces the file on disk.

If you try to save while the file is changed, nothing is written. A message says: "Another program changed *name*, so nothing was saved. Keep my version saves your changes over it; Reload discards your changes."

If the file is moved, renamed or deleted while it is open, a bar says:

**This file was moved, renamed or deleted. Save will create it again.** [Save] [Save As…] [Dismiss]

- **Save** writes your open document to the same path again, so the file is created again.
- **Save As…** saves it under a new name or folder.
- **Dismiss** hides the bar. Your changes stay open.

The bar stays until the file is back in its place, you save, or you choose **Dismiss**. The tab stays open.

If the folder is gone too, Save cannot create the file. The message says: "The folder for this file may no longer exist. Use Save As… to choose where to save it."

For a file over 500 MB, which PDF Suite cannot save, the bar says: "This file was moved, renamed or deleted. It is over 500 MB, so PDF Suite cannot save it again." It has only **Dismiss**.

## Close the app or a tab

If a tab has unsaved changes and you close it, PDF Suite asks "Save changes to *name* before closing?" with these choices:

- **Save**: save the changes, then close.
- **Don't save**: close without saving.
- **Cancel**: keep the tab open.

The question says: "Your changes will be lost if you don't save them."

If you close the app with unsaved changes, or close several tabs at once, PDF Suite asks once for all of them. For example: "Save changes to 3 files before closing?" **Save** saves each file, then closes. If one save does not finish, nothing is closed.

If Combine Files or Split into Files is still running, the app asks: "PDF Suite is still working on your files. Stop and exit?" with **Stop and exit** and **Cancel**. Stopping leaves no new files.

## If a file cannot be saved

If the save fails, the file on disk is not changed and your edits stay open. The message says why:

- "The file could not be saved. Check that it is not open in another program." Your changes are kept and can be saved again, but they can no longer be undone.
- "The file could not be saved, because PDF Suite did not have enough memory. The file on disk is unchanged and your edits are still open. Close other tabs and try again."
- "The file could not be saved, because something went wrong. The file on disk is unchanged and your edits are still open. If it happens again, Help ▸ Open Logs Folder has the details."

If a file has a password and its protection cannot be kept, a bar says: "This file's password protection cannot be kept when saving." Choose **Save without a password**, or **Cancel**.

For a file that is too large to save, see [Large files](#large-files) below.

## Recovery after a crash

PDF Suite keeps a record of your unsaved changes while you work. If the app closes unexpectedly, for example because of a crash or a power cut, it recovers them the next time you open it.

- Your tabs come back. A message says "Restored 3 tabs" (the number changes).
- If there are unsaved changes, a bar says **Recovered unsaved edits (3).** (the number changes) with **Keep** and **Discard**.
  - **Keep:** keeps the recovered changes in the open tab. Save to write them to the file.
  - **Discard:** throws away the recovered changes.
- If the file changed on disk since then, the edits are not put back. A bar says: "Unsaved edits from an earlier session were not restored, because this file has changed since then. You are seeing the file as it is on disk."
- If the edits cannot be put back for another reason, the bar says: "Unsaved edits from an earlier session could not be restored. You are seeing the file as it is on disk."
- Choose **OK** to close either bar.

Crash recovery can also stop for a file. A bar says why, with a **Save now** button. The bar stays until you save.

- "Crash recovery has stopped for this file, because PDF Suite could not write its recovery copy. Your latest changes are not protected until you save."
- "Crash recovery is off for this file until you save it, because it now includes pages from a password-protected PDF."

If a document stops working, a bar says "This document has stopped responding." with **Wait** and **Reopen**.

- **Wait** hides the bar.
- **Reopen** closes the document and opens it again with your unsaved edits.
- If some edits would be lost, PDF Suite asks first, with **Reopen** and **Cancel**. For example: "This file changed on disk, so your unsaved edits cannot be restored if you reopen. Reopen anyway?"

Recovery records from an older version of PDF Suite are not used. They are discarded.

Redo steps are not kept across a restart.

## Large files

- A file up to 1 GB can be opened to read and search.
- A file up to 500 MB can be edited and saved.
- A file over 500 MB opens for viewing only. A notice stays under the tabs: "This file is over 500 MB, so it is open for viewing only. You can read and search it, but you cannot edit or save it."
- A file over 1 GB is not opened. The message says: "This file is too large to open (the limit is 1 GB)."

If the document may be larger than 500 MB when saved, PDF Suite asks first: "This document may be larger than 500 MB, the most PDF Suite can save. If it is, the save will not finish and these changes can no longer be undone. Save anyway?" Choose **Save anyway** to try, or **Cancel**.

If the saved file would be too large, the save is refused: "This file is too large to save (the limit is 500 MB). The file on disk is unchanged and your edits are still open. Remove the pages or content that made it larger, then save again."

## Save often

Recovery helps, but it is not a backup. Save your work often, and keep a copy of important files.

## Known limits

- If another program changes the file at the very same moment as your save, its change can still be overwritten. The window for this is very short: PDF Suite checks the file again just before it replaces it.
