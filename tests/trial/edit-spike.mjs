// Text-edit trial for MuPDF (1.2.0 blueprint, "Trial run" section (a)).
//
// For each corpus PDF:
//   1. Pick one unique interior word on a line of a paragraph on page 1.
//   2. Lex the content stream (strings, hex strings, arrays, TJ kerns, q/Q, BT/ET),
//      find the word's glyph codes (decoded via the font's ToUnicode CMap), and
//      reverse their order. The glyph set is unchanged, so no font subsetting is needed.
//   3. Write the stream back, save, reopen, and measure geometry, font, render and search.
//
// Run:  node tests/trial/edit-spike.mjs            (all corpus files)
//       node tests/trial/edit-spike.mjs <file.pdf> (one file)
// Corpus files are untrusted data. They are only parsed, never executed.

import * as mupdf from "mupdf";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, "corpus");
const OUT = path.join(HERE, "out");
const RESULTS = path.join(HERE, "results", "1.2.0.json");

// Expected corpus, in blueprint order. A missing file is reported as BLOCKED, not skipped.
const EXPECTED = [
  { id: "tracemonkey", file: "tracemonkey/tracemonkey.pdf", kind: "pdf.js test corpus (tracemonkey.pdf)" },
  { id: "arxiv", file: "arxiv/arxiv.pdf", kind: "arXiv LaTeX paper (1706.03762)" },
  { id: "irs-fw9", file: "irs-fw9/fw9.pdf", kind: "IRS Form W-9 (irs.gov)" },
  { id: "word-export", file: "word-export/word-export.pdf", kind: "Word export (Word COM, SaveAs2 format 17)" },
  { id: "edge-print", file: "edge-print/edge-print.pdf", kind: "Edge headless print-to-pdf of local HTML" },
];

const PT_LIMITS = { otherCharsMaxPt: 0.01, editedWordMaxPt: 0.25, searchHitMaxPt: 0.5 };
const RENDER_SCALE = 2; // 144 dpi
const RENDER_PAD_PT = 1; // pixels within 1pt of the word box count as "inside"

// ---------- small helpers ----------

// mupdf returns its own Buffer type: copy out via asUint8Array().
const bytesOf = (x) => Buffer.from(x.asUint8Array());
const latin1 = (b) => Buffer.from(b).toString("latin1");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const isNull = (o) => !o || o.isNull();
function dictGet(o, key) {
  if (isNull(o) || !o.isDictionary()) return null;
  const v = o.get(key);
  return isNull(v) ? null : v;
}
function quadBox(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function unionBox(quads) {
  const boxes = quads.map(quadBox);
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}
const maxAbsDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const r4 = (n) => Math.round(n * 1e4) / 1e4;

// ---------- structured text ----------

function collectChars(doc, pageNo) {
  const page = doc.loadPage(pageNo);
  const st = page.toStructuredText("preserve-whitespace");
  const chars = [];
  let block = -1;
  let line = -1;
  st.walk({
    beginTextBlock() {
      block++;
    },
    beginLine() {
      line++;
    },
    onChar(c, origin, font, size, quad) {
      chars.push({ c, q: Array.from(quad), font: font.getName(), size, line, block });
    },
  });
  return chars;
}

// Search hits as mupdf reports them (used after the edit).
function countHits(doc, needle) {
  let total = 0;
  const hits = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const res = doc.loadPage(p).search(needle);
    for (const h of res) {
      total++;
      hits.push({ page: p, quads: h });
    }
  }
  return { total, hits };
}

// Cheap pre-check on extracted text (used during candidate selection).
function textOccurrences(docText, needle) {
  const re = new RegExp(`(?<![A-Za-z])${needle}(?![A-Za-z])`, "gi");
  return (docText.match(re) ?? []).length;
}

// ---------- content-stream lexer ----------

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([...Buffer.from("()<>[]{}/%")]);

