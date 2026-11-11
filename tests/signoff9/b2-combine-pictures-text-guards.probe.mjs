// Sign-Off 9, B2: Combine pictures and text, encrypted and XFA inputs, changed/deleted inputs, output name guards, Cancel.
import { join } from 'node:path';
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import * as mu from 'mupdf';
import { PNG } from 'pngjs';
import { buildPdf, put, dirOf, inspect, render, px, wipe, report, start, closeAll, openCombine, addFiles, rowNames, rowOf, rowsReady, combine, waitNotice, anyNotice, windowOf, sha, delay, messagesOf, waitFor, listing, closeNotice, setSaveAnswer, open as openDoc } from './lib9.mjs';
import { rgbPixels, makeTiff, withExif } from '../lib/makeImages.mjs';

const R = report('b2-combine-pictures-text-guards');
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

function walkFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

await R.step('B2a pictures and text', async () => {
  const dir = dirOf('in');
  // rotated phone photo: 400 x 300, EXIF orientation 6 (rotate 90 clockwise)
  const pm = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, 400, 300], false);
  pm.getPixels().set(rgbPixels(400, 300, 0));
  const phone = put(dir, 'phone.jpg', withExif(pm.asJPEG(92), { orientation: 6 }));
  // CMYK JPEG: pure cyan
  const cm = new mu.Pixmap(mu.ColorSpace.DeviceCMYK, [0, 0, 120, 80], false);
  const cpx = cm.getPixels();
  for (let i = 0; i < cpx.length; i += 4) { cpx[i] = 255; cpx[i + 1] = 0; cpx[i + 2] = 0; cpx[i + 3] = 0; }
  let cmykBytes = null;
  try { cmykBytes = cm.asJPEG(92, true); } catch (e) { R.say(`INFO cannot make a CMYK JPEG with mupdf: ${e.message}`); }
  const cmyk = cmykBytes ? put(dir, 'cmyk.jpg', Buffer.from(cmykBytes)) : null;
  // PNG with transparency: top half transparent, bottom half opaque red
  const png = new PNG({ width: 100, height: 60 });
  for (let y = 0; y < 60; y++) for (let x = 0; x < 100; x++) { const i = (y * 100 + x) * 4; png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = y < 30 ? 0 : 255; }
  const alpha = put(dir, 'alpha.png', PNG.sync.write(png));
  const tif = put(dir, 'scan.tif', makeTiff([{ w: 60, h: 40, seed: 10, dpi: 72 }, { w: 40, h: 60, seed: 20, dpi: 72 }, { w: 50, h: 50, seed: 30, dpi: 72 }]));
  const utf8 = put(dir, 'utf8.txt', 'Café ñandú — über naïve “quotes” € 5\nsecond line');
  const win1252 = put(dir, 'win1252.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x94, 0x20, 0x80, 0x20, 0x35, 0x0d, 0x0a, 0x6e, 0x75, 0x6c, 0x6c, 0x20, 0xfc, 0x62, 0x65, 0x72]));
  const empty = put(dir, 'empty.txt', '');
  const out = join(dirOf('out'), 'Pics.pdf');
  const all = [phone, cmyk, alpha, tif, utf8, win1252, empty].filter(Boolean);
  const before = all.map(sha);
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const dlg = await openCombine(s);
    await addFiles(s, dlg, all);
    await delay(4000);
    const names = await rowNames(dlg);
    const msgs = await messagesOf(dlg);
    R.say(`INFO rows: ${JSON.stringify(names)}; messages: ${JSON.stringify(msgs)}`);
    for (const n of names) R.say(`INFO row "${n}": ${(await rowOf(dlg, n).innerText()).replace(/\s+/g, ' ')}`);
    const notices = await dlg.locator('[data-combine-notices] p').evaluateAll((els) => els.map((e) => e.textContent));
    R.say(`INFO notices: ${JSON.stringify(notices)}`);
    R.say(`INFO summary: ${(await dlg.locator('[data-combine-summary]').innerText()).trim()}; Combine disabled: ${await dlg.getByRole('button', { name: 'Combine…' }).isDisabled()}`);
    R.check('empty.txt is neither silently listed as a 0-page row with Combine on, nor crashes: either refused with a message or a clear row', names.includes('empty.txt') ? /page/.test(await rowOf(dlg, 'empty.txt').innerText()) : msgs.some((m) => /empty\.txt/.test(m)), { names, msgs });
    if (names.includes('empty.txt') && (await dlg.getByRole('button', { name: 'Combine…' }).isDisabled())) {
      R.say('INFO empty.txt is listed and blocks Combine; removing it to continue');
      await rowOf(dlg, 'empty.txt').click();
      await dlg.getByRole('button', { name: 'Remove' }).click();
    }
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await dlg.getByLabel('Add a bookmark for each file').uncheck().catch(() => undefined);
    const disabled = await dlg.getByRole('button', { name: 'Combine…' }).isDisabled();
    R.check('Combine is available', !disabled);
    if (!disabled) {
      await combine(s, dlg, out);
      R.say(`INFO notice: ${await waitNotice(s, /Combined \d+ files|could not|wrong|Something/)}`);
      const p = inspect(out);
      R.say(`INFO result pages ${p.pages} sizes ${JSON.stringify(p.sizes)}`);
      R.say(`INFO texts ${JSON.stringify(p.text)}`);
      // order of the listed rows is the order added
      const idx = (n) => names.filter((x) => x !== 'empty.txt').indexOf(n);
      // phone photo
      const pi = idx('phone.jpg');
      R.check('phone photo comes out portrait (orientation 6 applied): taller than wide', p.sizes[pi][1] > p.sizes[pi][0], p.sizes[pi]);
      const img = render(out, pi, 1);
      const m = 4;
      const tl = px(img, m, m), tr = px(img, img.w - 1 - m, m), bl = px(img, m, img.h - 1 - m), br = px(img, img.w - 1 - m, img.h - 1 - m);
      R.say(`INFO phone corners TL ${tl} TR ${tr} BL ${bl} BR ${br} (expected TL~(0,255) TR~(0,0) BL~(255,255) BR~(255,0))`);
      R.check('phone photo corners are rotated the right way', near(tl.slice(0, 2), [0, 255], 45) && near(tr.slice(0, 2), [0, 0], 45) && near(bl.slice(0, 2), [255, 255], 45) && near(br.slice(0, 2), [255, 0], 45), { tl, tr, bl, br });
      if (cmyk) {
        const ci = idx('cmyk.jpg');
        const c = render(out, ci, 1);
        const mid = px(c, Math.floor(c.w / 2), Math.floor(c.h / 2));
        // reference: MuPDF's own decode of the same file
        const ref = new mu.Image(readFileSync(cmyk)).toPixmap();
        R.say(`INFO cmyk page colour ${mid}; reference decode components ${ref.getNumberOfComponents()}, first px ${[...ref.getPixels().slice(0, 4)]}`);
        R.check('CMYK jpeg: cyan stays cyan-ish (blue > red, not inverted to red/black)', mid[2] > mid[0] + 60, mid);
      }
      const ai = idx('alpha.png');
      const a = render(out, ai, 2);
      const top = px(a, Math.floor(a.w / 2), 6);
      const bottom = px(a, Math.floor(a.w / 2), a.h - 6);
      R.say(`INFO png alpha: page ${a.w}x${a.h}; transparent half ${top}, opaque half ${bottom}`);
      R.check('transparent PNG area is white, not black', top.every((v) => v > 230), top);
      R.check('opaque PNG area stays red', bottom[0] > 200 && bottom[1] < 60, bottom);
      const ti = idx('scan.tif');
      R.check('TIFF gives 3 pages in order after alpha.png', p.pages >= ti + 3 && JSON.stringify(p.sizes.slice(ti, ti + 3)) !== '[]', p.sizes.slice(ti, ti + 3));
      R.say(`INFO tiff page sizes: ${JSON.stringify(p.sizes.slice(ti, ti + 3))}`);
      const u = p.text[idx('utf8.txt') + 2] ?? '';
      const w = p.text[idx('win1252.txt') + 2] ?? '';
      R.say(`INFO utf8 page text: ${u}`);
      R.say(`INFO win1252 page text: ${w}`);
      R.check('UTF-8 accents are right (Café ñandú über, no Ã mojibake, no ? for the accents)', /Café/.test(u) && /ñandú/.test(u) && /über/.test(u) && !/Ã/.test(u), u);
      R.check('Windows-1252 file shows café, curly quotes, euro and über', /café/.test(w) && /über/.test(w) && !/�/.test(w) && /[“”]/.test(w), w);
      R.check('inputs unchanged', all.every((f, i) => sha(f) === before[i]));
    }
  } finally { await s.close(); }
});

