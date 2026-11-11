import { beforeEach, describe, expect, it } from 'vitest';
import { removedUids, useEditStore, type DocPages } from './editStore';

const CLEAN = { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };

function pages(version: number, uids: string[], extra: Partial<DocPages> = {}): DocPages {
  return { version, uids, revs: uids.map(() => 0), sizes: null, history: CLEAN, ...extra };
}

beforeEach(() => {
  useEditStore.setState({ byDoc: {}, selected: {} });
});

describe('edit store', () => {
  it('holds the page list of a document as the worker last reported it', () => {
    useEditStore.getState().setPages('doc', pages(1, ['0', '1', '2']));
    expect(useEditStore.getState().byDoc.doc?.uids).toEqual(['0', '1', '2']);
  });

  it('drops a selected uid that a later list no longer holds, and keeps the others', () => {
    const store = useEditStore.getState();
    store.setPages('doc', pages(1, ['0', '1', '2', '3']));
    store.select('doc', ['1', '3']);
    useEditStore.getState().setPages('doc', pages(2, ['0', '2', '3']));
    expect(useEditStore.getState().selected.doc).toEqual(['3']);
  });

  it('ignores a list from an older version, so a late event cannot roll the pages back', () => {
    const store = useEditStore.getState();
    store.setPages('doc', pages(3, ['0', '2']));
    store.setPages('doc', pages(2, ['0', '1', '2']));
    expect(useEditStore.getState().byDoc.doc?.version).toBe(3);
    expect(useEditStore.getState().byDoc.doc?.uids).toEqual(['0', '2']);
  });

  it('reports the removed uids in the order they were in', () => {
    expect(removedUids(['0', '1', '2', 'n1'], ['0', 'n1'])).toEqual(['1', '2']);
  });

  it('carries the undo state, so the dirty flag follows the journal', () => {
    const store = useEditStore.getState();
    store.setPages('doc', pages(1, ['0'], { history: { ...CLEAN, dirty: true, canUndo: true, undoLabel: 'Delete 1 page' } }));
    expect(useEditStore.getState().byDoc.doc?.history).toMatchObject({ dirty: true, undoLabel: 'Delete 1 page' });
  });

  it('clears a document, so a new document starts from an empty list', () => {
    const store = useEditStore.getState();
    store.setPages('doc', pages(5, ['0']));
    store.select('doc', ['0']);
    store.clear('doc');
    expect(useEditStore.getState().byDoc.doc).toBeUndefined();
    expect(useEditStore.getState().selected.doc).toBeUndefined();
    useEditStore.getState().setPages('doc', pages(1, ['0', '1']));
    expect(useEditStore.getState().byDoc.doc?.version).toBe(1);
  });
});
