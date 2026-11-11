// Sign-off round 2 (tests/signoff4) probe helpers. Drives the packaged app through tests/e2e/helpers.mjs
// (PDFSUITE_E2E=1: inactive windows, no Recent-list writes). Nothing here edits product code.
import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as mupdf from 'mupdf';
export * from '../e2e/matrix-lib.mjs';
import { waitFor, statusText, launch as launchRaw, pageCount } from '../e2e/matrix-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const HERE = here;
export const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

export function makeReport(name) {
  const file = join(OUT, `${name}.log`);
  writeFileSync(file, `# ${name} ${new Date().toISOString()}\n`);
  const results = [];
  const say = (line) => {
    console.log(line);
    appendFileSync(file, line + '\n');
  };
  return {
    say,
    info: (m) => say(`INFO  ${m}`),
    check(label, ok, detail = '') {
      results.push({ label, ok: !!ok });
      say(`${ok ? 'PASS ' : 'FAIL '} ${label}${detail ? ` :: ${detail}` : ''}`);
      return !!ok;
    },
    async step(label, fn) {
      try {
        await fn();
      } catch (e) {
        results.push({ label, ok: false });
        say(`FAIL  ${label} :: threw ${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 500)}`);
      }
    },
    summary() {
      const failed = results.filter((r) => !r.ok);
      say(`SUMMARY ${results.length - failed.length}/${results.length} passed`);
      for (const f of failed) say(`  failed: ${f.label}`);
      return failed.length;
    },
  };
}

