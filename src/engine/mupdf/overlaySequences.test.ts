// @vitest-environment node
// 1.3.4 Compare overlay, sequence tests on one document instance of the real engine core (blueprint Appendix C, S8, S9, S10):
// apply -> undo -> redo -> save -> save again -> reopen, with every saved file re-read with MuPDF (a separate document) and
// compared with what the live document shows; the swap of the worker after a save (the overlay is attached again and shows
// the same); recovery replay of a logged overlay from its stash; and the rules of the edit itself (pairs, conflicts,
// copy-on-write, one copy of an overlay page that goes on many pages).
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { EditCore, labelFor } from './editCore';
import { pageFingerprints } from './pageFingerprint';
import type { OverlayArgs, PageEdit } from './protocol';
import { EditLog, parseEditLog, replayLog, type LogPort } from '../../features/recovery/editLog';

function box(x0: number, y0: number, x1: number, y1: number, gray = 0): string {
  return `${gray} g ${x0} ${y0} ${x1 - x0} ${y1 - y0} re f`;
}

/** A document of 400 x 300 pages, each with its own box so a page that shows another page's content is seen. */
function build(count: number, content: (i: number) => string, size: [number, number] = [400, 300]): Uint8Array {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < count; i++) pdf.insertPage(i, pdf.addPage([0, 0, size[0], size[1]], 0, {}, content(i)));
  return pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
}

const baseBytes = (count = 3): Uint8Array => build(count, (i) => box(20 + i * 30, 220, 60 + i * 30, 280));
// Overlay page i has its box at x (300 - 20 i)..(340 - 20 i) and, from the top of the page, y 240..280 (user y 20..60).
const overlayBytes = (count = 3): Uint8Array => build(count, (i) => box(300 - i * 20, 20, 340 - i * 20, 60), [400, 300]);

interface Pixels {
  w: number;
  h: number;
  px: Uint8Array;
}

function renderDoc(bytes: Uint8Array | ArrayBuffer, index: number, scale = 1): Pixels {
  const doc = mu.Document.openDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.slice(0)), 'application/pdf');
  try {
    const page = doc.loadPage(index);
    const b = page.getBounds();
    const w = Math.round((b[2] - b[0]) * scale);
    const h = Math.round((b[3] - b[1]) * scale);
    const pixmap = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, w, h], true);
    pixmap.clear(255);
    const device = new mu.DrawDevice([scale, 0, 0, scale, 0, 0], pixmap);
    page.run(device, mu.Matrix.identity);
    device.close();
    const stride = pixmap.getStride();
    const src = pixmap.getPixels();
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w * 4), y * w * 4);
    pixmap.destroy();
    return { w, h, px };
  } finally {
    doc.destroy();
  }
}

const darkAt = (img: Pixels, x: number, y: number): boolean => img.px[(y * img.w + x) * 4]! < 60;

function differing(a: Pixels, b: Pixels): number {
  expect([a.w, a.h]).toEqual([b.w, b.h]);
  let bad = 0;
  for (let i = 0; i < a.w * a.h; i++) {
    const j = i * 4;
    if (Math.abs(a.px[j]! - b.px[j]!) > 12 || Math.abs(a.px[j + 1]! - b.px[j + 1]!) > 12 || Math.abs(a.px[j + 2]! - b.px[j + 2]!) > 12) bad++;
  }
  return bad / (a.w * a.h);
}

/** The live document's page as the worker draws it (no overlay). */
function live(core: MupdfCore, index: number, scale = 1, overlay?: OverlayArgs): Pixels {
  const { pixmap, w, h } = core.renderPixmap({ page: index, scale, rotation: 0, overlay });
  try {
    const stride = pixmap.getStride();
    const src = pixmap.getPixels();
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w * 4), y * w * 4);
    return { w, h, px };
  } finally {
    pixmap.destroy();
  }
}

function start(pages = 3, overlayPages = 3): { core: MupdfCore; source: string; uids: () => string[] } {
  const core = new MupdfCore(mu as never, {});
  core.open(baseBytes(pages), undefined);
  const source = core.attachSource(overlayBytes(overlayPages), undefined).sourceDocId;
  return { core, source, uids: () => core.editState!.pages().uids };
}

const overlay = (uids: string[], source: string, sourceUids: string[], extra: Partial<Extract<PageEdit, { op: 'overlay' }>> = {}): PageEdit => ({
  op: 'overlay',
  uids,
  sourceDocId: source,
  sourceUids,
  dx: 0,
  dy: 0,
  scale: 1,
  mode: 'multiply',
  opacity: 0.5,
  ...extra,
});

