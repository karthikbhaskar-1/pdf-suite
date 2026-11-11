// Sign-off probes for ticket 1.2.2 (tests/signoff5). Drives the packaged app through tests/e2e/helpers.mjs
// (PDFSUITE_E2E=1: inactive windows, no Recent-list writes). Nothing here edits product code.
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export * from '../signoff4/lib.mjs';
import { fixture, waitFor, toasts, pageCount, showPanel, delay } from '../signoff4/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT5 = join(here, 'out');
mkdirSync(OUT5, { recursive: true });
export const SCRATCH = join(process.env.PDFSUITE_SCRATCH ?? tmpdir(), 'signoff5');
export const WORK = join(SCRATCH, `work-${process.pid}`);
mkdirSync(WORK, { recursive: true });
let seq = 0;
/** A copy of a fixture under the scratch work folder, in its own subfolder, optionally renamed. */
export function mk(name, as = name) {
  const dir = join(WORK, String(++seq));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, as);
  copyFileSync(fixture(name), path);
  return { dir, path, name: as };
}
export function wipeWork() {
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless */ }
}
export const sha = (pathOrBuf) => createHash('sha1').update(typeof pathOrBuf === 'string' ? readFileSync(pathOrBuf) : pathOrBuf).digest('hex').slice(0, 10);
export const sameBytes = (path, buf) => existsSync(path) && readFileSync(path).equals(buf);
/** A valid PDF that differs from every other call: a fixture plus a trailing comment. */
export function outsideBytes(tag, base = 'mixed-sizes-rotated.pdf') {
  return Buffer.concat([readFileSync(fixture(base)), Buffer.from(`\n%outside-${tag}-${Date.now()}\n`)]);
}
export function report(name) {
  const file = join(OUT5, `${name}.log`);
  writeFileSync(file, `# ${name} ${new Date().toISOString()}\n`);
  const results = [];
  const say = (line) => { console.log(line); appendFileSync(file, line + '\n'); };
  return {
    say,
    info: (m) => say(`INFO  ${m}`),
    check(label, ok, detail = '') { results.push({ label, ok: !!ok }); say(`${ok ? 'PASS ' : 'FAIL '} ${label}${detail ? ` :: ${detail}` : ''}`); return !!ok; },
    async step(label, fn) {
      try { await fn(); } catch (e) { results.push({ label: `${label} threw`, ok: false }); say(`FAIL  ${label} :: threw ${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 400)}`); }
    },
    summary() { const failed = results.filter((r) => !r.ok); say(`SUMMARY ${results.length - failed.length}/${results.length} passed`); for (const f of failed) say(`  failed: ${f.label}`); return failed.length; },
  };
}
/** Toasts shown since index `from`. */
export const toastsSince = async (win, from) => (await toasts(win)).slice(from);
export const toastCount = async (win) => (await toasts(win)).length;
/** Waits for a toast matching `re` among those shown after index `from`. Returns it, or null after the timeout. */
export async function waitToast(win, from, re, timeoutMs = 15000) {
  try {
    const r = await waitFor(async () => (await toastsSince(win, from)).find((t) => re.test(t)) ?? null, { timeoutMs, label: `toast ${re}` });
    return r.value;
  } catch { return null; }
}
export const BLOCKED = /Another program changed .+, so nothing was saved/;
export const barShown = async (win) => (await win.locator('.doc-bar', { hasText: 'This file changed on disk' }).count()) > 0;
/** Duplicates page 1 (an edit that changes the page count) and waits for the count. */
export async function dup(win) {
  const before = await pageCount(win);
  await showPanel(win, 'Thumbnails');
  await win.locator('.thumb').first().waitFor({ timeout: 20000 });
  await win.evaluate(() => { const l = document.querySelector('.thumb-list'); if (l) l.scrollTop = 0; });
  await delay(150);
  await win.locator('.thumb').first().click();
  await win.keyboard.press('Control+d');
  await waitFor(async () => (await pageCount(win)) === before + 1, { timeoutMs: 20000, label: `page count ${before + 1}` });
  return before + 1;
}
export { readFileSync, writeFileSync, existsSync };
