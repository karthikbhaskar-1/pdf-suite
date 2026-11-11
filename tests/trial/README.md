# MuPDF text-edit trial (1.2.0, blueprint "Trial run" (a))

Question: can mupdf.js (pinned 1.28.6) change the words inside an existing content stream
without moving other text or changing the page? The answer decides whether V3 needs a PDFium
fallback. Bar: 5 of 5 corpus files pass.

Results: `results/1.2.0.json` (per-file metrics, PASS/FAIL, failure reasons).

## Rerun

Requires Node 22+ and the project's `node_modules` (mupdf and pdfjs-dist come from there).
Run from the project root.

1. Corpus (not committed; `corpus/` is gitignored):
   ```
   mkdir -p tests/trial/corpus/{tracemonkey,arxiv,irs-fw9,word-export,edge-print}
   curl -L -o tests/trial/corpus/tracemonkey/tracemonkey.pdf https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/tracemonkey.pdf
   curl -L -o tests/trial/corpus/arxiv/arxiv.pdf https://arxiv.org/pdf/1706.03762
   curl -L -o tests/trial/corpus/irs-fw9/fw9.pdf https://www.irs.gov/pub/irs-pdf/fw9.pdf
   ```
   - Word export: `powershell -File tests/trial/make-word-export.ps1` (Word COM, SaveAs2 as
     docx then PDF format 17). In the 1.2.0 session the save calls never returned, so this file is
     missing and reported as BLOCKED.
   - Edge export: write a small HTML page to a scratch folder, then
     `msedge --headless --print-to-pdf=tests/trial/corpus/edge-print/edge-print.pdf <page.html>`.
     The page used: a two-paragraph "Field Notes on River Survey" page, Georgia 14pt body.
   - Do not download from adobe.com (owner ruling).
2. `node tests/trial/edit-spike.mjs` writes `results/1.2.0.json` and `out/<id>-edited.pdf`.
   Pass one file with `node tests/trial/edit-spike.mjs <path-to-pdf>` (prints JSON, no results file).
3. `node tests/trial/pdfjs-crosscheck.mjs` reads the edited files with pdf.js (a second parser)
   and checks the reversed word is present and the original is gone from page 1.

## Method

1. Lex each page-1 content stream (and reachable Form XObjects) by hand: strings, hex strings,
   arrays, TJ numbers, q/Q, BT/ET, Tf, inline images skipped. Show strings and their byte offsets
   are recorded.
2. Decode glyph codes per font. Use the font's ToUnicode CMap when present. Otherwise align the
   page-1 content glyph codes, in order, with mupdf's structured-text characters, skipping
   mupdf's synthetic spaces (`learnFromStext`). Conflicts are counted in the results file. The
   end-to-end checks below verify the result through mupdf's and pdf.js's own decoders, so a bad
   learned mapping shows up as a failure.
3. Pick a word: an interior word of a paragraph line on page 1, letters only, 4+ characters, not
   a palindrome. The word must occur once on page 1, the reversed word must not occur anywhere
   in the document, and the codes must be in the same font with no word-space kern (TJ number
   <= -200), BT/ET or cm between them. Td/TD/Tm/T* do not break adjacency (they only move
   a glyph slot).
4. Reverse the word's glyph codes in place. TJ kerns and operators stay where they are. Rewrite
   each affected string as hex, `writeStream` the content stream, `saveToBuffer`, reopen.
5. Measure before and after:
   - other characters' quads (structured text): max movement, must be <= 0.01 pt
   - the word's union box: max movement, must be <= 0.25 pt (per-glyph movement is reported
     separately, since glyph slots change identity)
   - same font name for the word's characters
   - page 1 rendered at 2x: differing pixels outside the word box padded by 1 pt, must be 0
   - search for the reversed word: exactly 1 hit, union box within 0.5 pt of the original
   - other characters' text and font unchanged; the word reads back reversed

## Known limits

- Candidate rules were set during development: page-1 uniqueness (not whole-document), and a
  paragraph line is either in a text block with 2+ lines or at the body size next to another
  body-size line (Chromium gives each line its own block). The Td rule was changed so that
  Chromium's per-glyph layout is eligible at all; the change is about the operator semantics, not
  the outcome, and the edge-print result came after it.
- Stext alignment is a harness approximation for fonts without ToUnicode. It has many conflicts on
  tracemonkey and IRS (see `decoding` in the results), which is why the end-to-end checks matter.
- Only page 1 is edited, and only the content stream that holds the word.
- Chromium/Skia glyph advances come from `Td`, not from font widths, so reversing codes moves the
  word's right edge by the glyph-width difference.