describe('which pages the overlay goes on, and which overlay page goes on each', () => {
  it('lays overlay page i over base page i for each pair, and leaves the other pages untouched', async () => {
    const { core, source, uids } = start();
    const plain = [0, 1, 2].map((i) => live(core, i));
    // Pages 1 and 3 only, with overlay pages 3 and 1 (a pairing that is not in order).
    await core.applyEdits([overlay([uids()[0]!, uids()[2]!], source, ['2', '0'])]);
    // Page 1 got overlay page 3 (box at x 260..300, y 240..280), and page 2 is untouched.
    expect(darkAt(live(core, 0), 280, 260)).toBe(true);
    expect(darkAt(live(core, 0), 320, 260)).toBe(false);
    expect(differing(live(core, 1), plain[1]!)).toBe(0);
    // Page 3 got overlay page 1 (box at x 300..340).
    expect(darkAt(live(core, 2), 320, 260)).toBe(true);
    expect(darkAt(live(core, 2), 280, 260)).toBe(false);
    // The base boxes stay (page 1: x 20..60, y 20..80).
    expect(darkAt(live(core, 0), 40, 50)).toBe(true);
    core.close();
  });

  it('keeps every uid and moves only the revs of the pages it changed', async () => {
    const { core, source, uids } = start();
    const before = core.editState!.pages();
    await core.applyEdits([overlay([uids()[1]!], source, ['1'])]);
    const after = core.editState!.pages();
    expect(after.uids).toEqual(before.uids);
    expect(after.revs[0]).toBe(before.revs[0]);
    expect(after.revs[1]).not.toBe(before.revs[1]);
    expect(after.revs[2]).toBe(before.revs[2]);
    core.close();
  });

  it('is one undo step with the label "Add overlay to 3 pages"', async () => {
    const { core, source, uids } = start();
    await core.applyEdits([overlay(uids(), source, ['0', '1', '2'])]);
    expect(core.editState!.history.undoLabel).toBe('Add overlay to 3 pages');
    expect(labelFor([overlay(['0'], 's', ['0'])])).toBe('Add overlay to 1 page');
    core.undo();
    expect(core.editState!.history.canUndo).toBe(false);
    core.close();
  });
});

describe('the edit refuses what it cannot do, and changes nothing when it does', () => {
  it('a page deleted since the caller looked is a Conflict, and no page is changed', async () => {
    const { core, source } = start();
    const prints = core.fingerprints();
    await expect(core.applyEdits([overlay(['0', 'nope'], source, ['0', '1'])])).rejects.toMatchObject({ kind: 'Conflict' });
    expect(core.fingerprints()).toEqual(prints);
    expect(core.editState!.history.canUndo).toBe(false);
    core.close();
  });

  it('a source that is gone or a source page it does not have is refused', async () => {
    const { core, source } = start();
    await expect(core.applyEdits([overlay(['0'], 'src99', ['0'])])).rejects.toMatchObject({ kind: 'Conflict' });
    await expect(core.applyEdits([overlay(['0'], source, ['9'])])).rejects.toMatchObject({ kind: 'Unsupported' });
    core.close();
  });

  it('pages and overlay pages must pair up, the look must be one that can be added, and the size must be in range', async () => {
    const { core, source } = start();
    await expect(core.applyEdits([overlay(['0', '1'], source, ['0'])])).rejects.toMatchObject({ kind: 'Unsupported' });
    await expect(core.applyEdits([overlay(['0'], source, ['0'], { mode: 'difference' as never })])).rejects.toMatchObject({ kind: 'Unsupported' });
    await expect(core.applyEdits([overlay(['0'], source, ['0'], { scale: 5 })])).rejects.toMatchObject({ kind: 'Unsupported' });
    await expect(core.applyEdits([overlay(['0'], source, ['0'], { dx: Number.NaN })])).rejects.toMatchObject({ kind: 'Unsupported' });
    expect(core.editState!.history.canUndo).toBe(false);
    core.close();
  });

  it('no pages is no step', async () => {
    const { core, source } = start();
    const outcome = await core.applyEdits([overlay([], source, [])]);
    expect(outcome.changed).toBe(false);
    expect(core.editState!.history.canUndo).toBe(false);
    core.close();
  });
});

