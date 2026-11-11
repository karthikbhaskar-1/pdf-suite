// Independent sign-off probe, ticket 1.2.0: real-world PDFs on the packaged app.
// Proves (with assertions) which engine opened each file, that pages/thumbnails/loupe/overview show real
// pixels, that search highlights sit on ink, that bookmarks/properties work, that XFA goes to pdf.js and
// that MuPDF workers are freed on close.
// Run: node tests/signoff2/realworld.probe.mjs
import { join } from 'node:path';
import {
  CORPUS, launchTracked, openPath, engineState, pageInk, waitPainted, check, summary, statusText, waitFor, waitForPage,
  closeAll, cleanupProfile, fixture,
} from './lib.mjs';

const ARXIV = join(CORPUS, 'arxiv-attention', '1706.03762.pdf');
const XFA = join(CORPUS, 'xfa', 'xfa_filled_imm1344e.pdf');
const FW9 = join(CORPUS, 'irs-fw9', 'fw9.pdf');
const OUTLINE = join(CORPUS, 'outlines', 'nested_outline.pdf');

/** Ink check for the current search hit: dark pixels of the page canvas inside the highlight rectangle. */
function hitInk(win) {
  return win.evaluate(() => {
    const hit = document.querySelector('.search-hit-current');
    if (!hit) return { found: false };
    const page = hit.closest('.page');
    const c = page.querySelector('canvas.page-canvas');
    const pr = c.getBoundingClientRect();
    const hr = hit.getBoundingClientRect();
    const k = c.width / pr.width;
    const x0 = Math.floor((hr.left - pr.left) * k), y0 = Math.floor((hr.top - pr.top) * k);
    const w = Math.max(1, Math.round(hr.width * k)), h = Math.max(1, Math.round(hr.height * k));
    // Read a wider band (one word-width either side) to see where the ink of the line is.
    const bx = Math.max(0, x0 - w), bw = Math.min(c.width - bx, w * 3);
    const d = c.getContext('2d').getImageData(bx, y0, bw, h).data;
    const colInk = new Array(bw).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < bw; x++) {
      const o = (y * bw + x) * 4;
      if (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2] < 140) colInk[x]++;
    }
    const inside = colInk.slice(x0 - bx, x0 - bx + w);
    const inkCols = inside.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    return {
      found: true,
      rect: { x: Math.round(hr.left - pr.left), y: Math.round(hr.top - pr.top), w: Math.round(hr.width), h: Math.round(hr.height) },
      inkColsFrac: Number((inkCols.length / w).toFixed(3)),
      firstInk: inkCols.length ? Number((inkCols[0] / w).toFixed(3)) : null,
      lastInk: inkCols.length ? Number((1 - inkCols[inkCols.length - 1] / w).toFixed(3)) : null,
    };
  });
}

/** Correlates the loupe image (scaled down by 3) with the same region of the page canvas, and with a shifted region. */
function loupeCorrelation(win, mx, my) {
  return win.evaluate(({ mx, my }) => {
    const loupe = document.querySelector('.loupe-canvas');
    const pageEl = [...document.querySelectorAll('.viewer .page')].find((p) => {
      const r = p.getBoundingClientRect();
      return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
    });
    if (!loupe || !pageEl || loupe.width < 10) return { ok: false, why: 'no loupe image or page' };
    const c = pageEl.querySelector('canvas.page-canvas');
    const pr = c.getBoundingClientRect();
    const k = c.width / pr.width; // canvas px per css px
    const lr = loupe.getBoundingClientRect();
    const cw = Math.round((lr.width / 3) * k), ch = Math.round((lr.height / 3) * k);
    const gray = (data) => { const g = new Float32Array(data.length / 4); for (let i = 0; i < g.length; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]; return g; };
    const tmp = document.createElement('canvas'); tmp.width = cw; tmp.height = ch;
    const t = tmp.getContext('2d'); t.imageSmoothingQuality = 'high'; t.drawImage(loupe, 0, 0, cw, ch);
    const a = gray(t.getImageData(0, 0, cw, ch).data);
    const pc = c.getContext('2d');
    const crop = (dx, dy) => {
      const cx = Math.round((mx - pr.left) * k - cw / 2 + dx), cy = Math.round((my - pr.top) * k - ch / 2 + dy);
      return gray(pc.getImageData(cx, cy, cw, ch).data);
    };
    const corr = (p, q) => {
      let mp = 0, mq = 0; for (let i = 0; i < p.length; i++) { mp += p[i]; mq += q[i]; } mp /= p.length; mq /= q.length;
      let num = 0, dp = 0, dq = 0; for (let i = 0; i < p.length; i++) { const x = p[i] - mp, y = q[i] - mq; num += x * y; dp += x * x; dq += y * y; }
      return dp && dq ? num / Math.sqrt(dp * dq) : 0;
    };
    let dark = 0; for (const v of a) if (v < 140) dark++;
    return { ok: true, size: [cw, ch], loupeInk: Number((dark / a.length).toFixed(3)), corrSame: Number(corr(a, crop(0, 0)).toFixed(3)), corrShifted: Number(corr(a, crop(cw / 2, ch / 3)).toFixed(3)), loupePx: [loupe.width, loupe.height] };
  }, { mx, my });
}

