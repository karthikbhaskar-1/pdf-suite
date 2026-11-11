// Sign-Off 11, D: security of the Split folder token and of Combine's output path. The page is treated as hostile: the
// calls are made straight from the page (window.pdfSuite.jobs.*), then the same through the real sheets. Auditor code only.
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { buildPdf, put, dirOf, wipe, report, start, closeAll, open, openSheet, ready, chooseFolder, anyNotice, splitButton, listing, sha, closeNotice, delay, openCombine, addFiles, windowOf, WORK, inspect } from '../signoff9/lib9.mjs';

const R = report('s11-d-security');

function tree(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { out.push(`${p.slice(base.length)} (unreadable)`); continue; }
    if (st.isDirectory()) tree(p, base, out);
    else out.push(`${p.slice(base.length)}:${st.size}`);
  }
  return out.sort();
}
const jobs = (s, method, ...args) => s.win.evaluate(async ([m, a]) => {
  try {
    const fixed = a.map((x) => (x && x.__bytes ? new Uint8Array(x.__bytes).buffer : x));
    return await window.pdfSuite.jobs[m](...fixed);
  } catch (e) { return { threw: String(e && e.message ? e.message : e).slice(0, 200) }; }
}, [method, args]);

const BAD = [
  '..\\evil.pdf', '../evil.pdf', '..\\..\\evil.pdf', 'sub\\evil.pdf', 'sub/evil.pdf', 'C:\\Windows\\Temp\\evil-s11.pdf', '\\\\?\\C:\\evil-s11.pdf', '\\evil.pdf',
  'CON.pdf', 'con.pdf', 'NUL.pdf', 'PRN.pdf', 'AUX.pdf', 'COM1.pdf', 'LPT1.pdf', 'LPT1.txt.pdf', 'CON .pdf', 'CON..pdf', ' CON.pdf',
  'x..pdf', 'x .pdf', ' x.pdf', 'x.pdf.', 'x.pdf ', '.pdf', '..pdf', '...pdf',
  'x.pdf:stream', 'x:y.pdf', 'x.pdf::$DATA', 'x.txt:hidden.pdf', 'x.pdf:y.pdf',
  `${'L'.repeat(300)}.pdf`, `${'L'.repeat(197)}.pdf`,
  'a\u0000b.pdf', 'a\nb.pdf', 'a\tb.pdf', 'x.exe', 'x.pdf.exe', 'x', 'a*b.pdf', 'a?b.pdf', 'a"b.pdf', 'a<b.pdf', 'a>b.pdf', 'a|b.pdf',
];
// Names the rule lets through that are worth a look on disk: they must land inside the folder under exactly that name, or fail cleanly.
const ODD = ['COM\u00b9.pdf', 'CONIN$.pdf', 'CLOCK$.pdf', 'x.PDF', '.hidden.pdf', 'desktop.ini.pdf', `${'M'.repeat(196)}.pdf`, 'a\u202Efdp.exe.pdf', 'caf\u00e9 \u00fc.pdf', '~$x.pdf', 'x%20y%2e%2e%5c.pdf'];

