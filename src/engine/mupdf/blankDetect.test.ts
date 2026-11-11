// @vitest-environment node
// 1.3.2: blank-page detection, calibrated in docs/milestone-1.5/blank-calibration.md. The cases of that document are built here
// (vector pages and simulated scans) and measured through the real code (render at 50 dpi, paper tone, side band, largest mark):
//  - "Blank pages" (the default: ink <= 0.05% and mark <= 10 px) finds empty pages and scanner noise (dust, specks to 1 mm,
//    punch holes, edge shadow, bleed-through to 20%), and no page with dark content;
//  - "Blank and nearly blank pages" (ink <= 0.5%) also finds a page number, a short line, a signature line, a checkbox, a note,
//    the "intentionally left blank" notice, a black streak, 25% bleed-through;
//  - the known limits are pinned as limits (very pale text, a mark wholly in the side band, one mark of 10 px or less).
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import {
  BLANK_MARK_GAP,
  BLANK_PAPER_CONTRAST,
  BLANK_PRESETS,
  BLANK_SIDE_BAND_MM,
  blankMeasure,
  blankPages,
  isBlankAt,
  measurePixels,
  type BlankMeasure,
} from './blankDetect';
import { JobHarness, makeDoc } from './jobTestKit';

const LETTER = { w: 612, h: 792 };
const A4 = { w: 595, h: 842 };

type Verdict = 'blank' | 'nearly' | 'no';
const verdict = (m: BlankMeasure): Verdict => (isBlankAt(m, 'normal') ? 'blank' : isBlankAt(m, 'loose') ? 'nearly' : 'no');

// ---- Vector pages ------------------------------------------------------------------------------------------------------------

function vector(size: { w: number; h: number }, content: string, font = 'Helvetica'): mu.PDFDocument {
  const pdf = new mu.PDFDocument();
  const fonts = pdf.newDictionary();
  fonts.put('F1', pdf.addSimpleFont(new mu.Font(font)));
  const res = pdf.newDictionary();
  res.put('Font', fonts);
  pdf.insertPage(-1, pdf.addPage([0, 0, size.w, size.h], 0, res, content));
  return pdf;
}

const text = (s: string, x: number, y: number, pt = 12) => `BT /F1 ${pt} Tf ${x} ${y} Td (${s}) Tj ET`;
const measure = (pdf: mu.PDFDocument) => blankMeasure(mu, pdf, 0);

const pages = (name: string, build: (s: { w: number; h: number }) => string, expected: Verdict) => {
  for (const [label, size] of [['Letter', LETTER], ['A4', A4]] as const) {
    it(`${name} (${label}): ${expected}`, () => {
      const m = measure(vector(size, build(size)));
      expect(verdict(m), JSON.stringify(m)).toBe(expected);
    });
  }
};

describe('vector pages, as the calibration set', () => {
  pages('digital empty page', () => '', 'blank');
  pages('light watermark DRAFT (0.93 grey)', () => `q 0.93 g ${text('DRAFT', 60, 400, 120)} Q`, 'blank');
  pages('page number "12" in 10 pt', (s) => text('12', s.w / 2 - 6, 40, 10), 'nearly');
  pages('footer "Page 12 of 340 - Company confidential"', (s) => text('Page 12 of 340 - Company confidential', s.w / 2 - 90, 40, 10), 'nearly');
  pages('"See attached." in 12 pt', () => text('See attached.', 72, 700), 'nearly');
  pages('one sentence in 12 pt', () => text('This sentence is the only thing printed on the page.', 72, 700), 'nearly');
  pages('a checkbox with "I agree"', () => `0.75 w 100 600 10 10 re S ${text('I agree', 116, 601, 10)}`, 'nearly');
  pages('a signature line with its label', () => `0.75 w 100 200 m 300 200 l S ${text('Signature', 100, 188, 9)}`, 'nearly');
  pages('"This page intentionally left blank" in 12 pt', (s) => text('This page intentionally left blank', s.w / 2 - 105, s.h / 2, 12), 'nearly');
  pages('a full page of body text', () => Array.from({ length: 50 }, (_u, i) => text('Line of ordinary body text that fills a real page of a document', 72, 740 - i * 13, 11)).join('\n'), 'no');
  pages('a dark slide with a white title', () => `0.15 g 0 0 612 842 re f 1 g ${text('Quarterly results', 100, 400, 40)}`, 'no');
  pages('a coloured separator sheet (tone 175)', () => '0.69 g 0 0 700 900 re f', 'blank');
  pages('a coloured separator sheet with "See attached."', () => `0.69 g 0 0 700 900 re f 0 g ${text('See attached.', 72, 700)}`, 'nearly');
  pages('a dark page with nothing on it', () => '0.15 g 0 0 700 900 re f', 'blank');

  it('a sticky note alone is not blank at the default (nearly blank)', () => {
    const pdf = vector(LETTER, '');
    const page = pdf.loadPage(0);
    const note = page.createAnnotation('Text');
    note.setRect([200, 500, 224, 524]);
    note.setContents('call back');
    page.update();
    expect(verdict(measure(pdf))).toBe('nearly');
  });

  it('the new default no longer calls a page number or a short line blank (the old 0.1% did)', () => {
    expect(verdict(measure(vector(LETTER, text('See attached.', 72, 700))))).not.toBe('blank');
    expect(verdict(measure(vector(LETTER, text('12', 300, 40, 10))))).not.toBe('blank');
  });
});

