/** Stable identifier for one file's content (SHA-256 hex). Shared by all tabs and panes. */
export type DocId = string;

/** One page in a document's page list. The UI refers to pages by `id` only. */
export interface PageRef {
  id: string;
  docId: DocId;
  /** Index of the page in the original PDF. */
  srcIndex: number;
  /**
   * The page's content identity, "uid@rev" (see engine/mupdf/protocol.ts). It changes with the page's content, so caches
   * keyed by it never show the old content of a page. Absent for an engine that does not edit pages.
   */
  content?: string;
  /** Extra rotation in degrees (0, 90, 180, 270) on top of the page's own rotation. */
  rotation: 0 | 90 | 180 | 270;
  /** Crop box in PDF points, or null for the full page. */
  crop: { x: number; y: number; width: number; height: number } | null;
}

export type FitMode = 'none' | 'width' | 'page';

/** View rotation in degrees, clockwise. Belongs to one pane, never to the document. */
export type ViewRotation = 0 | 90 | 180 | 270;

/**
 * Where a pane is looking. `offset` is the fraction (0..1) of `pageId` above the top edge.
 * `rotation` turns the pane's view only; the document's pages are not changed.
 */
export interface ViewState {
  pageId: string | null;
  zoom: number;
  fit: FitMode;
  offset: number;
  rotation: ViewRotation;
}

export interface Pane {
  id: string;
  docId: DocId;
  view: ViewState;
}

export type TabStatus =
  | { kind: 'loading'; progress: number }
  | { kind: 'ready' }
  | { kind: 'needsPassword' }
  | { kind: 'error'; message: string };

/**
 * Where a tab's file came from, for crash recovery. Path origins are stored as a path only.
 * Byte origins are restored from the IndexedDB file cache, keyed by the document id.
 */
export type TabOrigin = { kind: 'path'; path: string } | { kind: 'bytes' };

export type SplitOrientation = 'horizontal' | 'vertical';

/**
 * Split view settings for a tab with two panes. `horizontal` stacks the panes (the divider is
 * horizontal); `vertical` puts them side by side (the divider is vertical). `ratio` is the first
 * pane's share of the space.
 */
export interface SplitState {
  orientation: SplitOrientation;
  ratio: number;
  syncScroll: boolean;
}

export interface Tab {
  id: string;
  title: string;
  origin: TabOrigin;
  status: TabStatus;
  /** Panes in this tab. A tab with no document has an empty list. Two panes means split view. */
  panes: Pane[];
  /** Set while the tab has two panes. Null otherwise. */
  split: SplitState | null;
}