// Returns operators with operands, plus the show-string tokens with their byte offsets.
function lexContent(buf) {
  let i = 0;
  const n = buf.length;
  const skipWS = () => {
    while (i < n) {
      const c = buf[i];
      if (WS.has(c)) i++;
      else if (c === 0x25) {
        while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
      } else break;
    }
  };
  function parseObj() {
    skipWS();
    if (i >= n) return null;
    const start = i;
    const c = buf[i];
    if (c === 0x28) {
      // literal string, nested parens, escapes
      i++;
      let lvl = 1;
      const out = [];
      while (i < n && lvl > 0) {
        const d = buf[i];
        if (d === 0x5c) {
          const e = buf[i + 1];
          i += 2;
          switch (e) {
            case 0x6e: out.push(10); break;
            case 0x72: out.push(13); break;
            case 0x74: out.push(9); break;
            case 0x62: out.push(8); break;
            case 0x66: out.push(12); break;
            case 0x28: case 0x29: case 0x5c: out.push(e); break;
            case 0x0d: if (buf[i] === 0x0a) i++; break; // line continuation
            case 0x0a: break;
            default:
              if (e >= 0x30 && e <= 0x37) {
                let v = e - 0x30;
                for (let k = 0; k < 2 && buf[i] >= 0x30 && buf[i] <= 0x37; k++) v = v * 8 + (buf[i++] - 0x30);
                out.push(v & 255);
              } else out.push(e);
          }
        } else if (d === 0x28) {
          lvl++;
          out.push(d);
          i++;
        } else if (d === 0x29) {
          lvl--;
          i++;
          if (lvl > 0) out.push(d);
        } else {
          out.push(d);
          i++;
        }
      }
      return { t: "str", raw: "literal", bytes: Buffer.from(out), start, end: i };
    }
    if (c === 0x3c && buf[i + 1] !== 0x3c) {
      i++;
      let hex = "";
      while (i < n && buf[i] !== 0x3e) {
        const ch = String.fromCharCode(buf[i++]);
        if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
      }
      i++;
      if (hex.length % 2) hex += "0";
      return { t: "str", raw: "hex", bytes: Buffer.from(hex, "hex"), start, end: i };
    }
    if (c === 0x3c && buf[i + 1] === 0x3c) {
      // dictionary: skip, honouring nesting
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        skipWS();
        if (i >= n) break;
        if (buf[i] === 0x3e && buf[i + 1] === 0x3e) { i += 2; depth--; }
        else if (buf[i] === 0x3c && buf[i + 1] === 0x3c) { i += 2; depth++; }
        else if (buf[i] === 0x28) parseObj();
        else i++;
      }
      return { t: "dict", start, end: i };
    }
    if (c === 0x5b) {
      i++;
      const items = [];
      for (;;) {
        skipWS();
        if (i >= n) break;
        if (buf[i] === 0x5d) { i++; break; }
        const v = parseObj();
        if (!v) break;
        items.push(v);
      }
      return { t: "arr", items, start, end: i };
    }
    if (c === 0x2f) {
      i++;
      const s = i;
      while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
      return { t: "name", v: latin1(buf.subarray(s, i)), start, end: i };
    }
    if (DELIM.has(c)) {
      i++;
      return { t: "kw", v: String.fromCharCode(c), start, end: i };
    }
    const s = i;
    while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
    const word = latin1(buf.subarray(s, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: "num", v: parseFloat(word), start, end: i };
    return { t: "kw", v: word, start, end: i };
  }

  const ops = [];
  let operands = [];
  let inlineImages = 0;
  while (true) {
    skipWS();
    if (i >= n) break;
    const v = parseObj();
    if (!v) break;
    if (v.t === "kw" && !["true", "false", "null"].includes(v.v)) {
      if (v.v === "BI") {
        // inline image: skip key/value pairs to ID, then binary data to EI
        inlineImages++;
        for (;;) {
          skipWS();
          if (i >= n) break;
          const save = i;
          const t = parseObj();
          if (!t || (t.t === "kw" && t.v === "ID")) break;
          if (i === save) i++;
        }
        i++; // single whitespace after ID
        let j = i;
        while (j < n - 2 && !(WS.has(buf[j - 1]) && buf[j] === 0x45 && buf[j + 1] === 0x49 && (j + 2 >= n || WS.has(buf[j + 2])))) j++;
        i = Math.min(n, j + 2);
        ops.push({ op: "BI", operands: [], start: v.start, end: i });
        operands = [];
        continue;
      }
      ops.push({ op: v.v, operands, start: v.start, end: v.end });
      operands = [];
    } else {
      operands.push(v);
    }
  }
  return { ops, inlineImages };
}

