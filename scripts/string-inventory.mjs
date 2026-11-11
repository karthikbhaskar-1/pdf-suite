// Lists every user-facing string in src/ and electron/ with file:line and writes docs/milestone-1.5/strings.md, grouped by feature.
// Run: node scripts/string-inventory.mjs
// What counts: JSX text; string attributes that people read or hear (aria-label, title, placeholder, alt, label, ...); and
// string literals or templates that read as a sentence or label (letters, and a space or a capital first letter) elsewhere
// in non-test code, except where the code position says they are not shown (imports, console calls, comparisons, class
// names, data-*, type literals, object keys). It errs on the side of listing; the review prunes.
import ts from 'typescript';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'docs/milestone-1.5/strings.md');
const TEXT_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'tooltip', 'description', 'text', 'message', 'heading', 'caption', 'summary']);
const SILENT_CALL = /^(console|logger|log|diag|assert|expect|require)\b|\.(log|warn|debug|info|addEventListener|removeEventListener|querySelector|querySelectorAll|getElementById|matches|closest|setAttribute|getAttribute|removeAttribute|postMessage|on|once|off|send|invoke|handle|emit|add|remove|toggle|contains|test|match|replace|replaceAll|split|startsWith|endsWith|includes|indexOf|join|padStart|padEnd|get|set|has|delete|resolve|dirname|basename|extname)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const FAULT_CODES = new Set(['PasswordNeeded', 'WrongPassword', 'Corrupt', 'NotPdf', 'Empty', 'Unsupported', 'Internal', 'Cancelled', 'Conflict', 'NeedsEncryptionChoice', 'Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']);

function looksLikeText(s) {
  const t = s.trim();
  if (FAULT_CODES.has(t)) return false; // error codes and PDF info keys, not shown
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return false;
  if (!t.includes(' ') && /^[a-z0-9_.:/#@$&{}\-\\[\]()*+?^|=<>%,;!~]+$/.test(t)) return false; // identifiers, paths, css, ids
  if (/^(https?:|file:|data:|\.{0,2}\/)/.test(t)) return false;
  if (/^[A-Za-z][A-Za-z0-9]*([.:][A-Za-z0-9-]+)+$/.test(t)) return false; // dotted or namespaced ids
  if (/^[\w-]+\/[\w.+*-]+$/.test(t)) return false; // mime types
  if (/^[MmLlCcZzHhVv][\d\s.,-]/.test(t)) return false; // svg paths
  if (!t.includes(' ') && /^[A-Z0-9_]+$/.test(t)) return false; // CONSTANT_IDS
  if (!t.includes(' ') && /^[a-z]+([A-Z][a-z0-9]*)+$/.test(t)) return false; // camelCase ids
  return t.includes(' ') || /^[A-Z][a-z]+/.test(t);
}

function enclosingCall(node) {
  for (let q = node.parent; q; q = q.parent) {
    if (ts.isCallExpression(q) || ts.isNewExpression(q)) return q;
    if (ts.isStatement(q) || ts.isArrowFunction(q) || ts.isFunctionExpression(q)) return null;
  }
  return null;
}

function skip(node) {
  const p = node.parent;
  if (!p) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) || ts.isPropertySignature(p) || ts.isEnumMember(p) || ts.isCaseClause(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
  const attr = ts.isJsxAttribute(p) ? p : ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent) ? p.parent : null;
  if (attr) return !TEXT_ATTRS.has(attr.name.getText());
  if (ts.isPropertyAssignment(p) && /^(className|id|key|type|role|name|href|src|style|testId|icon|variant|kind|mode|channel|accelerator|shortcut|keys|combo|code|command|commandId)$/.test(p.name.getText())) return true;
  const call = enclosingCall(node);
  if (call && ts.isCallExpression(call) && SILENT_CALL.test(call.expression.getText())) return true;
  return false;
}

function feature(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'electron') return 'electron (main process and preload)';
  if (parts[1] === 'features') return `features/${parts[2]}`;
  if (parts[1] === 'engine') return `engine${parts[2] === 'mupdf' ? '/mupdf' : parts[2] === 'pdfjs' ? '/pdfjs' : ''}`;
  if (['ui', 'panels', 'app', 'core', 'platform'].includes(parts[1])) return parts[1];
  return 'other';
}

function kindOf(node) {
  const p = node.parent;
  const attr = ts.isJsxAttribute(p) ? p : ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent) ? p.parent : null;
  if (attr) return attr.name.getText();
  const call = enclosingCall(node);
  if (call) {
    const c = call.expression.getText();
    if (/pushToast/.test(c)) return 'toast';
    if (/Error$|Fault$/.test(c)) return 'error';
  }
  if (ts.isPropertyAssignment(p)) return p.name.getText();
  return 'string';
}

const rows = [];
for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'electron'))]) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (node, value, kind) => {
    const v = value.replace(/\s+/g, ' ').trim();
    if (!v) return;
    rows.push({ rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, value: v, kind, feature: feature(rel) });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      if (/[A-Za-z]{2}/.test(node.getText())) add(node, node.getText(), 'jsx text');
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!skip(node) && looksLikeText(node.text)) add(node, node.text, kindOf(node));
    } else if (ts.isTemplateExpression(node)) {
      const raw = node.head.text + node.templateSpans.map((s) => `{${s.expression.getText().slice(0, 30)}}` + s.literal.text).join('');
      const plain = node.head.text + node.templateSpans.map((s) => ' ' + s.literal.text).join('');
      if (!skip(node) && looksLikeText(plain) && /[A-Za-z]{3}/.test(plain)) add(node, raw, kindOf(node));
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

rows.sort((a, b) => a.feature.localeCompare(b.feature) || a.rel.localeCompare(b.rel) || a.line - b.line);
const byFeature = new Map();
for (const r of rows) {
  if (!byFeature.has(r.feature)) byFeature.set(r.feature, []);
  byFeature.get(r.feature).push(r);
}
const esc = (s) => s.replace(/\|/g, '\\|');
let md = `# User-facing string inventory\n\nGenerated by scripts/string-inventory.mjs (do not edit by hand). ${rows.length} strings in ${new Set(rows.map((r) => r.rel)).size} files.\n\nA string is listed if it is JSX text, a text attribute (aria-label, title, placeholder, ...), or a sentence- or label-like literal outside imports, console calls, comparisons and class names. Some listed items are internal; the review in strings-findings.md prunes them.\n\n`;
md += `| Feature | Strings |\n|---|---|\n` + [...byFeature].map(([f, rs]) => `| ${f} | ${rs.length} |`).join('\n') + '\n';
for (const [f, rs] of byFeature) {
  md += `\n## ${f}\n\n| file:line | kind | string |\n|---|---|---|\n`;
  md += rs.map((r) => `| ${r.rel}:${r.line} | ${r.kind} | ${esc(r.value)} |`).join('\n') + '\n';
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md);
console.log(`${rows.length} strings in ${byFeature.size} groups -> ${relative(ROOT, OUT)}`);
