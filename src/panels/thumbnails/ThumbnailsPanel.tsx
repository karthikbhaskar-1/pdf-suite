import { engineIndexOf } from '../../engine/pageRef';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { buildLayout } from '../../features/viewer/layout';
import { Priority } from '../../engine/renderScheduler';
import { requestViewer } from '../../ui/viewer/viewerBus';
import { BitmapCanvas } from '../../ui/thumbnails/BitmapCanvas';
import { useThumbnail } from '../../ui/thumbnails/useThumbnail';
import { useFastScrolling } from '../../ui/viewer/scrollVelocity';
import { activeAfterDelete, applyListKey, applySelectionClick, revealScrollTop, selectAllIds } from './selection';
import { CommandButton } from '../../ui/topbar/CommandButton';
import { MenuCommand } from '../../ui/topbar/pageGroups';
import { pagesMenuItems } from '../../ui/menus/pageMenuItems';
import { FilePlusIcon, MoreIcon, RotateIcon, TrashIcon, ExtractIcon } from '../../ui/icons';
import { dropSlot, pageIdFromUid, pageUidFromId, reorderedUids, beforeUidFor } from '../../features/organizer/pageMath';
import { movePages, orderOf } from '../../features/organizer/actions';
import { isViewOnly } from '../../features/documents/viewOnly';
import { knobs } from '../../engine/testKnobs';

/** Thumbnail width in CSS pixels. */
export const THUMB_WIDTH_PX = 160;
const LABEL_PX = 20;
const GAP_PX = 10;
/** Rows drawn above and below the visible area. */
const OVERSCAN_PX = knobs.thumbOverscanPx;
/** The id of a row's element. It names the page by its uid, which has no spaces (a file path in a page id may). */
function rowDomId(uid: string | null, index: number): string {
  return `thumb-row-${uid ?? `i${index}`}`;
}

/** The active row, as the list remembers it: only valid for the document and the replacement it was set in. */
interface ActiveRow {
  docId: string;
  epoch: string;
  id: string;
}

/** Within this distance of the list's edge, a drag scrolls the list. */
const AUTO_SCROLL_EDGE_PX = 40;