// Walks operators, tracking Tf (with q/Q), BT/ET, and collecting show-string tokens.
function showStrings(ops) {
  const shows = [];
  const stack = [];
  let font = null;
  let size = 0;
  let btDepth = 0;
  let btCount = 0;
  for (const o of ops) {
    const a = o.operands;
    switch (o.op) {
      case "q": stack.push({ font, size }); break;
      case "Q": { const s = stack.pop(); if (s) ({ font, size } = s); break; }
      // Text-object and CTM changes break word adjacency. Td/TD/Tm/T* only move a glyph slot
      // (Chromium writes one Tj per glyph with a Td advance), so they are not barriers: the
      // codes change, the slots and their positions do not.
      case "BT": btDepth++; btCount++; shows.push({ barrier: true }); break;
      case "ET": btDepth = Math.max(0, btDepth - 1); shows.push({ barrier: true }); break;
      case "cm": shows.push({ barrier: true }); break;
      case "Tf": font = a[0]?.v ?? null; size = a[1]?.v ?? 0; break;
      case "Tj":
      case "'":
        if (a[0]?.t === "str") shows.push({ tok: a[0], font, size, inArray: false, op: o.op });
        break;
      case '"':
        if (a[2]?.t === "str") shows.push({ tok: a[2], font, size, inArray: false, op: o.op });
        break;
      case "TJ":
        if (a[0]?.t === "arr") {
          for (const it of a[0].items) {
            // A kern of -200 or more (thousandths of text space) is a word space in TeX output.
            if (it.t === "num") { if (it.v <= -200) shows.push({ barrier: true }); }
            else if (it.t === "str") shows.push({ tok: it, font, size, inArray: true, op: o.op });
          }
        }
        break;
      default: break;
    }
  }
  return { shows, btCount };
}

// ---------- fonts / ToUnicode ----------

const hexToUnits = (hex) => {
  const out = [];
  for (let k = 0; k + 4 <= hex.length; k += 4) out.push(parseInt(hex.slice(k, k + 4), 16));
  return out;
};
const unitsToStr = (units) => String.fromCharCode(...units);

function parseToUnicode(text) {
  const map = new Map();
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(p[1], 16), unitsToStr(hexToUnits(p[2])));
    }
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g;
    for (const r of m[1].matchAll(re)) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      if (hi - lo > 0x10000) continue;
      if (r[3] !== undefined) {
        const base = hexToUnits(r[3]);
        for (let c = lo; c <= hi; c++) {
          const u = base.slice();
          u[u.length - 1] += c - lo;
          map.set(c, unitsToStr(u));
        }
      } else {
        [...r[4].matchAll(/<([0-9A-Fa-f]*)>/g)].forEach((d, idx) => map.set(lo + idx, unitsToStr(hexToUnits(d[1]))));
      }
    }
  }
  return map;
}

function fontInfo(resources, name) {
  const fonts = dictGet(resources, "Font");
  const f = fonts && name ? dictGet(fonts, name) : null;
  if (!f) return null;
  const subtype = dictGet(f, "Subtype")?.asName() ?? "?";
  const enc = dictGet(f, "Encoding");
  const encName = enc && enc.isName() ? enc.asName() : enc ? "stream" : null;
  const tu = dictGet(f, "ToUnicode");
  const cmap = tu ? parseToUnicode(latin1(bytesOf(tu.readStream()))) : null;
  const baseFont = dictGet(f, "BaseFont")?.asName() ?? null;
  const cid = subtype === "Type0";
  return {
    name,
    baseFont,
    subtype,
    encoding: encName,
    kind: subtype === "Type3" ? "Type3" : cid ? `CID (${encName ?? "?"})` : `simple (${subtype})`,
    width: cid ? 2 : 1,
    cmap,
  };
}

// ---------- content streams (page Contents + reachable Form XObjects) ----------

// mupdf's isStream() is unreliable for indirect references (it reports false for some
// stream objects, and resolve() then throws on readStream). Probe by reading the stream.
function asStream(o) {
  if (isNull(o)) return null;
  try {
    o.readStream();
    return o;
  } catch {
    return null;
  }
}

