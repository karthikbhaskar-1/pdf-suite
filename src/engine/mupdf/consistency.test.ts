// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import { WorkerFault } from './protocol';
import { readTextPages } from './textJob';

/** Three letter pages, each with one word, opened the way the worker opens a file. */
function openedCore(): MupdfCore {
  const pdf = new mu.PDFDocument();
  for (let i = 0; i < 3; i++) {
    pdf.insertPage(i, pdf.addPage([0, 0, 612, 792], 0, {}, `BT /F1 24 Tf 72 700 Td (page ${i}) Tj ET`));
  }
  const core = new MupdfCore(mu, null);
  core.open(new Uint8Array(pdf.saveToBuffer('').asUint8Array().slice()), undefined);
  return core;
}

describe('a page is named by uid@rev, so a stale name never reaches the wrong content', () => {
  it('locates the page while its rev is current, and not after an edit changed it', async () => {
    const core = openedCore();
    expect(core.locate('1@0')).toBe(1);
    await core.applyEdits([{ op: 'rotate', uids: ['1'], degrees: 90 }]);
    // The page is still there, but its content changed, so the old name is refused.
    expect(core.locate('1@0')).toBe(-1);
    expect(core.locate('1@1')).toBe(1);
  });

  it('a deleted page is refused under its old name, and its neighbours keep theirs', async () => {
    const core = openedCore();
    await core.applyEdits([{ op: 'delete', uids: ['0'] }]);
    expect(core.locate('0@0')).toBe(-1);
    expect(core.locate('1@0')).toBe(0);
    expect(core.locate('2@0')).toBe(1);
  });

  it('undo brings back the old name, and the name of the undone content is refused for good', async () => {
    const core = openedCore();
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    core.undo();
    // The original content is back under its original rev, so its name is valid again.
    expect(core.locate('0@0')).toBe(0);
    // The rotated content's name is refused, so a bitmap cached for it is never drawn for the restored page.
    expect(core.locate('0@1')).toBe(-1);
    // A new edit takes a rev that has never been used, so it cannot collide with the undone one.
    await core.applyEdits([{ op: 'rotate', uids: ['0'], degrees: 90 }]);
    expect(core.editState!.pages().revs[0]).toBeGreaterThan(1);
  });

  it('a text read whose names moved on is cancelled before it reads the moved page', async () => {
    const core = openedCore();
    const names = core.editState!.pages();
    const expects = names.uids.map((uid, i) => `${uid}@${names.revs[i]}`);
    await core.applyEdits([{ op: 'move', uids: ['2'], beforeUid: '0' }]);
    const read: number[] = [];
    await expect(
      readTextPages({
        from: 0,
        count: 3,
        pageCount: core.pageCount,
        readPage: (index) => {
          read.push(index);
          return core.textPage(index);
        },
        isCancelled: (index) => core.locate(expects[index] ?? '') !== index,
        yieldTurn: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(WorkerFault);
    // Position 0 now holds another page, so the batch stops before it reads anything.
    expect(read).toEqual([]);
  });
});
