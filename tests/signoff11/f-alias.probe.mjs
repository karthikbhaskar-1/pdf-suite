// Sign-Off 11, F: Combine's "the output is one of the inputs / is open" guard when the same file is reached by another
// path: a folder junction, an 8.3 short name, the \?\ form. Auditor code only.
import { join } from 'node:path';
import { mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, open, openCombine, addFiles, windowOf, sha, delay, anyNotice, closeNotice } from '../signoff9/lib9.mjs';

const R = report('s11-f-alias');

await R.step('F1 output reaches an input, or an open document, through another path', async () => {
  const root = dirOf('alias');
  const real = join(root, 'Real Folder With A Long Name');
  mkdirSync(real);
  const alias = join(root, 'alias');
  let junction = false;
  try { symlinkSync(real, alias, 'junction'); junction = existsSync(join(alias, '.')); } catch (e) { R.say(`INFO no junction: ${e.message}`); }
  let shortDir = null;
  try { shortDir = execFileSync('cmd', ['/c', `for %I in ("${real}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).trim(); } catch { shortDir = null; }
  if (shortDir && shortDir.toLowerCase() === real.toLowerCase()) shortDir = null;
  R.say(`INFO junction made: ${junction}; 8.3 short path available: ${shortDir ? 'yes' : 'no'}`);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const cases = [
      { label: 'same spelling (control)', target: (n) => join(real, n) },
      junction && { label: 'through a folder junction', target: (n) => join(alias, n) },
      shortDir && { label: 'through the 8.3 short folder name', target: (n) => join(shortDir, n) },
      { label: 'the \\?\ form', target: (n) => `\\?\${join(real, n)}` },
    ].filter(Boolean);
    for (const mode of ['input', 'open tab']) {
      for (const c of cases) {
        const a = put(real, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
        const b = put(real, 'b.pdf', buildPdf({ pages: 1, tag: 'B' }));
        const open1 = put(real, 'opened.pdf', buildPdf({ pages: 5, tag: 'Opened' }));
        const before = { a: sha(a), b: sha(b), o: sha(open1) };
        if (mode === 'open tab' && !/Page 1 of 5/.test((await s.win.locator('footer').last().innerText().catch(() => '')))) await open(s, open1, 5);
        let dlg = windowOf(s.win);
        if ((await dlg.count()) === 0) dlg = await openCombine(s);
        if ((await dlg.locator('[data-row-id]').count()) !== 2) {
          const rows = await dlg.locator('[data-row-id]').count();
          if (rows > 0) { await s.win.keyboard.press('Control+a'); await dlg.getByRole('button', { name: 'Remove' }).click().catch(() => undefined); }
          await addFiles(s, dlg, [a, b], 2);
        }
        const box = dlg.getByLabel('Open the new file when it is ready');
        if (await box.isChecked()) await box.uncheck();
        const target = c.target(mode === 'input' ? 'a.pdf' : 'opened.pdf');
        await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, target);
        await dlg.getByRole('button', { name: 'Combine…' }).click();
        await delay(3000);
        const stillOpen = (await windowOf(s.win).count()) === 1;
        const msg = stillOpen ? (await windowOf(s.win).locator('[data-combine-target]').allInnerTexts()).join(' ').trim() : '';
        const notice = (await s.win.locator('[data-job-notice]').count()) ? await anyNotice(s, 30000) : '';
        const victim = mode === 'input' ? a : open1;
        const changed = sha(victim) !== (mode === 'input' ? before.a : before.o);
        R.say(`INFO [${mode}] [${c.label}] message "${msg}"; notice "${notice.slice(0, 70)}"; ${mode === 'input' ? 'a.pdf' : 'opened.pdf'} on disk: ${changed ? `REPLACED, now ${inspect(victim).pages} pages ${JSON.stringify(inspect(victim).text)}` : 'unchanged'}`);
        R.check(`[${mode}] [${c.label}] the output is refused and the file keeps its bytes`, !changed && /different name/.test(msg), { msg, notice, changed });
        await closeNotice(s);
        await delay(300);
      }
    }
  } finally {
    await s.close();
    try { rmSync(alias, { recursive: false, force: true }); } catch { /* the junction itself; the real folder is removed by wipe */ }
  }
});

await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
