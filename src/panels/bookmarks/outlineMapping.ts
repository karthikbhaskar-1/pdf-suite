import { engineIndexOf } from '../../engine/pageRef';
import type { PageList } from '../../core/model/pageList';
import type { OutlineItem } from '../../engine/types';

/** One bookmark, ready to show. `pageId` is null when the target is not a page of this document. */
export interface BookmarkNode {
  /** Unique within the tree: the path of child positions, such as "0.2.1". */
  key: string;
  title: string;
  pageId: string | null;
  /** Position of the target page in the page list, or -1. */
  pageIndex: number;
  children: BookmarkNode[];
}

/**
 * Maps an engine outline to bookmark nodes. Each outline target is a page of the original file
 * (its source index). The node points at the PageRef with that source index, so the tree keeps
 * working when the page list is reordered, and never holds a pdf.js index.
 */
export function outlineToNodes(items: readonly OutlineItem[], pages: PageList, parentKey = ''): BookmarkNode[] {
  // Index the page list once, by source page, so each lookup is O(1).
  const bySource = new Map<number, { id: string; index: number }>();
  pages.forEach((page, index) => {
    const engineIndex = engineIndexOf(page);
    if (!bySource.has(engineIndex)) bySource.set(engineIndex, { id: page.id, index });
  });
  return buildNodes(items, bySource, parentKey);
}

function buildNodes(
  items: readonly OutlineItem[],
  bySource: Map<number, { id: string; index: number }>,
  parentKey: string,
): BookmarkNode[] {
  return items.map((item, i) => {
    const key = parentKey === '' ? String(i) : `${parentKey}.${i}`;
    const target = item.pageIndex === null ? undefined : bySource.get(item.pageIndex);
    return {
      key,
      title: item.title.trim() === '' ? 'Untitled' : item.title,
      pageId: target?.id ?? null,
      pageIndex: target?.index ?? -1,
      children: buildNodes(item.children, bySource, key),
    };
  });
}

/** Keys of the nodes in a tree, in display order, skipping children of collapsed nodes. */
export function visibleKeys(nodes: readonly BookmarkNode[], expanded: ReadonlySet<string>): string[] {
  const keys: string[] = [];
  const walk = (list: readonly BookmarkNode[]) => {
    for (const node of list) {
      keys.push(node.key);
      if (node.children.length > 0 && expanded.has(node.key)) walk(node.children);
    }
  };
  walk(nodes);
  return keys;
}
