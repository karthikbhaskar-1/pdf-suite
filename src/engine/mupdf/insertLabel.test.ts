import { describe, expect, it } from 'vitest';
import { insertedNoun, insertKindWord } from './insertLabel';
import { labelFor } from './editCore';
import type { PageEdit } from './protocol';

const SIZE = { width: 612, height: 792 };
const insert = (template: 'blank' | 'lined' | 'grid', count?: number): PageEdit => ({ op: 'insertBlank', afterUid: null, size: SIZE, template, ...(count ? { count } : {}) });

describe('what an Insert says it inserted (1.2.2)', () => {
  it('names the kind of page: blank, lined or grid', () => {
    expect(insertedNoun([insert('blank')], 1)).toBe('blank page');
    expect(insertedNoun([insert('lined')], 2)).toBe('lined pages');
    expect(insertedNoun([insert('grid')], 3)).toBe('grid pages');
  });

  it('says only "pages" when one apply mixes kinds, and has no kind for other edits', () => {
    expect(insertedNoun([insert('lined'), insert('grid')], 2)).toBe('pages');
    expect(insertKindWord([insert('lined'), insert('grid')])).toBe('');
    expect(insertKindWord([{ op: 'delete', uids: ['1'] }])).toBe('');
  });

  it('is the word the Undo label uses', () => {
    expect(labelFor([insert('blank', 2)])).toBe('Insert 2 blank pages');
    expect(labelFor([insert('lined', 1)])).toBe('Insert 1 lined page');
    expect(labelFor([insert('grid', 3)])).toBe('Insert 3 grid pages');
    expect(labelFor([insert('lined'), insert('grid')])).toBe('Insert 2 pages');
  });
});
