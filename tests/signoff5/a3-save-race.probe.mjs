// Probe A3: how wide is the gap between a save's last look at the file and its write? Probe A2 saw one outside write,
// made 45 ms after Ctrl+S, overwritten with a plain "Saved". This measures the gap (the time the save's temp file exists
// beside the target, which starts just after the last look) for a 0.6 MB file and for a 60 MB file, and counts how many
// outside writes timed around it are lost.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as mupdf from 'mupdf';
import {
  launch, closeAll, cleanupProfile, newProfileDir, waitFor, pageCount, delay, isDirty, openMore, fixture,
  watchToasts, toastCount, toastsSince, waitToast, BLOCKED, barShown, dup, mk, wipeWork, sameBytes, outsideBytes, report,
  readFileSync, writeFileSync,
} from './lib.mjs';

const R = report('a3-save-race');
const profile = newProfileDir();
let s;
let win;
const keep = async () => { await win.getByRole('button', { name: 'Keep my version', exact: true }).click(); await waitFor(async () => !(await barShown(win)), { timeoutMs: 8000, label: 'bar gone' }); };
const tmpThere = (dir) => readdirSync(dir).some((f) => f.endsWith('.tmp'));
/** Presses Ctrl+S and watches the folder: when the temp file appears and when it is gone (renamed over the target). */
async function timedSave(path) {
  const dir = dirname(path);
  const from = await toastCount(win);
  const t0 = performance.now();
  await win.keyboard.press('Control+s');
  let seen = null;
  let gone = null;
  while (performance.now() - t0 < 30000) {
    const there = tmpThere(dir);
    if (seen === null && there) seen = performance.now() - t0;
    if (seen !== null && !there) { gone = performance.now() - t0; break; }
    if (seen === null && performance.now() - t0 > 15000) break;
    await new Promise((r) => setImmediate(r));
  }
  const t = await waitToast(win, from, /^Saved /, 30000);
  return { seen, gone, toast: t };
}
/** Ctrl+S, then the outside write the moment the temp file shows. Returns what ended up on disk. */
async function raceAtTemp(path, tag) {
  const dir = dirname(path);
  const out = outsideBytes(tag);
  const from = await toastCount(win);
  const t0 = performance.now();
  await win.keyboard.press('Control+s');
  let wroteAt = null;
  while (performance.now() - t0 < 15000) {
    if (tmpThere(dir)) { try { writeFileSync(path, out); wroteAt = performance.now() - t0; } catch (e) { wroteAt = `failed ${e.code}`; } break; }
    await new Promise((r) => setImmediate(r));
  }
  await delay(7500);
  return { wroteAt, outsideOnDisk: sameBytes(path, out), bar: await barShown(win), toasts: await toastsSince(win, from), sizeNow: statSync(path).size, outSize: out.length };
}

try {
  s = await launch({ profile });
  win = s.win;
  await win.waitForSelector('.empty-state');
  await watchToasts(win);

  await R.step('small file', async () => {
    const g = mk('big-1000.pdf', 'race.pdf');
    await openMore(s, g.path, 1000, 1);
    const gaps = [];
    for (let i = 0; i < 3; i++) { await dup(win); const r = await timedSave(g.path); if (r.seen !== null && r.gone !== null) gaps.push(Math.round(r.gone - r.seen)); await delay(300); }
    R.info(`0.6 MB file: the temp file exists for ${JSON.stringify(gaps)} ms per save (the last look at the file is just before it appears)`);
    let lost = 0;
    const rows = [];
    for (let i = 0; i < 6; i++) {
      if (await barShown(win)) await keep();
      await dup(win);
      const r = await raceAtTemp(g.path, `small-${i}`);
      if (typeof r.wroteAt === 'number' && !r.outsideOnDisk) lost++;
      rows.push(`${typeof r.wroteAt === 'number' ? Math.round(r.wroteAt) : r.wroteAt} ms: ${r.outsideOnDisk ? `outside bytes kept (bar=${r.bar})` : 'OVERWRITTEN by the save'} ${JSON.stringify(r.toasts)}`);
    }
    R.info(`0.6 MB file, outside write the moment the temp file appears, 6 tries: ${rows.join(' || ')}`);
    R.check('0.6 MB file: an outside write made while the save is writing is not silently overwritten (6 tries)', lost === 0, `${lost} of 6 overwritten with a plain "Saved"`);
    if (await barShown(win)) await keep();
  });
  for (let i = 0; i < 6 && (await win.getByRole('tab').count()) > 0; i++) {
    await win.keyboard.press('Control+Shift+w'); await delay(500);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(500);
  }

  await R.step('60 MB file', async () => {
    const g = mk('outline-6.pdf', 'large.pdf');
    // Make it 60 MB: a block of random bytes kept alive from the catalog.
    const doc = mupdf.Document.openDocument(readFileSync(fixture('outline-6.pdf')), 'application/pdf').asPDF();
    const blob = Buffer.alloc(60 * 1024 * 1024);
    for (let i = 0; i < blob.length; i += 4096) blob.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
    const ref = doc.addRawStream(blob, doc.newDictionary());
    doc.getTrailer().get('Root').put('SignoffBlob', ref);
    writeFileSync(g.path, doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    R.info(`large file is ${(statSync(g.path).size / 1048576).toFixed(1)} MB`);
    await openMore(s, g.path, 6, 1);
    const gaps = [];
    for (let i = 0; i < 2; i++) { await dup(win); const r = await timedSave(g.path); R.info(`60 MB save ${i + 1}: temp file from ${r.seen === null ? '?' : Math.round(r.seen)} ms to ${r.gone === null ? '?' : Math.round(r.gone)} ms after Ctrl+S; toast=${JSON.stringify(r.toast)}; size now ${(statSync(g.path).size / 1048576).toFixed(1)} MB`); if (r.seen !== null && r.gone !== null) gaps.push(Math.round(r.gone - r.seen)); await delay(500); }
    R.info(`60 MB file: the temp file exists for ${JSON.stringify(gaps)} ms per save`);
    await dup(win);
    const r = await raceAtTemp(g.path, 'large');
    R.info(`60 MB file, outside write the moment the temp file appears: wrote at ${typeof r.wroteAt === 'number' ? Math.round(r.wroteAt) : r.wroteAt} ms; ${r.outsideOnDisk ? `outside bytes kept (bar=${r.bar})` : `OVERWRITTEN by the save (file is now ${(r.sizeNow / 1048576).toFixed(1)} MB, the outside file was ${r.outSize} bytes)`}; toasts=${JSON.stringify(r.toasts)}`);
    R.check('60 MB file: an outside write made while the save is writing is not silently overwritten', typeof r.wroteAt !== 'number' || r.outsideOnDisk, JSON.stringify({ wroteAt: r.wroteAt, toasts: r.toasts }));
    if (await barShown(win)) await keep();
    R.info(`dirty at the end: ${await isDirty(win)}, pages ${await pageCount(win)}`);
  });
  for (let i = 0; i < 6 && (await win.getByRole('tab').count()) > 0; i++) {
    await win.keyboard.press('Control+Shift+w'); await delay(500);
    const p = win.getByRole('alertdialog');
    if ((await p.count()) > 0) await p.getByRole('button', { name: "Don't save", exact: true }).click();
    await delay(500);
  }
} catch (err) {
  R.check('probe ran to the end', false, String(err && err.stack ? err.stack : err).slice(0, 600));
} finally {
  await closeAll();
  cleanupProfile(profile);
  wipeWork();
}
process.exitCode = R.summary() ? 1 : 0;
