// Recovery stress: 5 runs of quick relaunch after a normal close, 5 after force-kill.
// Each run: 2 files, split view, page 500 and 300% zoom. Relaunch on the same profile must restore all of it.
// Run directly: node tests/e2e/recovery-stress.mjs
import { launch, fixture, statusText, waitForPage, forceKill, closeAll, cleanupProfile } from './helpers.mjs';

const RUNS = 5;
const results = [];

async function setup(s) {
  await s.win.waitForSelector('.empty-state');
  await s.setDialogAnswer([fixture('mixed-sizes-rotated.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 8');
  await s.setDialogAnswer([fixture('big-1000.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000');
  const box = s.win.getByLabel('Page number');
  await box.click();
  await box.fill('500');
  await box.press('Enter');
  await waitForPage(s, 'Page 500 of 1000');
  await s.win.keyboard.press('Control+=');
  await s.win.keyboard.press('Control+=');
  await s.win.keyboard.press('Control+\\');
  await s.win.locator('.pane-frame').nth(1).waitFor({ timeout: 10000 });
}

async function verify(r) {
  const toast = r.win.locator('.toast').filter({ hasText: /Restored \d+ tabs?/ });
  await toast.first().waitFor({ timeout: 20000 });
  const toastText = (await toast.first().innerText()).trim();
  const tabs = await r.win.getByRole('tab').count();
  await r.win.getByRole('tab').filter({ hasText: 'big-1000.pdf' }).click();
  let status = '';
  try {
    await waitForPage(r, 'Page 500 of 1000', { timeoutMs: 30000 });
  } catch {
    // Captured below through the status text.
  }
  status = await statusText(r.win);
  const panes = await r.win.locator('.pane-frame').count();
  const ok = toastText === 'Restored 2 tabs' && tabs === 2 && status === 'Page 500 of 1000 · 300%' && panes === 2;
  return { ok, toastText, tabs, status, panes };
}

for (const mode of ['close', 'kill']) {
  for (let i = 1; i <= RUNS; i++) {
    const s = await launch();
    let result;
    try {
      await setup(s);
      if (mode === 'close') {
        await s.close(); // normal close, then relaunch straight away
      } else {
        await forceKill(s.app);
        await s.close();
      }
      const r = await launch({ profile: s.profile });
      try {
        result = { mode, run: i, ...(await verify(r)) };
      } finally {
        await r.close();
      }
    } catch (e) {
      result = { mode, run: i, ok: false, error: e.message.split('\n')[0] };
    } finally {
      cleanupProfile(s.profile);
    }
    results.push(result);
    console.log(JSON.stringify(result));
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`recovery stress: ${passed}/${results.length} runs restored everything`);
await closeAll();
