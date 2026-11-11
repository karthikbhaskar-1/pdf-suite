import { documentRegistry } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { selectActiveTab, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useResidencyStore } from '../../features/documents/tabResidency';
import { ViewerPane } from '../viewer/ViewerPane';
import { EmptyState } from '../common/EmptyState';
import { SplitView } from '../split/SplitView';

/** The main area: the active tab's viewer, or a loading, error or empty message. */
export function WorkspaceBody() {
  const tab = useWorkspaceStore(selectActiveTab);
  const pane = tab?.panes[0];
  const doc = useDocumentsStore((s) => (pane ? s.docs[pane.docId] : undefined));
  // A document whose engine was ended while its tab was in the background is being opened again (see tabResidency.ts).
  const reopening = useResidencyStore((s) => (tab ? tab.panes.some((p) => s.state[p.docId] !== undefined) : false));

  if (!tab) return <EmptyState />;
  if (tab.status.kind === 'error') {
    return (
      <div className="tab-message" role="alert">
        {tab.status.message}
      </div>
    );
  }
  if (tab.status.kind === 'loading') {
    const percent = Math.round(tab.status.progress * 100);
    return (
      <div className="tab-message" role="status">
        <div>Opening {tab.title}…</div>
        <div className="load-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }
  if (tab.status.kind === 'needsPassword') {
    return <div className="tab-message">Waiting for the password.</div>;
  }
  if (!pane || !doc) return null;
  if (reopening) {
    return (
      <div className="tab-message" role="status">
        <div>Reopening {tab.title}…</div>
      </div>
    );
  }
  const viewer = tab.split && tab.panes.length >= 2 ? <SplitView tab={tab} /> : <ViewerPane key={pane.id} paneId={pane.id} />;
  // A dynamic XFA form is view-only in this version. The bar says so, above the pages.
  const isForm = documentRegistry.get(pane.docId)?.doc.capabilities.htmlLayer === true;
  if (!isForm) return viewer;
  return (
    <div className="form-view">
      <div className="info-bar" role="status">
        This form can be viewed but not edited yet.
      </div>
      {viewer}
    </div>
  );
}
