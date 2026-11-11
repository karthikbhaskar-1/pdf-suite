import { engineIndexOf } from '../../engine/pageRef';
import { useEffect, useState } from 'react';
import { documentRegistry } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { selectActiveTab, selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import type { DocumentMetadata } from '../../engine/types';
import type { FileStat } from '../../platform/desktop/contract';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import { residencyHooks } from '../../features/documents/residencyHooks';
import { propertyResolvers, type PropertyRow } from './resolvers';

/** Metadata is read once per document and reused. Documents are immutable, so this never goes stale. */
const metadataCache = new Map<string, Promise<DocumentMetadata>>();

function metadataFor(docId: string): Promise<DocumentMetadata> | undefined {
  const cached = metadataCache.get(docId);
  if (cached) return cached;
  const handle = documentRegistry.get(docId);
  if (!handle) return undefined;
  const promise = handle.doc.metadata();
  metadataCache.set(docId, promise);
  // A failed read is not kept, so a later open can try again.
  promise.catch(() => metadataCache.delete(docId));
  return promise;
}

// A released tab that came back from a file that changed on disk has other properties than the ones read from the file it had.
residencyHooks.changed = (docId) => {
  metadataCache.delete(docId);
};

/** Document and current page properties, from the resolver registry, for the active pane. */
export function PropertiesPanel() {
  // Narrow selectors, not the pane: the viewer rewrites the pane's view on every scroll frame (see usePageState.ts).
  const paneId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.id);
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const pageId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.view.pageId ?? null);
  const doc = useDocumentsStore((s) => (docId ? s.docs[docId] : undefined));
  const [metadata, setMetadata] = useState<DocumentMetadata | undefined>(undefined);
  const [stat, setStat] = useState<FileStat | null>(null);
  const selection = useSelectionStore((s) => s.selection);
  const pageIds = useSelectionStore((s) => s.pageIds);
  const path = useWorkspaceStore((s) => {
    const tab = selectActiveTab(s);
    return tab?.origin.kind === 'path' ? tab.origin.path : undefined;
  });

  useEffect(() => {
    setMetadata(undefined);
    if (!docId) return;
    let alive = true;
    metadataFor(docId)?.then((value) => {
      if (alive) setMetadata(value);
    });
    return () => {
      alive = false;
    };
  }, [docId]);

  // Desktop: the file's size and modified time come from the disk, not the bytes in memory.
  useEffect(() => {
    setStat(null);
    const bridge = getDesktopBridge();
    if (!bridge || !path) return;
    let alive = true;
    void bridge.files.stat(path).then((value) => {
      if (alive) setStat(value);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  if (!paneId || !docId || !doc) return <p className="panel-placeholder">Open a document to see its properties.</p>;

  // The page the user picked (a click on a page or thumbnail, or Properties from a page menu). With nothing
  // picked, the page at the top of the view is described.
  const picked = selection && selection.docId === docId ? doc.pages.findIndex((p) => p.id === selection.pageId) : -1;
  const pageIndex =
    picked >= 0 ? picked : pageId ? doc.pages.findIndex((p) => p.id === pageId) : -1;
  const page = pageIndex >= 0 ? doc.pages[pageIndex] : undefined;
  const size = page ? doc.sizes[engineIndexOf(page)] : undefined;
  const encrypted = documentRegistry.get(docId)?.doc.isEncrypted;
  const file = { path, size: stat?.size, modified: stat?.modified };
  const currentIndex = pageId ? doc.pages.findIndex((p) => p.id === pageId) : -1;
  const selectedCount = pageIds.filter((id) => doc.pages.some((p) => p.id === id)).length;
  const context = { doc, pageIndex, page, size, metadata, encrypted, file, pickedPage: picked >= 0, pickedElsewhere: picked >= 0 && picked !== currentIndex, selectedCount };

  return (
    <div className="props">
      {(['document', 'page'] as const).flatMap((type) =>
        propertyResolvers.forType(type).map((resolver) => {
          const heading = resolver.heading ? resolver.heading(context) : resolver.title;
          const note = resolver.note?.(context);
          return (
          <section key={resolver.id} className="props-section" aria-label={heading}>
            <h3>{heading}</h3>
            {note && <p className="props-note">{note}</p>}
            <dl>
              {resolver.rows(context).map((row: PropertyRow) => (
                <div key={row.label} className="props-row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          );
        }),
      )}
    </div>
  );
}