/** First index whose bottom edge is below `y`. */
function firstAtOrBelow(tops: readonly number[], heights: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const top = tops[mid] ?? 0;
    const bottom = top + (heights[mid] ?? 0);
    if (bottom <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The pages being dragged. Kept here, because a drag event's data cannot be read until the drop. */
interface DragState {
  docId: string;
  uids: string[];
  badge: HTMLElement;
}

/**
 * Page thumbnails in a virtualized list, with the page organizer's row of actions above it. Click jumps; Ctrl and Shift
 * select several pages. Drag reorders the selection (an accent line shows where it lands, a badge shows how many pages
 * move, and the list scrolls near its edges). Right-click offers the organizer's items.
 */
export function ThumbnailsPanel() {
  // Narrow selectors, not the pane: the viewer rewrites the pane's view on every scroll frame (see usePageState.ts).
  const paneId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.id);
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const pageId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.view.pageId ?? null);
  const doc = useDocumentsStore((s) => (docId ? s.docs[docId] : undefined));
  const selected = useSelectionStore((s) => s.pageIds);
  const anchorId = useSelectionStore((s) => s.anchorId);
  const editing = useEditStore((s) => (docId ? s.progress[docId] !== undefined : false));
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const scrollSpeed = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  const [dropAt, setDropAt] = useState<{ slot: number; top: number } | null>(null);
  const [active, setActive] = useState<ActiveRow | null>(null);
  const [listFocused, setListFocused] = useState(false);
  // A held Up or Down moves the selection on every repeat, but the document view jumps once, when the key is released.
  // A click focuses the list too; the list must not scroll to the active row under the pointer then (the row would move
  // between the press and the release, and the click would land on another page).
  const pointerFocus = useRef(false);
  const buttonsDown = useRef(false);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      buttonsDown.current = true;
      void event;
    };
    const up = () => {
      buttonsDown.current = false;
      pointerFocus.current = false;
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
    };
  }, []);
  const pendingJump = useRef<{ paneId: string; index: number } | null>(null);
  const fast = useFastScrolling();
  const currentPageId = pageId;
  const order = useMemo(() => (doc ? doc.pages.map((p) => p.id) : []), [doc]);
  // A saved or reloaded document replaces the open one (the worker's generation is part of every page's content name), and
  // its page ids then name other pages: the active row is forgotten rather than followed.
  const epoch = doc?.pages[0]?.content?.split('@')[2] ?? '';

  const rows = useMemo(() => {
    if (!doc) return { tops: [] as number[], heights: [] as number[], total: 0 };
    const layout = buildLayout(doc.pages, doc.sizes);
    const tops: number[] = [];
    const heights: number[] = [];
    let y = 0;
    for (const box of layout.boxes) {
      const height = (THUMB_WIDTH_PX * box.height) / Math.max(1, box.width) + LABEL_PX + GAP_PX;
      tops.push(y);
      heights.push(height);
      y += height;
    }
    return { tops, heights, total: y };
  }, [doc]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setScroll({ top: el.scrollTop, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  // A drag that ends outside the list, or a document change during a drag, must still clean up.
  useEffect(() => () => stopDrag(), []);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const docId0 = doc?.docId ?? null;

  /** Scrolls the list by the smallest distance that shows row `index` whole with a gap, without animation. */
  const revealRow = (index: number): void => {
    const el = scroller.current;
    const { tops, heights, total } = rowsRef.current;
    if (!el || index < 0 || index >= tops.length) return;
    const next = revealScrollTop(el.scrollTop, el.clientHeight, tops[index] ?? 0, heights[index] ?? 0, GAP_PX, total);
    if (next !== el.scrollTop) el.scrollTop = next;
  };
  const revealRef = useRef(revealRow);
  revealRef.current = revealRow;

  // The list follows the current page, by any route: the page box, Ctrl+G, Previous and Next, a bookmark, a search match,
  // scrolling. It waits while the document scrolls fast (no thumbnails are drawn during a fling), does nothing during a
  // thumbnail drag, and scrolls at most once per frame. Scrolling the list by hand does not run this effect: the list stays
  // where the user left it until the current page next changes.
  useEffect(() => {
    if (docId0 === null || currentPageId === null || fast) return;
    const index = order.indexOf(currentPageId);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      // Not while a mouse button is down: a press in the list must not see its row move.
      if (drag.current || buttonsDown.current) return;
      revealRef.current(index);
    });
    return () => cancelAnimationFrame(frame);
    // A new page order alone does not move the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId0, currentPageId, fast, epoch]);

  // After pages are deleted the active row is the page now in the first deleted place, or the last page.
  const lastOrder = useRef<{ docId: string | null; epoch: string; ids: string[] }>({ docId: null, epoch: '', ids: [] });
  useLayoutEffect(() => {
    const before = lastOrder.current;
    lastOrder.current = { docId: docId0, epoch, ids: order };
    if (before.docId !== docId0 || before.epoch !== epoch || !active || active.docId !== docId0) return;
    if (order.length >= before.ids.length) return;
    const next = activeAfterDelete(before.ids, order);
    if (next !== null && next !== active.id) setActive({ ...active, id: next });
  }, [order, docId0, epoch, active]);

  // The active row scrolls into view when it moves (a key press, a click).
  const activeKey = active && active.docId === docId0 && active.epoch === epoch ? active.id : null;
  useEffect(() => {
    if (activeKey === null) return;
    const index = order.indexOf(activeKey);
    if (index >= 0) revealRef.current(index);
    // Only a move of the active row scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  if (!paneId || !docId || !doc) return <p className="panel-placeholder">Open a document to see its pages.</p>;

  const first = firstAtOrBelow(rows.tops, rows.heights, scroll.top - OVERSCAN_PX);
  const lastEdge = scroll.top + scroll.height + OVERSCAN_PX;
  const items: JSX.Element[] = [];
  const selectedSet = new Set(selected);
  const orderSet = new Set(order);
  const activeId = activeKey !== null && orderSet.has(activeKey) ? activeKey : null;
  // With no active row yet, the current page's row is the one the list shows as active.
  const shownActiveId = activeId ?? (currentPageId !== null && orderSet.has(currentPageId) ? currentPageId : null);
  const shownActiveIndex = shownActiveId === null ? -1 : order.indexOf(shownActiveId);
  const rowCount = rows.heights.length;
  const pageRows = Math.max(1, Math.floor(scroll.height / Math.max(1, rowCount > 0 ? rows.total / rowCount : 1)));

  const makeActive = (id: string) => setActive({ docId, epoch, id });

  /** Stops the auto-scroll loop and forgets the drag. */
  function stopDrag(): void {
    const current = drag.current;
    drag.current = null;
    scrollSpeed.current = 0;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    current?.badge.remove();
    setDropAt(null);
  }

  /** Scrolls the list while a drag is held within the edge zone. The speed is set by the pointer on each dragover. */
  function startAutoScroll(): void {
    if (scrollFrame.current !== null) return;
    const step = () => {
      const el = scroller.current;
      if (el && scrollSpeed.current !== 0) el.scrollTop += scrollSpeed.current;
      scrollFrame.current = requestAnimationFrame(step);
    };
    scrollFrame.current = requestAnimationFrame(step);
  }

  /** The drop slot (0..n) of a pointer at clientY, and the speed the list should scroll at. */
  function slotAt(clientY: number): { slot: number; top: number } {
    const el = scroller.current;
    const rect = el?.getBoundingClientRect();
    const offset = rect ? clientY - rect.top : 0;
    const y = offset + (el?.scrollTop ?? 0);
    const slot = dropSlot(rows.tops, rows.heights, y);
    const top = slot < rows.tops.length ? (rows.tops[slot] ?? 0) : rows.total;
    if (rect) {
      if (offset < AUTO_SCROLL_EDGE_PX) scrollSpeed.current = -(AUTO_SCROLL_EDGE_PX - offset) / 2;
      else if (rect.height - offset < AUTO_SCROLL_EDGE_PX) scrollSpeed.current = (AUTO_SCROLL_EDGE_PX - (rect.height - offset)) / 2;
      else scrollSpeed.current = 0;
    }
    return { slot, top };
  }

  const onDragStart = (event: DragEvent<HTMLDivElement>, pageId: string) => {
    // Dragging a page outside the selection drags that page alone, as in a file manager.
    if (!selectedSet.has(pageId)) useSelectionStore.getState().setSelection([pageId], pageId);
    const picked = new Set(useSelectionStore.getState().pageIds);
    const uids = orderOf(docId).filter((uid) => picked.has(pageIdFromUid(docId, uid)));
    if (uids.length === 0) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${uids.length} pages`);
    // The badge is the drag image: its count tells how many pages move. It is removed when the drag ends.
    const badge = document.createElement('div');
    badge.className = 'thumb-drag-badge';
    badge.textContent = String(uids.length);
    document.body.appendChild(badge);
    event.dataTransfer.setDragImage(badge, 14, 14);
    drag.current = { docId, uids, badge };
    startAutoScroll();
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropAt(slotAt(event.clientY));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    event.preventDefault();
    const { slot } = slotAt(event.clientY);
    stopDrag();
    const list = orderOf(current.docId);
    const beforeUid = beforeUidFor(list, new Set(current.uids), slot);
    // A drop that leaves the order as it was is no edit at all.
    if (reorderedUids(list, current.uids, beforeUid).join('\n') === list.join('\n')) return;
    void movePages(current.docId, current.uids, beforeUid);
  };

  const buildRow = (i: number): JSX.Element | null => {
    const ref = doc.pages[i];
    if (!ref) return null;
    const uid = pageUidFromId(docId, ref.id);
    return (
      <ThumbnailRow
        key={ref.id}
        index={i}
        top={rows.tops[i] ?? 0}
        height={rows.heights[i] ?? 0}
        domId={rowDomId(uid, i)}
        count={doc.pages.length}
        docId={doc.docId}
        srcIndex={engineIndexOf(ref)}
        content={ref.content}
        rotation={ref.rotation}
        pageId={ref.id}
        current={pageId === ref.id}
        selected={selectedSet.has(ref.id)}
        active={shownActiveId === ref.id}
        draggable={!editing && !isViewOnly(docId)}
        onDragStart={(event) => onDragStart(event, ref.id)}
        onDragEnd={stopDrag}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          makeActive(ref.id);
          if (!selectedSet.has(ref.id)) {
            useSelectionStore.getState().setSelection([ref.id], ref.id);
            useSelectionStore.getState().selectPage(doc.docId, ref.id);
          }
          useOverlayStore.getState().openMenu(event.clientX, event.clientY, pagesMenuItems('thumb'));
        }}
        onClick={(event: MouseEvent) => {
          makeActive(ref.id);
          const result = applySelectionClick(selected, order, anchorId, ref.id, {
            ctrl: event.ctrlKey || event.metaKey,
            shift: event.shiftKey,
          });
          useSelectionStore.getState().setSelection(result.pageIds, result.anchorId);
          // The clicked page is what Properties describes.
          useSelectionStore.getState().selectPage(doc.docId, ref.id);
          // A plain click also jumps. Modified clicks only select.
          if (!event.ctrlKey && !event.metaKey && !event.shiftKey) requestViewer(paneId, { kind: 'goto', index: i });
        }}
      />
    );
  };

  let lastDrawn = first - 1;
  for (let i = first; i < doc.pages.length; i++) {
    const top = rows.tops[i] ?? 0;
    if (top > lastEdge) break;
    const row = buildRow(i);
    if (row) items.push(row);
    lastDrawn = i;
  }
  // The active row stays in the page while it is active, even when it is scrolled out of range: aria-activedescendant
  // needs its element.
  if (shownActiveIndex >= 0 && (shownActiveIndex < first || shownActiveIndex > lastDrawn)) {
    const row = buildRow(shownActiveIndex);
    if (row) items.push(row);
  }

  /** The thumbnail list's keys (see selection.ts applyListKey). */
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const store = useSelectionStore.getState();
    const result = applyListKey(
      { order, selected: store.pageIds, anchorId: store.anchorId, activeId, currentId: currentPageId, pageRows },
      event.key === 'Spacebar' ? ' ' : event.key,
      { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey },
    );
    if (!result.handled || result.activeId === null) return;
    event.preventDefault();
    // While a page menu is open, a list key only closes it: the selection must stay the one the menu was opened for.
    if (useOverlayStore.getState().menu !== null) {
      event.stopPropagation();
      useOverlayStore.getState().closeMenu();
      return;
    }
    if (event.key === 'Escape') {
      // Esc acts on this one thing and stops here (the spec's "Esc closes one thing").
      event.stopPropagation();
      document.querySelector<HTMLElement>('.main')?.focus();
      return;
    }
    makeActive(result.activeId);
    if (result.selectionChanged) {
      store.setSelection(result.pageIds, result.anchorId);
      // The page the user moved to is what Properties describes, as after a click.
      store.selectPage(docId, result.activeId);
    }
    const index = order.indexOf(result.activeId);
    if (result.jump && index >= 0) {
      if (event.repeat) pendingJump.current = { paneId, index };
      else requestViewer(paneId, { kind: 'goto', index });
    }
    if (result.openMenu && index >= 0) {
      const el = document.getElementById(rowDomId(pageUidFromId(docId, result.activeId), index));
      const rect = (el ?? event.currentTarget).getBoundingClientRect();
      useOverlayStore.getState().openMenu(rect.left + 24, rect.top + 24, pagesMenuItems('thumb'), { keyboard: true });
    }
  };

  const onListKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    const pending = pendingJump.current;
    if (!pending || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'PageUp' && event.key !== 'PageDown')) return;
    pendingJump.current = null;
    requestViewer(pending.paneId, { kind: 'goto', index: pending.index });
  };

  return (
    <div
      className="thumb-panel"
      onKeyDown={(event) => {
        // Ctrl+A in the panel selects every page (not the text of the sheet). Handled here, so the window's shortcut does not run.
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          const all = selectAllIds(order);
          useSelectionStore.getState().setSelection(all.pageIds, all.anchorId);
        }
      }}
    >
      <div className="thumb-toolbar" role="toolbar" aria-label="Page actions">
        <CommandButton commandId="pages.insert" label="Insert a blank page" className="thumb-tool">
          <FilePlusIcon />
        </CommandButton>
        <CommandButton commandId="pages.delete" label="Delete pages" className="thumb-tool">
          <TrashIcon />
        </CommandButton>
        <CommandButton commandId="pages.rotateRight" label="Rotate right 90°" className="thumb-tool">
          <RotateIcon />
        </CommandButton>
        <CommandButton commandId="pages.extract" label="Extract pages to a new PDF" className="thumb-tool">
          <ExtractIcon />
        </CommandButton>
        <details className="tb-menu thumb-more">
          <summary className="tb-button thumb-tool" aria-label="More page actions" title="More page actions">
            <MoreIcon />
          </summary>
          <div className="tb-menu-list" role="menu">
            <MenuCommand commandId="pages.duplicate">Duplicate</MenuCommand>
            <MenuCommand commandId="pages.replace">Replace…</MenuCommand>
            <MenuCommand commandId="pages.crop">Crop…</MenuCommand>
            <MenuCommand commandId="pages.size">Page size…</MenuCommand>
            <MenuCommand commandId="pages.reverse">Reverse</MenuCommand>
          </div>
        </details>
      </div>
      <div
        ref={scroller}
        className="thumb-list"
        role="listbox"
        aria-label="Pages"
        aria-multiselectable="true"
        // One tab stop for the whole list: the active row is named by aria-activedescendant.
        tabIndex={0}
        aria-activedescendant={
          shownActiveIndex >= 0 && shownActiveId !== null ? rowDomId(pageUidFromId(docId, shownActiveId), shownActiveIndex) : undefined
        }
        data-focused={listFocused ? 'true' : undefined}
        onMouseDown={() => {
          pointerFocus.current = true;
        }}
        onMouseUp={() => {
          pointerFocus.current = false;
        }}
        onKeyDown={onListKeyDown}
        onKeyUp={onListKeyUp}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          setListFocused(true);
          if (pointerFocus.current) {
            pointerFocus.current = false;
            return;
          }
          // Focus by Tab: the active row is the last active one, or else the current page's. The selection does not change.
          if (activeId === null && shownActiveId !== null) makeActive(shownActiveId);
          if (shownActiveIndex >= 0) revealRow(shownActiveIndex);
        }}
        onBlur={(event) => {
          if (event.target !== event.currentTarget) return;
          setListFocused(false);
          pendingJump.current = null;
          pointerFocus.current = false;
        }}
        // The Menu key and Shift+F10 also send a context menu event to the list itself (a right click lands on a row).
        onContextMenu={(event) => event.preventDefault()}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={(event) => {
          // Leaving the list hides the drop line; a drop outside the list does nothing.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropAt(null);
        }}
      >
        <div className="thumb-sheet" style={{ height: rows.total }}>
          {dropAt && drag.current && <div className="thumb-drop-line" style={{ top: dropAt.top }} aria-hidden="true" />}
          {items}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  index: number;
  top: number;
  height: number;
  domId: string;
  count: number;
  docId: string;
  content?: string;
  srcIndex: number;
  rotation: number;
  pageId: string;
  current: boolean;
  selected: boolean;
  active: boolean;
  draggable: boolean;
  onClick: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

/** One thumbnail with its page number. The current page gets an accent border; thumbnails are never recolored. */
function ThumbnailRow({
  index,
  top,
  height,
  domId,
  count,
  docId,
  srcIndex,
  content,
  rotation,
  pageId,
  current,
  selected,
  active,
  draggable,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: RowProps) {
  const bitmap = useThumbnail({ docId, srcIndex, content, rotation, widthPx: THUMB_WIDTH_PX, priority: Priority.Thumbnail });
  const classes = ['thumb', current && 'thumb-current', selected && 'thumb-selected', active && 'thumb-active'].filter(Boolean).join(' ');
  const uid = pageUidFromId(docId, pageId);
  return (
    <div
      className={classes}
      id={domId}
      role="option"
      aria-label={current ? `Page ${index + 1}, current page` : `Page ${index + 1}`}
      aria-posinset={index + 1}
      aria-setsize={count}
      aria-selected={selected}
      aria-current={current ? 'page' : undefined}
      data-page-id={pageId}
      data-uid={uid ?? undefined}
      draggable={draggable}
      style={{ top, height, width: THUMB_WIDTH_PX + 16 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {bitmap ? (
        <BitmapCanvas bitmap={bitmap} label={`Thumbnail of page ${index + 1}`} className="thumb-image" />
      ) : (
        <div className="thumb-image thumb-blank" />
      )}
      <span className="thumb-label">{index + 1}</span>
    </div>
  );
}