function contentStreams(doc, pageNo) {
  const pobj = doc.findPage(pageNo);
  const pageRes = pobj.getInheritable("Resources");
  const list = [];
  const c = pobj.get("Contents");
  if (!isNull(c) && c.isArray()) {
    for (let i = 0; i < c.length; i++) {
      const s = asStream(c.get(i));
      if (s) list.push({ obj: s, label: `page Contents[${i}]`, res: pageRes, form: false });
    }
  } else {
    const s = asStream(c);
    if (s) list.push({ obj: s, label: "page Contents", res: pageRes, form: false });
  }
  const seen = new Set();
  const walk = (res, depth, path) => {
    if (!res || depth > 8) return;
    const xo = dictGet(res, "XObject");
    if (!xo) return;
    xo.forEach((v, k) => {
      const s = asStream(v);
      if (!s) return;
      if (dictGet(s, "Subtype")?.asName() !== "Form") return;
      const id = s.asIndirect();
      if (seen.has(id)) return;
      seen.add(id);
      const own = dictGet(s, "Resources") ?? res;
      list.push({ obj: s, label: `form ${path}/${k}`, res: own, form: true });
      walk(own, depth + 1, `${path}/${k}`);
    });
  };
  walk(pageRes, 0, "");
  return list;
}

// Collect each show string's glyph codes (one unit per code). Units are decoded later.
function analyseStream(stream) {
  const buf = bytesOf(stream.obj.readStream());
  const { ops, inlineImages } = lexContent(buf);
  const { shows, btCount } = showStrings(ops);
  const fontCache = new Map();
  for (const s of shows) {
    if (s.barrier) continue;
    if (!fontCache.has(s.font)) fontCache.set(s.font, fontInfo(stream.res, s.font));
    const fi = fontCache.get(s.font);
    s.fi = fi;
    s.units = null;
    if (!fi) { s.codes = null; continue; }
    const w = fi.width;
    const bytes = s.tok.bytes;
    s.w = w;
    s.aligned = bytes.length % w === 0;
    s.codes = [];
    for (let k = 0; k + w <= bytes.length; k += w) {
      s.codes.push(w === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k]);
    }
  }
  return { buf, shows, btCount, inlineImages, opCount: ops.length, fonts: fontCache, pageContents: !stream.form };
}

// Learn glyph code -> character for fonts without a ToUnicode CMap. Page-level content
// glyph codes are aligned, in order, with mupdf's structured-text characters. mupdf's
// synthetic spaces (not glyphs in the stream) are skipped. Conflicts are counted, and the
// end-to-end checks catch any wrong mapping.
function learnFromStext(analysed, chars) {
  const map = new Map();
  let j = 0;
  let units = 0;
  let conflicts = 0;
  let unplaced = 0;
  for (const st of analysed) {
    if (!st.pageContents) continue;
    for (const s of st.shows) {
      if (!s.codes || (s.fi && s.fi.cmap)) continue;
      for (const code of s.codes) {
        units++;
        const key = `${s.font}\u0001${code}`;
        let placed = false;
        while (j < chars.length) {
          const ch = chars[j].c;
          if (map.has(key)) {
            if (map.get(key) === ch) { j++; placed = true; break; }
            if (ch === " ") { j++; continue; }
            conflicts++;
            j++;
            placed = true;
            break;
          }
          if (ch === " " && code !== 32) { j++; continue; }
          map.set(key, ch);
          j++;
          placed = true;
          break;
        }
        if (!placed) unplaced++;
      }
    }
  }
  return { map, units, conflicts, unplaced, learnedKeys: map.size };
}

// Attach decoded units: ToUnicode where the font has one, else the stext-learned map.
function decodeShows(analysed, learned) {
  for (const st of analysed) {
    for (const s of st.shows) {
      if (!s.codes) continue;
      s.units = s.codes.map((code) => {
        if (s.fi.cmap) return s.fi.cmap.get(code) ?? null;
        return learned.get(`${s.font}\u0001${code}`) ?? null;
      });
    }
  }
}

// Find occurrences of `word` among consecutive glyph units of one stream, all in one font.
// A word may span several show tokens (TeX kerning splits words), but barriers (word
// spaces, positioning operators, unaligned strings) never fall inside a match.
function findWordInStreams(analysed, word) {
  const found = [];
  const L = word.length;
  analysed.forEach((st, si) => {
    const flat = [];
    st.shows.forEach((sh, shi) => {
      if (sh.barrier || !sh.units || !sh.aligned) { flat.push({ barrier: true }); return; }
      sh.units.forEach((u, ui) => flat.push({ shi, ui, u, font: sh.font }));
    });
    for (let p = 0; p + L <= flat.length; p++) {
      let ok = true;
      for (let k = 0; k < L; k++) {
        const e = flat[p + k];
        if (e.barrier || e.u !== word[k] || e.font !== flat[p].font) { ok = false; break; }
      }
      if (ok) found.push({ si, entries: flat.slice(p, p + L).map((e) => ({ shi: e.shi, ui: e.ui })) });
    }
  });
  return found;
}

