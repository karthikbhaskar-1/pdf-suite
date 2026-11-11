# PDF Suite 0.1.0

This is the first public release of PDF Suite. It is a free, open-source PDF app for Windows.

**This release is not code-signed.** Windows SmartScreen may show "Windows protected your PC." To run the app, click **More info**, then **Run anyway**. Or right-click the file, choose **Properties**, tick **Unblock** at the bottom of the **General** tab, and click **OK**. See the [README](../../README.md#download-and-first-run-windows).

## Downloads

- **Installer** (`PDF-Suite-Setup-0.1.0-x64.exe`): recommended.
- **Portable zip** (`PDF-Suite-Portable-0.1.0-x64.zip`): unzip the whole folder anywhere and run `PDF Suite.exe`. It starts fastest: first page after about 0.5 seconds (median of 10 starts on the test machine, range 0.48 to 0.59). If you unblock the zip file before unzipping (see above), the files inside are not blocked either.
- **Portable `.exe`** (`PDF-Suite-Portable-0.1.0-x64.exe`): one file that unpacks itself on every start. First page after about 7 seconds (median of 10 starts, range 6.7 to 7.6).

## What is included

**Opening and reading**
- Open PDF files in tabs, including files with a password.
- Tabs come back after the app closes unexpectedly.
- Zoom, Fit Width, Fit Page, Actual Size, and zoom with Ctrl and the mouse wheel.
- Split the screen to see two parts of one file, or two files, with linked scrolling.
- Loupe magnifier and Pan and Zoom window.
- Dark mode and page colors.
- Search with match case and whole word.
- Thumbnails, Bookmarks and Properties panels.

**Organizing pages**
- Insert blank, lined and grid pages, or pages from another PDF.
- Delete, duplicate, replace, reverse and extract pages.
- Drag pages to change their order.
- Rotate pages by 90 or 180 degrees, or by a custom angle.
- Crop margins, or auto-crop white space.
- Make all pages one size, such as Letter or A4.
- Save, Save As and undo.

**Menus and toolbar**
- A menu bar with File, Edit, View, Pages, Window and Help.
- An icon toolbar that fits narrow windows, with a ... button for the rest.
- A status bar with page and zoom controls.
- A command palette (Ctrl+K).

**Pages**
- Cut Pages in Half. It cuts each double-page scan into two single pages.
- Combine Files, Split into Files and Overlay to Compare (see below).

**Safety**
- Warnings when a file changes on disk.
- A bar that stays when an open file is moved, renamed or deleted, with Save, Save As… and Dismiss.
- Recovery of unsaved changes after an unexpected close.
- Save checks the file on disk first.

## Known limitations

These are known problems in this release. Some are small, and some are planned for a later release.

- **Saving:** if another program changes the file at the very same moment as your save, its change can still be overwritten. The window for this is now very short.
- **Same file twice:** a file opened once through a mapped network drive and once through its network path opens twice.
- **Page numbers at 50% zoom:** the page box can skip a page while you scroll. Rotating twice after jumping to a page can rotate the wrong page.
- **Keyboard:** the Loupe and Pan and Zoom windows cannot be moved or resized with the keyboard.
- **Long sessions:** memory use can grow after many full scans of the thumbnails. Restart the app if it becomes slow.
- **Scrolling:** a fast scroll can pause for a fraction of a second now and then.
- Zoom: pages look slightly soft above about 400% zoom.
- **File size:** a file up to 1 GB opens. Editing and saving work up to 500 MB. A file over 500 MB opens for viewing only.
- **Start-up:** the portable `.exe` takes about 7 seconds to show the first page, because it unpacks itself on every start. Use the installer or the portable zip (about 0.5 seconds) if that is too slow.
- **Redo:** redo steps are not kept after a restart.
- **A document that stops working:** it does not restart by itself. After about 30 seconds a bar says so. Choose **Reopen** to open it again with your unsaved edits.
- **Rotation:** rotating a page back and forth by a small angle can make link and note boxes a little bigger.
- **Forms:** some government-style forms (XFA) can be viewed but not edited. Search highlights can land in the wrong place on some of these forms, and text typed into form boxes is not searched.
- **Background tabs:** if another program deletes the file of a background tab that has no unsaved changes, that tab cannot save it back yet.
- **Web version:** this release is for Windows. The web version is not covered by this release's checks.

## Combine, Split and Overlay

Combine Files, Split into Files and Overlay to Compare are included in this release. Check the [user guide](../user-guide/merge-split-cut-compare.md) for what each command does.

- Combine Files does not accept Word, Excel or PowerPoint files yet. Save them as PDF first.
- Combine Files reads text files written in Latin, Greek and Cyrillic letters only. Other letters appear as "?".

## Licence and source

PDF Suite is licensed under AGPL-3.0-or-later. See [LICENSE](../../LICENSE) and [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md).

**Source for bundled components.** PDF Suite bundles **mupdf.js 1.28.6, unmodified**. MuPDF is licensed under the AGPL, so its source is available: official repository (from the package's own metadata) https://cgit.ghostscript.com/mupdf.git/ , source for the 1.28.6 release: https://registry.npmjs.org/mupdf/-/mupdf-1.28.6.tgz. PDF Suite's own source is in this repository.

Electron's bundled `ffmpeg.dll` is licensed under the LGPL. Its source is part of the Chromium and Electron source trees; see https://github.com/electron/electron for Electron's source and release tags.

Code signing policy: [CODE-SIGNING-POLICY.md](CODE-SIGNING-POLICY.md).

To report a problem, use [GitHub Issues](https://github.com/karthikbhaskar-1/pdf-suite/issues).
