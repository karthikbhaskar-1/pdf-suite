import { create } from 'zustand';

/** Where a viewer is scrolled, in CSS pixels of its sheet. Written by each viewer, read by the floating windows. */
export interface PaneGeometry {
  scrollLeft: number;
  scrollTop: number;
  viewWidth: number;
  viewHeight: number;
}

/** The page under the pointer, with the point in page points. Null when the pointer is not over a page. */
export interface PointerProbe {
  paneId: string;
  docId: string;
  pageId: string;
  srcIndex: number;
  /** Extra rotation the page is shown with (the page list rotation). */
  rotation: number;
  /** Viewer zoom, 1 = 100%. */
  zoom: number;
  /** Pointer position inside the page, in points, in the displayed orientation. */
  x: number;
  y: number;
}

interface ViewerStateStore {
  geometry: Record<string, PaneGeometry>;
  pointer: PointerProbe | null;
  setGeometry: (paneId: string, geometry: PaneGeometry) => void;
  clearGeometry: (paneId: string) => void;
  setPointer: (probe: PointerProbe | null) => void;
}

export const useViewerStateStore = create<ViewerStateStore>()((set) => ({
  geometry: {},
  pointer: null,
  setGeometry: (paneId, geometry) =>
    set((s) => {
      const current = s.geometry[paneId];
      if (
        current &&
        current.scrollLeft === geometry.scrollLeft &&
        current.scrollTop === geometry.scrollTop &&
        current.viewWidth === geometry.viewWidth &&
        current.viewHeight === geometry.viewHeight
      ) {
        return s;
      }
      return { geometry: { ...s.geometry, [paneId]: geometry } };
    }),
  clearGeometry: (paneId) =>
    set((s) => {
      const { [paneId]: _removed, ...rest } = s.geometry;
      return { geometry: rest };
    }),
  setPointer: (probe) => set({ pointer: probe }),
}));
