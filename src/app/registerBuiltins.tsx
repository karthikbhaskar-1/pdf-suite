import { panels } from '../core/layout/panelRegistry';
import { topBar } from '../core/layout/topBarRegistry';
import { panelDefs } from '../panels/panelDefs';
import { pageLayers } from '../ui/viewer/pageLayers';
import { fileItems, navItems, searchItems, themeItems } from '../ui/topbar/groups';
import { viewItems } from '../ui/topbar/viewGroups';
import { pagesItems } from '../ui/topbar/pageGroups';
import { CropOverlay } from '../ui/organizer/CropOverlay';
import { CutGuide } from '../ui/organizer/CutGuide';
import { SearchHighlights } from '../features/search/SearchHighlights';
import { HtmlPageLayer } from '../ui/viewer/HtmlPageLayer';
import { registerBuiltinCommands } from './builtinCommands';
import { registerFeatureCommands } from './featureCommands';
import { registerOrganizerCommands } from './organizerCommands';
import { registerMenuCommands } from './menuCommands';
import { registerJobCommands } from './jobCommands';

/** Registers commands, top bar groups, panels and page overlays. Called once from bootApp. */
export function registerBuiltins(): void {
  registerBuiltinCommands();
  registerFeatureCommands();
  registerOrganizerCommands();
  registerJobCommands();
  registerMenuCommands();

  // The groups of the top bar, left to right. The Zoom group is not here: the zoom controls are in the status bar (1.2.2).
  topBar.register({ id: 'file', order: 10, label: 'File', items: fileItems });
  topBar.register({ id: 'nav', order: 20, label: 'Navigation', items: navItems });
  topBar.register({ id: 'view', order: 40, label: 'View', items: viewItems });
  // The page organizer's group sits after View (1.2.1 spec).
  topBar.register({ id: 'pages', order: 45, label: 'Pages', items: pagesItems });
  topBar.register({ id: 'search', order: 50, label: 'Find', items: searchItems });
  topBar.register({ id: 'theme', order: 60, label: 'Theme', items: themeItems });

  for (const def of panelDefs) panels.register(def);

  // Search highlights sit above the page image and below annotations (order 10).
  pageLayers.register({ id: 'search', order: 10, component: SearchHighlights });
  // The XFA HTML layer sits above the canvas and below the search highlights.
  pageLayers.register({ id: 'html', order: 5, component: HtmlPageLayer });
  // The crop box of the Crop sheet sits on top of the page (order 20).
  pageLayers.register({ id: 'organizer-crop', order: 20, component: CropOverlay });
  // The guide of the Cut Pages in Half sheet (the cut line and the numbers 1 and 2) sits on the same level.
  pageLayers.register({ id: 'organizer-cut', order: 21, component: CutGuide });
}
