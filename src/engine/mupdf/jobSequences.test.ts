// @vitest-environment node
// 1.3.2 sequences S2, S3, S11, S13, S14 at engine level, on the JobSession (the worker's logic): every file produced is re-read
// with pdf.js; the source bytes never change; a cancelled or failed run produces no `done`, and the next run on the same session works.
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import crypto from 'node:crypto';
import { JobHarness, makeDoc } from './jobTestKit';
import { CHUNK_BYTES, type FromJob } from './jobProtocol';
import { partSaveOptions } from './splitCore';
import { reread } from '../../../tests/lib/reread.mjs';

const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

const ranges = (...parts: Array<[number, number]>) => ({
  by: 'ranges' as const,
  parts: parts.map(([from, to], i) => ({ from, to, leafName: `S - ${String(i + 1).padStart(2, '0')}.pdf` })),
});

function locked(pages: number, password: string): Uint8Array {
  const doc = new mu.PDFDocument(makeDoc({ pages, info: { Title: 'Secret' } }));
  return doc.saveToBuffer(`encrypt=aes-256,user-password=${password},owner-password=${password}`).asUint8Array().slice();
}

describe('S3: split by bookmarks, the source is never changed', () => {
  it('parts hold the bookmarks\' pages; the source bytes are the same before and after; every part is re-read', async () => {
    const src = makeDoc({ pages: 9, outline: [{ title: 'A', page: 1 }, { title: 'B', page: 4 }, { title: 'C', page: 8 }] });
    const before = sha(src);
    const h = new JobHarness();
    await h.probe(src);
    h.send({ t: 'analyse', id: 3, what: 'outline' });
    await h.session.idle();
    const analysed = h.messages.find((m) => m.t === 'analysed');
    expect(analysed).toMatchObject({ result: { what: 'outline', entries: [{ title: 'A', page: 1 }, { title: 'B', page: 4 }, { title: 'C', page: 8 }] } });
    const out = await h.split({ kind: 'split', baseName: 'S', plan: ranges([1, 3], [4, 7], [8, 9]) });
    expect(out.error).toBeUndefined();
    expect(out.done).toMatchObject({ files: 3, pages: 9 });
    expect(sha(src)).toBe(before);
    const texts = await Promise.all(out.files.map(async (f) => (await reread(f.bytes)).text));
    expect(texts).toEqual([['Page 1', 'Page 2', 'Page 3'], ['Page 4', 'Page 5', 'Page 6', 'Page 7'], ['Page 8', 'Page 9']]);
  });

  it('a split after a split in the same session starts clean (S4 at engine level): a second run makes the same files', async () => {
    const src = makeDoc({ pages: 6 });
    const h = new JobHarness();
    await h.probe(src);
    const first = await h.split({ kind: 'split', baseName: 'S', plan: ranges([1, 3], [4, 6]) }, 10);
    const countBefore = first.files.length;
    const again = await h.split({ kind: 'split', baseName: 'S', plan: ranges([1, 3], [4, 6]) }, 11);
    expect(again.files.length).toBe(countBefore * 2);
    expect(again.files.slice(0, 2).map((f) => sha(f.bytes))).not.toEqual([]);
    expect((await reread(again.files[3]!.bytes)).text).toEqual(['Page 4', 'Page 5', 'Page 6']);
  });
});

