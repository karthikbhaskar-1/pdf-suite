import { useMemo } from 'react';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import type { CutDraft } from '../../core/stores/sheetStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { pageIdFromUid, pageUidFromId } from '../../features/organizer/pageMath';
import {
  CUT_MEASURING_MESSAGE,
  CUT_NO_MATCH_MESSAGE,
  CUT_DEFAULT_PERCENT,
  CUT_PERCENT_MESSAGE,
  cutScopeUids,
  cutShare,
  parseCutPercent,
  type CutTargets,
} from '../../features/organizer/cutMath';

/** What the Cut sheet, its footer and the guide on the pages need to know, as it is right now. */
export interface CutState {
  /** The cut position as a share (0.3 to 0.7), or null when the typed text is not valid. */
  at: number | null;
  /** The position the slider, the preview and the guide show: `at`, or the last valid one while the typed text is not valid. */
  shownAt: number;
  /** The pages "Apply to" names, and whether page sizes were still missing. */
  targets: CutTargets;
  /** The reason Apply is off, or null when it can run. */
  problem: string | null;
}

/** The last valid cut position seen (a share), so an invalid typed text leaves the slider and the guide where they were. */
let lastValidAt = CUT_DEFAULT_PERCENT / 100;

/**
 * The live state of a Cut sheet. It reads the page list, the page sizes, the selection and the focused pane's current page
 * from the stores, so a change to any of them (a click on a thumbnail, a save that renumbers the pages, an edit) changes
 * the count, the guide and what Apply cuts together. Nothing here is kept from when the sheet opened.
 */
export function useCutState(sheet: CutDraft): CutState {
  const order = useEditStore((s) => s.byDoc[sheet.docId]?.uids);
  const sizes = useDocumentsStore((s) => s.docs[sheet.docId]?.sizes);
  const selectedIds = useSelectionStore((s) => s.pageIds);
  const currentId = useWorkspaceStore((s) => {
    const pane = selectPane(s, s.activePaneId);
    return pane && pane.docId === sheet.docId ? pane.view.pageId : null;
  });
  return useMemo(() => {
    const uids = order ?? [];
    const chosen = new Set(selectedIds);
    const selected = uids.filter((uid) => chosen.has(pageIdFromUid(sheet.docId, uid)));
    const current = currentId === null ? null : pageUidFromId(sheet.docId, currentId);
    const targets = cutScopeUids({ order: uids, sizes: sizes ?? [], selected, current }, sheet.scope, sheet.direction);
    const percent = parseCutPercent(sheet.percentText);
    // Wide (or tall) pages depend on page sizes: while some are not measured the list may be incomplete, so Apply stays off.
    const problem =
      percent === null ? CUT_PERCENT_MESSAGE : targets.unmeasured ? CUT_MEASURING_MESSAGE : targets.uids.length === 0 ? CUT_NO_MATCH_MESSAGE : null;
    if (percent !== null) lastValidAt = cutShare(percent);
    return { at: percent === null ? null : cutShare(percent), shownAt: lastValidAt, targets, problem };
  }, [order, sizes, selectedIds, currentId, sheet.docId, sheet.scope, sheet.direction, sheet.percentText]);
}
