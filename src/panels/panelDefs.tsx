import type { PanelDef } from '../core/layout/panelRegistry';
import { BookmarksPanel } from './bookmarks/BookmarksPanel';
import { PropertiesPanel } from './properties/PropertiesPanel';
import { ThumbnailsPanel } from './thumbnails/ThumbnailsPanel';

const icon = (d: string) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** The left rail panels, in rail order: Thumbnails, Bookmarks, Properties. */
export const panelDefs: PanelDef[] = [
  {
    id: 'thumbnails',
    title: 'Thumbnails',
    icon: icon('M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z'),
    dock: 'left',
    component: ThumbnailsPanel,
  },
  {
    id: 'bookmarks',
    title: 'Bookmarks',
    icon: icon('M4 2h8v12l-4-3-4 3z'),
    dock: 'left',
    component: BookmarksPanel,
  },
  {
    id: 'properties',
    title: 'Properties',
    icon: icon('M2 4h12M2 8h12M2 12h8'),
    dock: 'left',
    component: PropertiesPanel,
  },
];
