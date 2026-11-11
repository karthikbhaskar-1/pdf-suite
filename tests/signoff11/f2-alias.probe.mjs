// Sign-Off 11, F (second run; the first rewrote the inputs between cases, which made the rows stale): Combine's "the output
// is one of the inputs / is open" guard when the same file is reached by another path. Fresh files for every case.
import { join } from 'node:path';
import { mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildPdf, put, dirOf, inspect, wipe, report, start, closeAll, open, openCombine, addFiles, windowOf, sha, delay, anyNotice, closeNotice, messagesOf } from '../signoff9/lib9.mjs';

const R = report('s11-f2-alias');
const junctions = [];

function place(n) {
  const root = dirOf(`alias${n}`);
  const real = join(root, 'Real Folder With A Long Name');
  mkdirSync(real);
  const alias = join(root, 'alias');
  let junction = false;
  try { symlinkSync(real, alias, 'junction'); junction = existsSync(join(alias, '.')); junctions.push(alias); } catch (e) { R.say(`INFO no junction: ${e.message}`); }
  let shortDir = null;
  try { shortDir = execFileSync('cmd', ['/c', `for %I in ("${real}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).trim(); } catch { shortDir = null; }
  if (shortDir && shortDir.toLowerCase() === real.toLowerCase()) shortDir = null;
  return { real, alias: junction ? alias : null, shortDir };
}
const KINDS = [
  { label: 'same spelling (control)', target: (p, n) => join(p.real, n) },
  { label: 'through a folder junction', target: (p, n) => (p.alias ? join(p.alias, n) : null) },
  { label: 'through the 8.3 short folder name', target: (p, n) => (p.shortDir ? join(p.shortDir, n) : null) },
  { label: 'the \\?\ form', target: (p, n) => `\\?\${join(p.real, n)}` },
];

async function oneCase(s, mode, kind, n) {
  const p = place(n);
  const a = put(p.real, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const b = put(p.real, 'b.pdf', buildPdf({ pages: 1, tag: 'B' }));
  const opened = put(p.real, 'opened.pdf', buildPdf({ pages: 5, tag: 'Opened' }));
  const victim = mode === 'input' ? a : opened;
  const before = sha(victim);
  const target = kind.target(p, mode === 'input' ? 'a.pdf' : 'opened.pdf');
  if (target === null) { R.say(`INFO [${mode}] [${kind.label}] not available on this machine`); return; }
  if (mode === 'open tab') await open(s, opened, 5);
  const dlg = await openCombine(s);
  if ((await dlg.locator('[data-row-id]').count()) > 0) {
    await dlg.locator('[data-combine-list]').focus();
    await s.win.keyboard.press('Control+a');
    await dlg.getByRole('button', { name: 'Remove' }).click();
    await delay(300);
  }
  await addFiles(s, dlg, [a, b], 2);
  const box = dlg.getByLabel('Open the new file when it is ready');
  if (await box.isChecked()) await box.uncheck();
  await s.app.evaluate(({ dialog }, t) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: t }); }, target);
  await dlg.getByRole('button', { name: 'Combine…' }).click();
  await delay(3500);
  const stillOpen = (await windowOf(s.win).count()) === 1;
  const msg = stillOpen ? (await windowOf(s.win).locator('[data-combine-target]').allInnerTexts()).join(' ').trim() : '';
  const other = stillOpen ? await messagesOf(windowOf(s.win)) : [];
  const notice = (await s.win.locator('[data-job-notice]').count()) ? await anyNotice(s, 30000) : '';
  const changed = sha(victim) !== before;
  const now = changed ? inspect(victim) : null;
  R.say(`INFO [${mode}] [${kind.label}] window ${stillOpen ? 'open' : 'closed'}; message "${msg}"; other messages ${JSON.stringify(other)}; notice "${notice.slice(0, 70)}"; ${mode === 'input' ? 'a.pdf' : 'opened.pdf'} on disk: ${changed ? `REPLACED, now ${now.pages} pages ${JSON.stringify(now.text)}` : 'unchanged'}${mode === 'open tab' ? `; tab status "${(await s.win.locator('footer').last().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 40)}"` : ''}`);
  R.check(`[${mode}] [${kind.label}] the output is refused with the spec message and the file keeps its bytes`, !changed && /different name/.test(msg), { msg, notice: notice.slice(0, 60), changed });
  await closeNotice(s);
  if ((await windowOf(s.win).count()) === 1) { await s.win.keyboard.press('Escape'); await delay(400); }
}

let n = 0;
for (const mode of ['input', 'open tab']) {
  await R.step(`F2 ${mode}`, async () => {
    const s = await start();
    try {
      await s.win.waitForSelector('.empty-state');
      for (const kind of KINDS) {
        try { await oneCase(s, mode, kind, ++n); } catch (e) { R.check(`[${mode}] [${kind.label}] ran`, false, String(e.message).split('\n')[0].slice(0, 200)); if ((await windowOf(s.win).count()) === 1) await s.win.keyboard.press('Escape'); }
      }
    } finally { await s.close(); }
  });
}
for (const j of junctions) { try { rmSync(j, { force: true }); } catch { /* removed with the work folder */ } }
await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
