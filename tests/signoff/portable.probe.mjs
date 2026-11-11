// Sign-off probe: the shipped portable exe launches, opens fixture files given on the command line,
// shows plain-English errors for bad files, and survives clicking around with nothing open.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, fixture } from './common.mjs';

const EXE = join(ROOT, 'release', 'PDF-Suite-Portable-0.1.0-x64.exe');
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => new Promise((done) => spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', done));

async function run(files, port, inspect) {
  const profile = mkdtempSync(join(tmpdir(), 'pdfsuite-signoff-'));
  const t0 = Date.now();
  const child = spawn(EXE, [...files, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 120 && !browser; i++) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
      if (!browser) await sleep(500);
    }
    if (!browser) throw new Error('could not connect over CDP');
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
      if (!page) await sleep(250);
    }
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.waitForLoadState('domcontentloaded');
    log(`  connected after ${Date.now() - t0} ms; title="${await page.title()}" url=${page.url().slice(0, 60)}`);
    await inspect(page, t0);
    log(`  errors: ${JSON.stringify(errors)}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await killTree(child.pid);
    await sleep(1500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

const status = (p) => p.locator('.status-bar').innerText().catch(() => '');

log('PORTABLE 1: big-1000.pdf + mixed on the command line');
await run([fixture('big-1000.pdf'), fixture('mixed-sizes-rotated.pdf')], 9341, async (p, t0) => {
  for (let i = 0; i < 100; i++) {
    if ((await p.getByRole('tab').count()) >= 2 && (await p.locator('.page-canvas').count()) > 0) break;
    await sleep(200);
  }
  log(`  tabs=${JSON.stringify(await p.getByRole('tab').allInnerTexts())} canvases=${await p.locator('.page-canvas').count()} status="${await status(p)}" at ${Date.now() - t0} ms from spawn`);
  await p.getByRole('tab').filter({ hasText: 'big-1000.pdf' }).click();
  await sleep(500);
  await p.keyboard.press('Control+g');
  await p.keyboard.type('999');
  await p.keyboard.press('Enter');
  await sleep(800);
  log(`  after Ctrl+G 999: status="${await status(p)}"`);
  await p.keyboard.press('Control+f');
  await p.getByLabel('Find in document').fill('zephyrbloom');
  for (let i = 0; i < 100; i++) {
    if (/^\d+ of 1000$/.test((await p.locator('.search-status').innerText()).trim())) break;
    await sleep(200);
  }
  log(`  search status: "${(await p.locator('.search-status').innerText()).trim()}"`);
  const shot = join(ROOT, 'tests', 'signoff', 'portable-shot.png');
  await p.screenshot({ path: shot });
  log(`  screenshot ${shot}`);
});

for (const [name, port] of [['truncated.pdf', 9342], ['png-renamed.pdf', 9343], ['empty.pdf', 9344], [join(ROOT, 'tests', 'fixtures', 'out', 'does-not-exist.pdf'), 9345], [join(ROOT, 'package.json'), 9346], [join(ROOT, 'release', 'win-unpacked', 'PDF Suite.exe'), 9349]]) {
  log(`PORTABLE bad file: ${name}`);
  await run([name.includes(':') ? name : fixture(name)], port, async (p, t0) => {
    for (let i = 0; i < 60; i++) {
      if ((await p.locator('.tab-message[role="alert"], .toast, [role=dialog]').count()) > 0) break;
      await sleep(250);
    }
    log(`  message visible ${Date.now() - t0} ms after spawn`);
    await sleep(500);
    log(`  inline: ${JSON.stringify(await p.locator('.tab-message').allInnerTexts())} toast: ${JSON.stringify(await p.locator('.toast').allInnerTexts())} dialog: ${JSON.stringify(await p.getByRole('dialog').allInnerTexts())} tabs: ${JSON.stringify(await p.getByRole('tab').allInnerTexts())}`);
  });
}

log('PORTABLE locked.pdf');
await run([fixture('locked.pdf')], 9347, async (p) => {
  const d = p.getByRole('dialog', { name: 'Password needed' });
  await d.waitFor({ timeout: 20000 });
  log(`  dialog: ${JSON.stringify((await d.innerText()).replace(/\s+/g, ' '))}`);
  await d.getByLabel('Password').fill('nope');
  await d.getByRole('button', { name: 'Open' }).click();
  await sleep(1000);
  log(`  after wrong password: ${JSON.stringify((await d.innerText()).replace(/\s+/g, ' '))}`);
  await d.getByLabel('Password').fill('test123');
  await d.getByRole('button', { name: 'Open' }).click();
  await sleep(1500);
  log(`  after right password: status="${await status(p)}" canvases=${await p.locator('.page-canvas').count()}`);
});

log('PORTABLE blank: nothing open, mash keys/clicks');
await run([], 9348, async (p) => {
  await p.locator('.empty-state').waitFor({ timeout: 20000 });
  const keys = ['Control+f', 'F3', 'Shift+F3', 'Escape', 'Control+\\', 'F6', 'Control+g', 'Escape', 'PageDown', 'PageUp', 'Home', 'End', 'Control+=', 'Control+-', 'Control+0', 'Control+1', 'Control+w', 'Control+Tab', 'Control+Shift+Tab', 'Control+k', 'Escape', 'ArrowDown', 'ArrowRight'];
  for (const k of keys) { await p.keyboard.press(k).catch(() => undefined); await sleep(60); }
  for (const name of ['Loupe', 'Pan-zoom', 'Thumbnails', 'Bookmarks', 'Properties']) {
    await p.getByRole('button', { name, exact: true }).click().catch((e) => log(`  click ${name}: ${e.message.split('\n')[0]}`));
    await sleep(150);
  }
  log(`  floating windows: ${JSON.stringify(await p.locator('.floating').allInnerTexts())}`);
  log(`  dock: ${JSON.stringify(await p.locator('aside.dock').allInnerTexts())}`);
  await p.mouse.click(600, 400, { button: 'right' });
  await p.mouse.move(600, 400); await p.mouse.down(); await p.mouse.move(700, 500, { steps: 5 }); await p.mouse.up();
  await p.mouse.wheel(0, 500);
  await p.keyboard.down('Control'); await p.mouse.wheel(0, -300); await p.keyboard.up('Control');
  for (const sel of ['.tb-group button', '.tb-group summary']) {
    const n = await p.locator(sel).count();
    for (let i = 0; i < n; i++) {
      const el = p.locator(sel).nth(i);
      const label = `${await el.innerText().catch(() => '')} ${await el.getAttribute('aria-label')} ${await el.getAttribute('title')}`;
      if (/open/i.test(label)) continue; // a real native file dialog would block the probe
      await el.click({ timeout: 2000 }).catch(() => undefined); await p.keyboard.press('Escape'); await sleep(50);
    }
  }
  log(`  still alive: empty-state=${await p.locator('.empty-state').count()} status="${await status(p)}"`);
});
log('done');
