// Probe C: save in place, Save As, cancelled Save As, a read-only file, a clean save, and an encrypted file
// (wrong password, edit, save, extract, save as), with a search of the profile for the password afterwards.
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitForCount, pageCount, fixture, waitFor, delay, setSaveAnswer, newProfileDir,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspectMupdf, inspectPdfjs, plainEnglish, toasts, bars, isDirty, clickRowByIndex, showPanel, statusText,
} from './lib.mjs';

const R = makeReport('c-save-encrypt');
const outDir = mkdtempSync(join(tmpdir(), 'pdfsuite-so3-'));
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;

/** Every file under a folder, with its bytes. */
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.size < 30_000_000) out.push(p);
    }
  };
  walk(dir);
  return out;
}
function findSecret(dir, secret) {
  const ascii = Buffer.from(secret, 'latin1');
  const wide = Buffer.from(secret, 'utf16le');
  const hits = [];
  for (const f of filesUnder(dir)) {
    let b;
    try {
      b = readFileSync(f);
    } catch {
      continue;
    }
    if (b.includes(ascii) || b.includes(wide)) hits.push(f);
  }
  return hits;
}

try {
  // ---------- Save As, Save, cancelled Save As, read-only
  const a = mk('mixed-sizes-rotated.pdf');
  const original = readFileSync(a.path);
  s = await launch();
  let { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, a.path, 8);
  await watchToasts(win);

  await R.step('Ctrl+S on an unchanged document does no harm', async () => {
    const before = readFileSync(a.path);
    await win.keyboard.press('Control+s');
    await delay(1500);
    const after = readFileSync(a.path);
    const d = inspectMupdf(a.path);
    R.info(`clean save: bytes ${before.length} -> ${after.length}, toasts: ${(await toasts(win)).join(' | ')}`);
    R.check('clean save: the file is still a valid 8-page PDF', d.ok && d.count === 8);
  });

  await jumpTo(win, 0);
  await toastAfter(win, () => win.keyboard.press('Delete'));
  await waitForCount(win, 7);

  await R.step('Save As cancelled: nothing written, still unsaved, no error shown', async () => {
    const n = (await toasts(win)).length;
    await win.keyboard.press('Control+Shift+S'); // helper stub: dialog cancelled
    await delay(1000);
    const added = (await toasts(win)).slice(n);
    R.check('cancelled Save As: still unsaved, no message', (await isDirty(win)) && added.length === 0, added.join(' | '));
    R.check('cancelled Save As: original file untouched', readFileSync(a.path).equals(original));
  });

  const b = join(outDir, 'Copy of mixed ünïcode (2).pdf');
  await R.step('Save As to a new name (spaces, accents, brackets)', async () => {
    await setSaveAnswer(s, b);
    const t = await toastAfter(win, () => menu(win, 'File', 'Save As…'));
    R.check('Save As toast names the new file', t.includes('Saved Copy of mixed ünïcode (2).pdf'), t);
    const d = inspectMupdf(b);
    R.check('Save As: new file is a valid 7-page PDF without page 1', d.ok && d.count === 7 && d.pages[0].text === 'Page 2: A4 portrait', JSON.stringify(d.pages?.map((p) => p.text)));
    R.check('Save As: original file byte-identical', readFileSync(a.path).equals(original));
    const tab = await win.locator('.tab-active .tab-title').innerText();
    R.check('Save As: tab and title show the new name, clean', tab.includes('Copy of mixed ünïcode (2).pdf') && !(await isDirty(win)) && (await win.title()) === 'Copy of mixed ünïcode (2).pdf — PDF Suite', `${tab} / ${await win.title()}`);
  });

  await R.step('after Save As, Ctrl+S writes the new file, not the original', async () => {
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    const d = inspectMupdf(b);
    R.check('Ctrl+S after Save As: new file has the rotation', /Saved Copy of mixed/.test(t) && d.pages[0].rotate === 90, `${t} rotate ${d.pages[0].rotate}`);
    R.check('Ctrl+S after Save As: original still byte-identical', readFileSync(a.path).equals(original));
  });

  await R.step('Save As without ".pdf" gets the extension', async () => {
    const bare = join(outDir, 'no-extension');
    await setSaveAnswer(s, bare);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    R.check('file written as no-extension.pdf', existsSync(`${bare}.pdf`) && !existsSync(bare), readdirSync(outDir).join(', '));
  });

  await R.step('Save As over a file that is open in another tab is refused in plain words', async () => {
    // Open the original again in a second tab, then go back and Save As onto it.
    await s.setDialogAnswer([a.path]);
    await win.keyboard.press('Control+o');
    await waitFor(async () => (await win.getByRole('tab').count()) === 2, { timeoutMs: 15000, label: 'two tabs' });
    await waitFor(async () => /of 8/.test(await statusText(win)), { timeoutMs: 15000, label: 'second tab ready' });
    await win.getByRole('tab').first().click();
    await waitFor(async () => /of 7/.test(await statusText(win)), { timeoutMs: 15000, label: 'first tab' });
    await showPanel(win, 'Thumbnails');
    await jumpTo(win, 1);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await setSaveAnswer(s, a.path);
    const t = await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    R.check('refusal message', /open in another tab/.test(t) && plainEnglish(t), t);
    R.check('refused Save As: target untouched, document still unsaved', readFileSync(a.path).equals(original) && (await isDirty(win)));
    // close second tab
    await win.getByRole('tab').nth(1).click();
    await win.keyboard.press('Control+w');
    await waitFor(async () => (await win.getByRole('tab').count()) === 1, { timeoutMs: 10000, label: 'one tab' });
  });

  await R.step('saving to a read-only file fails with a plain message and loses nothing', async () => {
    const target = join(outDir, 'no-extension.pdf');
    await waitFor(async () => /of 8/.test(await statusText(win)), { timeoutMs: 10000, label: 'doc with 8 pages' });
    const before = readFileSync(target);
    chmodSync(target, 0o444);
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    R.check('read-only save: plain failure message', /could not be saved/.test(t) && plainEnglish(t), t);
    R.check('read-only save: file unchanged, document still unsaved with 8 pages', readFileSync(target).equals(before) && (await isDirty(win)) && (await pageCount(win)) === 8);
    const leftovers = readdirSync(outDir).filter((f) => f.endsWith('.tmp'));
    R.check('read-only save: no temp file left behind', leftovers.length === 0, leftovers.join(','));
    chmodSync(target, 0o666);
    const t2 = await toastAfter(win, () => win.keyboard.press('Control+s'));
    const d = inspectMupdf(target);
    R.check('after clearing read-only, the save goes through', /Saved no-extension\.pdf/.test(t2) && d.count === 8, `${t2} count ${d.count}`);
  });

  await R.step('File ▸ Open Recent lists the saved-as file', async () => {
    await win.locator('.menu-tops > .menu-top > button', { hasText: /^File$/ }).click();
    await win.locator('.menu-item', { hasText: 'Open Recent' }).click();
    await delay(400);
    const items = await win.locator('.menu-sub .menu-item').allInnerTexts();
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    R.check('recent list has the Save As targets', items.some((i) => i.includes('no-extension.pdf')) && items.some((i) => i.includes('Copy of mixed')), JSON.stringify(items));
  });
  R.check('part 1: no console errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
  let all = await toasts(win);
  R.check('part 1: toasts are plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  await s.close();

  // ---------- Encrypted file
  const PW = 'test123';
  const e = mk('locked.pdf');
  const profile = newProfileDir();
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');
  await s.setDialogAnswer([e.path]);
  await win.keyboard.press('Control+o');
  const pw = win.getByRole('dialog').filter({ has: win.locator('input[type="password"]') });
  await pw.waitFor({ timeout: 15000 });
  await watchToasts(win);
  await R.step('encrypted: wrong password is refused in plain words, right one opens', async () => {
    await pw.locator('input[type="password"]').fill('wrong-one');
    await win.keyboard.press('Enter');
    await win.getByText('Wrong password, try again.').waitFor({ timeout: 10000 });
    R.check('wrong password message', true);
    await pw.locator('input[type="password"]').fill(PW);
    await win.keyboard.press('Enter');
    await waitFor(async () => /Page 1 of 1/.test(await statusText(win)), { timeoutMs: 15000, label: 'locked file open' });
    await showPanel(win, 'Thumbnails');
    await win.locator('.thumb').first().waitFor();
  });

  await R.step('encrypted: insert + duplicate, Ctrl+S keeps the password', async () => {
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await menu(win, 'Pages', 'Insert Blank Page…');
    await toastAfter(win, () => sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 3);
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(500);
    R.info(`encrypted save toast: ${t}; bars: ${(await bars(win)).join(' | ')}`);
    const locked = inspectMupdf(e.path);
    const opened = inspectMupdf(e.path, PW);
    R.check('encrypted save: file still needs the password', locked.needsPassword === true && locked.ok === false);
    R.check('encrypted save: opens with the same password, 3 pages', opened.ok && opened.count === 3 && opened.encrypted, `count ${opened.count}`);
    R.check('encrypted save: app still shows 3 pages, clean', (await pageCount(win)) === 3 && !(await isDirty(win)));
    let pj = null;
    try {
      pj = await inspectPdfjs(e.path, PW);
    } catch (err) {
      pj = { error: err.message };
    }
    R.check('encrypted save: pdf.js opens it with the password too', pj.count === 3, JSON.stringify(pj).slice(0, 200));
  });

  await R.step('encrypted: delete (forces a full rewrite), Ctrl+S keeps the password', async () => {
    await jumpTo(win, 1);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 2);
    const t = await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(500);
    const locked = inspectMupdf(e.path);
    const opened = inspectMupdf(e.path, PW);
    R.info(`after delete+save: toast ${t}; bars ${(await bars(win)).join(' | ')}`);
    R.check('encrypted full save: still locked, opens with the password, 2 pages', locked.needsPassword === true && opened.ok && opened.count === 2, `needs ${locked.needsPassword} count ${opened.count}`);
  });

  await R.step('encrypted: extract gives a locked file (or asks)', async () => {
    const target = join(outDir, 'locked-extract.pdf');
    await setSaveAnswer(s, target);
    await jumpTo(win, 0);
    const n = (await bars(win)).length;
    await menu(win, 'File', 'Extract Pages…');
    await delay(2500);
    const newBars = (await bars(win)).slice(n);
    const last = (await toasts(win)).at(-1);
    R.info(`extract from encrypted: toast "${last}", bars ${JSON.stringify(newBars)}`);
    if (existsSync(target)) {
      const locked = inspectMupdf(target);
      const opened = inspectMupdf(target, PW);
      R.check('encrypted extract: output needs the same password', locked.needsPassword === true && opened.ok && opened.count === 1, `needs ${locked.needsPassword} ok ${opened.ok}`);
    } else {
      R.check('encrypted extract: the app asked before writing an unencrypted copy', newBars.some((x) => /encrypt/i.test(x)), JSON.stringify(newBars));
    }
  });

  await R.step('encrypted: Save As keeps the password', async () => {
    const target = join(outDir, 'locked-copy.pdf');
    await setSaveAnswer(s, target);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    const t = await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    await delay(500);
    const locked = existsSync(target) ? inspectMupdf(target) : { missing: true };
    const opened = existsSync(target) ? inspectMupdf(target, PW) : { missing: true };
    R.info(`save as encrypted: toast ${t}; bars ${(await bars(win)).join(' | ')}`);
    R.check('encrypted Save As: copy is locked with the same password', locked.needsPassword === true && opened.ok && opened.count === 2 && opened.pages[0].rotate === 90, JSON.stringify({ locked: locked.needsPassword, ok: opened.ok, count: opened.count }));
  });

  await R.step('encrypted: an unsaved edit, then the password is nowhere on disk', async () => {
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await delay(1500); // the recovery log is written 300 ms after an edit
    const recoveryFiles = filesUnder(profile).filter((f) => /recovery/i.test(f));
    R.info(`recovery files: ${recoveryFiles.map((f) => f.split(/[\\/]/).slice(-2).join('/')).join(', ')}`);
    R.check('a recovery log exists for the unsaved edit', recoveryFiles.length > 0);
    const hits = [...findSecret(profile, PW), ...findSecret(outDir, PW), ...findSecret(e.dir, PW)];
    R.check('the password is not stored in the profile, the recovery log or next to the files', hits.length === 0, hits.join(' ; '));
    for (const f of recoveryFiles.filter((x) => /\.json$|log/i.test(x)).slice(0, 2)) R.info(`log ${f.split(/[\\/]/).pop()}: ${readFileSync(f, 'utf8').slice(0, 300)}`);
  });
  all = await toasts(win);
  R.check('part 2: toasts are plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.check('part 2: no console errors', s.errors.filter((x) => !/favicon/.test(x)).length === 0, s.errors.join(' || ').slice(0, 800));
  await s.close();
  await delay(800);
  const hitsAfterQuit = findSecret(profile, PW);
  R.check('after quitting, the password is still nowhere in the profile', hitsAfterQuit.length === 0, hitsAfterQuit.join(' ; '));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'c-failure');
} finally {
  await closeAll();
  for (const c of copies) removeCopy(c);
  rmSync(outDir, { recursive: true, force: true });
  process.exitCode = R.summary() ? 1 : 0;
}
