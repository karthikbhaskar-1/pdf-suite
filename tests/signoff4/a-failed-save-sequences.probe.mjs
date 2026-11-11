// Probe A (round-1 gap 1): saves that fail, in sequences round 1 did not try. Every result is read back from disk with an
// independent reader. One app session; each scenario starts from no open tabs.
import { join } from 'node:path';
import { readFileSync, chmodSync, writeFileSync, existsSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, waitFor, delay, setSaveAnswer, newProfileDir, cleanupProfile, fixture,
  makeReport, watchToasts, toastAfter, menu, menuItems, sheet, shot, inspect, inspectPdfjs, brief, toasts, bars, isDirty, plainEnglish, clickRowByIndex, showPanel, statusText,
} from './lib.mjs';

const R = makeReport('a-failed-save-sequences');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
let win;
let profile;
const recoveryFiles = () => (existsSync(join(profile, 'recovery')) ? readdirSync(join(profile, 'recovery')) : []);
const tmpLeft = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));
/** Closes every tab, answering Don't save, so the next scenario starts clean. */
async function closeEverything() {
  for (let i = 0; i < 6; i++) {
    if ((await win.locator('.empty-state').count()) > 0) return;
    await win.keyboard.press('Escape');
    await win.keyboard.press('Control+Shift+w');
    await delay(500);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(500);
  }
}
const save = () => toastAfter(win, () => win.keyboard.press('Control+s'));
const undoItem = async () => (await menuItems(win, 'Edit'))[0];