// ---- Simulated scans (200 dpi gray, as in the calibration) ---------------------------------------------------------------------

interface Scan {
  tone?: number;
  noise?: number;
  specks?: { count: number; mm: number };
  punch?: 'shadow' | 'black';
  edge?: boolean;
  streak?: { mm: number; value: number };
  bleed?: number;
  size?: { w: number; h: number };
}

/** Set so that this simulation puts 20% bleed-through under the default and 25% above it, as the calibration measured. */
const BLEED_GAIN = 1.2;

/** A gray scan of a blank sheet with the defects of `scan`, as a one-page PDF. */
function scanPdf(scan: Scan): mu.PDFDocument {
  const size = scan.size ?? LETTER;
  const dpi = 200;
  const W = Math.round((size.w / 72) * dpi);
  const H = Math.round((size.h / 72) * dpi);
  const px = new Uint8Array(W * H);
  let seed = 987654321;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const tone = scan.tone ?? 240;
  const noise = scan.noise ?? 5;
  for (let i = 0; i < px.length; i++) px[i] = Math.max(0, Math.min(255, Math.round(tone + (rnd() - 0.5) * 2 * noise)));
  const mm = dpi / 25.4;
  const disc = (cx: number, cy: number, r: number, value: number) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px[y * W + x] = value;
    }
  };
  if (scan.specks) for (let i = 0; i < scan.specks.count; i++) disc(60 + rnd() * (W - 120), 60 + rnd() * (H - 120), Math.max(0.6, (scan.specks.mm * mm) / 2), 40);
  if (scan.punch) {
    // Holes end 15.3 mm from the side edge (ISO 838): centres 12 mm in, 6 mm wide; three holes down the page.
    for (const frac of [0.25, 0.5, 0.75]) disc(12 * mm, H * frac, 3 * mm, scan.punch === 'black' ? 10 : 215);
    if (scan.punch === 'shadow') for (const frac of [0.25, 0.5, 0.75]) disc(12 * mm, H * frac, 3.4 * mm, 225);
  }
  if (scan.edge) for (let y = 0; y < H; y++) for (let x = 0; x < 30; x++) px[y * W + x] = Math.round(20 + x * 7);
  if (scan.streak) {
    // Aligned to the 50 dpi grid, so the streak falls in one column of the measured image.
    const cx = Math.round((W * 0.43) / 4) * 4;
    const width = Math.max(1, Math.floor(scan.streak.mm * mm));
    for (let y = 0; y < H; y++) for (let x = cx; x < cx + width; x++) px[y * W + x] = scan.streak.value;
  }
  if (scan.bleed) {
    // The back of the sheet shows through: a page of text, mirrored, blurred and weakened.
    const back = vector(size, Array.from({ length: 45 }, (_u, i) => text('Text on the other side of the sheet, line after line of it', 72, 740 - i * 14, 11)).join('\n'));
    const page = back.loadPage(0);
    const pix = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, W, H], false);
    pix.clear(255);
    const dev = new mu.DrawDevice([dpi / 72, 0, 0, dpi / 72, 0, 0], pix);
    page.run(dev, mu.Matrix.identity);
    dev.close();
    const src = pix.getPixels();
    const stride = pix.getStride();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -2; k <= 2; k++) sum += 255 - src[y * stride + Math.max(0, Math.min(W - 1, W - 1 - x + k))]!;
        const ink = Math.min(1, (sum / 5 / 255) * BLEED_GAIN);
        px[y * W + x] = Math.round(px[y * W + x]! * (1 - scan.bleed * ink));
      }
    }
  }
  const pdf = new mu.PDFDocument();
  const pix = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.getPixels().set(px);
  const xo = pdf.newDictionary();
  xo.put('Im0', pdf.addImage(new mu.Image(pix)));
  const res = pdf.newDictionary();
  res.put('XObject', xo);
  pdf.insertPage(-1, pdf.addPage([0, 0, size.w, size.h], 0, res, `q ${size.w} 0 0 ${size.h} 0 0 cm /Im0 Do Q`));
  return pdf;
}

