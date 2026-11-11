import { useEffect } from 'react';
import { useCompareStore } from '../../core/stores/compareStore';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useUiStore } from '../../core/stores/uiStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { comparingWith } from '../../features/compare/compareMath';
import { leaveCompare, showSettings } from '../../features/compare/compareSession';
import { useSearchStore } from '../../features/search/searchStore';

/**
 * The info bar of Overlay to Compare (1.3.4), under the tabs while the focused document is being compared: "Comparing with
 * «name». The overlay is only on screen." [Show settings] [Leave compare]. The bar stays with its document: changing tabs does
 * not leave the compare (UI spec), and the other document shows no bar. It also carries the Esc key for a hidden sheet.
 */

/** Esc leaves the compare while its sheet is hidden ([»]). With the sheet open, the sheet's own Esc does it (see SideSheet). */
function useEscLeavesCompare(docId: string | undefined, comparing: boolean): void {
  const menuOpen = useOverlayStore((s) => s.menu !== null || s.paletteOpen);
  const prompt = useUiStore((s) => s.closePrompt || s.sourcePassword !== null);
  useEffect(() => {
    if (!docId || !comparing || menuOpen || prompt) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Another sheet, or the search bar, has its own Esc.
      if (useSheetStore.getState().sheet !== null || useSearchStore.getState().open) return;
      event.preventDefault();
      leaveCompare(docId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docId, comparing, menuOpen, prompt]);
}

export function CompareBar() {
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const compare = useCompareStore((s) => (docId !== undefined && s.session?.docId === docId ? s.session : null));
  useEscLeavesCompare(docId, compare !== null);
  if (!docId || !compare) return null;
  return (
    <div className="doc-bars">
      <div className="info-bar doc-bar" role="status" data-compare-bar="true">
        <span>{compare.file ? comparingWith(compare.file.name) : 'No PDF chosen yet. Choose a PDF to compare with this document.'}</span>
        <button type="button" className="bar-button" onClick={() => showSettings(docId)}>
          Show settings
        </button>
        <button type="button" className="bar-button" onClick={() => leaveCompare(docId)}>
          Leave compare
        </button>
      </div>
    </div>
  );
}