try {
  profile = newProfileDir();
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');

  // ---------- A1. Three failed saves in a row with a different edit before each, undo/redo after, then a save that works
  await R.step('A1 threw', async () => {
    const a = mk('outline-6.pdf');
    const original = readFileSync(a.path);
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    chmodSync(a.path, 0o444);
    const f1 = await save();
    R.check('A1 fail 1: plain message, still unsaved, file untouched', /could not be saved/.test(f1) && plainEnglish(f1) && (await isDirty(win)) && readFileSync(a.path).equals(original), f1);
    const u1 = await undoItem();
    R.info(`A1 after fail 1: Edit menu first item "${u1.label}" disabled=${u1.disabled} title="${u1.title}"`);
    R.check('A1 after a failed save, Undo says why it stops', u1.disabled && /can no longer be undone|could not be saved/.test(u1.title + f1), `${u1.label} / ${u1.title}`);
    R.check('A1 after fail 1 the recovery log is still there', recoveryFiles().some((f) => f.endsWith('.json')), recoveryFiles().join(','));
    await jumpTo(win, 2);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    const f2 = await save();
    await jumpTo(win, 6);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 6);
    const f3 = await save();
    R.check('A1 fails 2 and 3: same plain message, file untouched, 6 pages on screen, unsaved', /could not be saved/.test(f2) && /could not be saved/.test(f3) && readFileSync(a.path).equals(original) && (await pageCount(win)) === 6 && (await isDirty(win)), `${f2} || ${f3}`);
    // A new edit after the failures can be undone and redone.
    await jumpTo(win, 0);
    await menu(win, 'Pages', 'Insert Blank Page…');
    await toastAfter(win, () => sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 7);
    await toastAfter(win, () => win.keyboard.press('Control+z'));
    await waitForCount(win, 6);
    const u2 = await undoItem();
    R.check('A1 a later edit can be undone; the earlier ones stay and Undo explains', (await pageCount(win)) === 6 && u2.disabled && u2.title.length > 10, `${u2.label} / ${u2.title}`);
    await toastAfter(win, () => win.keyboard.press('Control+y'));
    await waitForCount(win, 7);
    R.check('A1 recovery log still there before the good save', recoveryFiles().some((f) => f.endsWith('.json')), recoveryFiles().join(','));
    chmodSync(a.path, 0o666);
    const ok = await save();
    await delay(600);
    const d = inspect(a.path);
    R.info(`A1 good save: "${ok}" disk ${brief(d)} outline ${JSON.stringify(d.outline)}`);
    R.check('A1 disk has every edit: o1, blank, o1, o2 rotated 90, o3, o4, o5', d.ok && brief(d) === '7p [o1,·,o1,o2/r90,o3,o4,o5]', brief(d));
    const pj = await inspectPdfjs(a.path);
    R.check('A1 pdf.js agrees', pj.count === 7 && pj.pages[3].rotate === 90 && pj.pages[3].text === 'Outline page 2' && pj.pages[1].text === '', JSON.stringify(pj.pages.map((p) => [p.text, p.rotate])));
    R.check('A1 bookmarks follow their pages (Intro → page 4, Middle → page 6)', Array.isArray(d.outline) && d.outline.find((o) => o.title === 'Intro')?.page === 4 && d.outline.find((o) => o.title === 'Middle')?.page === 6, JSON.stringify(d.outline));
    R.check('A1 after the good save: clean, 7 pages, log gone, no temp file', !(await isDirty(win)) && (await pageCount(win)) === 7 && recoveryFiles().length === 0 && tmpLeft(a.dir).length === 0, `dirty=${await isDirty(win)} rec=${recoveryFiles()} tmp=${tmpLeft(a.dir)}`);
    // One more edit and save on the same document.
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await save();
    await delay(400);
    const d2 = inspect(a.path);
    R.check('A1 a further edit and save reaches the disk', brief(d2) === '7p [o1/r90,·,o1,o2/r90,o3,o4,o5]', brief(d2));
  });
  await closeEverything();

  // ---------- A2. Save As to a read-only file and to a folder that does not exist, then Save, then Save As that works, then Save
  await R.step('A2 threw', async () => {
    const a = mk('outline-6.pdf');
    const roTarget = join(a.dir, 'read-only-target.pdf');
    copyFileSync(fixture('mixed-sizes-rotated.pdf'), roTarget);
    const roBytes = readFileSync(roTarget);
    chmodSync(roTarget, 0o444);
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 5);
    await setSaveAnswer(s, roTarget);
    const f1 = await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    R.check('A2 Save As onto a read-only file: plain failure, target untouched, tab keeps its name and stays unsaved', /could not be saved/.test(f1) && plainEnglish(f1) && readFileSync(roTarget).equals(roBytes) && (await isDirty(win)) && (await win.title()).startsWith('outline-6.pdf'), `${f1} / ${await win.title()}`);
    await setSaveAnswer(s, join(a.dir, 'no-such-folder', 'x.pdf'));
    const f2 = await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    R.check('A2 Save As into a missing folder: plain failure, still unsaved', /could not be saved/.test(f2) && plainEnglish(f2) && (await isDirty(win)), f2);
    const ok = await save();
    await delay(500);
    const d = inspect(a.path);
    R.check('A2 Save after two failed Save As: the original file has the 5 pages', /Saved outline-6\.pdf/.test(ok) && brief(d) === '5p [o2,o3,o4,o5,o6]', `${ok} / ${brief(d)}`);
    const afterFirst = readFileSync(a.path);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 6);
    chmodSync(roTarget, 0o666);
    await setSaveAnswer(s, roTarget);
    const ok2 = await toastAfter(win, () => win.keyboard.press('Control+Shift+S'));
    await delay(500);
    const dt = inspect(roTarget);
    R.check('A2 Save As (now writable): target has 6 pages, original keeps its 5', /Saved read-only-target\.pdf/.test(ok2) && brief(dt) === '6p [o2,o2,o3,o4,o5,o6]' && readFileSync(a.path).equals(afterFirst), `${ok2} / ${brief(dt)}`);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    const ok3 = await save();
    await delay(500);
    const dt2 = inspect(roTarget);
    R.check('A2 Save after Save As goes to the new file only', /Saved read-only-target\.pdf/.test(ok3) && brief(dt2) === '6p [o2/r90,o2,o3,o4,o5,o6]' && readFileSync(a.path).equals(afterFirst), `${ok3} / ${brief(dt2)}`);
    R.check('A2 no temp files left', tmpLeft(a.dir).length === 0, tmpLeft(a.dir).join(','));
  });
  await closeEverything();

  // ---------- A3. The file changes on disk between a failed save and the next one
  await R.step('A3a threw', async () => {
    const a = mk('outline-6.pdf');
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    chmodSync(a.path, 0o444);
    await save();
    chmodSync(a.path, 0o666);
    // Another program writes a different PDF over the file; the user saves at once (before the 5 s disk watch).
    writeFileSync(a.path, readFileSync(fixture('mixed-sizes-rotated.pdf')));
    const nBars = (await bars(win)).length;
    const t = await save();
    await delay(600);
    const d = inspect(a.path);
    R.info(`A3a immediate save over an outside change: toast "${t}", disk ${brief(d)}, unsaved=${await isDirty(win)}, new bars: ${JSON.stringify((await bars(win)).slice(nBars))}`);
    R.check('A3a the file on disk is one whole document (my 7 pages, or the other program\'s 8), never a mix', d.ok && (brief(d) === '7p [o1,o1,o2,o3,o4,o5,o6]' || d.count === 8), brief(d));
    R.check('A3a screen and disk agree, or the document is still marked unsaved', (d.count === 7 && !(await isDirty(win))) || (await isDirty(win)), `disk ${d.count}, dirty ${await isDirty(win)}`);
  });
  await closeEverything();
  await R.step('A3b threw', async () => {
    const a = mk('outline-6.pdf');
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    chmodSync(a.path, 0o444);
    await save();
    chmodSync(a.path, 0o666);
    writeFileSync(a.path, readFileSync(fixture('mixed-sizes-rotated.pdf')));
    const bar = win.locator('.doc-bar', { hasText: 'This file changed on disk' });
    await bar.waitFor({ timeout: 15000 });
    R.check('A3b the outside change is announced', true);
    await bar.getByRole('button', { name: 'Keep my version' }).click();
    const t = await save();
    await delay(600);
    const d = inspect(a.path);
    R.check('A3b Keep my version + Save: disk has my 7 pages (the earlier edit survived the failed save)', brief(d) === '7p [o1,o1,o2,o3,o4,o5,o6]' && !(await isDirty(win)), `${t} / ${brief(d)}`);
  });
  await closeEverything();
  await R.step('A3c threw', async () => {
    // Reload after a failed save and an outside change: the screen must become the other program's file, sizes included.
    const a = mk('outline-6.pdf');
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    chmodSync(a.path, 0o444);
    await save();
    chmodSync(a.path, 0o666);
    writeFileSync(a.path, readFileSync(fixture('mixed-sizes-rotated.pdf')));
    const bar = win.locator('.doc-bar', { hasText: 'This file changed on disk' });
    await bar.waitFor({ timeout: 15000 });
    await bar.getByRole('button', { name: 'Reload' }).click();
    await waitForCount(win, 8);
    await delay(800);
    const u = await undoItem();
    R.check('A3c Reload: 8 pages, clean, nothing to undo, recovery log gone', (await pageCount(win)) === 8 && !(await isDirty(win)) && u.disabled && recoveryFiles().length === 0, `dirty=${await isDirty(win)} undo="${u.label}" rec=${recoveryFiles()}`);
    // Then an edit and a save on the reloaded document.
    await jumpTo(win, 7);
    await toastAfter(win, () => win.keyboard.press('Delete'));
    await waitForCount(win, 7);
    await save();
    await delay(500);
    const d = inspect(a.path);
    R.check('A3c edit + save after Reload: disk has the other file minus its last page', d.count === 7 && d.pages[0].text === 'Page 1: Letter portrait' && d.pages[6].text.startsWith('Page 7'), brief(d));
  });
  await closeEverything();

  // ---------- A4. Encrypted file: failed save, retry, edit, save again; the password must survive every time
  await R.step('A4 threw', async () => {
    const PW = 'test123';
    const e = mk('locked.pdf');
    const original = readFileSync(e.path);
    await s.setDialogAnswer([e.path]);
    await win.keyboard.press('Control+o');
    const pw = win.getByRole('dialog').filter({ has: win.locator('input[type="password"]') });
    await pw.waitFor({ timeout: 15000 });
    await pw.locator('input[type="password"]').fill(PW);
    await win.keyboard.press('Enter');
    await waitFor(async () => /Page 1 of 1/.test(await statusText(win)), { timeoutMs: 15000, label: 'locked file open' });
    await showPanel(win, 'Thumbnails');
    await win.locator('.thumb').first().waitFor();
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 2);
    chmodSync(e.path, 0o444);
    const f = await save();
    R.check('A4 encrypted, read-only: plain failure, file untouched', /could not be saved/.test(f) && readFileSync(e.path).equals(original), f);
    chmodSync(e.path, 0o666);
    const ok = await save();
    await delay(600);
    const locked = inspect(e.path);
    const d = inspect(e.path, PW);
    R.info(`A4 retry: "${ok}"; bars ${JSON.stringify(await bars(win))}; without password: ok=${locked.ok}; with: ${brief(d)} encrypted=${d.encrypted}`);
    R.check('A4 retry after the failure: still needs the password, and has both pages', locked.ok === false && locked.needsPassword && d.ok && d.count === 2 && d.pages.every((p) => p.text.startsWith('Locked document')), brief(d));
    await jumpTo(win, 1);
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    await menu(win, 'Pages', 'Insert Grid Page…');
    await toastAfter(win, () => sheet(win, 'Insert pages').getByRole('button', { name: 'Apply' }).click());
    await waitForCount(win, 3);
    chmodSync(e.path, 0o444);
    await save();
    chmodSync(e.path, 0o666);
    const ok2 = await save();
    await delay(600);
    const locked2 = inspect(e.path);
    const d2 = inspect(e.path, PW);
    R.check('A4 second round (edits, fail, save): password kept, 3 pages, page 2 rotated', locked2.ok === false && d2.ok && d2.count === 3 && d2.pages[1].rotate === 90 && d2.pages[2].text === '', `${ok2} / ${brief(d2)}`);
    let pjOk = false;
    try {
      const pj = await inspectPdfjs(e.path, PW);
      pjOk = pj.count === 3;
    } catch (err) {
      R.info(`A4 pdf.js: ${err.message}`);
    }
    R.check('A4 pdf.js opens the saved encrypted file with the password', pjOk);
    // Passwords are never stored: nothing in the profile holds it.
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (st.size < 20_000_000) {
          try {
            const b = readFileSync(p);
            if (b.includes(Buffer.from(PW, 'latin1')) || b.includes(Buffer.from(PW, 'utf16le'))) hits.push(p);
          } catch { /* locked by the app */ }
        }
      }
    };
    walk(profile);
    R.check('A4 the password is nowhere in the profile folder', hits.length === 0, hits.join(', '));
  });
  await closeEverything();

  // ---------- A5. 1000 pages: delete 400, failed save, rotate, save
  await R.step('A5 threw', async () => {
    const big = mk('big-1000.pdf');
    const before = inspect(big.path);
    const original = readFileSync(big.path);
    await open(s, big.path, 1000);
    await watchToasts(win);
    await clickRowByIndex(win, 0);
    await clickRowByIndex(win, 399, ['Shift']);
    const t = await toastAfter(win, () => win.keyboard.press('Delete'), 60000);
    await waitFor(async () => (await pageCount(win)) === 600, { timeoutMs: 30000, label: '600 pages' });
    R.info(`A5 delete 400: "${t}"`);
    chmodSync(big.path, 0o444);
    const t0 = Date.now();
    const f = await toastAfter(win, () => win.keyboard.press('Control+s'), 120000);
    R.info(`A5 failed save took ${Date.now() - t0} ms: "${f}"`);
    R.check('A5 failed save on 1000 pages: plain failure, file untouched, 600 pages unsaved', /could not be saved/.test(f) && readFileSync(big.path).equals(original) && (await pageCount(win)) === 600 && (await isDirty(win)), f);
    await win.locator('.thumb').first().click();
    await toastAfter(win, () => win.keyboard.press('Control+Shift+R'));
    chmodSync(big.path, 0o666);
    const t1 = Date.now();
    const ok = await toastAfter(win, () => win.keyboard.press('Control+s'), 120000);
    const ms = Date.now() - t1;
    await delay(800);
    const d = inspect(big.path);
    const want = before.pages.slice(400).map((p) => p.text);
    const got = d.pages.map((p) => p.text);
    R.info(`A5 good save took ${ms} ms: "${ok}"; disk ${d.count} pages, first "${got[0]}" r${d.pages[0].rotate}, last "${got.at(-1)}", size ${d.size} (was ${before.size})`);
    R.check('A5 disk: 600 pages, the right ones in order, page 1 rotated, clean document', d.ok && d.count === 600 && JSON.stringify(got) === JSON.stringify(want) && d.pages[0].rotate === 90 && d.pages.slice(1).every((p) => p.rotate === 0) && !(await isDirty(win)), `count ${d.count}`);
    R.check('A5 the save is quick enough to use (< 15 s)', ms < 15000, `${ms} ms`);
  });
  await closeEverything();

  const all = await toasts(win).catch(() => []);
  R.info('toasts of the last scenario: ' + all.join(' | '));
  R.check('no console or page errors in the whole session', s.errors.filter((x) => !/favicon/.test(x)).length === 0, s.errors.join(' || ').slice(0, 900));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'a-failure');
} finally {
  await closeAll();
  if (profile) cleanupProfile(profile);
  for (const c of copies) {
    try {
      for (const f of readdirSync(c.dir)) chmodSync(join(c.dir, f), 0o666);
    } catch { /* already gone */ }
    removeCopy(c);
  }
  process.exitCode = R.summary() ? 1 : 0;
}
