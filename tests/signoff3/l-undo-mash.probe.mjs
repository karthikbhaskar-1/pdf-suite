// Probe L: very fast undo / redo / edit key presses. The outcome may skip presses, but it must never drift: the page
// list must always be one of the states the document really had, Undo/Redo must walk exactly through them, and the saved
// file must match what the window shows.
import {
  launch, closeAll, copyOf, removeCopy, open, jumpTo, uids, waitFor, delay,
  makeReport, watchToasts, toastAfter, menuItems, shot, inspectMupdf, toasts, isDirty, snapshot, plainEnglish,
} from './lib.mjs';

const R = makeReport('l-undo-mash');
const a = copyOf('mixed-sizes-rotated.pdf');
let s;

try {
  s = await launch();
  const { win } = s;
  await win.waitForSelector('.empty-state');
  await open(s, a.path, 8);
  await watchToasts(win);
  const snaps = [await snapshot(win)];
  const steps = [
    ['rotate page 1', 0, 'Control+Shift+R'],
    ['duplicate page 2', 1, 'Control+d'],
    ['delete page 4', 3, 'Delete'],
    ['move page 1 down', 0, 'Alt+ArrowDown'],
    ['rotate page 3 left', 2, 'Control+Shift+L'],
    ['duplicate page 5', 4, 'Control+d'],
  ];
  for (const [, index, key] of steps) {
    await jumpTo(win, index);
    await toastAfter(win, () => win.keyboard.press(key));
    await delay(150);
    snaps.push(await snapshot(win));
  }
  const N = steps.length;
  const where = async () => snaps.indexOf(await snapshot(win));

  const settle = async () => {
    let last = '';
    for (let i = 0; i < 40; i++) {
      await delay(250);
      const now = await snapshot(win);
      if (now === last) return now;
      last = now;
    }
    return last;
  };
  const mashes = [
    'zzyzzzyyzyyyyy',
    'zzzzzzzzyyyyyyyy',
    'zyzyzyzyzyzy',
    'zzzyyzzzzyyyyyyzz',
  ];
  for (const [round, keys] of mashes.entries()) {
    await R.step(`mash ${round + 1}: ${keys}`, async () => {
      for (const k of keys) await win.keyboard.press(`Control+${k}`);
      await settle();
      const at = await where();
      const edits = await menuItems(win, 'Edit');
      R.check(`mash ${round + 1}: the page list is a state the document really had`, at >= 0, `state index ${at}; ${await snapshot(win)}`);
      R.info(`mash ${round + 1}: ended at step ${at} of ${N}; menu says "${edits[0].label}" (${edits[0].disabled ? 'off' : 'on'}) / "${edits[1].label}" (${edits[1].disabled ? 'off' : 'on'})`);
      R.check(`mash ${round + 1}: Undo/Redo availability matches where the document is`, (at === 0) === edits[0].disabled && (at === N) === edits[1].disabled, `at ${at}: undo off=${edits[0].disabled}, redo off=${edits[1].disabled}`);
      // Walk to the end one step at a time: each redo must give the next recorded state.
      for (let k = at + 1; k <= N; k++) {
        await win.keyboard.press('Control+y');
        await waitFor(async () => (await snapshot(win)) === snaps[k], { timeoutMs: 8000, label: `redo to step ${k}` });
      }
      R.check(`mash ${round + 1}: stepping forward reaches the newest state, Redo then off`, (await where()) === N && (await menuItems(win, 'Edit'))[1].disabled);
    });
  }
  await R.step('walk all the way back, one step at a time', async () => {
    for (let k = N - 1; k >= 0; k--) {
      await win.keyboard.press('Control+z');
      await waitFor(async () => (await snapshot(win)) === snaps[k], { timeoutMs: 8000, label: `undo to step ${k}` });
    }
    R.check('back at the start: clean, Undo off', !(await isDirty(win)) && (await menuItems(win, 'Edit'))[0].disabled);
  });
  await R.step('edits mixed into the mash, then save: disk equals the window', async () => {
    for (const k of ['Control+y', 'Control+y', 'Control+d', 'Control+z', 'Control+Shift+R', 'Control+y', 'Control+d', 'Control+z', 'Control+z', 'Control+y', 'Delete', 'Control+z']) await win.keyboard.press(k);
    await settle();
    const ids = await uids(win);
    const edits = await menuItems(win, 'Edit');
    R.info(`after the mixed mash: ${ids.length} pages [${ids.join(',')}], "${edits[0].label}" / "${edits[1].label}"`);
    // One undo and one redo must be exact inverses here too.
    const before = await snapshot(win);
    if (!edits[0].disabled) {
      await win.keyboard.press('Control+z');
      await settle();
      await win.keyboard.press('Control+y');
      await settle();
      R.check('undo then redo returns to the same state', (await snapshot(win)) === before);
    }
    const order = await uids(win);
    await toastAfter(win, () => win.keyboard.press('Control+s'));
    await delay(600);
    const disk = inspectMupdf(a.path);
    const after = await uids(win);
    R.check('saved file has the page count the window showed', disk.ok && disk.count === order.length && after.length === order.length, `disk ${disk.count}, window before save ${order.length}, after save ${after.length}`);
    const want = order.map((u) => (/^\d+$/.test(u) ? `Page ${Number(u) + 1}:` : null));
    const wrong = want.map((w, i) => (w && !disk.pages[i].text.startsWith(w) ? `${i + 1}: want ${w} have "${disk.pages[i].text}"` : null)).filter(Boolean);
    R.check('saved file has the original pages where the window showed them', wrong.length === 0, wrong.join(' ; '));
    R.info(`disk: ${JSON.stringify(disk.pages.map((p) => [p.text.slice(0, 7), p.rotate]))}`);
  });
  const all = await toasts(win);
  R.info('toasts: ' + [...new Set(all)].join(' | '));
  R.check('every toast is plain English', all.every(plainEnglish), all.filter((t) => !plainEnglish(t)).join(' | '));
  R.check('no console or page errors', s.errors.filter((e) => !/favicon/.test(e)).length === 0, s.errors.join(' || ').slice(0, 800));
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'l-failure');
} finally {
  await closeAll();
  removeCopy(a);
  process.exitCode = R.summary() ? 1 : 0;
}
