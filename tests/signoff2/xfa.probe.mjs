// Independent sign-off probe, ticket 1.2.0: what a user sees when opening a real XFA form (IRCC IMM1344).
// Compares the default route (MuPDF -> pdf.js enableXfa) with 1.1 behaviour (pdf.js, no XFA: override 'pdfjs').
import { join } from 'node:path';
import { CORPUS, ROOT2, launchTracked, openPath, engineState, check, summary, statusText, waitFor, closeAll, cleanupProfile } from './lib.mjs';

const XFA = join(CORPUS, 'xfa', 'xfa_filled_imm1344e.pdf');

async function run(engine) {
  const s = await launchTracked();
  try {
    await s.win.waitForSelector('.empty-state');
    if (engine) {
      await s.win.evaluate((e) => localStorage.setItem('pdfsuite.engine', e), engine);
      await s.win.reload();
      await s.win.waitForSelector('.empty-state');
    }
    await openPath(s, XFA, 'Page 1 of', 60000);
    await waitFor(async () => (await s.win.locator('.viewer .page-canvas').count()) > 0, { timeoutMs: 30000, label: 'page' });
    await s.win.waitForTimeout(3000);
    const status = await statusText(s.win);
    const pages = Number(status.match(/of (\d+)/)?.[1] ?? 0);
    const inks = [];
    for (let i = 0; i < Math.min(pages, 7); i++) {
      await s.win.keyboard.press('Control+g');
      await s.win.keyboard.type(String(i + 1));
      await s.win.keyboard.press('Enter');
      await s.win.waitForTimeout(1200);
      inks.push(await s.win.evaluate((idx) => {
        const c = document.querySelector(`.viewer .page[data-page-index="${idx}"] canvas.page-canvas`);
        if (!c || c.width === 300) return null;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0;
        for (let k = 0; k < d.length; k += 16) if (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2] < 200) ink++;
        const page = c.parentElement;
        return { ink: Number((ink / (d.length / 16)).toFixed(4)), textSpans: page.querySelectorAll('.textLayer span').length, otherLayers: page.children.length };
      }, i));
    }
    await s.win.keyboard.press('Control+g');
    await s.win.keyboard.type('1');
    await s.win.keyboard.press('Enter');
    await s.win.waitForTimeout(1000);
    const shot = join(ROOT2, 'tests', 'signoff2', `xfa-${engine ?? 'default'}.png`);
    await s.win.screenshot({ path: shot });
    await s.win.keyboard.press('Control+f');
    await s.win.getByLabel('Find in document').fill('sponsor');
    await s.win.waitForTimeout(2500);
    const search = (await s.win.locator('.search-status').innerText()).trim();
    const messages = await s.win.locator('.tab-message, .toast').allInnerTexts();
    const eng = await engineState(s.win);
    return { engine: engine ?? 'default', status, pages, inks, search, messages, eng, errors: s.errors, shot };
  } finally {
    await s.close();
    cleanupProfile(s.profile);
  }
}

try {
  const def = await run(null);
  console.log(JSON.stringify(def));
  const old = await run('pdfjs');
  console.log(JSON.stringify(old));
  check('XFA default route goes to pdf.js (no MuPDF document kept, pdf.js worker used)', def.eng.mupdfDocs === 0 && def.eng.pdfjsWorkersEver >= 1, def.eng);
  check('XFA default route shows the form content (some ink on page 1)', (def.inks[0]?.ink ?? 0) > 0.002, def.inks);
  check('XFA default route: any page shows content', def.inks.some((p) => (p?.ink ?? 0) > 0.002), def.inks);
  check('XFA default route: search finds the word "sponsor" (it is all over the form)', /^\d+ of \d+$/.test(def.search) && !/^0 /.test(def.search), def.search);
  check('XFA default route: if nothing can be shown, a plain-English message says so', def.inks.some((p) => (p?.ink ?? 0) > 0.002) || def.messages.length > 0, def.messages);
  check('1.1 behaviour (pdf.js, no XFA) shows the file\'s fallback page with ink, for comparison', (old.inks[0]?.ink ?? 0) > 0.002, old.inks);
} catch (e) {
  check('probe ran to completion', false, String(e.stack ?? e).slice(0, 800));
} finally {
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
