import { engineIndexOf } from '../../engine/pageRef';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useViewerStateStore, type PointerProbe } from '../../core/stores/viewerStateStore';
import { useOverlayStore } from '../../core/stores/overlayStore';
import type { FitMode, ViewState } from '../../core/model/types';
import { Priority } from '../../engine/renderScheduler';
import {
  anchorAt,
  currentAnchor,
  topPointAt,
  buildLayout,
  clampZoom,
  fitZoom,
  indexAtPoint,
  keepJump,
  onScrollViewport,
  pageLeftPx,
  scrollForAnchor,
  SHEET_MARGIN_PX,
  stepZoom,
  visibleRange,
  type Layout,
} from '../../features/viewer/layout';
import { scrollForPageFraction } from '../../features/overview/overviewMath';
import { effectiveRotation, rotateRect, swapsAxes } from '../../features/viewer/rotation';
import { clampPagePosition } from '../../features/split/syncMath';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useCompareStore } from '../../core/stores/compareStore';
import { overlayViewFor, type OverlayView } from '../../features/compare/compareMath';
import { buildPageMenu } from '../menus/menus';
import { knobs } from '../../engine/testKnobs';
import { DragHold } from './dragHold';
import { flushViewerRequest, registerViewer, remapPageId, requestViewer, type ViewerRequest } from './viewerBus';

/** Pages rendered above and below the viewport. */
const OVERSCAN = knobs.overscan;
const WHEEL_ZOOM_STEP = 1.1;
/** Where a search match or a page reveal lands: this share of the viewer height from the top. */
const REVEAL_SHARE = 1 / 3;

/** The other pane of a split tab, when sync-scroll is on. Scrolling either pane moves it. */
function syncPeerId(paneId: string): string | null {
  const tab = useWorkspaceStore.getState().tabs.find((t) => t.panes.some((p) => p.id === paneId));
  if (!tab?.split?.syncScroll || tab.panes.length < 2) return null;
  return tab.panes.find((p) => p.id !== paneId)?.id ?? null;
}

/** Page-relative position of the viewport top: the page index plus the fraction of that page above the top edge. */
function positionAt(layout: Layout, scrollTop: number, zoom: number): number {
  const a = anchorAt(layout, topPointAt(scrollTop, zoom));
  return a.index + a.fraction;
}

/** Where the viewport top sits. `screenY` is the pixel offset of the anchor from the top edge. */
interface Anchor {
  pageId: string | null;
  fraction: number;
  screenY: number;
}

