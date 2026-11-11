import { createKeymap, type Keymap } from '../core/keymap/keymap';
import { DocumentRegistry, defaultHasher } from '../engine/documentRegistry';
import { evictStaleBitmaps, evictStaleOverlayBitmaps } from '../engine/bitmapCache';
import { MupdfDocument } from '../engine/mupdf/mupdfDocument';
import { useEditStore } from '../core/stores/editStore';
import { pageContent } from '../core/model/pageList';
import { mirrorPageEvent } from '../features/documents/pageSync';
import { compareHooks } from '../features/compare/compareHooks';
import { residencyHooks } from '../features/documents/residencyHooks';
import { prewarmEngine, routerEngine } from '../engine/router';
import { createElectronFileService } from '../platform/electronFileService';
import { createWebFileService, type FileService } from '../platform/fileService';
import { getDesktopBridge } from '../platform/desktop/bridge';
import { detectRuntime } from '../platform/runtime';

/**
 * The document id each engine document is known by. A Save As re-keys a document (see DocumentRegistry.rekey), and the
 * page-list listener below then writes to the new id.
 */
const idOfDocument = new WeakMap<object, string>();

/** The one registry of open documents. Tabs and panes hold references into it. */
/** The file path of a document id, or null for a byte source. */
function pathOfDocId(docId: string): string | null {
  return docId.startsWith('path:') ? docId.slice('path:'.length) : null;
}

/**
 * Tells the main process which files have a document open. It writes a file only while one is (or after a Save dialog),
 * and revokes the right when the document closes. Failures are ignored: the main process then simply refuses a write.
 */
function reportOpen(docId: string): void {
  const path = pathOfDocId(docId);
  const files = getDesktopBridge()?.files;
  if (path && files?.documentOpened) void files.documentOpened(path).catch(() => undefined);
}

function reportClosed(docId: string): void {
  const path = pathOfDocId(docId);
  const files = getDesktopBridge()?.files;
  if (path && files?.documentClosed) void files.documentClosed(path).catch(() => undefined);
}

export const documentRegistry = new DocumentRegistry(
  routerEngine,
  defaultHasher,
  (docId, doc) => {
    idOfDocument.set(doc, docId);
    reportOpen(docId);
    // A MuPDF document reports its page list after each open, edit, undo and redo. The store keeps the latest.
    if (doc instanceof MupdfDocument) {
      // A new document has a new page list. Its version starts again, so the old entry is cleared first.
      useEditStore.getState().clear(docId);
      useEditStore.getState().setCanEdit(docId, doc.capabilities.canEdit);
      doc.onPages((event) => {
        const current = idOfDocument.get(doc) ?? docId;
        useEditStore.getState().setPages(current, {
          version: event.version,
          uids: event.uids,
          revs: event.revs,
          sizes: event.sizes ?? null,
          history: event.history,
        });
        // The panes read the page list from the documents store, so they show the edit at once.
        mirrorPageEvent(current, event, doc.generation);
        // Bitmaps of pages that are gone, or whose content changed, can never be drawn again: release them now.
        evictStaleBitmaps(current, new Set(event.uids.map((uid, i) => pageContent(uid, event.revs[i] ?? 0, doc.generation))));
        // The same for the Compare view's bitmaps (pseudo documents `${docId}#ov:...`, which the call above leaves alone).
        evictStaleOverlayBitmaps(current, new Set(event.uids.map((uid, i) => pageContent(uid, event.revs[i] ?? 0, doc.generation))));
      });
      // A save replaces the document with a new worker that has no sources: a Compare on it attaches its overlay again.
      compareHooks.replaced(docId);
    }
    residencyHooks.opened(docId);
  },
  (oldId, newId, doc) => {
    idOfDocument.set(doc, newId);
    reportClosed(oldId);
    reportOpen(newId);
    compareHooks.rekeyed(oldId, newId);
  },
  (docId) => {
    reportClosed(docId);
    compareHooks.closed(docId);
    residencyHooks.closed(docId);
  },
);
prewarmEngine();

const bridge = getDesktopBridge();
const runtime = detectRuntime();

/** The desktop build gets path-based files through the preload bridge. The web build keeps byte sources. */
export const fileService: FileService = bridge ? createElectronFileService(bridge) : createWebFileService();

export const keymap: Keymap = createKeymap(runtime);
