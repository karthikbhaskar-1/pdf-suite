import { describe, expect, it } from 'vitest';
import { createPageList, movePage } from '../../core/model/pageList';
import type { OutlineItem } from '../../engine/types';
import { outlineToNodes, visibleKeys } from './outlineMapping';

const DOC = 'doc0000000000000000ff';
const outline: OutlineItem[] = [
  {
    title: 'Chapter 1',
    pageIndex: 0,
    children: [{ title: 'Section 1.1', pageIndex: 2, children: [] }],
  },
  { title: 'Missing target', pageIndex: null, children: [] },
  { title: '', pageIndex: 4, children: [] },
];

describe('outlineToNodes', () => {
  it('maps outline targets to page ids by source index', () => {
    const pages = createPageList(DOC, 5);
    const nodes = outlineToNodes(outline, pages);
    expect(nodes[0]?.pageId).toBe(pages[0]?.id);
    expect(nodes[0]?.children[0]?.pageId).toBe(pages[2]?.id);
    expect(nodes[0]?.children[0]?.pageIndex).toBe(2);
  });

  it('leaves targets outside the file unmapped', () => {
    const nodes = outlineToNodes(outline, createPageList(DOC, 5));
    expect(nodes[1]?.pageId).toBeNull();
    expect(nodes[1]?.pageIndex).toBe(-1);
  });

  it('follows the page list when pages are reordered', () => {
    const pages = movePage(createPageList(DOC, 5), 4, 0);
    const nodes = outlineToNodes([{ title: 'Last', pageIndex: 4, children: [] }], pages);
    expect(nodes[0]?.pageIndex).toBe(0);
    expect(nodes[0]?.pageId).toBe(pages[0]?.id);
  });

  it('gives every node a path key, and an Untitled title when blank', () => {
    const nodes = outlineToNodes(outline, createPageList(DOC, 5));
    expect(nodes[0]?.key).toBe('0');
    expect(nodes[0]?.children[0]?.key).toBe('0.0');
    expect(nodes[2]?.title).toBe('Untitled');
  });
});

describe('visibleKeys', () => {
  it('skips the children of collapsed nodes', () => {
    const nodes = outlineToNodes(outline, createPageList(DOC, 5));
    expect(visibleKeys(nodes, new Set())).toEqual(['0', '1', '2']);
    expect(visibleKeys(nodes, new Set(['0']))).toEqual(['0', '0.0', '1', '2']);
  });
});