await R.step('B2b encrypted PDF: password asked, never stored; XFA refused', async () => {
  const dir = dirOf('in');
  const pw = 'Sekrit-Zq7-pw';
  const locked = new mu.PDFDocument(buildPdf({ pages: 2, tag: 'Locked' }));
  const lockedPath = put(dir, 'locked.pdf', Buffer.from(locked.saveToBuffer(`encrypt=aes-256,user-password=${pw},owner-password=${pw}`).asUint8Array().slice()));
  const plain = put(dir, 'plain.pdf', buildPdf({ pages: 1, tag: 'Plain' }));
  const xfa = put(dir, 'xfa.pdf', readFileSync(join(process.cwd(), 'tests', 'engine', 'corpus', 'xfa', 'xfa_filled_imm1344e.pdf')));
  const out = join(dirOf('out'), 'Locked out.pdf');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    let dlg = await openCombine(s);
    await addFiles(s, dlg, [xfa]);
    await waitFor(async () => (await messagesOf(dlg)).length >= 1, { timeoutMs: 30000, label: 'xfa message' });
    const m = await messagesOf(dlg);
    R.say(`INFO xfa messages: ${JSON.stringify(m)}`);
    R.check('XFA form refused with the spec message and not listed', m.includes("xfa.pdf was not added. It is a kind of form that can't be combined yet.") && (await rowNames(dlg)).length === 0, m);
    await s.setDialogAnswer([lockedPath]);
    await dlg.getByRole('button', { name: 'Add files…' }).click();
    const prompt = s.win.getByRole('dialog', { name: 'Password needed' });
    await prompt.waitFor({ timeout: 15000 });
    await prompt.getByLabel('Password').fill(pw);
    await prompt.getByRole('button', { name: 'Use password' }).click();
    await rowsReady(dlg, 1);
    await addFiles(s, dlg, [plain], 2);
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    await combine(s, dlg, out);
    await waitNotice(s, /Combined 2 files/);
    const p = inspect(out);
    R.check('output has no password and holds the locked pages', p.pages === 3 && p.text[0] === 'Locked 1', p.text);
    R.check('password text is not in the output', !readFileSync(out).includes(Buffer.from(pw)));
    // list is cleared after success: adding the locked file again must ask again
    dlg = await openCombine(s);
    R.say(`INFO rows after success when reopened: ${JSON.stringify(await rowNames(dlg))}`);
    await s.setDialogAnswer([lockedPath]);
    await dlg.getByRole('button', { name: 'Add files…' }).click();
    let asked = false;
    try { await prompt.waitFor({ timeout: 8000 }); asked = true; } catch { asked = false; }
    R.say(`INFO password asked again after list cleared: ${asked}`);
    if (asked) await prompt.getByRole('button', { name: 'Cancel' }).click();
    await delay(500);
    await dlg.getByRole('button', { name: 'Cancel' }).first().click().catch(() => undefined);
    await delay(500);
    // "never stored": the profile folder must not contain the password anywhere
    const hit = walkFiles(s.profile).filter((f) => { try { return statSync(f).size < 64 * 1024 * 1024 && readFileSync(f).includes(Buffer.from(pw)); } catch { return false; } });
    R.check('the password is not written anywhere in the app profile', hit.length === 0, hit);
  } finally { await s.close(); }
});