describe('simulated scans, as the calibration set', () => {
  const cases: Array<[string, Scan, Verdict]> = [
    ['clean white paper', { tone: 252, noise: 1 }, 'blank'],
    ['grey paper with heavy sensor noise', { tone: 200, noise: 14 }, 'blank'],
    ['dust: 40 specks of 0.3 mm', { specks: { count: 40, mm: 0.3 } }, 'blank'],
    ['dirty: 250 specks of 0.3 mm', { specks: { count: 250, mm: 0.3 } }, 'blank'],
    ['12 large specks of 1 mm', { specks: { count: 12, mm: 1 } }, 'blank'],
    ['hole-punch shadows', { punch: 'shadow' }, 'blank'],
    ['hole-punch holes, black backing', { punch: 'black' }, 'blank'],
    ['edge strip and shadow at the left edge', { edge: true }, 'blank'],
    ['faint bleed-through (10%)', { bleed: 0.1 }, 'blank'],
    ['bleed-through 15%', { bleed: 0.15 }, 'blank'],
    ['bleed-through 20%', { bleed: 0.2 }, 'blank'],
    ['strong bleed-through (25%)', { bleed: 0.25 }, 'nearly'],
    ['black ADF streak, 0.3 mm, full height', { streak: { mm: 0.3, value: 10 } }, 'nearly'],
    ['typical: noise, dust, hole shadows, edge and 10% bleed', { specks: { count: 30, mm: 0.3 }, punch: 'shadow', edge: true, bleed: 0.1 }, 'blank'],
  ];
  for (const [name, scan, expected] of cases) {
    for (const [label, size] of [['Letter', LETTER], ['A4', A4]] as const) {
      it(`${name} (${label}): ${expected}`, () => {
        const m = measure(scanPdf({ ...scan, size }));
        expect(verdict(m), JSON.stringify(m)).toBe(expected);
      });
    }
  }

  it('a 40% bleed-through (thin paper) is content at every choice', () => {
    expect(verdict(measure(scanPdf({ bleed: 0.4 })))).toBe('no');
  });
});

// ---- The measure itself --------------------------------------------------------------------------------------------------------

/** A gray image of w x h pixels with `paper` everywhere, then `draw` on it. */
function image(w: number, h: number, paper: number, draw: (set: (x: number, y: number, v: number) => void) => void) {
  const px = new Uint8Array(w * h).fill(paper);
  draw((x, y, v) => {
    px[y * w + x] = v;
  });
  return measurePixels(px, w, w, h);
}

describe('measurePixels', () => {
  const W = 425;
  const H = 550;

  it('the constants are the calibrated ones', () => {
    expect(BLANK_PRESETS).toEqual({ normal: { ink: 0.0005, mark: 10 }, loose: { ink: 0.005, mark: Infinity } });
    expect(BLANK_SIDE_BAND_MM).toBe(18);
    expect(BLANK_PAPER_CONTRAST).toBe(40);
    expect(BLANK_MARK_GAP).toBe(3);
  });

  it('ink is counted against the paper tone: a uniform sheet of any tone has none', () => {
    for (const paper of [255, 230, 175, 60]) expect(image(W, H, paper, () => undefined)).toEqual({ ink: 0, mark: 0 });
  });

  it('a mark darker than the paper by 40 counts; one by 30 does not; a lighter one counts too (a white title on dark paper)', () => {
    const dark = image(W, H, 230, (set) => {
      for (let y = 200; y < 210; y++) for (let x = 200; x < 230; x++) set(x, y, 230 - 41);
    });
    expect(dark.mark).toBe(300);
    const faint = image(W, H, 230, (set) => {
      for (let y = 200; y < 210; y++) for (let x = 200; x < 230; x++) set(x, y, 230 - 30);
    });
    expect(faint).toEqual({ ink: 0, mark: 0 });
    const light = image(W, H, 60, (set) => {
      for (let y = 200; y < 210; y++) for (let x = 200; x < 230; x++) set(x, y, 60 + 120);
    });
    expect(light.mark).toBe(300);
  });

  it('ink pixels within 3 px of each other are one mark; 5 px apart are two', () => {
    const near = image(W, H, 255, (set) => {
      for (let i = 0; i < 6; i++) set(200 + i * 3, 200, 0);
    });
    expect(near.mark).toBe(6);
    const apart = image(W, H, 255, (set) => {
      set(200, 200, 0);
      set(210, 200, 0);
    });
    expect(apart.mark).toBe(1);
  });

  it('the top and bottom 3% and the 18 mm side bands (at 50 dpi: 35 px) are ignored', () => {
    const edge = image(W, H, 255, (set) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < 35; x++) set(x, y, 0), set(W - 1 - x, y, 0);
      for (let x = 0; x < W; x++) for (let y = 0; y < 16; y++) set(x, y, 0), set(x, H - 1 - y, 0);
    });
    expect(edge).toEqual({ ink: 0, mark: 0 });
    const inside = image(W, H, 255, (set) => {
      for (let y = 200; y < 300; y++) set(36, y, 0);
    });
    expect(inside.mark).toBe(100);
  });

  it('the side band is never more than 15% of the width (a narrow page keeps its middle)', () => {
    const narrow = image(100, 100, 255, (set) => {
      for (let y = 10; y < 90; y++) for (let x = 40; x < 60; x++) set(x, y, 0);
    });
    expect(narrow.mark).toBeGreaterThan(1000);
  });
});

