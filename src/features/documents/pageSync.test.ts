// @vitest-environment node
// After Discard on the recovery bar the document is the file on disk again, with the page sizes that file has. The sizes in
// the documents store must be those, not the sizes of the edited document that was thrown away.
import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { remeasurePages } from './pageSync';

const DOC = 'path:C:\mixed.pdf';
const size = (width: number, height: number, rotation = 0) => ({ width, height, rotation });

const fakeDoc = (sizes: Array<ReturnType<typeof size>>) => ({ pageCount: sizes.length, pageSize: async (i: number) => sizes[i]! }) as never;

beforeEach(() => {
  useDocumentsStore.setState({ docs: {} });
});

describe('remeasurePages', () => {
  it('replaces the sizes of the edited document with those of the document that took its place', async () => {
    // The edited document: page 1 deleted, a copy of the landscape page added: landscape first, then three more.
    const edited = [size(792, 612), size(612, 792), size(595, 842), size(792, 612)];
    useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'mixed.pdf', pageCount: 4, pages: [], sizes: edited } } } as never);
    // The file on disk: portrait first.
    const onDisk = [size(612, 792), size(792, 612), size(595, 842), size(540, 720)];
    remeasurePages(DOC, fakeDoc(onDisk), () => true);
    // Cleared at once, so no page is drawn in another page's slot while the measuring runs.
    expect(useDocumentsStore.getState().docs[DOC]!.sizes.every((s) => s === undefined)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useDocumentsStore.getState().docs[DOC]!.sizes).toEqual(onDisk);
  });

  it('follows a different page count', async () => {
    useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'mixed.pdf', pageCount: 3, pages: [], sizes: [size(1, 1), size(1, 1), size(1, 1)] } } } as never);
    remeasurePages(DOC, fakeDoc([size(612, 792), size(612, 792)]), () => true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useDocumentsStore.getState().docs[DOC]!.sizes).toHaveLength(2);
  });

  it('stops when the document is no longer the current one', async () => {
    useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'mixed.pdf', pageCount: 1, pages: [], sizes: [size(1, 1)] } } } as never);
    remeasurePages(DOC, fakeDoc([size(612, 792)]), () => false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useDocumentsStore.getState().docs[DOC]!.sizes).toEqual([undefined]);
  });
});
