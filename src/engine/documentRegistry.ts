import type { DocId } from '../core/model/types';
import { canonicalPath } from './canonicalPath';
import { precheckBytes } from './precheck';
import type { DocumentSource, EngineDocument, OpenOptions, PdfEngine } from './types';

/** What the rest of the app sees for an open document. No pdf.js types. */
export interface DocHandle {
  readonly docId: DocId;
  readonly doc: EngineDocument;
  readonly pageCount: number;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Identity of a source. Byte sources are keyed by content hash, so identical files share one
 * handle. Path sources are keyed by path, because the bytes are not copied into the app.
 */
export type SourceHasher = (source: DocumentSource) => Promise<string>;

export const defaultHasher: SourceHasher = async (source) =>
  source.kind === 'bytes' ? sha256Hex(source.bytes) : `path:${source.path}`;

interface Entry {
  handle: DocHandle;
  refs: number;
  /**
   * True while the document's engine is ended but the entry, its references and its tabs are kept (see `suspend`). `get`
   * answers undefined then, so nothing draws or edits a document that has no engine.
   */
  suspended?: boolean;
  /** The reopen of a suspended entry that is running, so two callers at once share it. */
  resuming?: Promise<DocHandle>;
}

/**
 * One refcounted DocHandle per distinct file. Tabs and panes call `acquire` (or `retain`)
 * for each reference and `release` when they let go. The engine document is destroyed when
 * the last reference is released.
 */
export class DocumentRegistry {
  private readonly entries = new Map<DocId, Entry>();

  /**
   * @param onOpened called once for each document the registry opens (not for shared handles), with its id. The app
   * uses it to follow a document's page list.
   */
  constructor(
    private readonly engine: PdfEngine,
    private readonly hasher: SourceHasher = defaultHasher,
    private readonly onOpened?: (docId: DocId, doc: EngineDocument) => void,
    /** Called when rekey moves a document to a new id. */
    private readonly onRekeyed?: (oldId: DocId, newId: DocId, doc: EngineDocument) => void,
    /** Called when the last reference is released and the document is closed. */
    private readonly onClosed?: (docId: DocId) => void,
  ) {}

  /**
   * The id an open document of the same FILE already has, whatever spelling it was opened with (case, slashes, "." and ".."
   * parts, a trailing separator), or `docId` itself when none is open. Two spellings of one path must be one document: they
   * would otherwise be two documents over one file, writing one recovery log and racing to save.
   */
  sameFileId(docId: DocId): DocId {
    if (!docId.startsWith('path:') || this.entries.has(docId)) return docId;
    const wanted = canonicalPath(docId.slice('path:'.length));
    for (const id of this.entries.keys()) {
      if (id.startsWith('path:') && canonicalPath(id.slice('path:'.length)) === wanted) return id;
    }
    return docId;
  }

  /** Opens the source, or shares the open handle for the same file. Adds one reference. */
  async acquire(source: DocumentSource, options: OpenOptions = {}): Promise<DocHandle> {
    if (source.kind === 'bytes') {
      const precheck = precheckBytes(source.bytes);
      if (precheck) throw precheck;
    }

    const docId = this.sameFileId(await this.hasher(source));
    const existing = this.entries.get(docId);
    if (existing) {
      // A suspended document (its engine ended while its tab was in the background) is opened again for this caller too.
      if (existing.suspended) {
        const handle = await this.resumeEntry(docId, existing, source, options);
        existing.refs += 1;
        return handle;
      }
      existing.refs += 1;
      return existing.handle;
    }

    const doc = await this.engine.open(source, options);
    // Another caller may have opened the same file (under any spelling) while we were waiting.
    const raced = this.entries.get(this.sameFileId(docId));
    if (raced) {
      void doc.destroy();
      raced.refs += 1;
      return raced.handle;
    }

    const handle: DocHandle = { docId, doc, pageCount: doc.pageCount };
    this.entries.set(docId, { handle, refs: 1 });
    this.onOpened?.(docId, doc);
    return handle;
  }

