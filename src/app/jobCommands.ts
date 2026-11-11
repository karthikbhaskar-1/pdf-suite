import { commands } from '../core/commands/registry';
import { documentRegistry } from './services';
import { MupdfDocument } from '../engine/mupdf/mupdfDocument';
import { activeDocId } from '../features/organizer/actions';
import { openSplitSheet, splitAvailability } from '../features/jobs/splitFlow';
import { combineAvailability, openCombine } from '../features/jobs/combineFlow';
import { EDIT_LOCKED_MESSAGE } from './organizerCommands';
import { VIEW_ONLY_REASON } from '../core/fileLimits';

/**
 * The commands of the batch jobs. Split into Files (1.3.2) works on the open document's saved file; Combine comes with 1.3.3.
 * No default shortcut, on purpose (V2 brings customizable shortcuts). `enabled` and `disabledReason` are plain store reads:
 * the menu bar runs them on every scroll frame.
 */
export function registerJobCommands(): void {
  // Combine works with no document open: it needs no document at all (UI spec section 0).
  commands.register({
    id: 'pages.combine',
    label: 'Pages: Combine files',
    enabled: () => combineAvailability().enabled,
    disabledReason: () => combineAvailability().reason,
    run: () => {
      openCombine();
    },
  });
  commands.register({
    id: 'pages.splitFiles',
    label: 'Pages: Split into files',
    enabled: () => splitAvailability(activeDocId()).enabled,
    disabledReason: () => {
      const docId = activeDocId();
      const availability = splitAvailability(docId);
      if (availability.reason) return availability.reason;
      const handle = docId ? documentRegistry.get(docId)?.doc : undefined;
      // A file over the edit limit says so; a form that can only be viewed uses the existing tooltip.
      if (handle && handle instanceof MupdfDocument && handle.capabilities.viewOnly) return VIEW_ONLY_REASON;
      if (handle && (!(handle instanceof MupdfDocument) || !handle.capabilities.canEdit)) return EDIT_LOCKED_MESSAGE;
      return undefined;
    },
    run: () => {
      openSplitSheet(activeDocId());
    },
  });
}