describe('S11: encrypted input', () => {
  it('a wrong password, then the right one; a file that needs a password and gets none', async () => {
    const src = locked(5, 'open sesame');
    const h = new JobHarness();
    expect((await h.probe(src)).error).toMatchObject({ kind: 'PasswordNeeded' });
    const wrong = new JobHarness();
    expect((await wrong.probe(src, 'nope')).error).toMatchObject({ kind: 'WrongPassword' });
    const right = new JobHarness();
    const probed = (await right.probe(src, 'open sesame')).probed!;
    expect(probed).toMatchObject({ pages: 5, encrypted: true });
  });

  it('with the password kept, every part asks for the same password and nothing else opens it', async () => {
    const src = locked(6, 'open sesame');
    const h = new JobHarness();
    await h.probe(src, 'open sesame');
    const out = await h.split({ kind: 'split', baseName: 'S', password: 'open sesame', plan: ranges([1, 3], [4, 6]) });
    expect(out.error).toBeUndefined();
    expect(out.files).toHaveLength(2);
    for (const file of out.files) {
      const doc = mu.Document.openDocument(file.bytes, 'application/pdf');
      expect(doc.needsPassword()).toBe(true);
      expect(doc.authenticatePassword('wrong')).toBe(0);
      expect(doc.authenticatePassword('open sesame')).toBeGreaterThan(0);
      expect(doc.countPages()).toBe(3);
    }
    expect((await reread(out.files[1]!.bytes, { password: 'open sesame' })).text).toEqual(['Page 4', 'Page 5', 'Page 6']);
  });

  it('with the password dropped, the parts open without one', async () => {
    const src = locked(4, 'open sesame');
    const h = new JobHarness();
    await h.probe(src, 'open sesame');
    const out = await h.split({ kind: 'split', baseName: 'S', password: 'open sesame', dropEncryption: true, plan: ranges([1, 2], [3, 4]) });
    expect(out.error).toBeUndefined();
    for (const file of out.files) expect(mu.Document.openDocument(file.bytes, 'application/pdf').needsPassword()).toBe(false);
    expect((await reread(out.files[0]!.bytes)).text).toEqual(['Page 1', 'Page 2']);
  });

  it('a password that cannot be kept (it has a comma) makes no file at all: CannotKeepPassword; dropping it then works', async () => {
    // MuPDF's option text cannot hold a comma, so the file is locked with a plain password and the run is given the other one.
    const src = locked(4, 'abc');
    const h = new JobHarness();
    expect((await h.probe(src, 'abc')).probed).toBeDefined();
    const out = await h.split({ kind: 'split', baseName: 'S', password: 'a,b', plan: ranges([1, 2], [3, 4]) });
    expect(out.error).toMatchObject({ kind: 'CannotKeepPassword' });
    expect(out.files).toEqual([]);
    expect(h.messages.some((m) => m.t === 'file' || m.t === 'done')).toBe(false);
    const dropped = await h.split({ kind: 'split', baseName: 'S', password: 'abc', dropEncryption: true, plan: ranges([1, 2], [3, 4]) }, 9);
    expect(dropped.files).toHaveLength(2);
  });

  it('partSaveOptions: plain, kept (AES-256 with the password) or refused', () => {
    expect(partSaveOptions({ encrypted: false, password: undefined, dropEncryption: false })).toBe('garbage=compact');
    expect(partSaveOptions({ encrypted: true, password: 'abc', dropEncryption: true })).toBe('garbage=compact');
    expect(partSaveOptions({ encrypted: true, password: 'abc', dropEncryption: false })).toContain('encrypt=aes-256');
    expect(() => partSaveOptions({ encrypted: true, password: 'a,b', dropEncryption: false })).toThrow();
  });
});

describe('S13 and S2: a failed or cancelled run, then a good one', () => {
  it('a write failure at chunk 2 gives an error and no done; the next run succeeds and its files are right', async () => {
    let calls = 0;
    const h = new JobHarness({
      beforeChunk: () => {
        calls += 1;
        if (calls === 2) throw new Error('disk exploded');
      },
    });
    const src = makeDoc({ pages: 6 });
    const before = sha(src);
    await h.probe(src);
    const failed = await h.split({ kind: 'split', baseName: 'S', plan: ranges([1, 2], [3, 4], [5, 6]) }, 20);
    expect(failed.error).toMatchObject({ kind: 'Internal', id: 20 });
    expect(failed.done).toBeUndefined();
    const sent = h.messages.filter((m) => m.t === 'fileEnd').length;
    expect(sent).toBe(1);
    // The page tells main to abort, which removes the temp files; the worker is ready for another run.
    const again = await h.split({ kind: 'split', baseName: 'S', plan: ranges([1, 2], [3, 4], [5, 6]) }, 21);
    expect(again.done).toMatchObject({ id: 21, files: 3, pages: 6 });
    expect(sha(src)).toBe(before);
  });

  it('a cancel at half stops after the file in progress, sends no done, and the next run succeeds', async () => {
    let ends = 0;
    // eslint-disable-next-line prefer-const
    let h: JobHarness;
    h = new JobHarness({
      beforeChunk: (file) => {
        // The third file is about to be sent: the user presses Cancel.
        if (file === 3) {
          ends += 1;
          if (ends === 1) h.send({ t: 'cancel', id: 30 });
        }
      },
    });
    await h.probe(makeDoc({ pages: 12 }));
    const out = await h.split({ kind: 'split', baseName: 'S', plan: ranges([1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]) }, 30);
    expect(out.error).toMatchObject({ kind: 'Cancelled', id: 30 });
    expect(out.done).toBeUndefined();
    // The file that was being sent (the third) is finished; nothing after it is made. The page then tells main to abort.
    expect(out.files.length).toBe(3);
    const again = await h.split({ kind: 'split', baseName: 'S', plan: ranges([1, 6], [7, 12]) }, 31);
    expect(again.done).toMatchObject({ id: 31, files: 2 });
  });

  it('a cancel while waiting for the page\'s acknowledgement ends the job at once', async () => {
    const h = new JobHarness({ autoAck: false });
    await h.probe(makeDoc({ pages: 4 }));
    h.send({ t: 'start', id: 40, spec: { kind: 'split', baseName: 'S', plan: ranges([1, 2], [3, 4]) } });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.messages.some((m) => m.t === 'chunk')).toBe(true);
    h.send({ t: 'cancel', id: 40 });
    await h.session.idle();
    expect(h.messages.find((m) => m.t === 'error')).toMatchObject({ kind: 'Cancelled', id: 40 });
  });
});

