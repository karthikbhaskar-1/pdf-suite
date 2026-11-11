// @vitest-environment node
// Regression: bookmarks must follow the pages after an edit. The outline is read from the engine after each change, so
// a target is the page's place in the list as it is now (a delete before a bookmark moves it up one).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as mu from 'mupdf';
import { EditCore } from './editCore';

const OUTLINE = new URL('../../../tests/engine/corpus/outlines/nested_outline.pdf', import.meta.url);

/** Each outline entry's page index, by its title, as MuPDF reports it now. */
function targetsByTitle(doc: mu.Document): Map<string, number> {
  type Item = NonNullable<ReturnType<mu.Document['loadOutline']>>[number];
  const out = new Map<string, number>();
  const walk = (items: Item[] | null | undefined) => {
    for (const item of items ?? []) {
      if (typeof item.page === 'number' && item.page >= 0) out.set(item.title ?? '', item.page);
      walk(item.down);
    }
  };
  walk(doc.loadOutline());
  return out;
}

// nested_outline.pdf is not redistributable (scripts/download-test-corpus.mjs); skipped when it is absent.
describe.skipIf(!existsSync(OUTLINE))('bookmark targets after page edits (needs corpus nested_outline.pdf)', () => {
  it('moves each target with its page when the first page is deleted', async () => {
    const doc = mu.Document.openDocument(new Uint8Array(readFileSync(OUTLINE)), 'application/pdf');
    const pdf = doc.asPDF()!;
    const core = new EditCore(pdf, doc.countPages(), true);
    const before = targetsByTitle(doc);
    expect(before.get('2. Main Content')).toBe(3);
    await core.apply([{ op: 'delete', uids: [core.pages().uids[0]!] }]);
    const after = targetsByTitle(doc);
    // Page 0 is gone, so every bookmark on a later page is one place earlier, and it still names the same section.
    expect(after.get('2. Main Content')).toBe(2);
    expect(after.get('3. Conclusion')).toBe(5);
    expect(after.get('3.2 Future Work')).toBe(7);
  });

  it('keeps a bookmark on its page when pages move around it', async () => {
    const doc = mu.Document.openDocument(new Uint8Array(readFileSync(OUTLINE)), 'application/pdf');
    const pdf = doc.asPDF()!;
    const core = new EditCore(pdf, doc.countPages(), true);
    const count = core.pageCount;
    const uids = core.pages().uids;
    // Reverse the whole document: a target at index i must now name the page that was at index i, at position count-1-i.
    const before = targetsByTitle(doc);
    await core.apply([{ op: 'reverse', uids }]);
    const after = targetsByTitle(doc);
    for (const [title, index] of before) expect(after.get(title)).toBe(count - 1 - index);
  });
});
