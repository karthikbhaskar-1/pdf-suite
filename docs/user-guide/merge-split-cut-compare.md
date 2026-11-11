# Merge, split, cut and compare

> **Status:** all four commands are built. The messages on this page are the app's current text.

These four commands make new files, or change pages in a way that you can undo. Your original files are not changed unless you save over them.

## Cut Pages in Half

Use this for a scan of two book pages on one sheet. It cuts each page into two pages.

- **Menu:** Pages ▸ **Cut Pages in Half…**
- **Thumbnails:** right-click a page and choose **Cut Pages in Half**.
- **Palette:** press **Ctrl+K**, then "Pages: Cut pages in half".

The panel opens at the side of the window.

| Setting | Choices | Default |
|---|---|---|
| Cut into | Left and right, or Top and bottom | Left and right |
| Cut position | 30 to 70 percent, in steps of 0.5 | 50 |
| Page order | Left page first, or Right page first | Left page first |
| Apply to | Current page, Selected pages, All pages, Wide pages only (Tall pages only for Top and bottom) | Selected pages if two or more are selected, otherwise All pages |

- A dashed line shows the cut on each affected page. You can drag this line to set the cut position.
- Choose **Right page first** for books that are read from right to left.
- Nothing changes until you choose **Apply**. Choose **Cancel** to stop.
- A toast says "Cut 12 pages in half · Undo". The Edit menu says "Undo Cut 12 pages in half".

Keyboard: the Cut into choice gets focus when the panel opens. On the slider, the arrow keys move 0.5, Page Up and Page Down move 5, and Home and End go to 30 and 70.

## Combine Files

Use this to join PDFs, pictures and text files into one PDF.

- **Menu:** File ▸ **Combine Files…** or Pages ▸ **Combine files**.
- **Toolbar:** Combine, with the tooltip "Combine files".
- You can start Combine with no file open.

Combine opens in its own window. The window has a list of files on the left and a preview of the selected file on the right.

- **Add files…** opens a picker. You can choose PDF, JPEG, PNG, TIFF, GIF, BMP, WebP, and the text types .txt, .log, .md and .csv.
- **Add open files** adds every PDF that is open.
- **Move up, Move down**, or drag the handle to change the order. **Sort by name** sorts A to Z.
- **Pages** in a row takes a page range, for example `1-5, 8`. Empty means all pages.
- In the preview, click a page to leave it out, or click again to put it back.
- **Picture pages** (default: same size as the picture; or A4, Letter) and **Text pages** (default: Letter; or A4) set the page size.
- **Add a bookmark for each file** is on by default. It adds a bookmark for each file in the new PDF.
- **Open the new file when it is ready** is on by default.

Press **Combine…** to choose where to save the new file. The default name is "Combined.pdf". The new file is never the same file as one of the inputs.

Keyboard: use Alt+Up and Alt+Down to move a file. Use Delete to remove a file. Press **Esc** to cancel.

### Notices before you combine

| Message | What it means |
|---|---|
| Fillable forms in «a», «b»: what is filled in stays visible, but the boxes can no longer be typed in, and signatures can no longer be checked. Your original files are not changed. | The forms are flattened in the new file. |
| The new file will not have a password, although «a» does. | The new file is not protected. |
| «a» has layers that can be shown and hidden. In the new file they become part of the page, and hidden ones become visible. | Layers are merged. |
| «a» has unsaved changes. The saved version will be used. | Combine uses the file as it is saved on disk. |
| Files attached inside «a» are not copied to the new file. | Attachments are left out. |
| «a» has 14 characters PDF Suite can't print yet (it prints Latin, Greek and Cyrillic letters). Each will appear as “?”. The text file itself is not changed. | Some characters cannot be shown. |

### Messages when a file is not added

| Message | What it means |
|---|---|
| «name» was not added. Word, Excel and PowerPoint files can't be combined yet. For now, save it as a PDF first, then add the PDF. | Office files are not accepted yet. |
| «name» was not added. PDF Suite can combine PDFs, pictures (JPEG, PNG, TIFF, GIF, BMP, WebP) and text files. | The type of file is not supported. |
| «name» is damaged or is not a PDF, so it was not added. | The file cannot be read. |
| «name» was not added. It is a kind of form that can't be combined yet. | XFA forms cannot be combined. |
| «name» was not added, because what is filled in on its form could not be kept. | The form values could not be kept. |
| «name» is too large a picture to add (the limit is 50 megapixels). | The picture is too big. |
| «name» was not added, because one of its pages is too large (the limit is 50 megapixels a page). | A page of a multi-page picture file is too big. |
| «name» is too large to add (text files can be up to 32 MB). | The text file is too big. |
| You can combine up to 500 files at once. The extra files were not added. | There is a limit of 500 files. |
| These files are too large to combine at once (the limit is 500 MB in total). | The total size is too big. |
| Choose a different name: that file is one of the files being combined. | The new file cannot use the name of an input. |
| Choose a different name: that file is open in PDF Suite. | The new file cannot use the name of an open file. |