// ---------- candidate selection ----------

const isWord = (w) => /^[A-Za-z]{4,}$/.test(w) && w.toLowerCase() !== [...w.toLowerCase()].reverse().join("");

function candidateWords(chars) {
  // Interior words on lines of paragraphs (blocks with 2+ lines), in document order.
  const lineBlockLines = new Map();
  const lines = new Map();
  for (const ch of chars) {
    if (!lines.has(ch.line)) lines.set(ch.line, []);
    lines.get(ch.line).push(ch);
  }
  for (const [, lc] of lines) {
    const b = lc[0].block;
    lineBlockLines.set(b, (lineBlockLines.get(b) ?? 0) + 1);
  }
  // Paragraph rule: the line's text block has 2+ lines, or (for producers that give each line
  // its own block, such as Chromium) the line is at the page's modal body size and has a
  // neighbouring line at that size.
  const ordered = [...lines.entries()];
  const sizeKey = (lc) => Math.round(lc[0].size * 10);
  const sizeCount = new Map();
  for (const [, lc] of ordered) sizeCount.set(sizeKey(lc), (sizeCount.get(sizeKey(lc)) ?? 0) + 1);
  const modal = [...sizeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const inParagraph = (idx) => {
    const [, lc] = ordered[idx];
    if ((lineBlockLines.get(lc[0].block) ?? 0) >= 2) return true;
    if (sizeKey(lc) !== modal) return false;
    const nb = [ordered[idx - 1], ordered[idx + 1]].filter(Boolean);
    return nb.some(([, o]) => sizeKey(o) === modal);
  };
  const out = [];
  for (let idx = 0; idx < ordered.length; idx++) {
    const [lineId, lc] = ordered[idx];
    if (!inParagraph(idx)) continue;
    if (lc.some((c) => c.c.length !== 1)) continue;
    const text = lc.map((c) => c.c).join("");
    const runs = [...text.matchAll(/[^ ]+/g)];
    if (runs.length < 3) continue;
    runs.slice(1, -1).forEach((m) => {
      const word = m[0];
      if (!isWord(word)) return;
      const startIdx = chars.indexOf(lc[m.index]);
      out.push({ word, lineId, block: lc[0].block, startIdx, lineText: text });
    });
  }
  return out;
}

// ---------- per-file trial ----------

function runFile(entry, absFile) {
  const result = {
    id: entry.id,
    corpusFile: path.relative(HERE, absFile).replace(/\\/g, "/"),
    description: entry.kind,
    sha256: sha256(absFile),
    bytes: fs.statSync(absFile).size,
    pass: false,
    failure: null,
    checks: {},
  };
  try {
    const original = fs.readFileSync(absFile);
    const docBefore = mupdf.PDFDocument.openDocument(original, "application/pdf");
    result.pages = docBefore.countPages();
    const charsBefore = collectChars(docBefore, 0);
    result.charsOnPage1 = charsBefore.length;

    // Pick a candidate: unique in the document, reversed form absent, and the word is
    // contiguous glyph codes inside one show string of a page-1 content stream.
    const streams = contentStreams(docBefore, 0);
    const analysed = streams.map(analyseStream);
    const learned = learnFromStext(analysed, charsBefore);
    decodeShows(analysed, learned.map);
    result.decoding = {
      method: "ToUnicode where present, else stext alignment of page-1 content glyphs",
      stextLearnedKeys: learned.learnedKeys,
      stextAlignedUnits: learned.units,
      stextConflicts: learned.conflicts,
      stextUnplaced: learned.unplaced,
    };
    let chosen = null;
    const rejected = { notUniqueOnPage1: 0, reversedPresent: 0, notInOneString: 0, multipleOwners: 0 };
    // Document text (all pages) for the reversed-word pre-check. Joined with spaces per page.
    const docText = [...Array(docBefore.countPages()).keys()]
      .map((p) => docBefore.loadPage(p).toStructuredText("preserve-whitespace").asText())
      .join("\n");
    const page1Text = charsBefore.map((c) => c.c).join("");
    for (const cand of candidateWords(charsBefore)) {
      const rev = [...cand.word].reverse().join("");
      if (textOccurrences(page1Text, cand.word) !== 1) { rejected.notUniqueOnPage1++; continue; }
      if (textOccurrences(docText, rev) !== 0) { rejected.reversedPresent++; continue; }
      const owners = findWordInStreams(analysed, cand.word);
      if (owners.length === 0) { rejected.notInOneString++; continue; }
      if (owners.length > 1) { rejected.multipleOwners++; continue; }
      const stIdx = owners[0].si;
      const own = owners[0];
      const sh = analysed[stIdx].shows[own.entries[0].shi];
      // Locate the same word in page-1 stext: char index + char count must match the word.
      const stextIdx = cand.startIdx;
      const stextWord = charsBefore.slice(stextIdx, stextIdx + cand.word.length).map((c) => c.c).join("");
      if (stextWord !== cand.word) { rejected.notInOneString++; continue; }
      chosen = { cand, rev, owner: own, streamIdx: stIdx, show: sh, stextIdx };
      break;
    }
    result.candidateRejections = rejected;
    if (!chosen) throw new Error(`no eligible word (rejections: ${JSON.stringify(rejected)})`);

    const { cand, rev, owner, streamIdx, show, stextIdx } = chosen;
    const L = cand.word.length;
    const wIdx = [];
    for (let k = 0; k < L; k++) wIdx.push(stextIdx + k);
    const wordBefore = wIdx.map((k) => charsBefore[k]);
    const wordBoxBefore = unionBox(wordBefore.map((c) => c.q));

    const stream = streams[streamIdx];
    const fontInfoObj = show.fi;
    result.word = {
      original: cand.word,
      reversed: rev,
      line: cand.lineText,
      stextCharIndex: stextIdx,
      glyphUnits: L,
      boxBefore: wordBoxBefore.map(r4),
    };
    result.location = {
      stream: stream.label,
      inFormXObject: stream.form,
      contentStreamOps: analysed[streamIdx].opCount,
      btBlocks: analysed[streamIdx].btCount,
      inlineImagesSkipped: analysed[streamIdx].inlineImages,
    };
    result.font = {
      resourceName: show.font,
      baseFont: fontInfoObj.baseFont,
      subtype: fontInfoObj.subtype,
      encoding: fontInfoObj.encoding,
      kind: fontInfoObj.kind,
      toUnicode: !!fontInfoObj.cmap,
      decodedBy: fontInfoObj.cmap ? "ToUnicode" : "stext alignment",
      stextFontName: wordBefore[0].font,
    };
    result.stringTokenBytes = owner.entries.map((e) => analysed[streamIdx].shows[e.shi].tok.bytes.length);
    result.wordSpansStringTokens = new Set(owner.entries.map((e) => e.shi)).size;

    // Build the edit. The word's code units are reversed in order and written back into the
    // same token slots. TJ kerns and everything else stay where they are.
    const shows = analysed[streamIdx].shows;
    const entries = owner.entries;
    const perShow = new Map();
    for (const e of entries) {
      if (!perShow.has(e.shi)) perShow.set(e.shi, Buffer.from(shows[e.shi].tok.bytes));
    }
    const codeBytes = entries.map((e) => {
      const sh = shows[e.shi];
      return Buffer.from(sh.tok.bytes.subarray(e.ui * sh.w, e.ui * sh.w + sh.w));
    });
    codeBytes.reverse().forEach((cb, k) => {
      const e = entries[k];
      cb.copy(perShow.get(e.shi), e.ui * shows[e.shi].w);
    });
    let buf = analysed[streamIdx].buf;
    const order = [...perShow.keys()].sort((a, b) => shows[b].tok.start - shows[a].tok.start);
    for (const shi of order) {
      const tok = shows[shi].tok;
      const hex = `<${perShow.get(shi).toString("hex")}>`;
      buf = Buffer.concat([buf.subarray(0, tok.start), Buffer.from(hex, "latin1"), buf.subarray(tok.end)]);
    }
    const newStream = buf;

    // Write back. Editing in place on the page-1 document that owns this stream.
    const docEdit = mupdf.PDFDocument.openDocument(original, "application/pdf");
    const editStreams = contentStreams(docEdit, 0);
    const target = editStreams[streamIdx];
    target.obj.writeStream(newStream);
    const edited = bytesOf(docEdit.saveToBuffer(""));
    fs.mkdirSync(OUT, { recursive: true });
    const outFile = path.join(OUT, `${entry.id}-edited.pdf`);
    fs.writeFileSync(outFile, edited);
    result.editedFile = path.relative(HERE, outFile).replace(/\\/g, "/");

    // Reopen and measure.
    const docAfter = mupdf.PDFDocument.openDocument(edited, "application/pdf");
    const charsAfter = collectChars(docAfter, 0);
    if (charsAfter.length !== charsBefore.length) {
      throw new Error(`character count changed ${charsBefore.length} -> ${charsAfter.length}`);
    }
    // Text identity: every other character still reads the same, with the same font.
    const wordSetAll = new Set(wIdx);
    const otherTextChanged = charsBefore.filter((c, k) => !wordSetAll.has(k) && (c.c !== charsAfter[k].c || c.font !== charsAfter[k].font)).length;
    const wordAfter = wIdx.map((k) => charsAfter[k]);
    const wordBoxAfter = unionBox(wordAfter.map((c) => c.q));
    result.word.boxAfter = wordBoxAfter.map(r4);
    result.word.textAfter = wordAfter.map((c) => c.c).join("");
    result.word.lineAfter = charsAfter
      .filter((c) => c.line === charsAfter[stextIdx].line)
      .map((c) => c.c)
      .join("");

    // 1. Other characters: quads before vs after.
    const wordSet = new Set(wIdx);
    let otherMax = 0;
    let otherCount = 0;
    charsBefore.forEach((c, k) => {
      if (wordSet.has(k)) return;
      otherCount++;
      otherMax = Math.max(otherMax, maxAbsDiff(c.q, charsAfter[k].q));
    });
    // Per-glyph movement inside the word (informational: glyph slots change identity).
    let perGlyphMax = 0;
    wIdx.forEach((k) => { perGlyphMax = Math.max(perGlyphMax, maxAbsDiff(charsBefore[k].q, charsAfter[k].q)); });
    result.metrics = {
      otherCharsCompared: otherCount,
      otherCharsMaxMovePt: r4(otherMax),
      editedWordUnionMaxMovePt: r4(maxAbsDiff(wordBoxBefore, wordBoxAfter)),
      editedWordPerGlyphMaxMovePt: r4(perGlyphMax),
    };

    // 2. Same font name for the word's characters.
    const fontsBefore = [...new Set(wordBefore.map((c) => c.font))];
    const fontsAfter = [...new Set(wordAfter.map((c) => c.font))];
    result.metrics.fontBefore = fontsBefore;
    result.metrics.fontAfter = fontsAfter;

    // 3. Render page 1 before and after. Pixels outside the word box (plus padding) must match.
    const pmB = docBefore.loadPage(0).toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB, false);
    const pmA = docAfter.loadPage(0).toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB, false);
    const W = pmB.getWidth();
    const H = pmB.getHeight();
    if (pmA.getWidth() !== W || pmA.getHeight() !== H) throw new Error("render size changed");
    const pxB = Uint8Array.from(pmB.getPixels());
    const pxA = Uint8Array.from(pmA.getPixels());
    const comp = pxB.length / (W * H);
    const x0 = Math.floor((wordBoxBefore[0] - RENDER_PAD_PT) * RENDER_SCALE);
    const y0 = Math.floor((wordBoxBefore[1] - RENDER_PAD_PT) * RENDER_SCALE);
    const x1 = Math.ceil((wordBoxBefore[2] + RENDER_PAD_PT) * RENDER_SCALE);
    const y1 = Math.ceil((wordBoxBefore[3] + RENDER_PAD_PT) * RENDER_SCALE);
    let outsideDiff = 0;
    let insideDiff = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * comp;
        let differs = false;
        for (let c = 0; c < comp; c++) if (pxB[o + c] !== pxA[o + c]) { differs = true; break; }
        if (!differs) continue;
        if (x >= x0 && x < x1 && y >= y0 && y < y1) insideDiff++;
        else outsideDiff++;
      }
    }
    result.metrics.renderOutsideDiffPixels = outsideDiff;
    result.metrics.renderInsideDiffPixels = insideDiff;
    result.metrics.renderSize = [W, H, RENDER_SCALE];

    // 4. Search for the reversed word after the edit: exactly 1 hit within 0.5pt.
    const hitsRev = countHits(docAfter, rev);
    const hitsOrig = countHits(docAfter, cand.word);
    result.metrics.searchReversedHits = hitsRev.total;
    result.metrics.searchOriginalHitsAfter = hitsOrig.total;
    if (hitsRev.total === 1) {
      const hb = unionBox(hitsRev.hits[0].quads);
      result.metrics.searchHitMaxMovePt = r4(maxAbsDiff(hb, wordBoxBefore));
    } else {
      result.metrics.searchHitMaxMovePt = null;
    }

    // Verdict.
    const m = result.metrics;
    result.checks = {
      otherCharsMoveLe0_01pt: m.otherCharsMaxMovePt <= PT_LIMITS.otherCharsMaxPt,
      editedWordMoveLe0_25pt: m.editedWordUnionMaxMovePt <= PT_LIMITS.editedWordMaxPt,
      sameFontName: fontsBefore.length === fontsAfter.length && fontsBefore.every((f, i) => f === fontsAfter[i]),
      renderUnchangedOutsideWord: m.renderOutsideDiffPixels === 0,
      searchExactlyOneHitWithin0_5pt: m.searchReversedHits === 1 && m.searchHitMaxMovePt !== null && m.searchHitMaxMovePt <= PT_LIMITS.searchHitMaxPt,
      editedWordReadsReversed: result.word.textAfter === rev,
      otherCharsTextUnchanged: otherTextChanged === 0,
    };
    result.metrics.otherCharsTextChanged = otherTextChanged;
    result.pass = Object.values(result.checks).every(Boolean);
    if (!result.pass) {
      result.failure = Object.entries(result.checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(", ");
    }
  } catch (err) {
    result.pass = false;
    result.failure = `error: ${err.message}`;
    result.errorStack = String(err.stack ?? "").split("\n").slice(0, 4).map((l) => l.trim());
  }
  return result;
}

