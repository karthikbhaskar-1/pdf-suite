// Diagnosis: after a programmatic jump, which visible pages stay unpainted and for how long; and memory per process
// at each step. Run: node tests/signoff2/diag-jump.probe.mjs [heavy]
import { join } from 'node:path';
import { ROOT2, launchTracked, engineState, waitFor, waitForPage, closeAll, cleanupProfile, fixture } from './lib.mjs';

const file = process.argv[2] === 'heavy' ? join(ROOT2, 'tests', 'signoff', 'out', 'heavy-1000.pdf') : fixture('big-1000.pdf');
const s = await launchTracked();
const mem = async (label) => {
  const m = await s.metrics();
  const by = {};
  for (const x of m) by[x.type] = (by[x.type] ?? 0) + Math.round(x.memKB / 1024);
  console.log(`MEM ${label}: ${JSON.stringify(by)} wasm=${JSON.stringify((await engineState(s.win)).wasmMB)}`);
};
const state = () => s.win.evaluate(() => {
  const v = document.querySelector('.viewer'); const vr = v.getBoundingClientRect();
  return [...v.querySelectorAll('.page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > vr.top && r.top < vr.bottom; })
    .map((p) => `${Number(p.dataset.pageIndex) + 1}:${p.querySelector('.page-placeholder') ? 'PH' : 'ok'}:${p.querySelector('canvas').width}`).join(' ');
});
try {
  await s.win.waitForSelector('.empty-state');
  await mem('empty');
  await s.setDialogAnswer([file]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  await s.win.waitForTimeout(1000);
  await mem('opened');
  // Case A: jump with nothing else going on.
  for (const frac of [0.137, 0.512, 0.888]) {
    await s.win.evaluate((f) => { const v = document.querySelector('.viewer'); v.scrollTop = (v.scrollHeight - v.clientHeight) * f; }, frac);
    const seen = [];
    for (const t of [100, 300, 1000, 3000, 6000]) {
      await s.win.waitForTimeout(t - (seen.length ? [100, 300, 1000, 3000, 6000][seen.length - 1] : 0));
      seen.push(`${t}ms[${await state()}]`);
    }
    console.log(`JUMP A ${frac}: ${seen.join(' | ')}`);
  }
  await mem('after A');
  // Case B: wheel burst, then jump immediately (what perf.probe did).
  const vb = await s.win.locator('.viewer').first().boundingBox();
  await s.win.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  for (let i = 0; i < 60; i++) { await s.win.mouse.wheel(0, 600); await s.win.waitForTimeout(25); }
  await s.win.waitForTimeout(800);
  await mem('after wheel burst');
  for (const frac of [0.137, 0.512]) {
    await s.win.evaluate((f) => { const v = document.querySelector('.viewer'); v.scrollTop = (v.scrollHeight - v.clientHeight) * f; }, frac);
    const seen = [];
    let prev = 0;
    for (const t of [100, 300, 1000, 3000, 6000, 10000]) { await s.win.waitForTimeout(t - prev); prev = t; seen.push(`${t}ms[${await state()}]`); }
    console.log(`JUMP B ${frac}: ${seen.join(' | ')}`);
  }
  // Does the user-visible status agree? Scroll a tiny bit by wheel and see if pages paint.
  await s.win.mouse.wheel(0, 50);
  await s.win.waitForTimeout(1500);
  console.log(`after small wheel: [${await state()}]`);
  await mem('end');
  await s.win.screenshot({ path: join(ROOT2, 'tests', 'signoff2', 'diag-jump.png') });
  console.log(`errors ${JSON.stringify(s.errors)}`);
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
}