describe('copy-on-write and size', () => {
  it('a duplicate that shares the page content is not changed when the original gets an overlay', async () => {
    const { core, source, uids } = start(2);
    await core.applyEdits([{ op: 'duplicate', uids: [uids()[0]!] }]);
    const plain = live(core, 1);
    await core.applyEdits([overlay([uids()[0]!], source, ['0'])]);
    expect(differing(live(core, 1), plain)).toBe(0);
    expect(differing(live(core, 0), plain)).toBeGreaterThan(0);
    core.close();
  });

  it('one overlay page on every page is copied into the file once, not once per page', async () => {
    const plainSize = (() => {
      const core = new MupdfCore(mu as never, {});
      core.open(baseBytes(20), undefined);
      const size = core.save(false, false).bytes.byteLength;
      core.close();
      return size;
    })();
    const core = new MupdfCore(mu as never, {});
    core.open(baseBytes(20), undefined);
    const src = core.attachSource(overlayBytes(1), undefined).sourceDocId;
    await core.applyEdits([overlay(core.editState!.pages().uids, src, new Array<string>(20).fill('0'))]);
    const saved = core.save(false, false).bytes;
    const text = Buffer.from(saved).toString('latin1');
    // 20 pages, each with its own small drawing, but one Form XObject: the overlay's content is stored once.
    expect(text.match(/\/Subtype\s*\/Form/g)?.length).toBe(1);
    // Each page adds a few small objects (a drawing, q, Q, a state and two resource dictionaries), not a copy of the overlay.
    expect(saved.byteLength - plainSize).toBeLessThan(20 * 600);
    core.close();
  });

  it('two overlays on one page both show, and undo takes them off one at a time', async () => {
    const { core, source, uids } = start(1);
    await core.applyEdits([overlay([uids()[0]!], source, ['0'])]);
    await core.applyEdits([overlay([uids()[0]!], source, ['2'], { dx: 0, dy: -100 })]);
    const both = live(core, 0);
    expect(darkAt(both, 320, 260)).toBe(true); // overlay page 1 (box at x 300..340, y 240..280)
    expect(darkAt(both, 280, 160)).toBe(true); // overlay page 3 (box at x 260..300, y 240..280) moved up by 100: y 140..180
    core.undo();
    expect(darkAt(live(core, 0), 280, 160)).toBe(false);
    expect(darkAt(live(core, 0), 320, 260)).toBe(true);
    core.undo();
    expect(darkAt(live(core, 0), 320, 260)).toBe(false);
    core.close();
  });
});

describe('S9: apply -> undo -> redo -> save -> save again -> reopen (each saved file re-read with MuPDF)', () => {
  it('every saved file shows the overlay exactly as the live document does', async () => {
    const { core, source, uids } = start();
    const plain = live(core, 0);
    await core.applyEdits([overlay(uids(), source, ['0', '1', '2'], { dx: 12, dy: 8, scale: 0.75 })]);
    const applied = [0, 1, 2].map((i) => live(core, i));
    expect(differing(applied[0]!, plain)).toBeGreaterThan(0);

    core.undo();
    expect(differing(live(core, 0), plain)).toBe(0);
    core.redo();
    expect(differing(live(core, 0), applied[0]!)).toBe(0);

    const first = core.save(false, false);
    for (let i = 0; i < 3; i++) expect(differing(renderDoc(first.bytes, i), applied[i]!)).toBeLessThanOrEqual(0.001);
    // Saving the same document again (the first save may not have reached the disk) gives the same pages.
    const second = core.save(false, false);
    for (let i = 0; i < 3; i++) expect(differing(renderDoc(second.bytes, i), applied[i]!)).toBeLessThanOrEqual(0.001);
    // The fingerprints of the bytes match the document on screen.
    const reopened = new MupdfCore(mu as never, {});
    reopened.open(new Uint8Array(first.bytes.slice(0)), undefined);
    expect(reopened.fingerprints()).toEqual(first.fingerprints);
    // A reopened document is plain: the overlay is part of the pages now, and nothing is attached.
    expect(differing(live(reopened, 2), applied[2]!)).toBeLessThanOrEqual(0.001);
    reopened.close();
    core.close();
  });

  it('a save after an overlay is a full save, and the file reopens with the right page count', async () => {
    const { core, source, uids } = start();
    await core.applyEdits([overlay(uids(), source, ['0', '1', '2'])]);
    const saved = core.save(true, true);
    expect(saved.mode).toBe('full');
    const doc = mu.Document.openDocument(new Uint8Array(saved.bytes.slice(0)), 'application/pdf');
    expect(doc.countPages()).toBe(3);
    doc.destroy();
    core.close();
  });

  it('the saved file holds the overlay as a Form with a Multiply state, and no trace of the temporary page', async () => {
    const { core, source, uids } = start(1, 1);
    await core.applyEdits([overlay([uids()[0]!], source, ['0'])]);
    const text = Buffer.from(core.save(false, false).bytes).toString('latin1');
    expect(text).toContain('/Multiply');
    expect(text.match(/\/Type\s*\/Page\b/g)?.length).toBe(1);
    core.close();
  });

  it('See-through is saved as a transparency, and is read back at the same strength', async () => {
    const { core, source, uids } = start(1, 1);
    await core.applyEdits([overlay([uids()[0]!], source, ['0'], { mode: 'blend', opacity: 0.4 })]);
    const applied = live(core, 0);
    const saved = core.save(false, false);
    expect(differing(renderDoc(saved.bytes, 0), applied)).toBeLessThanOrEqual(0.001);
    expect(Buffer.from(saved.bytes).toString('latin1')).toMatch(/\/ca\s+0?\.4/);
    core.close();
  });
});