await R.step('D1 folder token and leaf names, called from the page', async () => {
  const root = dirOf('sec');
  const out = join(root, 'chosen');
  mkdirSync(out);
  const sentinel = put(root, 'precious.pdf', 'PRECIOUS');
  const inside = put(out, 'taken.pdf', 'TAKEN');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const before = tree(root);
    // no token at all, a made-up token
    const fake = 'a'.repeat(32);
    R.check('begin with a made-up folder token is refused', (await jobs(s, 'begin', { folderToken: fake }, [])).ok === false);
    R.check('begin with a folder PATH in place of a token is refused', (await jobs(s, 'begin', { folderToken: out }, [])).ok !== true);
    R.check('begin with a picked path that holds no write grant is refused', (await jobs(s, 'begin', { pickedPath: join(out, 'ungranted.pdf') }, [])).ok !== true);
    R.check('begin with both a token and a path is refused', (await jobs(s, 'begin', { folderToken: fake, pickedPath: join(out, 'u.pdf') }, [])).ok !== true);
    R.check('openFile with a made-up job token is refused', (await jobs(s, 'openFile', fake, 'x.pdf')).ok !== true);
    const win = await jobs(s, 'readInput', 'C:\\Windows\\win.ini');
    R.check('readInput of a file the user never chose is refused', !(win && win.ok === true) && !(win && win.bytes), JSON.stringify(win).slice(0, 160));
    const desc = await jobs(s, 'describeInputs', ['C:\\Windows\\win.ini', sentinel]);
    R.check('describeInputs says nothing about files the user never chose', Array.isArray(desc) ? desc.length === 0 : true, JSON.stringify(desc).slice(0, 200));
    // a real token
    await s.setDialogAnswer([out]);
    const folder = await jobs(s, 'pickFolder');
    R.check('pickFolder gives a token (32 hex) and the path as a label only', /^[0-9a-f]{32}$/.test(folder?.token ?? '') && folder.label === out, folder);
    const begun = await jobs(s, 'begin', { folderToken: folder.token }, []);
    R.check('begin with the real token works', begun.ok === true, begun);
    const accepted = [];
    for (const name of BAD) {
      const r = await jobs(s, 'openFile', begun.jobToken, name);
      if (r && r.ok === true) accepted.push(name);
    }
    R.check(`all ${BAD.length} bad leaf names are refused by main`, accepted.length === 0, accepted.map((n) => JSON.stringify(n.slice(0, 40))));
    await jobs(s, 'abort', begun.jobToken);
    await delay(300);
    R.check('after abort the folder tree is exactly as before (no file made anywhere, no .part)', JSON.stringify(tree(root)) === JSON.stringify(before), tree(root));
    R.check('nothing appeared in C:\\Windows\\Temp or C:\\', !existsSync('C:\\Windows\\Temp\\evil-s11.pdf') && !existsSync('C:\\evil-s11.pdf'));
    R.check('a dead job token is refused', (await jobs(s, 'openFile', begun.jobToken, 'x.pdf')).ok !== true);
    // an existing name is never replaced; the folder token dies with a committed job
    const b2 = await jobs(s, 'begin', { folderToken: folder.token }, []);
    const f = await jobs(s, 'openFile', b2.jobToken, 'taken.pdf');
    const bytes = { __bytes: [...Buffer.from('%PDF-1.4 new')] };
    R.check('append over 4 MB is refused', (await s.win.evaluate(async ([t, id]) => { try { return await window.pdfSuite.jobs.append(t, id, 0, new ArrayBuffer(4 * 1024 * 1024 + 1)); } catch (e) { return { threw: true }; } }, [b2.jobToken, f.fileId])).ok !== true);
    R.check('append out of order is refused', (await jobs(s, 'append', b2.jobToken, f.fileId, 5, bytes)).ok !== true);
    const ap = await jobs(s, 'append', b2.jobToken, f.fileId, 0, bytes);
    const wrongLen = await jobs(s, 'closeFile', b2.jobToken, f.fileId, 999);
    R.say(`INFO append ${JSON.stringify(ap)}; closeFile with a wrong length: ${JSON.stringify(wrongLen)}`);
    const cm = await jobs(s, 'commit', b2.jobToken);
    R.say(`INFO commit after a wrong length: ${JSON.stringify(cm)}; folder: ${JSON.stringify(listing(out))}`);
    R.check('existing taken.pdf still holds its own bytes', readFileSync(inside, 'utf8') === 'TAKEN');
    // clean run on a taken name
    const b3 = await jobs(s, 'begin', { folderToken: folder.token }, []);
    R.say(`INFO begin again with the same folder token: ${JSON.stringify(b3).slice(0, 80)}`);
    if (b3.ok) {
      const f3 = await jobs(s, 'openFile', b3.jobToken, 'taken.pdf');
      await jobs(s, 'append', b3.jobToken, f3.fileId, 0, bytes);
      await jobs(s, 'closeFile', b3.jobToken, f3.fileId, 12);
      const c3 = await jobs(s, 'commit', b3.jobToken);
      R.check('a taken name gets " (2)" and the old file is untouched', c3.ok === true && c3.results?.[0]?.name === 'taken (2).pdf' && readFileSync(inside, 'utf8') === 'TAKEN' && existsSync(join(out, 'taken (2).pdf')), { c3, files: listing(out) });
      R.check('the folder token is dead after a committed job', (await jobs(s, 'begin', { folderToken: folder.token }, [])).ok !== true);
    }
    // odd but allowed names
    for (const name of ODD) {
      await s.setDialogAnswer([out]);
      const fo = await jobs(s, 'pickFolder');
      const b = await jobs(s, 'begin', { folderToken: fo.token }, []);
      const o = await jobs(s, 'openFile', b.jobToken, name);
      if (!o || o.ok !== true) { R.say(`INFO odd name ${JSON.stringify(name.slice(0, 30))}: refused ${JSON.stringify(o)}`); await jobs(s, 'abort', b.jobToken); continue; }
      await jobs(s, 'append', b.jobToken, o.fileId, 0, bytes);
      await jobs(s, 'closeFile', b.jobToken, o.fileId, 12);
      const c = await jobs(s, 'commit', b.jobToken);
      const landed = c.ok === true && existsSync(join(out, c.results[0].name));
      R.say(`INFO odd name ${JSON.stringify(name.slice(0, 30))}: commit ${c.ok === true ? `ok as ${JSON.stringify(c.results[0].name.slice(0, 40))}` : JSON.stringify(c)}; file is in the folder: ${landed}`);
      R.check(`odd name ${JSON.stringify(name.slice(0, 24))}: lands in the chosen folder under its own name, or fails with nothing left`, c.ok === true ? landed && c.results[0].name === name : true);
    }
    await delay(300);
    const after = tree(root);
    R.check('nothing outside the chosen folder changed and no temp file is left', after.filter((x) => !x.startsWith('\\chosen\\') && !x.startsWith('/chosen/')).join('|') === before.filter((x) => !x.startsWith('\\chosen\\') && !x.startsWith('/chosen/')).join('|') && !after.some((x) => /pdfsuite-.*\.part/.test(x)), after.map((x) => x.slice(0, 60)));
    R.check('precious.pdf beside the folder is untouched', readFileSync(sentinel, 'utf8') === 'PRECIOUS');
    // a long path: deep folder + 196-character name (over 260 in total)
    let deep = join(root, 'deep');
    while (deep.length < 230) deep = join(deep, 'd'.repeat(40));
    mkdirSync(deep, { recursive: true });
    await s.setDialogAnswer([deep]);
    const fo = await jobs(s, 'pickFolder');
    const b = await jobs(s, 'begin', { folderToken: fo?.token ?? fake }, []);
    if (b.ok) {
      const longName = `${'N'.repeat(150)}.pdf`;
      const o = await jobs(s, 'openFile', b.jobToken, longName);
      let c = { ok: false, at: 'openFile', o };
      if (o.ok) {
        await jobs(s, 'append', b.jobToken, o.fileId, 0, bytes);
        await jobs(s, 'closeFile', b.jobToken, o.fileId, 12);
        c = await jobs(s, 'commit', b.jobToken);
      } else await jobs(s, 'abort', b.jobToken);
      const left = readdirSync(deep);
      R.say(`INFO long path (${join(deep, longName).length} characters): ${JSON.stringify(c).slice(0, 200)}; folder holds ${JSON.stringify(left.map((x) => x.slice(0, 30)))}`);
      R.check('long path: the file is there complete, or nothing is left', c.ok === true ? left.length === 1 && left[0] === longName : left.length === 0, left.map((x) => x.slice(0, 30)));
    } else R.say(`INFO long folder not accepted: ${JSON.stringify(fo)} ${JSON.stringify(b)}`);
    const journal = join(s.profile, 'jobs-journal.json');
    R.say(`INFO jobs-journal.json: ${existsSync(journal) ? readFileSync(journal, 'utf8').slice(0, 200) : 'not in the profile root'}`);
  } finally { await s.close(); }
});