await R.step('B2c inputs changed or deleted after adding (text, picture)', async () => {
  const dir = dirOf('in');
  const txt = put(dir, 'note.txt', 'original text line');
  const png = put(dir, 'pic.png', (() => { const p = new PNG({ width: 20, height: 20 }); p.data.fill(200); return PNG.sync.write(p); })());
  const pdfA = put(dir, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const out = join(dirOf('out'), 'Chg.pdf');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [pdfA, txt, png], 3);
    await delay(300);
    writeFileSync(txt, 'CHANGED text, now much longer than before so the size differs a lot');
    rmSync(png);
    await setSaveAnswer(s, out);
    await dlg.getByRole('button', { name: 'Combine…' }).click();
    await delay(4000);
    const m = await messagesOf(dlg);
    R.say(`INFO messages: ${JSON.stringify(m)}; window open: ${(await windowOf(s.win).count()) === 1}; out exists: ${existsSync(out)}`);
    R.check('changed txt and deleted picture are both reported, nothing written', !existsSync(out) && m.some((x) => /note\.txt/.test(x)) && m.some((x) => /pic\.png/.test(x)), m);
    const notice = await s.win.locator('[data-job-notice]').count();
    R.say(`INFO a job notice is showing: ${notice}`);
  } finally { await s.close(); }
});