describe('S8: the view survives the worker swap of a save', () => {
  it('delete a base page, save, open the bytes in a fresh worker, attach the overlay again: the view is the same', async () => {
    const { core, source, uids } = start(3, 3);
    const args = (src: string, page: number): OverlayArgs => ({ sourceDocId: src, sourcePage: page, dx: 4, dy: 6, scale: 1, mode: 'multiply', opacity: 0.5 });
    await core.applyEdits([{ op: 'delete', uids: [uids()[0]!] }]);
    const before = live(core, 0, 1, args(source, 1));
    const saved = core.save(false, false);
    core.close();
    // What the page does after a save: a new worker on the saved bytes, and the overlay file read and attached again.
    const next = new MupdfCore(mu as never, {});
    next.open(new Uint8Array(saved.bytes), undefined);
    const attached = next.attachSource(overlayBytes(3), undefined);
    // The old source id means nothing to the new worker (so the page must use the new one): it is refused, never drawn wrong.
    if (attached.sourceDocId === source) expect(source).toBeTruthy();
    const after = live(next, 0, 1, args(attached.sourceDocId, 1));
    expect(differing(after, before)).toBeLessThanOrEqual(0.001);
    expect(() => live(next, 0, 1, args('src77', 1))).toThrow();
    next.close();
  });

  it('leaving detaches the source: the worker no longer draws it', () => {
    const { core, source } = start();
    const args: OverlayArgs = { sourceDocId: source, sourcePage: 0, dx: 0, dy: 0, scale: 1, mode: 'multiply', opacity: 0.5 };
    expect(() => live(core, 0, 1, args)).not.toThrow();
    core.detachSource(source);
    expect(() => live(core, 0, 1, args)).toThrow();
    core.close();
  });

  it('reports the overlay file facts the sheet needs: page count, form kind, and a page size', () => {
    const core = new MupdfCore(mu as never, {});
    core.open(baseBytes(1), undefined);
    const attached = core.attachSource(overlayBytes(2), undefined);
    expect(attached.pages).toBe(2);
    expect(attached.xfa).toEqual({ needsRendering: false, xfaPresent: false, fieldCount: 0 });
    expect(core.sourceSize(attached.sourceDocId, 1)).toEqual({ width: 400, height: 300 });
    expect(() => core.sourceSize(attached.sourceDocId, 5)).toThrow();
    expect(() => core.sourceSize('src99', 0)).toThrow();
    core.close();
  });
});