  /**
   * Ends the engine of an open document and keeps everything else: the entry, its references (so the file stays "open" for the
   * main process: its write right and its place in the last-session record are not touched) and the document's id. `get` answers
   * undefined until `resume`. The caller decides when this is safe (a document with no unsaved edits and no running operation).
   * Returns false when the document is not open or is suspended already.
   */
  suspend(docId: DocId): boolean {
    const entry = this.entries.get(docId);
    if (!entry || entry.suspended) return false;
    entry.suspended = true;
    void entry.handle.doc.destroy();
    return true;
  }

  isSuspended(docId: DocId): boolean {
    return this.entries.get(docId)?.suspended === true;
  }

  /**
   * Opens a suspended document again from its source, under the same id and with the references it has. Resolves with the
   * new handle; a document that is not suspended resolves with its handle unchanged. A failed open leaves it suspended.
   */
  resume(docId: DocId, source: DocumentSource, options: OpenOptions = {}): Promise<DocHandle> {
    const entry = this.entries.get(docId);
    if (!entry) return Promise.reject(new Error('The document is not open.'));
    if (!entry.suspended) return Promise.resolve(entry.handle);
    return this.resumeEntry(docId, entry, source, options);
  }

  private resumeEntry(docId: DocId, entry: Entry, source: DocumentSource, options: OpenOptions): Promise<DocHandle> {
    if (entry.resuming) return entry.resuming;
    const work = (async (): Promise<DocHandle> => {
      const doc = await this.engine.open(source, options);
      // The document was closed (its last reference released) while the file was being read: nothing to put it in.
      if (this.entries.get(docId) !== entry) {
        void doc.destroy();
        throw new Error('The document was closed while it was being reopened.');
      }
      entry.handle = { docId, doc, pageCount: doc.pageCount };
      entry.suspended = false;
      this.onOpened?.(docId, doc);
      return entry.handle;
    })();
    entry.resuming = work;
    const clear = (): void => {
      if (entry.resuming === work) entry.resuming = undefined;
    };
    work.then(clear, clear);
    return work;
  }

  /** Adds one reference to a document that is already open. */
  retain(docId: DocId): void {
    const entry = this.entries.get(docId);
    if (entry) entry.refs += 1;
  }

  /** Drops one reference. Destroys the engine document when none are left. */
  release(docId: DocId): void {
    const entry = this.entries.get(docId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.entries.delete(docId);
      // A suspended document's engine is already ended.
      if (!entry.suspended) void entry.handle.doc.destroy();
      this.onClosed?.(docId);
    }
  }

  /**
   * Swaps the engine document of an open entry for a new one, and destroys the old one. Used after a save reopens the
   * file in a fresh worker. Every holder of the docId then sees the new document. Returns false when the docId is not open.
   */
  replaceDocument(docId: DocId, doc: EngineDocument): boolean {
    const entry = this.entries.get(docId);
    if (!entry || entry.suspended) return false;
    const previous = entry.handle.doc;
    entry.handle = { docId, doc, pageCount: doc.pageCount };
    this.onOpened?.(docId, doc);
    void previous.destroy();
    return true;
  }

  /**
   * Moves an open entry to a new docId, with its references. Save As uses it: after the file is written under a new
   * path, the document is known by that path, and the old path is free to open again as a fresh document. Returns
   * false when the old id is not open or the new id is already taken.
   */
  rekey(oldId: DocId, newId: DocId): boolean {
    if (oldId === newId) return this.entries.has(oldId);
    const entry = this.entries.get(oldId);
    if (!entry || this.entries.has(newId)) return false;
    this.entries.delete(oldId);
    const handle: DocHandle = { docId: newId, doc: entry.handle.doc, pageCount: entry.handle.pageCount };
    this.entries.set(newId, { handle, refs: entry.refs, ...(entry.suspended ? { suspended: true } : {}) });
    this.onRekeyed?.(oldId, newId, handle.doc);
    return true;
  }

  get(docId: DocId): DocHandle | undefined {
    const entry = this.entries.get(docId);
    return entry && !entry.suspended ? entry.handle : undefined;
  }

  refCount(docId: DocId): number {
    return this.entries.get(docId)?.refs ?? 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