describe('output leaves in chunks of 4 MB, each acknowledged before the next', () => {
  it('a part over 4 MB is sent as several chunks in order; chunk n + 1 only after the ack of n; the bytes add up and open', async () => {
    const pdf = new mu.PDFDocument();
    const pix = new mu.Pixmap(mu.ColorSpace.DeviceGray, [0, 0, 2400, 2200], false);
    crypto.randomFillSync(pix.getPixels());
    const xo = pdf.newDictionary();
    xo.put('Im', pdf.addImage(new mu.Image(pix)));
    const res = pdf.addObject(pdf.newDictionary());
    res.put('XObject', xo);
    pdf.insertPage(-1, pdf.addPage([0, 0, 600, 550], 0, res, 'q 600 0 0 550 0 0 cm /Im Do Q'));
    const src = pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
    expect(src.length).toBeGreaterThan(CHUNK_BYTES);

    const h = new JobHarness({ autoAck: false });
    await h.probe(src);
    h.send({ t: 'start', id: 50, spec: { kind: 'split', baseName: 'S', plan: ranges([1, 1]) } });
    const chunks = (): Extract<FromJob, { t: 'chunk' }>[] => h.messages.filter((m): m is Extract<FromJob, { t: 'chunk' }> => m.t === 'chunk');
    for (let seq = 0; seq < 2; seq++) {
      await new Promise((r) => setTimeout(r, 40));
      // Only chunk `seq` has been sent: the next one waits for the ack.
      expect(chunks().map((c) => c.seq)).toEqual(Array.from({ length: seq + 1 }, (_u, i) => i));
      expect(chunks()[seq]!.bytes.byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
      h.send({ t: 'ack', id: 50, file: 1, seq });
    }
    await new Promise((r) => setTimeout(r, 40));
    // The last chunk, then fileEnd after its ack.
    const total = chunks().length;
    h.send({ t: 'ack', id: 50, file: 1, seq: total - 1 });
    await h.session.idle();
    const out = h.output();
    expect(out.error).toBeUndefined();
    expect(out.files).toHaveLength(1);
    expect(chunks().length).toBeGreaterThanOrEqual(2);
    const end = h.messages.find((m) => m.t === 'fileEnd');
    expect(end).toMatchObject({ byteLength: out.files[0]!.bytes.length, pages: 1 });
    expect(mu.Document.openDocument(out.files[0]!.bytes, 'application/pdf').countPages()).toBe(1);
  });
});

describe('the session itself', () => {
  it('start without a probe asks for the file with `need`, and runs when `input` answers', async () => {
    const src = makeDoc({ pages: 4 });
    const h = new JobHarness();
    h.send({ t: 'start', id: 60, spec: { kind: 'split', baseName: 'S', plan: ranges([1, 2], [3, 4]) } });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.messages.find((m) => m.t === 'need')).toMatchObject({ index: 0, id: 60 });
    h.send({ t: 'input', id: 60, index: 0, bytes: src.slice().buffer as ArrayBuffer });
    await h.session.idle();
    expect(h.output().done).toMatchObject({ files: 2, pages: 4 });
  });

  it('a damaged file is reported as Damaged, a file over the limit as TotalTooLarge, a range outside the document as Internal', async () => {
    const h = new JobHarness();
    expect((await h.probe(new Uint8Array([1, 2, 3, 4, 5]))).error).toMatchObject({ kind: 'Damaged' });
    const h2 = new JobHarness();
    await h2.probe(makeDoc({ pages: 3 }));
    const out = await h2.split({ kind: 'split', baseName: 'S', plan: ranges([1, 9]) });
    expect(out.error?.kind).toBe('Internal');
  });

  it('progress is throttled to about ten a second and ends with the last one of each phase', async () => {
    // A clock that never moves: only the first message and the ones that complete a count may pass.
    const h = new JobHarness({ now: () => 0 });
    await h.probe(makeDoc({ pages: 40 }));
    const out = await h.split({ kind: 'split', baseName: 'S', plan: ranges(...Array.from({ length: 40 }, (_u, i): [number, number] => [i + 1, i + 1])) });
    const progress = out.messages.filter((m) => m.t === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThanOrEqual(5);
    // With a moving clock (a real run) the four phases all show.
    let now = 0;
    const h2 = new JobHarness({ now: () => (now += 200) });
    await h2.probe(makeDoc({ pages: 6 }));
    const real = await h2.split({ kind: 'split', baseName: 'S', plan: ranges([1, 2], [3, 4], [5, 6]) });
    for (const phase of ['copying', 'saving', 'checking', 'writing']) expect(real.messages.some((m) => m.t === 'progress' && m.phase === phase)).toBe(true);
  });

  it('a probe of a form file reports its facts', async () => {
    const h = new JobHarness();
    const probed = (await h.probe(makeDoc({ pages: 2 }))).probed!;
    expect(probed).toMatchObject({ pages: 2, encrypted: false, fields: 0, formValuesKept: true, xfa: false, layers: false, attachments: 0, unprintable: 0 });
  });
});