await R.step('B2d output name guards', async () => {
  const dir = dirOf('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const b = put(dir, 'b.pdf', buildPdf({ pages: 2, tag: 'B' }));
  const outDir = dirOf('out');
  const sentinel = put(outDir, 'x.txt.pdf', 'PRECIOUS sentinel, not a pdf');
  const sentinelSha = sha(sentinel);
  const before = [sha(a), sha(b)];
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    // record every message box the app shows, and answer the first button that looks like Cancel
    await s.app.evaluate(({ dialog }) => {
      globalThis.__boxes = [];
      dialog.showMessageBox = async (...args) => {
        const opts = args.find((x) => x && typeof x === 'object' && !x.webContents) ?? {};
        globalThis.__boxes.push({ message: opts.message, detail: opts.detail, buttons: opts.buttons, cancelId: opts.cancelId });
        return { response: opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 0), checkboxChecked: false };
      };
    });
    const dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b], 2);
    await dlg.getByLabel('Open the new file when it is ready').uncheck();
    // 1. typed "x.txt" where "x.txt.pdf" exists
    await combine(s, dlg, join(outDir, 'x.txt'));
    await delay(3500);
    const boxes = await s.app.evaluate(() => globalThis.__boxes);
    R.say(`INFO message boxes shown: ${JSON.stringify(boxes)}; files: ${JSON.stringify(listing(outDir))}`);
    const changed = sha(sentinel) !== sentinelSha;
    const noticeText = (await s.win.locator('[data-job-notice]').count()) ? (await anyNotice(s, 5000)) : '';
    R.say(`INFO notice after typed "x.txt": ${noticeText}`);
    R.check('x.txt.pdf is not replaced without asking (it still holds the sentinel, or the app asked first)', !changed || boxes.length > 0, { changed, boxes });
    if (changed) R.say('INFO the existing x.txt.pdf WAS overwritten');
    R.say(`INFO window still open after that: ${(await windowOf(s.win).count()) === 1}`);
    // 2. output is one of the inputs, spelled differently
    if ((await windowOf(s.win).count()) === 0) {
      const dlg2 = await openCombine(s);
      R.say(`INFO reopened rows: ${JSON.stringify(await rowNames(dlg2))}`);
    }
    const dlgNow = windowOf(s.win);
    if ((await dlgNow.locator('[data-row-id]').count()) === 2) {
      for (const variant of [a.toUpperCase().replace(/\\/g, '/'), join(dir, '.', 'sub', '..', 'b.pdf'), a.replace(/\.pdf$/, '.PDF')]) {
        await combine(s, dlgNow, variant);
        await delay(2500);
        const t = await dlgNow.locator('[data-combine-target]').innerText().catch(() => '');
        R.say(`INFO output "${variant}": target message "${t.trim()}"; window open ${(await windowOf(s.win).count()) === 1}; inputs unchanged ${sha(a) === before[0] && sha(b) === before[1]}`);
        R.check(`output spelled "${variant.slice(-24)}" is refused and the input is intact`, /different name/.test(t) && sha(a) === before[0] && sha(b) === before[1], t);
        if ((await windowOf(s.win).count()) === 0) break;
      }
    }
  } finally { await s.close(); }
});

await R.step('B2e Cancel', async () => {
  const dir = dirOf('in');
  const a = put(dir, 'a.pdf', buildPdf({ pages: 2, tag: 'A' }));
  const b = put(dir, 'b.pdf', buildPdf({ pages: 2, tag: 'B' }));
  const outDir = dirOf('out');
  const s = await start();
  try {
    await s.win.waitForSelector('.empty-state');
    let dlg = await openCombine(s);
    await addFiles(s, dlg, [a, b], 2);
    // cancel the Save dialog
    await s.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
    await dlg.getByRole('button', { name: 'Combine…' }).click();
    await delay(1500);
    R.check('cancelling the Save dialog keeps the window and the list', (await windowOf(s.win).count()) === 1 && (await dlg.locator('[data-row-id]').count()) === 2);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await delay(800);
    R.check('window Cancel closes it, nothing written', (await windowOf(s.win).count()) === 0 && listing(outDir).length === 0);
    dlg = await openCombine(s);
    R.say(`INFO rows after Cancel and reopen: ${JSON.stringify(await rowNames(dlg))}`);
    await s.win.keyboard.press('Escape');
    await delay(600);
    R.check('Esc closes the window', (await windowOf(s.win).count()) === 0);
  } finally { await s.close(); }
});
await closeAll();
wipe();
process.exitCode = R.summary() ? 1 : 0;
