// Sign-off probe: automatic crash recovery for (1) a renderer crash inside a running app and
// (2) a hard kill of the whole app, with three tabs including a password-locked one and a split.
import { launch, fixture, waitFor, waitForPage, statusText, forceKill, closeAll, cleanupProfile } from './common.mjs';

const log = (...a) => console.log(...a);
const tabNames = (win) => win.getByRole('tab').allInnerTexts().then((t) => t.map((x) => x.trim().split('\n')[0]));

try {
  const s = await launch();
  const profile = s.profile;
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 8');
  await s.setDialogAnswer([fixture('locked.pdf')]);
  await s.win.keyboard.press('Control+o');
  const dialog = s.win.getByRole('dialog', { name: 'Password needed' });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByLabel('Password').fill('test123');
  await dialog.getByRole('button', { name: 'Open' }).click();
  await waitForPage(s, 'Page 1 of 1');
  await s.setDialogAnswer([fixture('big-1000.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000');
  await s.win.keyboard.press('Control+g');
  await s.win.keyboard.type('250');
  await s.win.keyboard.press('Enter');
  await waitForPage(s, 'Page 250 of 1000');
  await s.win.keyboard.press('Control+=');
  await s.win.keyboard.press('Control+\\');
  await s.win.waitForTimeout(1500);
  const before = { tabs: await tabNames(s.win), status: await statusText(s.win), panes: await s.win.locator('.pane-frame').count() };
  log(`before renderer crash: ${JSON.stringify(before)}`);

  // (1) Renderer crash: the main process should reload and restore.
  await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  log('renderer crashed');
  const js = (code) => s.app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(c), code);
  const snap = "({ tabs: [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()), status: document.querySelector('.status-bar') ? document.querySelector('.status-bar').textContent.trim() : null, panes: document.querySelectorAll('.pane-frame').length, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent), dialog: [...document.querySelectorAll('[role=dialog]')].map((t) => t.textContent), messages: [...document.querySelectorAll('.tab-message')].map((t) => t.textContent) })";
  let afterCrash = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 500));
    afterCrash = await js(snap).catch(() => null);
    if (afterCrash && afterCrash.tabs.length >= 1 && /Page/.test(afterCrash.status ?? '')) break;
  }
  log(`after renderer crash (${Date.now() - t0} ms): ${JSON.stringify(afterCrash)}`);
  await new Promise((r) => setTimeout(r, 2000));
  log(`after renderer crash +2s: ${JSON.stringify(await js(snap).catch((e) => e.message))}`);
  await js(`[...document.querySelectorAll('[role=tab]')].find((t) => t.innerText.includes('locked.pdf'))?.click(); true`);
  await new Promise((r) => setTimeout(r, 1500));
  log(`locked tab after crash: ${JSON.stringify(await js(snap).catch((e) => e.message))}`);
  await js(`[...document.querySelectorAll('[role=tab]')].find((t) => t.innerText.includes('big-1000.pdf'))?.click(); true`);
  await new Promise((r) => setTimeout(r, 1500));
  log(`big tab after crash: ${JSON.stringify(await js(snap).catch((e) => e.message))}`);
  const w = null;

  // (2) Hard kill of the app.
  await new Promise((r) => setTimeout(r, 2000));
  await forceKill(s.app);
  log('app force-killed');
  const r = await launch({ profile });
  await waitFor(async () => (await r.win.getByRole('tab').count()) >= 1, { timeoutMs: 30000, label: 'tabs after relaunch' }).catch((e) => log(`  ${e.message}`));
  await r.win.waitForTimeout(3000);
  log(`after relaunch: ${JSON.stringify({ tabs: await tabNames(r.win), status: await statusText(r.win), panes: await r.win.locator('.pane-frame').count(), toast: await r.win.locator('.toast').allInnerTexts().catch(() => []), dialog: await r.win.getByRole('dialog').allInnerTexts().catch(() => []) })}`);
  await r.win.keyboard.press('Escape').catch(() => undefined);
  await r.win.getByRole('tab').filter({ hasText: 'big-1000.pdf' }).click();
  await r.win.waitForTimeout(1000);
  log(`big tab after relaunch: status ${JSON.stringify(await statusText(r.win))}; panes ${await r.win.locator('.pane-frame').count()}`);
  log(`errors (first run, excluding crash noise): ${JSON.stringify(s.errors.filter((e) => !/crash|Target closed|gone/i.test(e)).slice(0, 5))}`);
  log(`errors (relaunch): ${JSON.stringify(r.errors.slice(0, 5))}`);
  await r.close();
  cleanupProfile(profile);
} finally {
  await closeAll();
}
