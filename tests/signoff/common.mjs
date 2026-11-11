// Shared helpers for the independent sign-off probes. Reuses the e2e launcher.
export * from '../e2e/helpers.mjs';
import { launch, fixture, waitForPage } from '../e2e/helpers.mjs';

export async function openFiles(files, statuses) {
  const s = await launch();
  await s.win.waitForSelector('.empty-state');
  for (let i = 0; i < files.length; i++) {
    await s.setDialogAnswer([files[i].includes(':') ? files[i] : fixture(files[i])]);
    await s.win.keyboard.press('Control+o');
    await waitForPage(s, statuses[i], { timeoutMs: 60000 });
  }
  return s;
}

/** Top visible page (1-based) and the fraction of it scrolled past, for the viewer in pane frame i (or the single viewer). */
export function topPage(win, i = null) {
  const loc = i === null ? win.locator('.viewer').first() : win.locator('.pane-frame').nth(i).locator('.viewer');
  return loc.evaluate((v) => {
    const vr = v.getBoundingClientRect();
    const pages = [...v.querySelectorAll('.page')].sort((a, b) => Number(a.dataset.pageIndex) - Number(b.dataset.pageIndex));
    for (const p of pages) {
      const r = p.getBoundingClientRect();
      if (r.bottom > vr.top + 1) return { page: Number(p.dataset.pageIndex) + 1, frac: Number(((vr.top - r.top) / r.height).toFixed(3)), scrollTop: Math.round(v.scrollTop) };
    }
    return null;
  });
}

export async function runCommand(win, text) {
  await win.keyboard.press('Control+k');
  await win.getByLabel('Type a command').fill(text);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(400);
}

export async function wheelOver(win, locator, dy, times = 1) {
  const b = await locator.boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let k = 0; k < times; k++) {
    await win.mouse.wheel(0, dy);
    await win.waitForTimeout(60);
  }
  await win.waitForTimeout(600);
}

/** Captures a rectangle of the window in the main process and returns pixel stats (RGB). */
export async function pixels(app, rect) {
  return app.evaluate(async ({ BrowserWindow }, r) => {
    const w = BrowserWindow.getAllWindows()[0];
    const img = await w.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
    const { width, height } = img.getSize();
    const buf = img.toBitmap(); // BGRA
    const counts = new Map();
    let n = 0;
    const stride = buf.length / Math.max(1, height);
    const realW = Math.floor(stride / 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < realW; x++) {
        const o = y * stride + x * 4;
        const key = `${buf[o + 2] >> 3 << 3},${buf[o + 1] >> 3 << 3},${buf[o] >> 3 << 3}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        n++;
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, c]) => `${k}:${((c / n) * 100).toFixed(1)}%`);
    return { width, height, top };
  }, rect);
}
