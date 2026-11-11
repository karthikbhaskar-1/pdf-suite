import type { DocId, PageRef } from './types';

/** An ordered, immutable list of page references. Every operation returns a new list. */
export type PageList = readonly PageRef[];

/**
 * The page id of a uid: "<docId>:<uid>". The whole document id is used, never a prefix of it: documents in one folder
 * share a long path prefix, and two documents must never share a page id (a selection is a set of page ids).
 */
export function pageIdForUid(docId: DocId, uid: string): string {
  return `${docId}:${uid}`;
}

/** The page id after its document was re-keyed (Save As): the same uid under the new document id. */
export function rekeyPageId(oldDocId: DocId, newDocId: DocId, pageId: string): string {
  const prefix = `${oldDocId}:`;
  return pageId.startsWith(prefix) ? pageIdForUid(newDocId, pageId.slice(prefix.length)) : pageId;
}

/** Deterministic page id, so a restored session maps view state back to the same pages. */
export function pageIdFor(docId: DocId, srcIndex: number): string {
  return pageIdForUid(docId, String(srcIndex));
}

export function createPageList(docId: DocId, pageCount: number): PageList {
  const pages: PageRef[] = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push({ id: pageIdFor(docId, i), docId, srcIndex: i, rotation: 0, crop: null });
  }
  return pages;
}

/**
 * The cache name of one page's content: "uid@rev", plus "@generation" for a MuPDF document. The generation is one per
 * document instance (worker), so a new worker (after a save or a reload, which restart the uids at 0) never matches a
 * bitmap that an earlier worker drew under the same uid and rev.
 */
export function pageContent(uid: string, rev: number, generation?: number): string {
  return generation === undefined ? `${uid}@${rev}` : `${uid}@${rev}@${generation}`;
}

/**
 * The page list the worker reported: one ref per page in order. Ids follow the page's uid, so view state keeps naming
 * the same page after a move. The engine index (srcIndex) is the page's position, as the engine reads pages.
 */
export function pageListFromPages(docId: DocId, uids: readonly string[], revs: readonly number[], generation?: number): PageList {
  return uids.map((uid, position) => ({
    id: pageIdForUid(docId, uid),
    docId,
    srcIndex: position,
    rotation: 0,
    crop: null,
    content: pageContent(uid, revs[position] ?? 0, generation),
  }));
}

export function indexOfPage(list: PageList, pageId: string): number {
  return list.findIndex((p) => p.id === pageId);
}

export function pageAt(list: PageList, index: number): PageRef | undefined {
  return list[index];
}

/** Rotates one page by `delta` degrees (multiples of 90), wrapping at 360. */
export function rotatePage(list: PageList, pageId: string, delta: number): PageList {
  return list.map((p) => {
    if (p.id !== pageId) return p;
    const next = (((p.rotation + delta) % 360) + 360) % 360;
    return { ...p, rotation: next as PageRef['rotation'] };
  });
}

export function removePage(list: PageList, pageId: string): PageList {
  return list.filter((p) => p.id !== pageId);
}

/** Moves the page at `from` so it ends up at index `to` (both indexes into the current list). */
export function movePage(list: PageList, from: number, to: number): PageList {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}