try {
  const s = await launchTracked();
  const win = s.win;
  await win.waitForSelector('.empty-state');
  await waitFor(async () => (await engineState(win)).mupdfWorkersLive >= 1, { timeoutMs: 20000, label: 'spare worker' });
  const base = await engineState(win);
  check('baseline: one warm spare MuPDF worker, no documents', base.mupdfWorkersLive === 1 && base.mupdfDocs === 0, base);

  // ---------- 1. arXiv paper on MuPDF ----------
  const t0 = performance.now();
  await openPath(s, ARXIV, 'Page 1 of 15');
  const p1 = await waitPainted(win, 0);
  const arxivPaint = Math.round(performance.now() - t0);
  const e1 = await engineState(win);
  check('arXiv opened by MuPDF (1 MuPDF doc, doc worker + spare, no pdf.js worker)', e1.mupdfDocs === 1 && e1.mupdfWorkersLive === 2 && e1.pdfjsWorkersEver === 0, e1);
  check('arXiv page 1 painted with real ink', p1.value.ink > 0.01 && p1.value.w > 300, { ...p1.value, msToPaint: arxivPaint });

  // Search, with highlight placed on the glyph ink.
  await win.keyboard.press('Control+f');
  await win.getByLabel('Find in document').fill('Transformer');
  await waitFor(async () => /^\d+ of \d+$/.test((await win.locator('.search-status').innerText()).trim()), { timeoutMs: 20000, label: 'search done' });
  const st = (await win.locator('.search-status').innerText()).trim();
  const total = Number(st.split(' of ')[1]);
  check('search "Transformer" finds many hits in the arXiv paper', total >= 20, st);
  const inkRows = [];
  for (let i = 0; i < 6; i++) {
    await win.waitForTimeout(700);
    const h = await hitInk(win);
    inkRows.push({ status: (await win.locator('.search-status').innerText()).trim(), ...h });
    await win.keyboard.press('F3');
  }
  const goodHits = inkRows.filter((r) => r.found && r.inkColsFrac > 0.5 && r.firstInk < 0.12 && r.lastInk < 0.12);
  check('search highlight covers the matched glyph ink (6 consecutive hits)', goodHits.length === inkRows.length, inkRows);
  await win.keyboard.press('Escape');

  // Zoom to 400% and check the page re-renders sharp, and the highlight still sits on ink.
  for (let i = 0; i < 8; i++) await win.keyboard.press('Control+=');
  await win.waitForTimeout(1500);
  const zoomStatus = await statusText(win);
  const zoomed = await win.evaluate(() => {
    const v = document.querySelector('.viewer').getBoundingClientRect();
    const pages = [...document.querySelectorAll('.viewer .page')].filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; });
    const c = pages[0]?.querySelector('canvas');
    return c ? { canvasW: c.width, cssW: Math.round(c.getBoundingClientRect().width), dpr: devicePixelRatio } : null;
  });
  // Both engines cap a page bitmap at 16 MP (pdf.js did in 1.1: MAX_CANVAS_PIXELS). Expect min(full, cap).
  const expectW = zoomed ? Math.min(zoomed.cssW * zoomed.dpr, zoomed.cssW * zoomed.dpr * Math.sqrt(16e6 / ((zoomed.cssW * zoomed.dpr) * (zoomed.cssW * zoomed.dpr * 792 / 612)))) : 0;
  check('after zoom-in the visible page is re-rendered at zoom resolution (up to the 16 MP cap 1.1 also had)', zoomed && Math.abs(zoomed.canvasW - expectW) / expectW < 0.05, { zoomStatus, ...zoomed, expectW: Math.round(expectW) });
  await win.keyboard.press('Control+f');
  await win.getByLabel('Find in document').fill('Transformer');
  await win.waitForTimeout(1500);
  const zHit = await hitInk(win);
  check('at high zoom the current highlight still covers glyph ink', zHit.found && zHit.inkColsFrac > 0.5 && zHit.firstInk < 0.12 && zHit.lastInk < 0.12, zHit);
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+0');
  await win.waitForTimeout(800);

  // Bookmarks: hierarchy from the real outline, click jumps.
  await win.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  const tree = win.getByRole('tree', { name: 'Bookmarks', exact: true });
  await tree.waitFor({ timeout: 10000 });
  await win.waitForTimeout(500);
  const items = await tree.getByRole('treeitem').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-level')}|${e.getAttribute('aria-expanded')}|${e.innerText.replace(/[▸▾]/g, '').trim().split('\n')[0]}`));
  check('Bookmarks tree shows the arXiv outline (Introduction, Model Architecture, Why Self-Attention…)', items.some((t) => /Introduction/.test(t)) && items.some((t) => /Why Self-Attention/.test(t)) && items.some((t) => /\|true\||\|false\|/.test(t)), items.slice(0, 10));
  await tree.getByRole('button', { name: /^Why Self-Attention/ }).first().click();
  await win.waitForTimeout(800);
  const afterBm = await statusText(win);
  check('clicking "Why Self-Attention" jumps to page 6', afterBm.startsWith('Page 6 of 15'), afterBm);

  // Properties: document + current page; follows clicked page.
  await win.getByRole('button', { name: 'Properties', exact: true }).click();
  const props = win.getByRole('complementary', { name: 'Properties', exact: true });
  await props.waitFor({ timeout: 5000 });
  const docText = (await props.locator('section[aria-label="Document"]').innerText()).replace(/\s+/g, ' ');
  check('Properties Document section shows real file facts (path, PDF version, 15 pages)', /1706\.03762\.pdf/.test(docText) && /1\.\d/.test(docText) && /15/.test(docText), docText.slice(0, 400));
  await win.keyboard.press('Control+-');
  await win.keyboard.press('Control+-');
  await win.keyboard.press('Control+-');
  await win.waitForTimeout(800);
  const vis = await win.locator('.viewer .page').evaluateAll((els) => {
    const v = document.querySelector('.viewer').getBoundingClientRect();
    return els.filter((e) => { const r = e.getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom; }).map((e) => Number(e.dataset.pageIndex));
  });
  const target = vis.length ? vis[vis.length - 1] : null;
  if (target !== null) {
    const tb = await win.locator(`.viewer .page[data-page-index="${target}"]`).boundingBox();
    await win.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await win.waitForTimeout(500);
  }
  const curText = (await props.locator('section[aria-label="Current page"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('Properties "Current page" follows a clicked page in the viewer', target !== null && new RegExp(`\\b${target + 1}\\b`).test(curText), { clicked: target === null ? null : target + 1, fullyVisible: vis.map((i) => i + 1), curText });

  // Thumbnails: real pixels, jump, range selection.
  await win.getByRole('button', { name: 'Thumbnails', exact: true }).click();
  await win.locator('.thumb[role="option"]').first().waitFor({ timeout: 10000 });
  await win.waitForTimeout(1500);
  const thumbs = await win.locator('.thumb canvas').evaluateAll((cs) => cs.slice(0, 4).map((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 200) ink++;
    return { w: c.width, h: c.height, ink: Number((ink / (d.length / 4)).toFixed(3)) };
  }));
  check('thumbnails are drawn with real page content', thumbs.length >= 3 && thumbs.every((t) => t.ink > 0.005), thumbs);
  const row = (n) => win.locator('.thumb[role="option"]').filter({ has: win.locator('.thumb-label', { hasText: new RegExp(`^${n}$`) }) });
  await row(3).click();
  await win.waitForTimeout(700);
  const st3 = await statusText(win);
  await row(5).click({ modifiers: ['Shift'] });
  await win.waitForTimeout(300);
  const sel = await win.locator('[role="option"][aria-selected="true"] .thumb-label').allInnerTexts();
  check('thumbnail click jumps (page 3) and Shift+click selects the range 3-5', st3.startsWith('Page 3 of 15') && sel.join(',') === '3,4,5', { st3, sel });

  // Loupe: magnified view matches the page region under the pointer.
  await win.keyboard.press('Control+1');
  await win.waitForTimeout(800);
  await win.getByRole('button', { name: 'Loupe', exact: true }).click();
  await win.locator('.floating[aria-label="Loupe"]').waitFor({ timeout: 5000 });
  const vb = await win.locator('.viewer').first().boundingBox();
  const loupeRows = [];
  // Points on real text: centres of text-layer spans that are inside the viewer.
  const spots = await win.evaluate(({ vb }) => {
    const out = [];
    const spans = [...document.querySelectorAll('.viewer .textLayer span')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 60 && r.left > vb.x + 150 && r.right < vb.x + vb.width - 150 && r.top > vb.y + 100 && r.bottom < vb.y + vb.height - 100;
    });
    for (const f of [0.2, 0.7]) { const e = spans[Math.floor(spans.length * f)]; if (e) { const r = e.getBoundingClientRect(); out.push([r.left + r.width / 2, r.top + r.height / 2]); } }
    return out;
  }, { vb });
  for (const [mx0, my0] of spots.length ? spots : [[vb.x + vb.width * 0.6, vb.y + vb.height * 0.5]]) {
    const mx = mx0 - 1, my = my0 - 1;
    await win.mouse.move(mx, my);
    await win.mouse.move(mx + 1, my + 1);
    await win.waitForTimeout(1200);
    loupeRows.push(await loupeCorrelation(win, mx + 1, my + 1));
  }
  check('Loupe shows the region under the pointer (correlation with the page region high, shifted region low)', loupeRows.every((r) => r.ok && r.corrSame > 0.8 && r.corrSame - r.corrShifted > 0.3), loupeRows);
  await win.locator('.floating[aria-label="Loupe"]').getByRole('button', { name: /close/i }).click().catch(() => win.keyboard.press('Escape'));

  // Pan and zoom: overview has pixels and moving the rectangle scrolls the viewer.
  for (let i = 0; i < 4; i++) await win.keyboard.press('Control+=');
  await win.waitForTimeout(600);
  await win.getByRole('button', { name: 'Pan and zoom', exact: true }).click();
  const pz = win.locator('.floating[aria-label="Pan and zoom"]');
  await pz.waitFor({ timeout: 5000 });
  await waitFor(async () => (await pz.locator('.overview-rect').count()) === 1, { timeoutMs: 10000, label: 'overview rect' });
  await win.waitForTimeout(1000);
  const ovInk = await pz.locator('canvas').first().evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 200) ink++;
    return { w: c.width, h: c.height, ink: Number((ink / (d.length / 4)).toFixed(3)) };
  });
  const scrollBefore = await win.locator('.viewer').first().evaluate((v) => [v.scrollLeft, v.scrollTop]);
  const rb = await pz.locator('.overview-rect').boundingBox();
  await win.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await win.mouse.down();
  await win.mouse.move(rb.x + rb.width / 2 + 20, rb.y + rb.height / 2 + 30, { steps: 6 });
  await win.mouse.up();
  await win.waitForTimeout(600);
  const scrollAfter = await win.locator('.viewer').first().evaluate((v) => [v.scrollLeft, v.scrollTop]);
  check('Pan-and-Zoom overview shows the page and dragging its rectangle scrolls the viewer', ovInk.ink > 0.005 && (scrollAfter[0] !== scrollBefore[0] || scrollAfter[1] !== scrollBefore[1]), { ovInk, scrollBefore, scrollAfter });
  await win.keyboard.press('Escape');

  // ---------- 2. XFA goes to pdf.js; second document on top ----------
  await win.keyboard.press('Control+0');
  await openPath(s, XFA, 'Page 1 of', 60000);
  await waitFor(async () => (await win.locator('.viewer .page-canvas').count()) > 0, { timeoutMs: 30000, label: 'xfa page' });
  await win.waitForTimeout(2500);
  const ex = await engineState(win);
  const xInk = await pageInk(win, 0);
  check('XFA form routed to pdf.js: MuPDF still holds only the arXiv doc, a pdf.js worker exists, page painted', ex.mupdfDocs === 1 && ex.pdfjsWorkersEver >= 1 && xInk.ink > 0.005 && !xInk.placeholder, { ...ex, xInk, status: await statusText(win) });
  check('XFA routing frees the MuPDF worker it probed (doc + spare only)', ex.mupdfWorkersLive === 2, ex);

  // ---------- 3. fw9 (forms) + nested outline on MuPDF, then close everything ----------
  await openPath(s, FW9, 'Page 1 of 6');
  await waitPainted(win, 0);
  await openPath(s, OUTLINE, 'Page 1 of 9');
  await waitPainted(win, 0);
  await win.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  const tree2 = win.getByRole('tree', { name: 'Bookmarks', exact: true });
  await tree2.waitFor({ timeout: 10000 });
  await win.waitForTimeout(500);
  const lv = await tree2.getByRole('treeitem').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-level')}:${e.innerText.replace(/[▸▾]/g, '').trim().split('\n')[0]}`));
  const expandBtn = win.getByRole('button', { name: /^Expand 2\. Main Content/ });
  if (await expandBtn.count()) await expandBtn.click();
  await win.waitForTimeout(300);
  const lv2 = await tree2.getByRole('treeitem').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-level')}:${e.innerText.replace(/[▸▾]/g, '').trim().split('\n')[0]}`));
  const child = tree2.getByRole('button', { name: /^2\.2 Second Topic/ });
  if (await child.count()) await child.click();
  await win.waitForTimeout(600);
  const st22 = await statusText(win);
  check('nested outline: level-2 children appear under their parent and "2.2 Second Topic" jumps to page 6', lv2.some((t) => t.startsWith('2:2.')) && st22.startsWith('Page 6 of 9'), { before: lv, after: lv2, st22 });
  const e3 = await engineState(win);
  check('4 tabs open: 3 MuPDF documents (arXiv, fw9, outline) + XFA on pdf.js; 3 doc workers + spare', e3.mupdfDocs === 3 && e3.mupdfWorkersLive === 4, e3);

  // Close all tabs one by one.
  for (let i = 0; i < 4; i++) {
    await win.locator('.tab-close').first().click();
    await win.waitForTimeout(400);
  }
  await win.waitForSelector('.empty-state', { timeout: 10000 });
  await win.waitForTimeout(1500);
  const e4 = await engineState(win);
  check('after closing every tab: no MuPDF document and only the warm spare worker remains', e4.mupdfDocs === 0 && e4.mupdfWorkersLive === 1, e4);
  check('no console or page errors during the real-world run', s.errors.length === 0, s.errors.slice(0, 10));
  await s.close();
  cleanupProfile(s.profile);
} catch (e) {
  check('probe ran to completion', false, String(e.stack ?? e).slice(0, 800));
} finally {
  await closeAll();
  process.exitCode = summary() ? 1 : 0;
}
