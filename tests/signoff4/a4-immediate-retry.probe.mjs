// Probe A4: the save that follows a failed save AT ONCE (no pause), with and without an outside change of the file.
// Probe A saw a document still marked unsaved after "Saved …" in this sequence; this isolates it and repeats it.
import { join } from 'node:path';
import { readFileSync, chmodSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, waitForCount, pageCount, delay, newProfileDir, cleanupProfile, fixture,
  makeReport, watchToasts, toastAfter, menuItems, shot, inspect, brief, toasts, isDirty, uids,
} from './lib.mjs';

const R = makeReport('a4-immediate-retry');
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
  let ids = '';
  try {
    ids = (await uids(win)).join(',');
  } catch (e) {
    ids = `!${String(e.message).slice(0, 120)}`;
  }
  R.info(`${label}: tabs=${await win.getByRole('tab').count()} pages=${await pageCount(win)} uids=${ids} dirty=${await isDirty(win)} title="${await win.title()}" undo="${u[0].label}"${u[0].disabled ? `(off: ${u[0].title})` : ''} bars=${JSON.stringify(await win.locator('.doc-bar').allInnerTexts())} log: ${recSteps()} disk: ${brief(inspect(path))}`);
};
const save = (ms = 20000) => toastAfter(win, () => win.keyboard.press('Control+s'), ms);

async function variant(label, { failFirst, outsideChange }) {
  await R.step(`${label} threw`, async () => {
    const a = mk('outline-6.pdf');
    await open(s, a.path, 6);
    await watchToasts(win);
    await jumpTo(win, 0);
    await toastAfter(win, () => win.keyboard.press('Control+d'));
    await waitForCount(win, 7);
    if (failFirst) {
      chmodSync(a.path, 0o444);
      await save();
      chmodSync(a.path, 0o666);
    }
    if (outsideChange) writeFileSync(a.path, readFileSync(fixture('mixed-sizes-rotated.pdf')));
    const t = await save();
    await delay(600);
    const dirty600 = await isDirty(win);
    await state(`${label} +0.6 s after "${t}"`, a.path);
    await delay(3000);
    const dirty = await isDirty(win);
    const d = inspect(a.path);
    R.check(`${label}: disk has my 7 pages`, brief(d) === '7p [o1,o1,o2,o3,o4,o5,o6]', brief(d));
    R.check(`${label}: after "Saved …" the document is clean`, /^Saved/.test(t) && !dirty600 && !dirty, `toast "${t}" dirty@0.6s=${dirty600} dirty@3.6s=${dirty}`);
    if (dirty) {
      await shot(win, `a4-${label.replace(/\W+/g, '-')}`);
      // Does the document still work? One more edit, then look.
      await jumpTo(win, 0).catch((e) => R.info(`${label}: jumpTo threw ${String(e.message).slice(0, 150)}`));
      const t2 = await toastAfter(win, () => win.keyboard.press('Control+Shift+R'), 8000).catch((e) => `no toast (${e.message})`);
      await delay(800);
      await state(`${label} after one more rotate ("${t2}")`, a.path);
      const t3 = await save(8000).catch((e) => `no toast (${e.message})`);
      await delay(800);
      await state(`${label} after one more save ("${t3}")`, a.path);
    }
    // Close the tab; a prompt here means the app thinks there are unsaved edits.
    await win.keyboard.press('Control+w');
    await delay(700);
    const prompt = win.getByRole('alertdialog');
    const asked = (await prompt.count()) > 0;
    if (asked) {
      R.info(`${label}: closing asks "${(await prompt.innerText()).replace(/\s+/g, ' ')}"`);
      await prompt.getByRole('button', { name: "Don't save", exact: true }).click();
      await delay(700);
    }
    const closed = (await win.locator('.empty-state').count()) > 0;
    R.check(`${label}: the tab closes without asking (nothing is unsaved)`, !asked && closed, `asked=${asked} closed=${closed}`);
    if (!closed) {
      // Get back to an empty window for the next variant.
      for (let i = 0; i < 4 && (await win.locator('.empty-state').count()) === 0; i++) {
        await win.keyboard.press('Control+Shift+w');
        await delay(600);
        if ((await prompt.count()) > 0) await prompt.getByRole('button', { name: "Don't save", exact: true }).click();
        await delay(600);
      }
    }
  });
}

try {
  profile = newProfileDir();
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');
  await variant('V1 fail, retry at once', { failFirst: true, outsideChange: false });
  await variant('V2 fail, outside change, save at once', { failFirst: true, outsideChange: true });
  await variant('V3 outside change, save at once (no failure)', { failFirst: false, outsideChange: true });
  await variant('V2 again', { failFirst: true, outsideChange: true });
  await variant('V1 again', { failFirst: true, outsideChange: false });
  R.check('no console or page errors', s.errors.filter((x) => !/favicon/.test(x)).length === 0, s.errors.join(' || ').slice(0, 900));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'a4-failure');
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
