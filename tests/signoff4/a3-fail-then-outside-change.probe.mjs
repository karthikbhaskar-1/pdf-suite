// Probe A3: a failed save, then the file is changed by another program, then (a) Save, (b) Keep my version + Save,
// (c) Reload. Probe A saw the document still marked unsaved after each; this follows the state step by step.
import { join } from 'node:path';
import { readFileSync, chmodSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, delay, newProfileDir, cleanupProfile, fixture,
  makeReport, watchToasts, toastAfter, menuItems, shot, inspect, brief, toasts, isDirty, uids,
} from './lib.mjs';

const R = makeReport('a3-fail-then-outside-change');
const copies = [];
const mk = (name) => {
  const c = copyOf(name);
  copies.push(c);
  return c;
};
let s;
let win;
let profile;
const recSteps = () => {
  const dir = join(profile, 'recovery');
  if (!existsSync(dir)) return 'no folder';
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return `${j.steps.length} steps [${j.steps.map((st) => st.map((e) => e.op).join('+')).join(', ')}]`;
    } catch (e) {
      return `unreadable ${e.message}`;
    }
  }).join(' ; ') || 'none';
};
const state = async (label, path) => {
  const u = (await menuItems(win, 'Edit')).slice(0, 2);
  const line = `${label}: pages=${await pageCount(win)} uids=${(await uids(win)).join(',')} dirty=${await isDirty(win)} title="${await win.title()}" undo="${u[0].label}"${u[0].disabled ? `(off: ${u[0].title})` : ''} redo="${u[1].label}"${u[1].disabled ? '(off)' : ''} bars=${JSON.stringify(await win.locator('.doc-bar').allInnerTexts())} log: ${recSteps()} disk: ${brief(inspect(path))}`;
  R.info(line);
};
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
const save = (ms = 20000) => toastAfter(win, () => win.keyboard.press('Control+s'), ms);
async function prepare() {
  const a = mk('outline-6.pdf');
  await open(s, a.path, 6);
  await watchToasts(win);
  await jumpTo(win, 0);
  await toastAfter(win, () => win.keyboard.press('Control+d'));
  await waitForCount(win, 7);
  chmodSync(a.path, 0o444);
  const f = await save();
  chmodSync(a.path, 0o666);
  await delay(500);
  await state('  after the failed save', a.path);
  writeFileSync(a.path, readFileSync(fixture('mixed-sizes-rotated.pdf')));
  return { a, f };
}

try {
  profile = newProfileDir();
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');

  for (const round of [1, 2]) {
    await R.step(`(a) round ${round} threw`, async () => {
      const { a } = await prepare();
      const t = await save();
      await delay(300);
      await state(`(a) +0.3 s after "${t}"`, a.path);
      await delay(2500);
      await state('(a) +2.8 s', a.path);
      await delay(4500);
      await state('(a) +7.3 s', a.path);
      const d = inspect(a.path);
      const dirty = await isDirty(win);
      R.check(`(a) round ${round}: fail, outside change, Save: disk has my 7 pages`, brief(d) === '7p [o1,o1,o2,o3,o4,o5,o6]', brief(d));
      R.check(`(a) round ${round}: after "Saved …" the document is not marked unsaved`, !dirty, `dirty=${dirty}`);
      if (dirty) {
        await shot(win, `a3-a-still-unsaved-${round}`);
        // What does a user who trusts the dot do next? Save again, then look at the file.
        const t2 = await save().catch((e) => `no toast (${e.message})`);
        await delay(800);
        await state(`(a) after saving again ("${t2}")`, a.path);
      }
    });
    await closeEverything();
  }

  await R.step('(b) threw', async () => {
    const { a } = await prepare();
    const bar = win.locator('.doc-bar', { hasText: 'This file changed on disk' });
    await bar.waitFor({ timeout: 15000 });
    await state('(b) bar showing', a.path);
    await bar.getByRole('button', { name: 'Keep my version' }).click();
    const t = await save();
    await delay(1500);
    await state(`(b) +1.5 s after "${t}"`, a.path);
    R.check('(b) fail, outside change, Keep my version, Save: disk has my 7 pages and the document is clean', brief(inspect(a.path)) === '7p [o1,o1,o2,o3,o4,o5,o6]' && !(await isDirty(win)), `dirty=${await isDirty(win)}`);
  });
  await closeEverything();

  await R.step('(c) threw', async () => {
    const { a } = await prepare();
    const bar = win.locator('.doc-bar', { hasText: 'This file changed on disk' });
    await bar.waitFor({ timeout: 15000 });
    await bar.getByRole('button', { name: 'Reload' }).click();
    await delay(2500);
    await state('(c) +2.5 s after Reload', a.path);
    const n = await pageCount(win);
    const dirty = await isDirty(win);
    R.check('(c) fail, outside change, Reload: the screen shows the 8 pages now on disk, clean', n === 8 && !dirty, `pages=${n} dirty=${dirty}`);
    if (dirty) await shot(win, 'a3-c-reload-still-unsaved');
    // Ctrl+S now: must never write the old 7-page document over the other program's file without the user asking.
    const before = readFileSync(a.path);
    const nT = (await toasts(win)).length;
    await win.keyboard.press('Control+s');
    await delay(2000);
    await state(`(c) after Ctrl+S (new toasts: ${JSON.stringify((await toasts(win)).slice(nT))})`, a.path);
    R.check('(c) Ctrl+S right after Reload leaves the other program\'s 8-page file as it is', inspect(a.path).count === 8, `disk ${brief(inspect(a.path))}; bytes same=${readFileSync(a.path).equals(before)}`);
  });
  await closeEverything();
  R.check('no console or page errors', s.errors.filter((x) => !/favicon/.test(x)).length === 0, s.errors.join(' || ').slice(0, 900));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'a3-failure');
} finally {
  await closeAll();
  if (profile) cleanupProfile(profile);
  for (const c of copies) {
    try {
      for (const f of readdirSync(c.dir)) chmodSync(join(c.dir, f), 0o666);
    } catch { /* gone */ }
    removeCopy(c);
  }
  process.exitCode = R.summary() ? 1 : 0;
}