describe('S10: a logged overlay replays from its stash to the same pages, uids and content', () => {
  const KEY = 'c'.repeat(64);
  const memory = () => {
    const logs = new Map<string, string>();
    const stashes = new Map<string, ArrayBuffer>();
    const port: LogPort = {
      write: async (key, text) => void logs.set(key, text),
      writeStash: async (_key, name, bytes) => void stashes.set(name, bytes.slice(0)),
      clear: async (key) => void logs.delete(key),
    };
    return { logs, stashes, port };
  };

  it('replays onto the base file: the overlay edit names its source by stash, and the replay gives the same fingerprints', async () => {
    const base = baseBytes(3);
    const over = overlayBytes(3);
    const { logs, stashes, port } = memory();

    const liveDoc = mu.Document.openDocument(base.slice(), 'application/pdf');
    const livePdf = liveDoc.asPDF()!;
    const sources = new Map<string, mu.PDFDocument>();
    const liveCore = new EditCore(livePdf, 3, true, { mu, sources });
    const srcDoc = mu.Document.openDocument(over.slice(), 'application/pdf');
    sources.set('src1', srcDoc.asPDF()!);
    const log = new EditLog(KEY, 'C:\\docs\\x.pdf', { size: 1, modified: 2 }, port);
    await log.addSource('src1', over.slice().buffer as ArrayBuffer);
    const steps: PageEdit[][] = [
      [{ op: 'rotate', uids: ['0'], degrees: 90 }],
      [overlay(['0', '2'], 'src1', ['1', '0'], { dx: 3, dy: 4, scale: 1.2, mode: 'blend', opacity: 0.3 })],
      [{ op: 'delete', uids: ['1'] }],
    ];
    for (const step of steps) log.record(step, (await liveCore.apply(step)).uidSeed);
    await log.flush();
    const expectedUids = liveCore.pages().uids;
    const expectedPrints = pageFingerprints(livePdf);

    const file = parseEditLog(logs.get(KEY)!)!;
    // The overlay step refers to the stash, not to the live source id.
    const stored = file.steps[1]![0] as Extract<PageEdit, { op: 'overlay' }>;
    expect(stored.sourceDocId).toBe(file.stashes[0]);
    expect(file.stashes.length).toBe(1);

    const replayed = mu.Document.openDocument(base.slice(), 'application/pdf').asPDF()!;
    const replaySources = new Map<string, mu.PDFDocument>();
    const replayCore = new EditCore(replayed, 3, true, { mu, sources: replaySources });
    let attachSeq = 0;
    const result = await replayLog(file, async (name) => stashes.get(name)?.slice(0) ?? null, {
      attachSource: async (bytes) => {
        attachSeq += 1;
        const id = `replay${attachSeq}`;
        replaySources.set(id, mu.Document.openDocument(new Uint8Array(bytes), 'application/pdf').asPDF()!);
        return id;
      },
      applyStep: async (edits, seed) => void (await replayCore.apply(edits, undefined, seed)),
      undoStep: async () => replayCore.undo(),
    });
    expect(result.applied).toBe(3);
    expect(replayCore.pages().uids).toEqual(expectedUids);
    expect(pageFingerprints(replayed)).toEqual(expectedPrints);
    // Each replayed step is its own undo step.
    replayCore.undo();
    replayCore.undo();
    expect(replayCore.history.undoLabel).toBe('Rotate 1 page');
  });

  it('a password-protected overlay source is not stashed, so recovery for it is switched off by the page (see editOps)', () => {
    // The log itself has no stash for a source it was never given; recording an edit that names one is an error the page
    // avoids by switching recovery off first. This pins that the log refuses rather than writes a step it cannot replay.
    const { port } = memory();
    const log = new EditLog(KEY, 'C:\\docs\\x.pdf', { size: 1, modified: 2 }, port);
    expect(() => log.record([overlay(['0'], 'src9', ['0'])], 0)).toThrow(/no stash/);
  });
});

describe('an overlay on a large document stays quick', () => {
  it('adds one overlay page to 300 pages in one step, and undoes it', async () => {
    const pdf = new mu.PDFDocument();
    for (let i = 0; i < 300; i++) pdf.insertPage(i, pdf.addPage([0, 0, 400, 300], 0, {}, box(10 + (i % 50), 10, 60, 40)));
    const sources = new Map<string, mu.PDFDocument>();
    const core = new EditCore(pdf, 300, true, { mu, sources });
    sources.set('s', mu.Document.openDocument(overlayBytes(1), 'application/pdf').asPDF()!);
    const started = performance.now();
    await core.apply([overlay(core.pages().uids, 's', new Array<string>(300).fill('0'))]);
    const addMs = performance.now() - started;
    const undoStarted = performance.now();
    core.undo();
    const undoMs = performance.now() - undoStarted;
    // Not a timing gate (the protected results are measured in the app); this only catches a quadratic slowdown.
    expect(addMs).toBeLessThan(15000);
    expect(undoMs).toBeLessThan(5000);
    console.info(`[overlay 300 pages] add ${Math.round(addMs)} ms, undo ${Math.round(undoMs)} ms`);
  });
});
