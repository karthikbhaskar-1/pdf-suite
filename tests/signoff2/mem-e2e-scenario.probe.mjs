// Sign-off probe: the exact bigfile.e2e memory scenario (open, jump to 1000, two scrollTop sweeps), but counting the
// renderer process, which Electron reports as type 'Tab' (bigfile.e2e sums 'Renderer'+'GPU', i.e. GPU only).
// Run: node tests/signoff2/mem-e2e-scenario.probe.mjs [mupdf|pdfjs]
import { launchTracked, check, summary, waitForPage, waitFor, statusText, closeAll, cleanupProfile, fixture } from './lib.mjs';

const engine = process.argv[2] ?? 'mupdf';
const s = await launchTracked();
const row = async () => {
  const by = {};
  for (const m of await s.metrics()) by[m.type] = (by[m.type] ?? 0) + Math.round(m.memKB / 1024);
  return { types: by, e2eSum: (by.Renderer ?? 0) + (by.GPU ?? 0), tabPlusGpu: (by.Tab ?? 0) + (by.GPU ?? 0) };
};
const sweep = () => s.win.evaluate(async () => {
  const v = document.querySelector('.viewer'); const max = v.scrollHeight - v.clientHeight;
  for (let i = 0; i <= 120; i++) { v.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
  for (let i = 120; i >= 0; i--) { v.scrollTop = (max * i) / 120; await new Promise((r) => setTimeout(r, 16)); }
});
try {
  await s.win.waitForSelector('.empty-state');
  if (engine === 'pdfjs') {
    await s.win.evaluate(() => localStorage.setItem('pdfsuite.engine', 'pdfjs'));
    await s.win.reload();
    await s.win.waitForSelector('.empty-state');
  }
  await s.setDialogAnswer([fixture('big-1000.pdf')]);
  await s.win.keyboard.press('Control+o');
  await waitForPage(s, 'Page 1 of 1000', { timeoutMs: 60000 });
  const box = s.win.getByLabel('Page number');
  await box.click(); await box.fill('1000'); await box.press('Enter');
  await waitFor(async () => (await statusText(s.win)).startsWith('Page 1000 of 1000'), { timeoutMs: 30000 });
  await sweep();
  await waitFor(async () => (await statusText(s.win)).startsWith('Page 1 of 1000'), { timeoutMs: 10000 });
  const first = await row();
  await sweep();
  await s.win.waitForTimeout(1000);
  const second = await row();
  console.log(JSON.stringify({ engine, first, second }));
  check(`[${engine}] bigfile.e2e scenario: renderer(Tab)+GPU < 800 MB after first pass`, first.tabPlusGpu < 800, first);
  check(`[${engine}] bigfile.e2e scenario: renderer(Tab)+GPU < 800 MB after second pass`, second.tabPlusGpu < 800, second);
} finally {
  await s.close();
  cleanupProfile(s.profile);
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
