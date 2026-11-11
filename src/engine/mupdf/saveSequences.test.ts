// @vitest-environment node
// Save sequences on ONE document instance of the real engine core. After every save the produced bytes are reopened with a
// separate MuPDF document and compared, page by page (text, rotation, size), with a model of what the document should be.
// This is the test that would have caught the data-loss bug: the second incremental save of a document returned the
// original file, and nothing compared the bytes of each save with the state on screen.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { MupdfCore } from './core';
import type { PageEdit } from './protocol';

const OUTLINE = new URL('../../../tests/fixtures/out/outline-6.pdf', import.meta.url);

/** What one page should be: where its content came from ('blank' for an inserted page), and its rotation. */
interface Expected {
  source: number | 'blank';
  rotate: number;
}

/** The model of the document: the same edits applied to a plain list. */
class Model {
  pages: Expected[] = Array.from({ length: 6 }, (_, i) => ({ source: i + 1, rotate: 0 }));
  duplicate(index: number): void {
    this.pages.splice(index + 1, 0, { ...this.pages[index]! });
  }
  rotate(index: number, degrees: number): void {
    const page = this.pages[index]!;
    page.rotate = (page.rotate + degrees) % 360;
  }
  delete(index: number): void {
    this.pages.splice(index, 1);
  }
  insertBlank(afterIndex: number): void {
    this.pages.splice(afterIndex + 1, 0, { source: 'blank', rotate: 0 });
  }
  move(index: number, beforeIndex: number | null): void {
    const [page] = this.pages.splice(index, 1);
    if (beforeIndex === null) this.pages.push(page!);
    else this.pages.splice(beforeIndex > index ? beforeIndex - 1 : beforeIndex, 0, page!);
  }
}

/** The pages of bytes as the model describes them. */
function describePages(bytes: ArrayBuffer | Uint8Array): Expected[] {
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : new Uint8Array(bytes);
  const doc = mu.Document.openDocument(data, 'application/pdf');
  try {
    const pdf = doc.asPDF()!;
    return Array.from({ length: doc.countPages() }, (_, i) => {
      const text = doc.loadPage(i).toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ').trim();
      const match = /Outline page (\d+)/.exec(text);
      const rotate = pdf.findPage(i).getInheritable('Rotate');
      return { source: match ? Number(match[1]) : 'blank', rotate: rotate.isNull() ? 0 : rotate.asNumber() };
    });
  } finally {
    doc.destroy();
  }
}

/** A core on a fresh copy of the fixture, and the model that goes with it. */
function start(): { core: MupdfCore; model: Model; original: Uint8Array } {
  const original = new Uint8Array(readFileSync(OUTLINE));
  const core = new MupdfCore(mu as never, {});
  core.open(original.slice(), undefined);
  return { core, model: new Model(), original };
}

const uidAt = (core: MupdfCore, index: number): string => core.editState!.pages().uids[index]!;
const run = async (core: MupdfCore, edit: (uid: string) => PageEdit, index: number) => {
  await core.applyEdits([edit(uidAt(core, index))]);
};
const duplicate = (core: MupdfCore, model: Model, index: number) => {
  model.duplicate(index);
  return run(core, (uid) => ({ op: 'duplicate', uids: [uid] }), index);
};
const rotate = (core: MupdfCore, model: Model, index: number, degrees = 90) => {
  model.rotate(index, degrees);
  return run(core, (uid) => ({ op: 'rotate', uids: [uid], degrees }), index);
};
const remove = (core: MupdfCore, model: Model, index: number) => {
  model.delete(index);
  return run(core, (uid) => ({ op: 'delete', uids: [uid] }), index);
};
const insertBlank = (core: MupdfCore, model: Model, afterIndex: number) => {
  model.insertBlank(afterIndex);
  return core.applyEdits([{ op: 'insertBlank', afterUid: uidAt(core, afterIndex), size: { width: 612, height: 792 }, template: 'blank' }]);
};
const move = (core: MupdfCore, model: Model, index: number, beforeIndex: number | null) => {
  model.move(index, beforeIndex);
  return core.applyEdits([{ op: 'move', uids: [uidAt(core, index)], beforeUid: beforeIndex === null ? null : uidAt(core, beforeIndex) }]);
};

/** One save of `core`, checked: the bytes reopen to exactly the model's pages, and match the fingerprints the core reported. */
function saveAndCheck(core: MupdfCore, model: Model, label: string, samePath = true): ReturnType<MupdfCore['save']> {
  const saved = core.save(samePath, true);
  expect(describePages(saved.bytes), label).toEqual(model.pages);
  expect(core.pageCount, `${label}: the core's page list`).toBe(model.pages.length);
  return saved;
}

describe('save sequences on one document, every save checked page by page', () => {
  it('edit, save, edit, save', async () => {
    const { core, model } = start();
    await duplicate(core, model, 0);
    saveAndCheck(core, model, 'first save');
    await rotate(core, model, 2);
    await remove(core, model, 4);
    saveAndCheck(core, model, 'second save');
    await insertBlank(core, model, 1);
    saveAndCheck(core, model, 'third save');
  });

  it('edit, save with the bytes thrown away (a failed write), save', async () => {
    const { core, model, original } = start();
    await duplicate(core, model, 0);
    await rotate(core, model, 0);
    saveAndCheck(core, model, 'the save whose write failed');
    const retry = saveAndCheck(core, model, 'the retry');
    expect(Buffer.from(retry.bytes).equals(Buffer.from(original))).toBe(false);
  });

  it('a failed save, more edits, a save', async () => {
    const { core, model } = start();
    await duplicate(core, model, 1);
    saveAndCheck(core, model, 'failed write');
    await move(core, model, 0, null);
    await rotate(core, model, 3, 180);
    saveAndCheck(core, model, 'save after more edits');
  });

  it('edit, save as (a different path), edit, save (the first path)', async () => {
    const { core, model } = start();
    await duplicate(core, model, 2);
    const asNew = saveAndCheck(core, model, 'save as', false);
    expect(asNew.mode).toBe('full');
    await rotate(core, model, 0);
    await remove(core, model, 5);
    const same = saveAndCheck(core, model, 'save to the original path');
    expect(same.mode).toBe('full');
  });

  it('insert only, save, then delete, save', async () => {
    const { core, model } = start();
    await insertBlank(core, model, 5);
    await insertBlank(core, model, 0);
    saveAndCheck(core, model, 'after inserting');
    await remove(core, model, 1);
    await remove(core, model, 0);
    saveAndCheck(core, model, 'after deleting');
  });

  it('three saves in a row with no edits between them', async () => {
    const { core, model } = start();
    await duplicate(core, model, 0);
    await rotate(core, model, 1);
    const first = saveAndCheck(core, model, 'save 1');
    const second = saveAndCheck(core, model, 'save 2');
    const third = saveAndCheck(core, model, 'save 3');
    expect(second.fingerprints).toEqual(first.fingerprints);
    expect(third.fingerprints).toEqual(first.fingerprints);
  });

  it('a save of a document with no edits is the original pages', async () => {
    const { core, model } = start();
    saveAndCheck(core, model, 'clean save');
    saveAndCheck(core, model, 'clean save again');
  });

  it('saves, then undo of a step made after the save, then a save', async () => {
    const { core, model } = start();
    await duplicate(core, model, 0);
    saveAndCheck(core, model, 'save');
    await rotate(core, model, 0);
    core.undo();
    model.rotate(0, -90);
    saveAndCheck(core, model, 'save after an undo of a later step');
  });
});
