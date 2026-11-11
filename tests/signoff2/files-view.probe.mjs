// Independent sign-off probe, ticket 1.2.0: bad/locked/damaged real-world files on MuPDF, dark mode + recolor on real
// page pixels, two-file split with synchronized scrolling (real-world arXiv + 1,000-page file).
// Run: node tests/signoff2/files-view.probe.mjs
import { join } from 'node:path';
import {
  CORPUS, launchTracked, openPath, engineState, pageInk, waitPainted, check, summary, statusText, waitFor, waitForPage,
  closeAll, cleanupProfile, fixture,
} from './lib.mjs';
import { pixels as px } from '../signoff/common.mjs';

const D = join(CORPUS, 'derived');

async function outcomeFor(path, extra) {
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([path]);
    await s.win.keyboard.press('Control+o');
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    const r = await waitFor(async () => {
      if (await dialog.count()) return { kind: 'password', text: (await dialog.innerText()).replace(/\s+/g, ' ') };
      const msg = s.win.locator('.tab-message[role="alert"]');
      if (await msg.count()) return { kind: 'message', text: (await msg.first().innerText()).trim() };
      const p = await pageInk(s.win, 0);
      if (p.found && !p.placeholder && p.w !== 300) return { kind: 'page', ink: p.ink, status: await statusText(s.win) };
      return null;
    }, { timeoutMs: 30000, label: 'outcome' });
    const out = { ...r.value, eng: await engineState(s.win) };
    if (extra) Object.assign(out, await extra(s, out));
    out.errors = [...s.errors];
    return out;
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
}