/** Records every toast, info bar and alert text the app shows from now on. */
export async function watchToasts(win) {
  await win.evaluate(() => {
    if (window.__so4) return;
    window.__so4 = { toasts: [], bars: [] };
    const seen = new WeakSet();
    const scan = () => {
      for (const el of document.querySelectorAll('.toast')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__so4.toasts.push(el.querySelector('span')?.textContent ?? el.textContent ?? '');
      }
      for (const el of document.querySelectorAll('.info-bar, .tab-message, [role="alert"], [role="alertdialog"], [role="dialog"]')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__so4.bars.push((el.textContent ?? '').trim().slice(0, 400));
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  });
}
export const toasts = (win) => win.evaluate(() => [...(window.__so4?.toasts ?? [])]);
export const bars = (win) => win.evaluate(() => [...(window.__so4?.bars ?? [])]);
/** Runs `action`, then waits for a new toast. Returns the new toast texts joined. */
export async function toastAfter(win, action, timeoutMs = 20000) {
  const before = (await toasts(win)).length;
  await action();
  const r = await waitFor(async () => {
    const all = await toasts(win);
    return all.length > before ? all.slice(before) : null;
  }, { timeoutMs, label: 'a new toast' });
  return r.value.join(' | ');
}

/** Clicks through the classic menu bar: menu(win, 'Pages', 'Duplicate'). */
export async function menu(win, top, ...path) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  for (let i = 0; i < path.length; i++) {
    const exact = new RegExp(`^${path[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const base = i === 0
      ? win.locator('.menu-top > .menu-dropdown > .menu-item, .menu-top > .menu-dropdown > .menu-sub-wrap > .menu-item')
      : win.locator('.menu-sub .menu-item');
    const item = base.filter({ has: win.locator('.menu-label', { hasText: exact }) });
    await item.first().waitFor({ timeout: 5000 });
    if (i < path.length - 1) {
      await item.first().hover();
      await win.locator('.menu-sub').waitFor({ timeout: 5000 });
    } else {
      await item.first().click();
    }
  }
}
export async function menuItems(win, top) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  const items = await win.locator('.menu-top > .menu-dropdown > .menu-item, .menu-top > .menu-dropdown > .menu-sub-wrap > .menu-item').evaluateAll((els) =>
    els.map((el) => ({ label: el.querySelector('.menu-label')?.textContent ?? '', disabled: el.disabled, title: el.getAttribute('title') ?? '', accel: el.querySelector('.menu-accel')?.textContent ?? '' })),
  );
  await win.keyboard.press('Escape');
  return items;
}
export const sheet = (win, name) => win.getByRole('dialog', { name });
export async function shot(win, name) {
  try {
    await win.screenshot({ path: join(OUT, `${name}.png`) });
  } catch {
    /* a screenshot is a convenience */
  }
}

/** True for a message a user can read: no raw error names, codes, stack text or object dumps. */
export function plainEnglish(text) {
  if (!text) return true;
  if (/\b(E[A-Z]{4,}|[A-Z][a-z]+Error)\b/.test(text)) return false;
  return !/(Error:|\bat \w+ \(|\bundefined\b|\bnull\b|\[object|\bNaN\b|0x[0-9a-f]{2,}|mupdf|wasm|\{"|\bstack\b|exception|\bInternal\b|\bConflict\b|\bUnsupported\b|invalid-argument|write-failed|path:)/i.test(text);
}

// ---------- Independent reader (the mupdf npm package in plain node, not the app's worker code)
const num = (o) => (o && !o.isNull() ? o.asNumber() : null);
const arr = (o) => {
  if (!o || o.isNull() || !o.isArray()) return null;
  const out = [];
  for (let i = 0; i < o.length; i++) out.push(Math.round(o.get(i).asNumber() * 100) / 100);
  return out;
};
function inherited(page, key) {
  let node = page;
  for (let hops = 0; hops < 50 && node && !node.isNull(); hops++) {
    const v = node.get(key);
    if (v && !v.isNull()) return v;
    node = node.get('Parent');
  }
  return null;
}
export function inspect(path, password, { text = true } = {}) {
  const bytes = readFileSync(path);
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const needs = doc.needsPassword();
    if (needs) {
      const auth = password ? doc.authenticatePassword(password) : 0;
      if (!auth) return { ok: false, needsPassword: true, size: bytes.length };
    }
    const pdf = doc.asPDF();
    const n = doc.countPages();
    const pages = [];
    for (let i = 0; i < n; i++) {
      const obj = pdf.findPage(i);
      let t = '';
      let shown = null;
      if (text) {
        const page = doc.loadPage(i);
        try {
          t = page.toStructuredText().asText().replace(/\s+/g, ' ').trim().slice(0, 60);
        } catch (e) {
          t = `!text-error ${e.message}`;
        }
        const b = page.getBounds();
        shown = [Math.round((b[2] - b[0]) * 100) / 100, Math.round((b[3] - b[1]) * 100) / 100];
        page.destroy?.();
      }
      const annots = obj.get('Annots');
      pages.push({
        media: arr(inherited(obj, 'MediaBox')),
        crop: arr(inherited(obj, 'CropBox')),
        rotate: num(inherited(obj, 'Rotate')) ?? 0,
        shown,
        annots: annots && !annots.isNull() && annots.isArray() ? annots.length : 0,
        text: t,
      });
    }
    let outline = [];
    try {
      const walk = (items) => {
        for (const it of items ?? []) {
          outline.push({ title: it.title, page: typeof it.page === 'number' ? it.page + 1 : it.page });
          walk(it.down);
        }
      };
      walk(doc.loadOutline());
    } catch (e) {
      outline = `!outline-error ${e.message}`;
    }
    const enc = pdf.getTrailer().get('Encrypt');
    return { ok: true, size: bytes.length, eof: /%%EOF\s*$/.test(tail), repaired: pdf.wasRepaired(), encrypted: !!(enc && !enc.isNull()), needsPassword: needs, count: n, pages, outline };
  } finally {
    doc.destroy();
  }
}
/** pdf.js as a second opinion: count, shown size, rotation and text per page. */
export async function inspectPdfjs(path, password) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const task = pdfjs.getDocument({ data, password, verbosity: 0, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100, rotate: page.rotate, text: tc.items.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60) });
  }
  const count = doc.numPages;
  await task.destroy();
  return { count, pages };
}
/** "p1,p2/r90,..." for outline-6 style pages; short page labels with rotation. */
export function brief(d) {
  if (!d.ok) return `NOT OPENABLE (needsPassword=${d.needsPassword})`;
  return `${d.count}p [${d.pages.map((p) => `${(p.text || '·').replace('Outline page ', 'o').replace(/^Page (\d+):.*/, 'm$1').replace('Annotated page ', 'a')}${p.rotate ? `/r${p.rotate}` : ''}`).join(',')}]`;
}

// ---------- App sessions that can end by themselves (close-prompt probes)
/** Launches and tracks the process itself: the Playwright handle is unusable once the app is gone. */
export async function start(options = {}) {
  const x = await launchRaw(options);
  x.proc = x.app.process();
  x.gone = false;
  x.proc.once('exit', () => { x.gone = true; });
  return x;
}
export function kill(x) {
  return new Promise((done) => {
    if (!x || x.gone) return done();
    const killer = spawn('taskkill', ['/PID', String(x.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('exit', () => setTimeout(done, 400));
  });
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The close prompt's title text, or '' when it is not showing (or the window is gone). */
export async function promptText(x) {
  if (x.gone) return '';
  try {
    const p = x.win.getByRole('alertdialog');
    return (await p.count()) > 0 ? (await p.innerText()).replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  }
}
/** After a close request: waits up to `ms` for the prompt or for the process to end. */
export async function watchClose(x, ms = 5000) {
  const t0 = Date.now();
  let prompt = '';
  while (Date.now() - t0 < ms) {
    if (x.gone) break;
    prompt = await promptText(x);
    if (prompt) break;
    await sleep(100);
  }
  await sleep(300);
  return { prompt, exited: x.gone };
}
export async function answer(x, name) {
  try {
    const p = x.win.getByRole('alertdialog');
    if ((await p.count()) > 0) {
      await p.getByRole('button', { name, exact: true }).click();
      return true;
    }
  } catch { /* window gone */ }
  return false;
}
export async function waitGone(x, ms = 10000) {
  const t0 = Date.now();
  while (!x.gone && Date.now() - t0 < ms) await sleep(100);
  return x.gone;
}
/** Ends a session whatever state it is in: asks to close, answers Don't save, and force-kills what is left. */
export async function endCleanly(x) {
  if (!x || x.gone) return;
  try {
    if (!(await promptText(x))) void x.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
    await sleep(800);
    await answer(x, "Don't save");
    await waitGone(x, 4000);
  } catch { /* gone */ }
  if (!x.gone) await kill(x);
}
/** Opens one more file in a new tab and waits for it to be the active document. */
export async function openMore(s, path, pages, tabsAfter) {
  await s.setDialogAnswer([path]);
  await s.win.keyboard.press('Control+o');
  await waitFor(async () => (await s.win.getByRole('tab').count()) === tabsAfter && (await pageCount(s.win)) === pages, { timeoutMs: 30000, label: `tab ${tabsAfter} with ${pages} pages` });
}
export { statusText };