await R.step('D2 Split by bookmarks with hostile bookmark titles, and hostile File names in the sheet', async () => {
  const root = dirOf('sec2');
  const out = join(root, 'chosen');
  mkdirSync(out);
  const titles = ['..\\..\\evil', 'CON', 'trailing dot.', 'stream:x', 'T'.repeat(300), '   ', 'a/b\\c*?"<>|', 'NUL', '..'];
  const path = put(root, 'Marks.pdf', buildPdf({ pages: titles.length, outline: titles.map((t, i) => ({ title: t, page: i + 1 })) }));
  const before = sha(path);
  const beforeTree = tree(root);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await open(s, path, titles.length);
    let sheet = await openSheet(s);
    await ready(sheet);
    await sheet.getByRole('radio', { name: 'Bookmarks' }).click();
    await delay(500);
    R.say(`INFO example: ${(await sheet.locator('[data-split-example]').innerText()).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    await chooseFolder(s, sheet, out);
    await splitButton(sheet).click();
    const text = await anyNotice(s, 60000);
    const names = listing(out);
    R.say(`INFO notice: ${text}`);
    R.say(`INFO files: ${JSON.stringify(names.map((n) => (n.length > 70 ? `${n.slice(0, 40)}…(${n.length})` : n)))}`);
    R.check(`${titles.length} files, all inside the chosen folder, one page each`, names.length === titles.length && names.every((n) => inspect(join(out, n)).pages === 1), names.length);
    const after = tree(root).filter((x) => !/[\\/]chosen[\\/]/.test(x));
    R.check('nothing was written outside the chosen folder', JSON.stringify(after) === JSON.stringify(beforeTree), after);
    R.check('every name is at most 200 characters and ends in .pdf', names.every((n) => n.length <= 200 && n.endsWith('.pdf')));
    R.check('source unchanged', sha(path) === before);
    await closeNotice(s);
    // hostile File name typed in the sheet
    for (const typed of ['..\\up', '../up', 'CON', 'Report.', 'a:x', 'x'.repeat(300), '   ', 'C:\\Windows\\Temp\\s11']) {
      const o2 = join(root, `o-${Math.random().toString(36).slice(2, 7)}`);
      mkdirSync(o2);
      sheet = await openSheet(s);
      await ready(sheet);
      await sheet.getByLabel('Pages in each file').fill('5');
      const field = sheet.getByLabel('File name');
      await field.fill(typed);
      const value = await field.inputValue();
      await chooseFolder(s, sheet, o2);
      const err = (await sheet.locator('[data-split-error]').allInnerTexts()).join(' | ');
      const disabled = await splitButton(sheet).isDisabled();
      let made = [];
      let note = '';
      if (!disabled) {
        await splitButton(sheet).click();
        note = await anyNotice(s, 60000).catch(() => 'no notice');
        made = listing(o2);
        await closeNotice(s);
      } else {
        await sheet.getByRole('button', { name: 'Cancel' }).click();
      }
      await delay(300);
      R.say(`INFO File name ${JSON.stringify(typed.slice(0, 30))}: field holds ${value.length} characters; message "${err}"; Split ${disabled ? 'off' : 'on'}; notice "${note.slice(0, 90)}"; files ${JSON.stringify(made.map((n) => (n.length > 60 ? `${n.slice(0, 30)}…(${n.length})` : n)))}`);
      const outside = tree(root).filter((x) => !/[\\/](chosen|o-[a-z0-9]+)[\\/]/.test(x));
      R.check(`File name ${JSON.stringify(typed.slice(0, 20))}: refused with a message, or the files are inside the chosen folder; nothing outside`, (disabled ? err.length > 0 : made.length === 2 && made.every((n) => existsSync(join(o2, n)))) && JSON.stringify(outside) === JSON.stringify(beforeTree), { err, made, outside });
    }
    R.check('nothing appeared in C:\\Windows\\Temp', !readdirSync('C:\\Windows\\Temp', { withFileTypes: false }).some((n) => /^s11/.test(n)));
  } finally { await s.close(); }
});

await R.step('D3 Combine output path from the Save dialog: odd names', async () => {
  const root = dirOf('sec3');
  const out = join(root, 'outdir');
  mkdirSync(out);
  const a = put(root, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const b = put(root, 'b.pdf', buildPdf({ pages: 1, tag: 'B' }));
  const shas = [sha(a), sha(b)];
  let deep = join(root, 'deep');
  while (deep.length < 240) deep = join(deep, 'e'.repeat(40));
  mkdirSync(deep, { recursive: true });
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    await s.app.evaluate(({ dialog }) => {
      globalThis.__boxes = [];
      dialog.showMessageBox = async (...args) => {
        const opts = args.find((x) => x && typeof x === 'object' && !x.webContents) ?? {};
        globalThis.__boxes.push({ message: opts.message, detail: opts.detail });
        return { response: opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 0), checkboxChecked: false };
      };
    });
    const cases = [
      { label: 'CON', path: join(out, 'CON'), expect: 'refused' },
      { label: 'CON.pdf', path: join(out, 'CON.pdf'), expect: 'refused' },
      { label: 'nul.txt.pdf', path: join(out, 'nul.txt.pdf'), expect: 'refused' },
      { label: 'trailing dot', path: join(out, 'trail.'), expect: 'refused' },
      { label: 'trailing dot after .pdf', path: `${join(out, 'trail.pdf')}.`, expect: 'refused' },
      { label: 'trailing space', path: `${join(out, 'trail.pdf')} `, expect: 'refused' },
      { label: 'alternate data stream :x', path: `${join(out, 'ads.pdf')}:x`, expect: 'refused' },
      { label: 'alternate data stream on an input', path: `${a}:x.pdf`, expect: 'refused' },
      { label: 'stream name ads:x.pdf', path: join(out, 'ads:x.pdf'), expect: 'refused' },
      { label: '300-character name', path: join(out, `${'L'.repeat(300)}.pdf`), expect: 'refused' },
      { label: 'input spelled with ..', path: join(out, '..', 'a.pdf'), expect: 'refused' },
      { label: 'input with a trailing dot', path: `${a}.`, expect: 'refused' },
      { label: 'input as \\\\?\\ path', path: `\\\\?\\${a}`, expect: 'refused' },
      { label: 'input by short 8.3-like upper case', path: a.toUpperCase(), expect: 'refused' },
      { label: 'path with .. to the folder above (the user chose it)', path: join(out, '..', 'above.pdf'), expect: 'either' },
      { label: 'long path, name ok', path: join(deep, 'LongOut.pdf'), expect: 'either' },
    ];
    for (const c of cases) {
      let dlg = windowOf(s.win);
      if ((await dlg.count()) === 0) dlg = await openCombine(s);
      if ((await dlg.locator('[data-row-id]').count()) !== 2) await addFiles(s, dlg, [a, b], 2);
      const box = dlg.getByLabel('Open the new file when it is ready');
      if (await box.isChecked()) await box.uncheck();
      await s.app.evaluate(() => { globalThis.__boxes.length = 0; });
      const treeBefore = tree(root);
      await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, c.path);
      await dlg.getByRole('button', { name: 'Combine…' }).click();
      await delay(3000);
      const boxes = await s.app.evaluate(() => globalThis.__boxes.slice());
      const open = (await windowOf(s.win).count()) === 1;
      const target = open ? (await windowOf(s.win).locator('[data-combine-target]').allInnerTexts()).join(' ') : '';
      const notice = (await s.win.locator('[data-job-notice]').count()) ? await anyNotice(s, 30000) : '';
      const treeAfter = tree(root);
      const added = treeAfter.filter((x) => !treeBefore.includes(x));
      const inputsOk = sha(a) === shas[0] && sha(b) === shas[1];
      R.say(`INFO [${c.label}] boxes ${JSON.stringify(boxes)}; window ${open ? 'open' : 'closed'}; target "${target.trim()}"; notice "${notice.slice(0, 80)}"; new on disk ${JSON.stringify(added.map((x) => (x.length > 70 ? `…${x.slice(-50)}` : x)))}`);
      const refused = added.length === 0 && !/^Combined/.test(notice);
      if (c.expect === 'refused') R.check(`[${c.label}] is refused: nothing new on disk, inputs intact`, refused && inputsOk, { added, notice });
      else R.check(`[${c.label}] either makes exactly one complete PDF where the user said, or nothing; inputs intact`, inputsOk && (refused || (added.length === 1 && /\.pdf:\d+$/.test(added[0]) && !/\.part/.test(added[0]))), added);
      if (added.length === 1 && c.expect === 'either') {
        const made = join(root, added[0].replace(/:\d+$/, ''));
        R.check(`[${c.label}] the new file has the 3 pages`, inspect(made).pages === 3);
      }
      R.check(`[${c.label}] no temp file left`, !treeAfter.some((x) => /\.part/.test(x)));
      await closeNotice(s);
    }
    // ADS check on the input itself
    R.check('inputs unchanged at the end', sha(a) === shas[0] && sha(b) === shas[1]);
  } finally { await s.close(); }
});

await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
