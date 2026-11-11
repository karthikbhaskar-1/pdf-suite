// Sign-off round 3 probe helpers. Drives the packaged app through tests/e2e/helpers.mjs (PDFSUITE_E2E=1: no prompts left,
// inactive windows). Nothing here edits product code.
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export * from '../e2e/matrix-lib.mjs';
import { waitFor, statusText, uids, lastScan } from '../e2e/matrix-lib.mjs';
export { inspectMupdf, inspectPdfjs } from './inspect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
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
        say(`FAIL  ${label} :: threw ${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 400)}`);
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

/** Records every toast text the app shows from now on (toasts vanish after a few seconds). */
export async function watchToasts(win) {
  await win.evaluate(() => {
    if (window.__so3) return;
    window.__so3 = { toasts: [], bars: [] };
    const seen = new WeakSet();
    const scan = () => {
      for (const el of document.querySelectorAll('.toast')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__so3.toasts.push(el.querySelector('span')?.textContent ?? el.textContent ?? '');
      }
      for (const el of document.querySelectorAll('.info-bar, .tab-message, [role="alert"], [role="alertdialog"]')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__so3.bars.push((el.textContent ?? '').trim());
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  });
}
export const toasts = (win) => win.evaluate(() => [...(window.__so3?.toasts ?? [])]);
export const bars = (win) => win.evaluate(() => [...(window.__so3?.bars ?? [])]);
export async function lastToast(win) {
  const all = await toasts(win);
  return all.at(-1) ?? '';
}
export async function waitToast(win, re, timeoutMs = 15000) {
  const from = (await toasts(win)).length;
  return waitFor(async () => (await toasts(win)).slice(Math.max(0, from - 1)).find((t) => re.test(t)), { timeoutMs, label: `toast ${re}` }).then((r) => r.value);
}
/** Runs `action`, then waits for a new toast (one that was not there before). Returns its text. */
export async function toastAfter(win, action, timeoutMs = 20000) {
  const before = (await toasts(win)).length;
  await action();
  const r = await waitFor(async () => {
    const all = await toasts(win);
    return all.length > before ? all.slice(before) : null;
  }, { timeoutMs, label: 'a new toast' });
  return r.value.join(' | ');
}

/** Clicks through the classic menu bar: menu(win, 'Pages', 'Duplicate') or menu(win, 'View', 'Split', 'Vertical'). */
export async function menu(win, top, ...path) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  for (let i = 0; i < path.length; i++) {
    const exact = new RegExp(`^${path[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const base = i === 0
      ? win.locator('.menu-top > .menu-dropdown > .menu-item, .menu-top > .menu-dropdown > .menu-sub-wrap > .menu-item')
      : win.locator('.menu-sub .menu-item');
    const item = base.filter({ has: win.locator('.menu-label', { hasText: exact }) });
    await item.first().waitFor({ timeout: 5000 });
    // A submenu opens when the pointer rests on its parent row; the last label is the one that is clicked.
    if (i < path.length - 1) {
      await item.first().hover();
      await win.locator('.menu-sub').waitFor({ timeout: 5000 });
    } else {
      await item.first().click();
    }
  }
}
/** Labels, enabled state and tooltip of the items of a top-level menu (opens it, reads, closes with Esc). */
export async function menuItems(win, top) {
  await win.locator('.menu-tops > .menu-top > button', { hasText: new RegExp(`^${top}$`) }).click();
  const items = await win.locator('.menu-top > .menu-dropdown > .menu-item, .menu-top > .menu-dropdown > .menu-sub-wrap > .menu-item').evaluateAll((els) =>
    els.map((el) => ({ label: el.querySelector('.menu-label')?.textContent ?? '', disabled: el.disabled, title: el.getAttribute('title') ?? '', accel: el.querySelector('.menu-accel')?.textContent ?? '' })),
  );
  await win.keyboard.press('Escape');
  return items;
}

/** Order (uids) plus the thumbnail row tops, as one comparable snapshot string. */
export async function snapshot(win) {
  const ids = await uids(win);
  const tops = (lastScan.tops ?? []).map((t) => Math.round(t));
  return JSON.stringify({ ids, tops, h: Math.round(lastScan.scrollHeight ?? 0), status: (await statusText(win)).replace(/Page \d+ of/, 'Page ? of').split('·')[0].trim() });
}
export const sheet = (win, name) => win.getByRole('dialog', { name });
export async function shot(win, name) {
  try {
    await win.screenshot({ path: join(OUT, `${name}.png`) });
  } catch {
    /* a screenshot is a convenience */
  }
}
export { plainEnglish } from './plain.mjs';
export { rendererMemoryMB } from '../e2e/helpers.mjs';
