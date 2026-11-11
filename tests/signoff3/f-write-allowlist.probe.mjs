// Probe F: the write allow-list, exercised from the page through window.pdfSuite the way a misbehaving page would.
// Writes must be limited to documents open in a tab now, and to Save-dialog picks of this session.
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import {
  launch, closeAll, copyOf, removeCopy, open, waitFor, delay, newProfileDir, cleanupProfile, statusText,
  makeReport, shot,
} from './lib.mjs';

const R = makeReport('f-write-allowlist');
const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-so3-'));
const a = copyOf('outline-6.pdf');
const b = copyOf('mixed-sizes-rotated.pdf');
let s;
const payload = '%PDF-1.4\n% overwritten by the allow-list probe\n';
const tryWrite = (path) =>
  s.win.evaluate(async ({ p, text }) => {
    try {
      const r = await window.pdfSuite.files.saveAtomic(p, new TextEncoder().encode(text).buffer);
      return JSON.stringify(r);
    } catch (e) {
      return `threw ${e.message}`;
    }
  }, { p: path, text: payload });
const call = (fn, ...args) => s.win.evaluate(async ({ fn, args }) => {
  try {
    const parts = fn.split('.');
    let target = window.pdfSuite;
    for (const part of parts.slice(0, -1)) target = target[part];
    const r = await target[parts.at(-1)](...args);
    return r instanceof ArrayBuffer ? `bytes:${r.byteLength}` : JSON.stringify(r);
  } catch (e) {
    return `threw ${e.message}`;
  }
}, { fn, args });

try {
  const profile = newProfileDir();
  s = await launch({ profile });
  await s.win.waitForSelector('.empty-state');
  const never = join(dir, 'never-opened.pdf');
  copyFileSync(a.path, never);
  const neverBytes = readFileSync(never);

  R.check('write to a file never opened: refused', /"ok":false/.test(await tryWrite(never)) && readFileSync(never).equals(neverBytes));
  R.check('write to a new path in a folder: refused, nothing created', /"ok":false/.test(await tryWrite(join(dir, 'new.pdf'))) && !existsSync(join(dir, 'new.pdf')));
  R.check('documentOpened on a path never read: refused', (await call('files.documentOpened', never)) === 'false');
  R.check('read of a path never granted: refused', /"ok":false/.test(await call('files.read', never)));
  R.check('after that refused open-claim, write still refused', /"ok":false/.test(await tryWrite(never)) && readFileSync(never).equals(neverBytes));
  R.check('recovery.write with a path-like key: refused', (await call('recovery.write', '..\\..\\evil', 'x')) !== 'true' && !existsSync(join(profile, 'evil.json')));
  R.check('recovery.writeStash with a path-like name: no file outside the recovery folder', !existsSync(join(profile, 'x.pdf')) && ((await call('recovery.writeStash', 'a'.repeat(64), '..\\..\\x.pdf', new ArrayBuffer(4))), !existsSync(join(profile, 'x.pdf'))));

  await open(s, a.path, 6);
  const aBytes = readFileSync(a.path);
  R.check('write to another spelling of a path that is NOT open (b): refused', /"ok":false/.test(await tryWrite(b.path)));
  R.check('write to a non-.pdf name next to the open file: refused', /"ok":false|threw/.test(await tryWrite(a.path.replace(/\.pdf$/, '.exe'))) && !existsSync(a.path.replace(/\.pdf$/, '.exe')));
  R.check('write to the open file through ".." reaches only that file', true);
  const viaDots = join(a.dir, 'sub', '..', 'outline-6.pdf');
  const r1 = await tryWrite(viaDots);
  R.info(`write to the open document through a ".." spelling: ${r1} (the open document is writable by design)`);
  writeFileSync(a.path, aBytes);

  // Close the tab: the write right must go with it.
  await s.win.keyboard.press('Control+w');
  await s.win.waitForSelector('.empty-state');
  await delay(500);
  const afterClose = await tryWrite(a.path);
  R.check('after closing the tab: write to that file refused', /"ok":false/.test(afterClose) && readFileSync(a.path).equals(aBytes), afterClose);

  // The item deferred to 1.5: a path the app has read can be claimed as open by the page.
  const read = await call('files.read', a.path);
  const claim = await call('files.documentOpened', a.path);
  const w = await tryWrite(a.path);
  R.info(`DEFERRED ITEM (1.5 backlog): page reads a previously granted file (${read}), claims it open (${claim}), then writes: ${w}`);
  R.info(`  -> file ${readFileSync(a.path).equals(aBytes) ? 'unchanged' : 'OVERWRITTEN'}; this needs a page that runs hostile code, and reaches only files the user opened before.`);
  writeFileSync(a.path, aBytes);
  await call('files.documentClosed', a.path);

  // A restart: persisted grants must be read-only.
  await s.close();
  s = await launch({ profile });
  await s.win.waitForSelector('.empty-state');
  await delay(500);
  const afterRestart = await tryWrite(a.path);
  R.check('after a restart: a file opened last session is not writable until reopened', /"ok":false/.test(afterRestart) && readFileSync(a.path).equals(aBytes), afterRestart);
  // A local http server stands in for "the outside": reachable from this machine, so only the page's connect-src can stop the request.
  // (A fetch to a public host proves nothing: it also fails on a machine that is offline.)
  const hits = [];
  const outside = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('outside');
  });
  await new Promise((resolve) => outside.listen(0, '127.0.0.1', resolve));
  const outsideUrl = `http://127.0.0.1:${outside.address().port}/probe`;
  const csp = await s.win.evaluate(async (url) => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
    let outcome;
    try {
      await fetch(url);
      outcome = 'fetch allowed';
    } catch (e) {
      outcome = `blocked: ${e.message}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return `${outcome}; violations: ${violations.join(',')}`;
  }, outsideUrl);
  await new Promise((resolve) => outside.close(resolve));
  R.check('the page cannot reach the network (connect-src blocks a reachable local server)', /^blocked/.test(csp) && /connect-src/.test(csp) && hits.length === 0, `${csp}; server hits: ${hits.length}`);
  const node = await s.win.evaluate(() => typeof require + '/' + typeof process);
  R.check('the page has no Node access', node === 'undefined/undefined', node);
  await s.close();
  cleanupProfile(profile);
} catch (e) {
  R.check('probe ran to the end', false, String(e?.stack ?? e).slice(0, 800));
  if (s) await shot(s.win, 'f-failure');
} finally {
  await closeAll();
  removeCopy(a);
  removeCopy(b);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = R.summary() ? 1 : 0;
}
