# PDF Suite

PDF Suite is a free, open-source PDF app for Windows. You can open, read, search and organize PDF files in tabs. It runs on your own computer, and your files stay there. The app is built with Electron and uses the MuPDF engine to read and change PDF files.

## What it can do in Version 1

- Open PDF files, including files that have a password, in tabs.
- Reopen your tabs after the app closes unexpectedly.
- Open files up to 1 GB to read and search. Edit and save files up to 500 MB.
- Read with zoom, Fit Width, Fit Page, a Loupe magnifier and a Pan and Zoom window.
- Split the screen to see two parts of one file, or two files, side by side with the scrolling linked.
- Use dark mode, or change the page colors to make reading easier.
- Search the text of a document, with match case and whole word options.
- Use the Thumbnails, Bookmarks and Properties panels.
- Organize pages: insert blank, lined or grid pages, or pages from another PDF; delete, duplicate, replace, reverse and extract pages; drag pages to change their order; rotate pages; crop margins or auto-crop white space; make all pages one size.
- Cut Pages in Half: cut a double-page scan into two single pages.
- Combine PDFs, pictures and text files into one PDF. Split a PDF into several files. Lay one PDF over another to compare them.
- Save, save as and undo.

See the [user guide](docs/user-guide/index.md) for step-by-step help.

## Download and first run (Windows)

1. Go to the Releases page of this project on GitHub: https://github.com/karthikbhaskar-1/pdf-suite/releases
2. Pick one of the three downloads:
   - **Installer** (`PDF-Suite-Setup-<version>-x64.exe`): recommended. It sets up the file association for PDF files.
   - **Portable zip** (`PDF-Suite-Portable-<version>-x64.zip`): no installation, and it starts fastest. Unzip the whole folder anywhere, then run `PDF Suite.exe` inside it. The first page showed after about 0.5 seconds (median of 10 starts).
   - **Portable `.exe`** (`PDF-Suite-Portable-<version>-x64.exe`): a single file, no installation. It unpacks itself on every start, so the first page showed after about 7 seconds (median of 10 starts).
3. Run the installer, or `PDF Suite.exe` from the unzipped folder, or the portable `.exe`. For the zip, unblock the zip file (see below) before you unzip it.

**The first releases are not code-signed.** Windows SmartScreen may show a blue box that says "Windows protected your PC." This is expected for an unsigned app. To run PDF Suite anyway:

- Click **More info**, then click **Run anyway**.

Or, before you run the file:

1. Right-click the downloaded file and choose **Properties**.
2. At the bottom of the **General** tab, tick **Unblock**.
3. Click **OK**, then run the file.

Signing is planned. See the [code signing policy](docs/release/CODE-SIGNING-POLICY.md).

## Known limitations

- Zoom: pages look slightly soft above about 400% zoom.
- File size: a file up to 1 GB opens to read and search. A file over 500 MB opens for viewing only.

The full list is in the [release notes](docs/release/RELEASE-NOTES-0.1.0.md#known-limitations).

## Build from source

You need Node.js and npm.

```
npm ci
npm run fixtures
node scripts/download-test-corpus.mjs   # optional
npm test
npm run desktop:pack
```

- `npm ci` installs the exact versions in the project.
- `npm run fixtures` generates the test fixtures (they are not committed). It is needed before `npm test`.
- `node scripts/download-test-corpus.mjs` is optional: it downloads the public sample PDFs. Tests that need a sample PDF that is not present are skipped, with the reason shown.
- `npm test` runs the test suite.
- `npm run desktop:pack` builds the app into the release folder, without an installer.

To build the installer, the portable `.exe` and the portable zip, run `npm run desktop:build`.

## Licence

Copyright (c) The PDF Suite authors.

PDF Suite is free software, licensed under the **GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later)**. See [LICENSE](LICENSE).

This licence is required because PDF Suite uses MuPDF, which is licensed under the AGPL. Other components use licences that work with the AGPL.

Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### Source for bundled components

PDF Suite bundles **mupdf.js 1.28.6, unmodified**. MuPDF is licensed under the AGPL, so its source is available: official repository (from the package's own metadata) https://cgit.ghostscript.com/mupdf.git/ , source for the 1.28.6 release: https://registry.npmjs.org/mupdf/-/mupdf-1.28.6.tgz. PDF Suite's own source is in this repository.

Electron's bundled `ffmpeg.dll` is licensed under the LGPL. Its source is part of the Chromium and Electron source trees; see https://github.com/electron/electron for Electron's source and release tags.


## Code signing

Code signing for Windows releases is planned through SignPath Foundation. The policy is in [CODE-SIGNING-POLICY.md](docs/release/CODE-SIGNING-POLICY.md).

## Report a problem

Please report bugs and ask for features on GitHub Issues: https://github.com/karthikbhaskar-1/pdf-suite/issues

Before you post, check the log. In the app, choose **Help ▸ Open Logs Folder**. Remove any private information from the log before you share it.
