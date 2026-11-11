import { pageIdForUid } from '../../core/model/pageList';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useSheetStore, type SheetDraft } from '../../core/stores/sheetStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { requestViewer } from '../../ui/viewer/viewerBus';

/**
 * When a saved (or reloaded) document replaces the open one, its worker is new and its page uids start again at 0. A
 * selection or a current page that still names the old uids would then name other pages (after "duplicate page 1" the
 * old uid 2 is the third page, the new uid 2 is the second). Everything that names a page by uid is therefore moved over
 * by POSITION: the page at index i of the old list becomes the page at index i of the new one. This is the one helper
 * every path that replaces a document with fresh uids uses (plain Save, Save As, Reload from disk, Discard).
 */

/** The uids of a document's pages as they are now. Call it before the document is replaced. */
export function currentOrder(docId: string): string[] {
  return [...(useEditStore.getState().byDoc[docId]?.uids ?? [])];
}

/**
 * The selected uids on the new list. Positions are only valid when the new list has the same pages in the same order
 * (`samePages`: a save writes exactly what was on screen) and as many of them. Otherwise nothing stays selected.
 */
export function remapSelectedUids(oldUids: readonly string[], newUids: readonly string[], selected: readonly string[], samePages: boolean): string[] {
  if (!samePages || oldUids.length !== newUids.length) return [];
  const out: string[] = [];
  for (const uid of selected) {
    const at = oldUids.indexOf(uid);
    if (at >= 0) out.push(newUids[at]!);
  }
  return out;
}

/** The uid on the new list that takes the place of `uid`: the same position, clamped to the last page. Null with no pages. */
export function remapCurrentUid(oldUids: readonly string[], newUids: readonly string[], uid: string): string | null {
  if (newUids.length === 0) return null;
  const at = Math.max(0, oldUids.indexOf(uid));
  return newUids[Math.min(at, newUids.length - 1)] ?? null;
}

/**
 * The open side sheet's draft of `docId` on the new page list, or null when it cannot follow: the pages are not the same
 * ones (a reload), or one of the pages it names is not on the new list. The Rotate, Crop, Page size, Replace and "Delete
 * pages?" sheets store the uids (or a page id) of the pages they act on when they open, so they follow the pages by position
 * like the selection does. The From and Replace sheets also forget the PDF they were filled from (it was attached to the replaced worker).
 * The other sheets name no page by uid (Insert uses a position, Cut reads the live state).
 */
export function remapSheetDraft(sheet: SheetDraft, oldUids: readonly string[], newUids: readonly string[], samePages: boolean): SheetDraft | null {
  const docId = sheet.docId;
  const prefix = `${docId}:`;
  const noSource = { sourceDocId: null, sourceName: null, sourcePages: 0 };
  const mapAll = (uids: readonly string[]): string[] | null => {
    const mapped = remapSelectedUids(oldUids, newUids, uids, samePages);
    return mapped.length === uids.length ? mapped : null;
  };
  switch (sheet.kind) {
    case 'rotate':
    case 'size':
    case 'confirmDelete': {
      const uids = mapAll(sheet.uids);
      return uids === null ? null : { ...sheet, uids };
    }
    case 'replace': {
      const uids = mapAll([sheet.uid]);
      return uids === null ? null : { ...sheet, ...noSource, uid: uids[0]!, sourcePage: 1 };
    }
    // The PDF the sheet was filled from was attached to the OLD worker. Source ids restart at src1 in each worker, and a
    // Compare session attaches its overlay as src1 again, so the old id would name another file's pages. The sheet stays open
    // and asks for the PDF again.
    case 'from':
      return { ...sheet, ...noSource, range: '' };
    case 'crop': {
      const uids = mapAll(sheet.uids);
      if (uids === null) return null;
      if (!sheet.pageId.startsWith(prefix)) return { ...sheet, uids };
      const page = mapAll([sheet.pageId.slice(prefix.length)]);
      return page === null ? null : { ...sheet, uids, pageId: pageIdForUid(docId, page[0]!) };
    }
    default:
      return sheet;
  }
}

/**
 * Moves the selection and each pane's current page of `docId` from the old page list to the new one. `samePages` is true
 * for a save (the file holds the pages that were on screen) and false for a reload from disk, where the file can differ:
 * the selection is then cleared and the current page only clamped. Call it right after the replacement, with the order
 * taken by `currentOrder` before it.
 */
export function remapAfterReplace(docId: string, oldUids: readonly string[], samePages: boolean): void {
  const newUids = currentOrder(docId);
  const prefix = `${docId}:`;

  // An open sheet of this document names pages by uid too: it follows them by position, or closes when it cannot.
  const sheet = useSheetStore.getState().sheet;
  if (sheet && sheet.docId === docId) {
    const next = remapSheetDraft(sheet, oldUids, newUids, samePages);
    if (next === null) useSheetStore.getState().close();
    else useSheetStore.setState({ sheet: next });
  }

  const uidOf = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : null);

  const selection = useSelectionStore.getState();
  const mine = selection.pageIds.filter((id) => id.startsWith(prefix));
  if (mine.length > 0 || (selection.anchorId !== null && selection.anchorId.startsWith(prefix))) {
    const uids = remapSelectedUids(oldUids, newUids, mine.map((id) => uidOf(id)!), samePages);
    const ids = uids.map((uid) => pageIdForUid(docId, uid));
    const anchorUid = selection.anchorId === null ? null : uidOf(selection.anchorId);
    const anchor = anchorUid === null ? undefined : remapSelectedUids(oldUids, newUids, [anchorUid], samePages)[0];
    useSelectionStore.setState({
      pageIds: [...selection.pageIds.filter((id) => !id.startsWith(prefix)), ...ids],
      anchorId: anchorUid === null ? selection.anchorId : anchor === undefined ? null : pageIdForUid(docId, anchor),
    });
  }

  // The page Properties describes follows the same rule.
  const picked = useSelectionStore.getState().selection;
  if (picked && picked.docId === docId) {
    const uid = uidOf(picked.pageId);
    const next = samePages && uid !== null ? remapSelectedUids(oldUids, newUids, [uid], true)[0] : undefined;
    useSelectionStore.setState({ selection: next === undefined ? null : { ...picked, pageId: pageIdForUid(docId, next) } });
  }

  // Each viewer also keeps the page it is on in its own anchor (so a rebuilt layout stays where the user was). That anchor
  // names a page by the old id too, so it is moved the same way, or the layout would scroll back to the page that used to
  // have the id: after "duplicate page 1, save", page 3 would show as page 2.
  const oldIds = oldUids.map((uid) => pageIdForUid(docId, uid));
  const newIds = newUids.map((uid) => pageIdForUid(docId, uid));
  for (const tab of useWorkspaceStore.getState().tabs) {
    for (const pane of tab.panes) if (pane.docId === docId) requestViewer(pane.id, { kind: 'remapPages', from: oldIds, to: newIds });
  }

  useWorkspaceStore.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.panes.some((pane) => pane.docId === docId && pane.view.pageId !== null)
        ? {
            ...tab,
            panes: tab.panes.map((pane) => {
              const uid = pane.docId === docId && pane.view.pageId !== null ? uidOf(pane.view.pageId) : null;
              if (uid === null) return pane;
              const next = remapCurrentUid(oldUids, newUids, uid);
              return next === null ? pane : { ...pane, view: { ...pane.view, pageId: pageIdForUid(docId, next) } };
            }),
          }
        : tab,
    ),
  }));
}
