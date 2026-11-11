// Sign-off probe: a non-.pdf file chosen in the Open dialog (user typed *.* in the dialog).
import { writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, ROOT, fixture, closeAll, cleanupProfile } from './common.mjs';

const OUT = join(ROOT, 'tests', 'signoff', 'out');
writeFileSync(join(OUT, 'notes.txt'), 'just some text, not a pdf');
copyFileSync(fixture('png-renamed.pdf'), join(OUT, 'picture.png'));
const log = (...a) => console.log(...a);
try {
  for (const f of ['notes.txt', 'picture.png']) {
    const s = await launch();
    await s.win.waitForSelector('.empty-state');
    await s.setDialogAnswer([join(OUT, f)]);
    await s.win.keyboard.press('Control+o');
    await s.win.waitForTimeout(3000);
    log(`${f}: tabs ${JSON.stringify(await s.win.getByRole('tab').allInnerTexts())}; inline ${JSON.stringify(await s.win.locator('.tab-message').allInnerTexts())}; toast ${JSON.stringify(await s.win.locator('.toast').allInnerTexts())}; empty-state ${await s.win.locator('.empty-state').count()}; errors ${JSON.stringify(s.errors)}`);
    await s.close();
    cleanupProfile(s.profile);
  }
} finally {
  await closeAll();
}
