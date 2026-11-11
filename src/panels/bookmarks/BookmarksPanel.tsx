import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { documentRegistry } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import type { OutlineItem } from '../../engine/types';
import { requestViewer } from '../../ui/viewer/viewerBus';
import { outlineToNodes, visibleKeys, type BookmarkNode } from './outlineMapping';


/** Collapsible outline. Click jumps to the page. Up/Down move, Left/Right collapse and expand, Enter jumps. */
export function BookmarksPanel() {
  // Narrow selectors, not the pane: the viewer rewrites the pane's view on every scroll frame (see usePageState.ts).
  const paneId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.id);
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const doc = useDocumentsStore((s) => (docId ? s.docs[docId] : undefined));
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setOutline(null);
    setExpanded(new Set());
  }, [docId]);

  // A bookmark's target is a page index, and the indexes move with every edit (delete, move, reverse, insert). The
  // outline is read from the engine again after each change to the page list, so every target names the page's place
  // now. Nothing is cached across edits: a cached outline points at the pages as they were when it was read.
  const pages = doc?.pages;
  useEffect(() => {
    if (!docId) return;
    const handle = documentRegistry.get(docId);
    if (!handle) return;
    let alive = true;
    handle.doc.outline().then(
      (items) => {
        if (alive) setOutline(items);
      },
      () => {
        if (alive) setOutline([]);
      },
    );
    return () => {
      // A newer page list has started a newer read; this one must not overwrite it.
      alive = false;
    };
  }, [docId, pages]);

  // Mapped to page ids on every render, so the tree follows the page list.
  const nodes = useMemo<BookmarkNode[]>(
    () => (outline && doc ? outlineToNodes(outline, doc.pages) : []),
    [outline, doc],
  );
  const nodeByKey = useMemo(() => {
    const map = new Map<string, BookmarkNode>();
    const walk = (list: BookmarkNode[]) => {
      for (const node of list) {
        map.set(node.key, node);
        walk(node.children);
      }
    };
    walk(nodes);
    return map;
  }, [nodes]);

  if (!paneId || !docId || !doc) return <p className="panel-placeholder">Open a document to see its bookmarks.</p>;
  if (outline === null) return <p className="panel-placeholder">Loading bookmarks…</p>;
  if (nodes.length === 0) return <p className="panel-placeholder">This file has no bookmarks.</p>;

  const keys = visibleKeys(nodes, expanded);
  const current = focusKey && nodeByKey.has(focusKey) ? focusKey : keys[0] ?? null;

  const jump = (node: BookmarkNode) => {
    if (node.pageIndex >= 0) requestViewer(paneId, { kind: 'goto', index: node.pageIndex });
  };

  const focus = (key: string) => {
    setFocusKey(key);
    buttons.current.get(key)?.focus();
  };

  const toggle = (key: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!current) return;
    const node = nodeByKey.get(current);
    if (!node) return;
    const index = keys.indexOf(current);
    const hasChildren = node.children.length > 0;
    const isOpen = expanded.has(current);
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = keys[Math.min(index + 1, keys.length - 1)];
        if (next) focus(next);
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = keys[Math.max(index - 1, 0)];
        if (prev) focus(prev);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (hasChildren && isOpen) {
          toggle(current, false);
        } else {
          const cut = current.lastIndexOf('.');
          if (cut > 0) focus(current.slice(0, cut));
        }
        return;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (hasChildren && !isOpen) toggle(current, true);
        else if (hasChildren) {
          const first = node.children[0];
          if (first) focus(first.key);
        }
        return;
      }
      case 'Enter':
        event.preventDefault();
        jump(node);
        return;
    }
  };

  const renderNodes = (list: BookmarkNode[], depth: number): JSX.Element[] =>
    list.map((node) => {
      const hasChildren = node.children.length > 0;
      const open = expanded.has(node.key);
      return (
        <li key={node.key} role="none">
          <div
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={hasChildren ? open : undefined}
            aria-selected={node.key === current}
            className="bookmark-row"
            style={{ paddingLeft: depth * 14 }}
          >
            {hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                className="bookmark-toggle"
                aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`}
                onClick={() => toggle(node.key, !open)}
              >
                {open ? '▾' : '▸'}
              </button>
            ) : (
              <span className="bookmark-toggle" aria-hidden="true" />
            )}
            <button
              ref={(el) => {
                if (el) buttons.current.set(node.key, el);
                else buttons.current.delete(node.key);
              }}
              type="button"
              tabIndex={node.key === current ? 0 : -1}
              className="bookmark-title"
              disabled={node.pageIndex < 0}
              title={node.pageIndex < 0 ? 'Not a page in this file' : `Page ${node.pageIndex + 1}`}
              onFocus={() => setFocusKey(node.key)}
              onClick={() => {
                setFocusKey(node.key);
                jump(node);
              }}
            >
              {node.title}
            </button>
          </div>
          {hasChildren && open && <ul role="group" className="bookmark-group">{renderNodes(node.children, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <div role="tree" aria-label="Bookmarks" className="bookmark-tree" onKeyDown={onKeyDown}>
      <ul className="bookmark-list">{renderNodes(nodes, 0)}</ul>
    </div>
  );
}
