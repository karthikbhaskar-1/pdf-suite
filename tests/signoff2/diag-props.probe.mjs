// Diagnosis: Properties "Document" metadata sometimes shows dashes. Repeats the realworld sequence and reads the
// section right away, after 3 s and after 10 s, then reopens the panel.
import { join } from 'node:path';
import { CORPUS, launchTracked, openPath, waitPainted, waitFor, closeAll, cleanupProfile } from './lib.mjs';

const s = await launchTracked();
const read = async () => (await s.win.getByRole('complementary', { name: 'Properties', exact: true }).locator('section[aria-label="Document"]').innerText().catch(() => '(none)')).replace(/\s+/g, ' ').replace(/^.*?\.pdf /, '').slice(0, 260);
try {
  await s.win.waitForSelector('.empty-state');
  for (const variant of ['plain', 'after-zoom-search']) {
    await openPath(s, join(CORPUS, 'arxiv-attention', '1706.03762.pdf'), 'Page 1 of 15');
    await waitPainted(s.win, 0);
    if (variant !== 'plain') {
      await s.win.keyboard.press('Control+f');
      await s.win.getByLabel('Find in document').fill('Transformer');
      await waitFor(async () => /^\d+ of \d+$/.test((await s.win.locator('.search-status').innerText()).trim()), { timeoutMs: 20000 });
      for (let i = 0; i < 6; i++) { await s.win.waitForTimeout(700); await s.win.keyboard.press('F3'); }
      await s.win.keyboard.press('Escape');
      for (let i = 0; i < 8; i++) await s.win.keyboard.press('Control+=');
      await s.win.waitForTimeout(1500);
      await s.win.keyboard.press('Control+f');
      await s.win.getByLabel('Find in document').fill('Transformer');
      await s.win.waitForTimeout(1500);
      await s.win.keyboard.press('Escape');
      await s.win.keyboard.press('Control+0');
      await s.win.waitForTimeout(800);
    }
    await s.win.getByRole('button', { name: 'Properties', exact: true }).click();
    const now = await read();
    await s.win.waitForTimeout(3000);
    const at3 = await read();
    await s.win.waitForTimeout(7000);
    const at10 = await read();
    await s.win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
    await s.win.waitForTimeout(500);
    await s.win.getByRole('button', { name: 'Properties', exact: true }).click();
    await s.win.waitForTimeout(1500);
    const reopened = await read();
    console.log(JSON.stringify({ variant, now, at3, at10, reopened }));
    await s.win.locator('.tab-close').first().click();
    await s.win.waitForSelector('.empty-state');
    await s.win.waitForTimeout(800);
  }
  console.log(`errors ${JSON.stringify([...s.errors])}`);
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
}