try {
  // ---------- Bad, locked, damaged ----------
  const aes = await outcomeFor(join(D, 'aes256-locked.pdf'), async (s) => {
    const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
    await dialog.getByLabel('Password').fill('wrong');
    await dialog.getByRole('button', { name: 'Open' }).click();
    await s.win.waitForTimeout(1200);
    const wrong = (await dialog.innerText()).replace(/\s+/g, ' ');
    await dialog.getByLabel('Password').fill('aes256pw');
    await dialog.getByRole('button', { name: 'Open' }).click();
    await waitForPage(s, 'Page 1 of 6', { timeoutMs: 20000 }).catch(() => undefined);
    const p = await waitPainted(s.win, 0).catch(() => ({ value: null }));
    return { wrong, afterRight: await statusText(s.win), ink: p.value?.ink, engAfter: await engineState(s.win) };
  });
  check('AES-256 locked real form: password prompt, plain "Wrong password" on a bad one, opens on MuPDF with the right one', aes.kind === 'password' && /Wrong password/.test(aes.wrong) && aes.afterRight.startsWith('Page 1 of 6') && aes.ink > 0.01 && aes.engAfter.mupdfDocs === 1 && aes.errors.length === 0, aes);
  const dam = await outcomeFor(join(D, 'damaged-xref.pdf'));
  check('damaged xref (real fw9): repaired and shown by MuPDF, no error', dam.kind === 'page' && dam.ink > 0.01 && dam.eng.mupdfDocs === 1 && dam.errors.length === 0, dam);
  const tr = await outcomeFor(join(D, 'truncated-half.pdf'));
  check('truncated real file: either shows what survives or says "This file is damaged." in plain English, no console errors', (tr.kind === 'page' || (tr.kind === 'message' && tr.text === 'This file is damaged.')) && tr.errors.length === 0, tr);
  for (const [name, msg] of [['empty.pdf', 'This file is empty.'], ['png-renamed.pdf', "This isn't a PDF."], ['truncated.pdf', 'This file is damaged.'], ['notes.txt', "This isn't a PDF."]]) {
    const r = await outcomeFor(fixture(name));
    check(`${name}: inline plain-English "${msg}", no console errors`, r.kind === 'message' && r.text === msg && r.errors.length === 0, r);
  }

  // ---------- Dark mode + recolor on real page pixels ----------
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    await openPath(s, join(CORPUS, 'arxiv-attention', '1706.03762.pdf'), 'Page 1 of 15');
    await waitPainted(s.win, 0);
    await s.win.waitForTimeout(800);
    const pg = await s.win.locator('.viewer .page-canvas').first().boundingBox();
    const blank = { x: pg.x + pg.width * 0.05, y: pg.y + pg.height * 0.02, width: 40, height: 20 };
    const body = { x: pg.x + pg.width * 0.2, y: pg.y + 300, width: pg.width * 0.6, height: 200 };
    const topColor = async (r) => (await px(s.app, r)).top[0];
    const theme0 = await s.win.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await s.win.getByRole('button', { name: 'Light or dark' }).or(s.win.getByRole('button', { name: 'Theme' })).first().click();
    await s.win.waitForTimeout(400);
    const theme1 = await s.win.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const pageInDark = await topColor(blank);
    check('dark mode switches the app chrome and leaves the page itself white (recolor off)', theme0 !== theme1 && /^24[08],24[08],24[08]/.test(pageInDark), { theme0, theme1, pageInDark });
    const openRecolor = () => s.win.locator('summary', { hasText: /^Page colors:/ }).evaluate((sum) => { sum.parentElement.open = true; });
    const closeRecolor = () => s.win.locator('summary', { hasText: /^Page colors:/ }).evaluate((sum) => { sum.parentElement.open = false; });
    await openRecolor();
    await s.win.getByRole('menuitemradio', { name: 'Invert', exact: true }).click();
    await closeRecolor();
    await s.win.waitForTimeout(700);
    const inv = { blank: await topColor(blank), body: (await px(s.app, body)).top };
    check('Invert turns the white page background black on screen', /^([0-9]|1[0-9]|2[0-9]),/.test(inv.blank) || inv.blank.startsWith('0,0,0') || inv.blank.startsWith('8,8,8'), inv);
    await openRecolor();
    await s.win.getByRole('menuitemradio', { name: 'Custom', exact: true }).click();
    await s.win.getByLabel('Custom background color').fill('#102030');
    await s.win.getByLabel('Custom text color').fill('#ffee00');
    await closeRecolor();
    await s.win.waitForTimeout(800);
    const cust = { blank: await topColor(blank), body: (await px(s.app, body)).top };
    const near = (c, rgb) => { const [r, g, b] = c.split(':')[0].split(',').map(Number); return Math.abs(r - rgb[0]) <= 16 && Math.abs(g - rgb[1]) <= 16 && Math.abs(b - rgb[2]) <= 16; };
    check('Custom pair: background becomes #102030 and text pixels become yellow #ffee00', near(cust.blank, [16, 32, 48]) && cust.body.some((c) => near(c, [255, 238, 0]) || /^2[45][0-9],2[23][0-9],/.test(c)), cust);
    await openRecolor();
    await s.win.getByRole('menuitemradio', { name: 'Off', exact: true }).click();
    await closeRecolor();

    // ---------- Two different files in split with sync ----------
    await openPath(s, fixture('big-1000.pdf'), 'Page 1 of 1000');
    await s.win.getByRole('tab').filter({ hasText: '1706.03762.pdf' }).click();
    await s.win.waitForTimeout(400);
    await s.win.keyboard.press('Control+\\');
    await waitFor(async () => (await s.win.locator('.pane-frame').count()) === 2, { label: 'two panes' });
    await s.win.getByRole('combobox', { name: 'Document in this pane' }).nth(1).selectOption({ label: 'big-1000.pdf' });
    await s.win.waitForTimeout(1200);
    const names = await s.win.getByRole('combobox', { name: 'Document in this pane' }).evaluateAll((els) => els.map((e) => e.selectedOptions[0].textContent));
    const pos = () => s.win.evaluate(() => [...document.querySelectorAll('.viewer')].map((v) => {
      const vr = v.getBoundingClientRect();
      const pages = [...v.querySelectorAll('.page')].sort((a, b) => Number(a.dataset.pageIndex) - Number(b.dataset.pageIndex));
      for (const p of pages) { const r = p.getBoundingClientRect(); if (r.bottom > vr.top + 1) return Number(p.dataset.pageIndex) + (vr.top - r.top) / r.height; }
      return NaN;
    }));
    const wheel = async (i, dy, n) => {
      const b = await s.win.locator('.viewer').nth(i).boundingBox();
      await s.win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      for (let k = 0; k < n; k++) { await s.win.mouse.wheel(0, dy); await s.win.waitForTimeout(60); }
      await s.win.waitForTimeout(900);
    };
    const p0 = await pos();
    await wheel(1, 400, 5);
    const p1 = await pos();
    await wheel(0, 300, 4);
    const p2 = await pos();
    const d1 = [p1[0] - p0[0], p1[1] - p0[1]], d2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const both = await Promise.all([0, 1].map((i) => pageInk(s.win, Math.floor(p2[i]), i)));
    check('two different files side by side: scrolling either pane moves the other by the same page amount', names[0] !== names[1] && d1[0] > 0.3 && Math.abs(d1[0] - d1[1]) < 0.1 && d2[0] > 0.3 && Math.abs(d2[0] - d2[1]) < 0.1, { names, p0, p1, p2 });
    check('both split panes show painted pages', both.every((b) => b.found && b.ink > 0.001), both);
    check('no console errors in view checks', s.errors.length === 0, s.errors.slice(0, 5));
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
} catch (e) {
  check('probe ran to completion', false, String(e.stack ?? e).slice(0, 800));
} finally {
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