// ---------- main ----------

const onlyFile = process.argv[2] ? path.resolve(process.argv[2]) : null;
const files = [];
for (const entry of EXPECTED) {
  const abs = path.join(CORPUS, entry.file);
  if (onlyFile && path.resolve(abs) !== onlyFile) continue;
  if (!fs.existsSync(abs)) {
    files.push({ entry, abs: null });
  } else files.push({ entry, abs });
}

const perFile = files.map(({ entry, abs }) => {
  if (!abs) {
    return {
      id: entry.id,
      corpusFile: path.relative(HERE, path.join(CORPUS, entry.file)).replace(/\\/g, "/"),
      description: entry.kind,
      pass: false,
      status: "BLOCKED",
      failure: "corpus file not present (see README: the Word COM export did not complete in this session)",
    };
  }
  const r = runFile(entry, abs);
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${entry.id}  ${r.failure ?? ""}`);
  return r;
});

const passed = perFile.filter((r) => r.pass).length;
const summary = {
  milestone: "1.2.0",
  trial: "mupdf.js in-stream text edit (word glyph-order reversal)",
  mupdfVersion: "1.28.6",
  node: process.version,
  generatedAt: new Date().toISOString(),
  criteria: {
    otherCharsMaxMovePt: PT_LIMITS.otherCharsMaxPt,
    editedWordUnionMaxMovePt: PT_LIMITS.editedWordMaxPt,
    searchHitMaxMovePt: PT_LIMITS.searchHitMaxPt,
    samePhysicalFont: "same resource font name and stext font name for the word's characters",
    renderOutsideWord: `0 differing pixels outside the word box padded by ${RENDER_PAD_PT}pt, at ${RENDER_SCALE}x`,
    search: "exactly 1 hit for the reversed word, union box within 0.5pt of the original word",
  },
  required: `${EXPECTED.length} of ${EXPECTED.length}`,
  passed: `${passed} of ${EXPECTED.length}`,
  verdict: passed === EXPECTED.length ? "PASS" : "FAIL",
  files: perFile,
};

if (!onlyFile) {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\n${summary.passed} files passed. Verdict: ${summary.verdict}. Results: ${RESULTS}`);
} else {
  console.log(JSON.stringify(perFile[0], null, 2));
}