describe('the known limits of the calibration (listed for the 1.5 backlog; these pages are misjudged on purpose)', () => {
  it('very pale text (0.80 grey) is blank at the default', () => {
    expect(verdict(measure(vector(LETTER, `0.8 g ${text('A very pale line of text that nobody can read', 72, 700)}`)))).toBe('blank');
  });

  it('a bare page number in the bottom corner with 0.5 in margins lies in the side band and is not seen', () => {
    expect(verdict(measure(vector(LETTER, text('12', 560, 36, 10))))).toBe('blank');
  });

  it('a single mark of 10 pixels or less (a full stop) is taken for a speck', () => {
    expect(verdict(measure(vector(LETTER, text('.', 300, 400, 12))))).toBe('blank');
  });
});

describe('blankPages and analyse "blank" in the job worker', () => {
  it('lists the pages that pass a preset, 0-based', () => {
    const list: BlankMeasure[] = [{ ink: 0, mark: 0 }, { ink: 0.0003, mark: 12 }, { ink: 0.002, mark: 90 }, { ink: 0.01, mark: 500 }];
    expect(blankPages(list, 'normal')).toEqual([0]);
    expect(blankPages(list, 'loose')).toEqual([0, 1, 2]);
  });

  it('returns ink and mark for every page once, with progress, in page order', async () => {
    const pdf = new mu.PDFDocument();
    const fonts = pdf.newDictionary();
    fonts.put('F1', pdf.addSimpleFont(new mu.Font('Helvetica')));
    const res = pdf.newDictionary();
    res.put('Font', fonts);
    for (const body of ['', text('Full page', 100, 400, 40), '', text('More text', 100, 400, 40)]) pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, res, body));
    const h = new JobHarness();
    await h.probe(pdf.saveToBuffer('garbage=compact').asUint8Array().slice());
    h.send({ t: 'analyse', id: 5, what: 'blank' });
    await h.session.idle();
    const analysed = h.messages.find((m) => m.t === 'analysed');
    if (analysed?.t !== 'analysed' || analysed.result.what !== 'blank') throw new Error('no blank analysis');
    const { ink, mark } = analysed.result;
    expect(ink).toHaveLength(4);
    expect(mark).toHaveLength(4);
    expect(blankPages(ink.map((v, i) => ({ ink: v, mark: mark[i]! })), 'normal')).toEqual([0, 2]);
    const looking = h.messages.filter((m) => m.t === 'progress' && m.phase === 'looking');
    expect(looking.at(-1)).toMatchObject({ done: 4, total: 4, unit: 'pages' });
  });

  it('stops at once on cancel and returns no result', async () => {
    const h = new JobHarness();
    await h.probe(makeDoc({ pages: 60 }));
    h.send({ t: 'analyse', id: 6, what: 'blank' });
    h.send({ t: 'cancel', id: 6 });
    await h.session.idle();
    expect(h.messages.some((m) => m.t === 'analysed')).toBe(false);
    expect(h.messages.find((m) => m.t === 'error')).toMatchObject({ kind: 'Cancelled', id: 6 });
  });
});