A file with a password asks for the password once. If you cancel the password prompt, the file is not added: "«name» was not added because it needs a password."

### Result messages

| Message | What it means |
|---|---|
| Combined 3 files into Combined.pdf (16 pages). | The job is done. Choose Show in folder to see the file. |
| Cancelled. No files were created and your original files were not changed. | You cancelled the job. |
| The new file could not be written, so nothing was created. Your files were not changed. | The file could not be written. |
| There is not enough space on drive X:. Nothing was written. | The disk is full. |
| PDF Suite can't write to that folder. Choose another folder. | The folder is read-only or cannot be used. |

## Split into Files

Use this to cut one PDF into several files.

- **Menu:** File ▸ **Split into Files…** or Pages ▸ **Split into files**.
- You need an open PDF.

Split works from the saved file. If the document has unsaved changes, the panel says: "Save your changes first? Split works from the saved file." Choose **Save and continue**, or **Cancel**.

The panel on the right has these options:

- **Split by:** Page count, File size, Blank pages or Bookmarks. Only the chosen method shows its own options.
  - **Page count:** pages in each file (default 10).
  - **File size:** the largest file size, in MB or KB (default 10 MB).
  - **Blank pages:** finds blank pages and splits at them. You can choose how sensitive the search is, and untick any page you do not want to split at. Choose whether blank pages are left out of the new files or kept at the end of the file before.
  - **Bookmarks:** starts a new file at each top-level bookmark.
- **Save in:** choose the folder. You must choose one.
- **File name:** the name for the new files. The examples show the result, for example "Report - part 01.pdf".
- **Keep the password on the new files:** on by default, for locked files only.

If a file with the same name is already there, the new file gets "(2)" added to its name. Nothing is replaced.

The panel shows what will happen before you start, for example "Makes 12 files." Choose **Split** to start.

A split cannot be done in some cases:

| Message | What it means |
|---|---|
| This document can't be split yet, because what is filled in on its form could not be kept in the new files. The document is not changed. | The form values cannot be kept. |
| This document was not split, because it needs its password. | You cancelled the password prompt. |
| This document is too large to split (the limit is 500 MB). | The file is too big. |
| This document is a kind of form that can't be split yet. The document is not changed. | The document is an XFA form. |
| The saved file could not be read, so it can't be split. The document is not changed. | The saved file cannot be read. |
| This document has only one page, so there is nothing to split. | There must be at least two pages. |
| The saved file is damaged, so it can't be split. Try File ▸ Save As first, then split the new copy. | The file on disk is damaged. |
| This document has no bookmarks to split by. | You chose Bookmarks, but the file has none. |
| Enter a whole number from 1 to 119. (For a 120-page file.) | The number of pages per file is not valid. |

When the split is done, the message says "Split Report.pdf into 12 files."

To stop a split, choose **Cancel** in the status bar. No files are left behind. The message says "Cancelled. No files were created and your original files were not changed." Closing the document's tab does not stop a split that is running.

## Overlay to Compare

Use this to lay one PDF over another, to compare two versions of a plan or layout.

- **Menu:** Pages ▸ **Overlay to Compare…**
- **Palette:** "Pages: Overlay to compare". Use "Pages: Leave overlay compare" to stop.
- You need an editable PDF open.

Choose the PDF to lay over the open one. The overlay is only on screen until you add it to pages.

- **Look:** Both, See-through, or Differences. Differences uses red for things only in this document, blue-green for things only in the overlay, and black for things in both.
- **Opacity:** 0 to 100 percent, for See-through.
- **Match pages:** page by page, starting at a page you choose, or the same overlay page on every page.
- **Line up:** move the overlay up, down, left or right, in points, millimetres or inches. Use **Size** and **Fit to page** to adjust it.
- **Show overlay:** press **F8** to turn it on or off.
- **Add to:** Current page, Selected pages or All matched pages.

Press **Add overlay to pages** to add the overlay as a change. You can undo it. Choose **Leave compare** to stop. Press **Esc** also stops it.

Overlay messages:

| Message | What it means |
|---|---|
| Comparing with «name». The overlay is only on screen. | Compare is on. The overlay is not in the file yet. |
| «name» has unsaved changes. The overlay shows its last saved version. | The overlay file has changes that are not saved. |
| «name» is a kind of form that can't be used as an overlay. | The overlay file is an XFA form. |
| The overlay file has changed or can no longer be read, so comparing has stopped. Choose the PDF again to carry on. | The overlay file was changed, moved or deleted, or another program has it locked. |
| The overlay page is a different size. | The overlay and the page are different sizes. Choose Fit to page. |
| This page has no overlay page. | The overlay has fewer pages than this document. |
| “Differences” is for viewing only. Choose Both or See-through to add the overlay to the pages. | Differences cannot be added to pages. |

Comments and form boxes in the overlay file are not copied.