export function useViewerController(paneId: string) {
  const pane = useWorkspaceStore((s) => selectPane(s, paneId));
  const docId = pane?.docId;
  const doc = useDocumentsStore((s) => (docId ? s.docs[docId] : undefined));
  // Compare view (1.3.4): the session of this pane's document, or null. One store read per render of the viewer.
  const compare = useCompareStore((s) => (docId !== undefined && s.session?.docId === docId ? s.session : null));
  const zoom = pane?.view.zoom ?? 1;
  const fit = pane?.view.fit ?? 'none';

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const anchorRef = useRef<Anchor>({ pageId: pane?.view.pageId ?? null, fraction: pane?.view.offset ?? 0, screenY: 0 });
  /** Last page-relative position reported to sync. Its change is what sync sends to the other pane. */
  const positionRef = useRef<number | null>(null);
  /**
   * Records a move this viewer made itself (a nudge from the other pane, or a layout restore), so the
   * next scroll frame does not send it back. Movement the user made that has not been reported yet stays
   * pending, so the next frame still sends it to the other pane.
   */
  const settleOwnMove = (before: number, after: number): void => {
    const previous = positionRef.current;
    positionRef.current = previous === null ? after : after - (before - previous);
  };

  // The pane's own view rotation turns the layout. Document pages are untouched.
  const viewRotation = pane?.view.rotation ?? 0;
  const layout = useMemo<Layout | null>(
    () => (doc ? buildLayout(doc.pages, doc.sizes, viewRotation) : null),
    [doc, viewRotation],
  );

  // Latest values for handlers that run outside React's render cycle.
  const latest = useRef({ layout, zoom, viewport });
  useLayoutEffect(() => {
    latest.current = { layout, zoom, viewport };
  });

  const setView = useCallback(
    (patch: Partial<ViewState>) => useWorkspaceStore.getState().setView(paneId, patch),
    [paneId],
  );

  // Scroll geometry for the floating windows (pan-and-zoom reads it).
  const publishGeometry = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    useViewerStateStore.getState().setGeometry(paneId, {
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      viewWidth: el.clientWidth,
      viewHeight: el.clientHeight,
    });
  }, [paneId]);

  // Track the scroller size.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
      publishGeometry();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      useViewerStateStore.getState().clearGeometry(paneId);
    };
  }, [paneId, publishGeometry]);

  // Last pointer position over this viewer, in client coordinates. Used to refresh the loupe on scroll.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const pointerFrame = useRef(0);

  // Scrollbar drag hold: while the thumb moves, pages are not requested (see dragHold.ts).
  const dragHold = useRef(new DragHold());
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [held, setHeld] = useState(false);
  const updateHold = useRef((): void => undefined);
  updateHold.current = (): void => {
    clearTimeout(holdTimer.current);
    const now = performance.now();
    const isHeld = dragHold.current.isHeld(now);
    setHeld(isHeld);
    const lifts = dragHold.current.liftsAt();
    if (isHeld && lifts !== null) holdTimer.current = setTimeout(() => updateHold.current(), Math.max(0, lifts - now));
  };
  // A release anywhere ends the drag, even when the pointer has left the viewer.
  useEffect(() => {
    const end = () => {
      dragHold.current.end();
      updateHold.current();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      clearTimeout(holdTimer.current);
    };
  }, []);

  // Scroll events update the anchor, the saved view and the split peer, at most once per frame.
  const frame = useRef(0);
  const jumpRef = useRef<{ index: number; scrollTop: number } | null>(null);
  /** The page the user is on (see currentAnchor): the jump target while the viewer is where the jump left it, else the end rule. */
  const viewedAnchor = useCallback((el: HTMLElement, current: Layout, z: number) => {
    const jump = jumpRef.current;
    const stillThere = jump !== null && Math.abs(el.scrollTop - jump.scrollTop) <= 1;
    if (!stillThere) jumpRef.current = null;
    return currentAnchor(current, topPointAt(el.scrollTop, z), {
      atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
      jumpIndex: stillThere ? jump.index : null,
    });
  }, []);
  const onScroll = useCallback(() => {
    dragHold.current.moved(performance.now());
    updateHold.current();
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollerRef.current;
      const { layout: current, zoom: z } = latest.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      publishGeometry();
      refreshProbe();
      if (!current) return;
      // The pane was resized and has not re-anchored yet: this scroll is the browser's clamp, not the user (see viewportSettled).
      // The measured size is adopted at once, so the pane re-anchors and settles even when no resize event comes.
      const sized = onScrollViewport({ width: el.clientWidth, height: el.clientHeight }, latest.current.viewport);
      if (sized.adopt) setViewport(sized.adopt);
      if (!sized.handle) return;
      const raw = anchorAt(current, topPointAt(el.scrollTop, z));
      // The page the user is on: after a jump, the page jumped to; at the very end, the last page (see currentAnchor).
      const a = viewedAnchor(el, current, z);
      const box = current.boxes[a.index];
      if (!box) return;
      anchorRef.current = { pageId: box.pageId, fraction: a.fraction, screenY: 0 };
      const view = selectPane(useWorkspaceStore.getState(), paneId)?.view;
      if (view?.pageId !== box.pageId || Math.abs((view?.offset ?? 0) - a.fraction) > 0.001) {
        setView({ pageId: box.pageId, offset: a.fraction });
      }
      // Sync: this pane moved by `delta` pages, so the other pane moves by the same amount. Whichever pane
      // the user scrolls counts, and the amount is page-relative, so zoom and rotation do not matter.
      // The split peer follows the real position of the viewport, not the page the user is on.
      const position = raw.index + raw.fraction;
      const previous = positionRef.current;
      positionRef.current = position;
      const peer = syncPeerId(paneId);
      if (peer && previous !== null && Math.abs(position - previous) > 1e-6) {
        requestViewer(peer, { kind: 'nudge', delta: position - previous });
      }
    });
  }, [paneId, setView, publishGeometry]);

  /** The page and point under a client position, or null when the pointer is in a gap or outside the pages. */
  const probeAt = (clientX: number, clientY: number): PointerProbe | null => {
    const el = scrollerRef.current;
    const { layout: current, zoom: z, viewport: vp } = latest.current;
    if (!el || !current || !doc) return null;
    const rect = el.getBoundingClientRect();
    const sheetX = clientX - rect.left + el.scrollLeft;
    const sheetY = clientY - rect.top + el.scrollTop;
    const pointY = sheetY / z;
    const index = indexAtPoint(current, pointY);
    const box = current.boxes[index];
    const ref = doc.pages[index];
    if (!box || !ref) return null;
    const sheetWidth = Math.max(vp.width, current.width * z + SHEET_MARGIN_PX * 2);
    const x = (sheetX - pageLeftPx(sheetWidth, box.width * z)) / z;
    const y = pointY - box.top;
    if (x < 0 || x > box.width || y < 0 || y > box.height) return null;
    return {
      paneId,
      docId: doc.docId,
      pageId: box.pageId,
      srcIndex: engineIndexOf(ref),
      rotation: effectiveRotation(ref.rotation, viewRotation),
      zoom: z,
      x,
      y,
    };
  };
  const probeRef = useRef(probeAt);
  probeRef.current = probeAt;

  /** Recomputes the loupe probe for the last pointer position (after a scroll, the page under it changes). */
  function refreshProbe(): void {
    const p = lastPointer.current;
    if (!p) return;
    const probe = probeRef.current(p.x, p.y);
    const store = useViewerStateStore.getState();
    if (probe || store.pointer?.paneId === paneId) store.setPointer(probe);
  }

  // Keep the anchor on screen when the layout, zoom or viewport changes (including measured page sizes).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !layout) return;
    const a = anchorRef.current;
    const index = a.pageId ? layout.boxes.findIndex((b) => b.pageId === a.pageId) : -1;
    if (index < 0) return;
    const target = scrollForAnchor(layout, index, a.fraction, zoom, a.screenY);
    if (Math.abs(el.scrollTop - target) > 0.5) el.scrollTop = target;
    // The viewer moved itself to keep its anchor (the panes changed size, or the zoom did): the page the user jumped to stays
    // the current page, and the split peer is not told that this pane moved. Both are read from where the viewer is now (a
    // page the viewer cannot scroll to the top, the last pages, sits lower than the anchor says).
    jumpRef.current = keepJump(jumpRef.current, index, el.scrollTop);
    const placed = anchorAt(layout, topPointAt(el.scrollTop, zoom));
    positionRef.current = placed.index + placed.fraction;
    setScrollTop(el.scrollTop);
  }, [layout, zoom, viewport.width, viewport.height]);

  // Fit modes recompute the zoom when the viewport or the page sizes change.
  useEffect(() => {
    const el = scrollerRef.current;
    const { layout: current, viewport: vp } = latest.current;
    if (!el || !current || fit === 'none' || vp.width === 0) return;
    // Fit page fits the page the user is on (the last page when the viewer is at the end), not the one at the top edge.
    const top = viewedAnchor(el, current, latest.current.zoom);
    const box = current.boxes[top.index];
    const target =
      fit === 'width'
        ? fitZoom('width', { width: current.width, height: 1 }, vp.width, vp.height)
        : fitZoom('page', { width: box?.width ?? current.width, height: box?.height ?? 1 }, vp.width, vp.height);
    if (Math.abs(target - latest.current.zoom) > 0.001) setView({ zoom: target });
  }, [layout, fit, viewport.width, viewport.height, setView, viewedAnchor]);

  /** Changes zoom around a screen point, keeping that point's place on screen. */
  const applyZoom = useCallback(
    (next: number, screenY: number, nextFit: FitMode = 'none') => {
      const el = scrollerRef.current;
      const { layout: current, zoom: now } = latest.current;
      if (!el || !current) return;
      const target = clampZoom(next);
      if (Math.abs(target - now) < 1e-4 && nextFit === fit) return;
      const a = anchorAt(current, (el.scrollTop + screenY) / now);
      const box = current.boxes[a.index];
      const lastBox = current.boxes[current.boxes.length - 1];
      if (lastBox && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        // Scrolled to the very end: stay at the end (the bottom of the last page at the bottom edge), so the page the user is
        // on stays the last one after the zoom.
        anchorRef.current = { pageId: lastBox.pageId, fraction: 1, screenY: el.clientHeight };
      } else if (box) anchorRef.current = { pageId: box.pageId, fraction: a.fraction, screenY };
      setView({ zoom: target, fit: nextFit });
    },
    [fit, setView],
  );

  // Ctrl+wheel zooms around the cursor. Must be non-passive to cancel the browser's own zoom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      applyZoom(latest.current.zoom * factor, event.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  // Requests from commands (keyboard, top bar).
  const handleRequest = useRef<(request: ViewerRequest) => void>(() => undefined);
  handleRequest.current = (request) => {
    const el = scrollerRef.current;
    const { layout: current, zoom: z, viewport: vp } = latest.current;
    if (!el) return;
    switch (request.kind) {
      case 'goto': {
        if (!current) return;
        const index = Math.min(Math.max(request.index, 0), current.boxes.length - 1);
        const box = current.boxes[index];
        if (!box) return;
        anchorRef.current = { pageId: box.pageId, fraction: 0, screenY: 0 };
        el.scrollTop = scrollForAnchor(current, index, 0, z, 0);
        // Where the jump left the viewer: while it stays there, the current page is the one jumped to, even when the
        // viewer could not scroll that page up to the top (the last pages).
        jumpRef.current = { index, scrollTop: el.scrollTop };
        setScrollTop(el.scrollTop);
        setView({ pageId: box.pageId, offset: 0 });
        return;
      }
      case 'scrollScreen':
        el.scrollBy({ top: request.direction * el.clientHeight * 0.9 });
        return;
      case 'zoomStep':
        applyZoom(stepZoom(z, request.direction), vp.height / 2);
        return;
      case 'setZoom':
        applyZoom(request.zoom, vp.height / 2);
        return;
      case 'fit': {
        if (!current) return;
        const box = current.boxes[viewedAnchor(el, current, z).index];
        const next =
          request.mode === 'width'
            ? fitZoom('width', { width: current.width, height: 1 }, vp.width, vp.height)
            : fitZoom('page', { width: box?.width ?? current.width, height: box?.height ?? 1 }, vp.width, vp.height);
        applyZoom(next, 0, request.mode);
        return;
      }
      case 'reveal': {
        if (!current) return;
        const index = Math.min(Math.max(request.index, 0), current.boxes.length - 1);
        const box = current.boxes[index];
        if (!box) return;
        // The rectangle is in unrotated page points. Map it through this pane's view rotation, as the highlight layer does.
        const turned = swapsAxes(viewRotation);
        const at = rotateRect(
          request.rect,
          turned ? box.height : box.width,
          turned ? box.width : box.height,
          viewRotation,
        );
        const fraction = box.height > 0 ? Math.min(1, Math.max(0, at.y / box.height)) : 0;
        const screenY = vp.height * REVEAL_SHARE;
        anchorRef.current = { pageId: box.pageId, fraction, screenY };
        el.scrollTop = scrollForAnchor(current, index, fraction, z, screenY);
        setScrollTop(el.scrollTop);
        setView({ pageId: box.pageId, offset: fraction });
        // Horizontal: scroll only when the rectangle is not wholly inside the viewer's width.
        const sheetWidth = Math.max(vp.width, current.width * z + SHEET_MARGIN_PX * 2);
        const left = pageLeftPx(sheetWidth, box.width * z) + at.x * z;
        const right = left + at.width * z;
        const visibleLeft = el.scrollLeft + SHEET_MARGIN_PX;
        const visibleRight = el.scrollLeft + el.clientWidth - SHEET_MARGIN_PX;
        if (left < visibleLeft || right > visibleRight) {
          const fits = right - left <= visibleRight - visibleLeft;
          el.scrollLeft = Math.max(0, fits ? (left + right) / 2 - el.clientWidth / 2 : left - SHEET_MARGIN_PX);
        }
        return;
      }
      case 'nudge': {
        if (!current) return;
        const count = current.boxes.length;
        const before = positionAt(current, el.scrollTop, z);
        const target = clampPagePosition(before + request.delta, count);
        const index = Math.min(Math.floor(target), count - 1);
        const fraction = Math.min(1, Math.max(0, target - index));
        el.scrollTop = scrollForAnchor(current, index, fraction, z, 0);
        setScrollTop(el.scrollTop);
        // Record where the viewer actually landed (the browser may stop short at the end of the document).
        const landed = anchorAt(current, topPointAt(el.scrollTop, z));
        const landedBox = current.boxes[landed.index];
        if (landedBox) anchorRef.current = { pageId: landedBox.pageId, fraction: landed.fraction, screenY: 0 };
        // This move came from the other pane, so it is not sent back.
        settleOwnMove(before, positionAt(current, el.scrollTop, z));
        return;
      }
      case 'remapPages': {
        // The page the viewer keeps in view moves with its page by position, so the layout rebuilt for the new
        // document does not scroll back to the page that used to have this id.
        const held = anchorRef.current;
        const next = remapPageId(held.pageId, request.from, request.to);
        if (next !== undefined) anchorRef.current = { ...held, pageId: next };
        return;
      }
      case 'scrollTo': {
        if (!current) return;
        const box = current.boxes[request.index];
        if (!box) return;
        const pageWidth = box.width * z;
        const sheetWidth = Math.max(vp.width, current.width * z + SHEET_MARGIN_PX * 2);
        const target = scrollForPageFraction(
          { left: pageLeftPx(sheetWidth, pageWidth), top: box.top * z, width: pageWidth, height: box.height * z },
          { x: request.fx, y: request.fy },
          pageWidth <= vp.width,
        );
        if (target.scrollLeft !== null) el.scrollLeft = target.scrollLeft;
        el.scrollTop = target.scrollTop;
        return;
      }
    }
  };
  // A request is taken only once the viewer is laid out and mounted. Until then the bus keeps it queued.
  const isReady = () => latest.current.layout !== null && scrollerRef.current !== null;
  useEffect(
    () =>
      registerViewer(paneId, (request) => {
        // A sync nudge is relative to the viewer's place when it arrives, so it is dropped rather than kept.
        if (!isReady()) return request.kind === 'nudge' || request.kind === 'remapPages';
        handleRequest.current(request);
        return true;
      }),
    [paneId],
  );
  // Layout arrives after the first render, so a request queued before that is delivered here.
  useEffect(() => {
    if (layout) flushViewerRequest(paneId);
  }, [paneId, layout]);

  if (!pane || !doc || !layout) return null;

  const hasViewport = viewport.height > 0;
  const onScreen = hasViewport ? visibleRange(layout, scrollTop, viewport.height, zoom, 0) : { first: -1, last: -2 };
  const range = hasViewport ? visibleRange(layout, scrollTop, viewport.height, zoom, OVERSCAN) : { first: 0, last: -1 };
  const sheetWidth = Math.max(viewport.width, layout.width * zoom + SHEET_MARGIN_PX * 2);

  const slots: PageSlot[] = [];
  for (let i = range.first; i <= range.last; i++) {
    const box = layout.boxes[i];
    const ref = doc.pages[i];
    if (!box || !ref) continue;
    const inView = i >= onScreen.first && i <= onScreen.last;
    const width = box.width * zoom;
    slots.push({
      key: box.pageId,
      paneId,
      docId: doc.docId,
      pageId: box.pageId,
      index: i,
      srcIndex: engineIndexOf(ref),
      content: ref.content,
      rotation: effectiveRotation(ref.rotation, viewRotation),
      left: Math.max(SHEET_MARGIN_PX, (sheetWidth - width) / 2),
      top: box.top * zoom,
      width,
      height: box.height * zoom,
      zoom,
      priority: inView ? Priority.Visible : Priority.Prefetch,
      inView,
      textEnabled: inView,
      paused: held,
      overlay: overlayViewFor(compare, i),
    });
  }

  const scrollerProps: ViewerScrollerProps = {
    paneId,
    scrollerRef,
    onScroll,
    onPointerDown: (event) => {
      // A press on the scrollbar gutter (right or bottom edge) starts a drag of the thumb.
      const el = event.currentTarget;
      const rect = el.getBoundingClientRect();
      const onBar = event.clientX - rect.left >= el.clientWidth || event.clientY - rect.top >= el.clientHeight;
      if (!onBar) return;
      dragHold.current.begin(performance.now());
      updateHold.current();
    },
    onPointerMove: (event) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
      if (pointerFrame.current) return;
      pointerFrame.current = requestAnimationFrame(() => {
        pointerFrame.current = 0;
        const p = lastPointer.current;
        if (p) useViewerStateStore.getState().setPointer(probeRef.current(p.x, p.y));
      });
    },
    onPointerLeave: () => {
      lastPointer.current = null;
      if (useViewerStateStore.getState().pointer?.paneId === paneId) useViewerStateStore.getState().setPointer(null);
    },
    onClick: (event) => {
      // A click on a page selects it, so the Properties panel describes that page. A click on the empty space
      // around the pages clears that selection.
      const page = (event.target as Element).closest?.('.page');
      const ref = doc.pages[Number(page?.getAttribute('data-page-index'))];
      if (page && ref) useSelectionStore.getState().selectPage(doc.docId, ref.id);
      else useSelectionStore.setState({ selection: null });
    },
    onContextMenu: (event) => {
      const page = (event.target as Element).closest?.('.page');
      const index = Number(page?.getAttribute('data-page-index'));
      if (!page || Number.isNaN(index)) return;
      event.preventDefault();
      useOverlayStore.getState().openMenu(event.clientX, event.clientY, buildPageMenu(paneId, index));
    },
  };

  return { paneId, sheetWidth, sheetHeight: layout.height * zoom, slots, scrollerProps };
}

/** One page of the viewer, with the props its PageView needs. */
export interface PageSlot {
  /** The page's "uid@rev" (see PageRef.content). */
  content?: string;
  key: string;
  paneId: string;
  docId: string;
  pageId: string;
  index: number;
  srcIndex: number;
  rotation: number;
  left: number;
  top: number;
  width: number;
  height: number;
  zoom: number;
  priority: Priority;
  /** True when the page intersects the viewport (no overscan): only such a page gets a large full-resolution bitmap. */
  inView: boolean;
  textEnabled: boolean;
  paused: boolean;
  /** Compare view (1.3.4): the overlay laid over this page, or undefined for the plain page. */
  overlay?: OverlayView;
}

/** The scroll container's ref and event handlers, as the view attaches them. */
export interface ViewerScrollerProps {
  paneId: string;
  scrollerRef: RefObject<HTMLDivElement>;
  onScroll: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

/** What the view renders: the sheet's size, its pages and the scroller's handlers. */
export type ViewerModel = NonNullable<ReturnType<typeof useViewerController>>;
