// Sign-off probe: Loupe magnifies what is under the pointer, Pan-and-zoom shows/drives the view,
// dark mode changes the chrome, recolor changes the actual page pixels.
import { openFiles, topPage, pixels, waitFor, closeAll, cleanupProfile } from './common.mjs';

const log = (...a) => console.log(...a);

try {
  // ---------- Loupe ----------
  let s = await openFiles(['mixed-sizes-rotated.pdf'], ['Page 1 of 8']);
  await s.win.getByRole('button', { name: 'Loupe', exact: true }).click();
  const loupe = s.win.locator('.floating[aria-label="Loupe"]');
  await loupe.waitFor({ timeout: 5000 });
  log(`Loupe before hover: ${JSON.stringify((await loupe.innerText()).trim())}`);
  const page1 = s.win.locator('.page[data-page-index="0"]');
  const pb = await page1.boundingBox();
  const lb = await loupe.locator('.loupe-body').boundingBox();
  log(`page1 box ${JSON.stringify(pb)}, loupe body ${JSON.stringify(lb)}`);
  // Text "Page 1: Letter portrait" is drawn at (40pt, 40pt) at 18pt. Zoom from status.
  const z = await s.win.evaluate(() => Number(document.querySelector('.status-bar').innerText.match(/(\d+)%/)[1]) / 100);
  const textPt = { x: 90, y: 50 };
  await s.win.mouse.move(pb.x + textPt.x * z, pb.y + textPt.y * z);
  await s.win.waitForTimeout(1200);
  const onText = await pixels(s.app, lb);
  log(`Loupe over text (zoom ${z}): ${JSON.stringify(onText)}`);
  const canvasInfo = await loupe.locator('canvas').evaluate((c) => ({ w: c.width, h: c.height, cssW: c.getBoundingClientRect().width })).catch((e) => e.message);
  log(`Loupe canvas: ${JSON.stringify(canvasInfo)}`);
  await s.win.mouse.move(pb.x + pb.width * 0.5, pb.y + pb.height * 0.7);
  await s.win.waitForTimeout(1200);
  const onBlank = await pixels(s.app, lb);
  log(`Loupe over blank area: ${JSON.stringify(onBlank)}`);
  // Magnification check: the text glyph height in the viewer vs in the loupe.
  const viewerRegion = await pixels(s.app, { x: pb.x + 30 * z, y: pb.y + 30 * z, width: 200 * z, height: 40 * z });
  log(`Viewer region with text: ${JSON.stringify(viewerRegion)}`);
  // Loupe window drag
  const hdr = loupe.locator('.floating-header');
  const hb = await hdr.boundingBox();
  await s.win.mouse.move(hb.x + 20, hb.y + hb.height / 2);
  await s.win.mouse.down();
  await s.win.mouse.move(hb.x - 150, hb.y + 100, { steps: 6 });
  await s.win.mouse.up();
  const hb2 = await hdr.boundingBox();
  log(`Loupe dragged by (${Math.round(hb2.x - hb.x)}, ${Math.round(hb2.y - hb.y)})`);
  log(`Loupe errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);

  // ---------- Pan and zoom ----------
  s = await openFiles(['big-1000.pdf'], ['Page 1 of 1000']);
  for (let i = 0; i < 6; i++) await s.win.keyboard.press('Control+=');
  await s.win.waitForTimeout(600);
  log(`PZ status after zoom-in: ${await s.win.locator('.status-bar').innerText()}`);
  await s.win.getByRole('button', { name: 'Pan and zoom', exact: true }).click();
  const pz = s.win.locator('.floating[aria-label="Pan and zoom"]');
  await pz.waitFor({ timeout: 5000 });
  await waitFor(async () => (await pz.locator('.overview-rect').count()) === 1, { timeoutMs: 10000, label: 'overview rect' });
  const rectStyle = () => pz.locator('.overview-rect').evaluate((e) => e.getAttribute('style'));
  const viewerScroll = () => s.win.locator('.viewer').evaluate((v) => ({ left: Math.round(v.scrollLeft), top: Math.round(v.scrollTop) }));
  log(`PZ overview canvas: ${await pz.locator('canvas').count()} canvas, label=${await pz.locator('canvas').first().getAttribute('aria-label')}`);
  const ob = await pz.locator('.overview-frame').boundingBox();
  log(`PZ overview pixels: ${JSON.stringify(await pixels(s.app, ob))}`);
  log(`PZ rect before: ${await rectStyle()}; viewer scroll ${JSON.stringify(await viewerScroll())}`);
  const rb = await pz.locator('.overview-rect').boundingBox();
  await s.win.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await s.win.mouse.down();
  await s.win.mouse.move(rb.x + rb.width / 2 + 40, rb.y + rb.height / 2 + 60, { steps: 8 });
  await s.win.mouse.up();
  await s.win.waitForTimeout(500);
  log(`PZ after dragging rect (+40,+60): rect ${await rectStyle()}; viewer scroll ${JSON.stringify(await viewerScroll())}; top page ${JSON.stringify(await topPage(s.win))}`);
  // Scroll viewer: rect should follow.
  const vb = await s.win.locator('.viewer').boundingBox();
  await s.win.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await s.win.mouse.wheel(0, 300);
  await s.win.waitForTimeout(600);
  log(`PZ after wheel 300 in viewer: rect ${await rectStyle()}; viewer ${JSON.stringify(await viewerScroll())}`);
  // Click elsewhere in the overview: centers the rect there
  await s.win.mouse.click(ob.x + ob.width * 0.8, ob.y + ob.height * 0.85);
  await s.win.waitForTimeout(500);
  log(`PZ after click at (80%,85%): rect ${await rectStyle()}; viewer ${JSON.stringify(await viewerScroll())}`);
  log(`PZ hint: ${await pz.locator('.floating-hint').innerText()}`);
  log(`PZ errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);

  // ---------- Dark mode and recolor ----------
  s = await openFiles(['mixed-sizes-rotated.pdf'], ['Page 1 of 8']);
  const chrome = async () => s.win.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    body: getComputedStyle(document.body).backgroundColor,
    viewer: getComputedStyle(document.querySelector('.viewer')).backgroundColor,
    topbar: getComputedStyle(document.querySelector('.tb-group')?.parentElement ?? document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
  }));
  log(`Theme initial: ${JSON.stringify(await chrome())}`);
  const shell = { x: 0, y: 0, width: 1184, height: 70 };
  log(`Topbar pixels initial: ${JSON.stringify(await pixels(s.app, shell))}`);
  await s.win.getByRole('button', { name: 'Light or dark' }).click();
  await s.win.waitForTimeout(300);
  log(`Theme toggled: ${JSON.stringify(await chrome())}`);
  log(`Topbar pixels toggled: ${JSON.stringify(await pixels(s.app, shell))}`);
  const pg = await s.win.locator('.page-canvas').first().boundingBox();
  const zz = await s.win.evaluate(() => Number(document.querySelector('.status-bar').innerText.match(/(\d+)%/)[1]) / 100);
  const textBand = { x: pg.x + 35 * zz, y: pg.y + 35 * zz, width: 260 * zz, height: 30 * zz };
  const blank = { x: pg.x + pg.width * 0.3, y: pg.y + pg.height * 0.5, width: 60, height: 60 };
  log(`Page (dark theme, recolor off) blank: ${JSON.stringify(await pixels(s.app, blank))}`);

  const openRecolor = () => s.win.locator('summary', { hasText: /^Page colors:/ }).evaluate((sum) => { sum.parentElement.open = true; });
  const setMode = async (label) => {
    await openRecolor();
    await s.win.getByRole('menuitemradio', { name: label, exact: true }).click();
    await s.win.locator('summary', { hasText: /^Page colors:/ }).evaluate((sum) => { sum.parentElement.open = false; });
    await s.win.waitForTimeout(600);
  };
  for (const mode of ['Invert', 'Sepia', 'Night', 'High contrast']) {
    await setMode(mode);
    log(`Recolor ${mode}: blank ${JSON.stringify((await pixels(s.app, blank)).top)}; text band ${JSON.stringify((await pixels(s.app, textBand)).top)}`);
  }
  await setMode('Custom');
  await openRecolor();
  await s.win.getByLabel('Custom background color').fill('#102030');
  await s.win.getByLabel('Custom text color').fill('#ffee00');
  await s.win.locator('summary', { hasText: /^Page colors:/ }).evaluate((sum) => { sum.parentElement.open = false; });
  await s.win.waitForTimeout(800);
  log(`Recolor Custom (#102030 bg / #ffee00 text): blank ${JSON.stringify((await pixels(s.app, blank)).top)}; text band ${JSON.stringify((await pixels(s.app, textBand)).top)}`);
  log(`Recolor label now: ${await s.win.locator('summary', { hasText: /^Page colors:/ }).innerText()}`);
  log(`Visual errors: ${JSON.stringify(s.errors)}`);
  await s.close();
  cleanupProfile(s.profile);
} finally {
  await closeAll();
}
