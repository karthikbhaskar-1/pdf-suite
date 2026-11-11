/**
 * The MuPDF worker. One worker holds one document. It runs one job per macrotask, so a queued cancel or a
 * more urgent render can run between two jobs. Jobs come from the queue in priority order.
 *
 * The WASM module is compiled once on the page and posted here as a WebAssembly.Module. The worker hooks it
 * in through mupdf's `$libmupdf_wasm_Module.instantiateWasm`, before mupdf.js is imported.
 */
import { MupdfCore } from './core';
import { loadMu } from './loadMu';
import { endTurn, runSizesJob } from './workerJobs';
import { labelFor, type Tick } from './editCore';
import { createYielder, readTextPages } from './textJob';
import {
  JobQueue,
  Priority,
  VersionCounter,
  WorkerFault,
  textTransferList,
  checkBaseVersion,
  type EditOutcome,
  type ErrorKind,
  type FromWorker,
  type HistoryState,
  type OpenResult,
  type Request,
} from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** Pages whose sizes are computed in one background job. */
const SIZE_CHUNK = 16;
/** Most pages one text request reads. */
const TEXT_LIMIT = 64;

const yieldTurn = createYielder();

/** An edit over this many pages, or one running longer than PROGRESS_MS, reports progress. */
const PROGRESS_PAGES = 100;
const PROGRESS_MS = 2000;

let core: MupdfCore | null = null;
const queue = new JobQueue<Request>();
const version = new VersionCounter();
/** Id of the job that is running now, or 0. */
let current = 0;
/** Ids of running jobs that were cancelled. Their results are dropped. */
const abandoned = new Set<number>();
let scheduled = false;

/** A MessageChannel posts the next job as its own macrotask, which setTimeout would delay by a clamp. */
const turn = new MessageChannel();
turn.port1.onmessage = () => {
  void runNext();
};

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function postError(id: number, kind: ErrorKind, message: string): void {
  post({ id, ok: false, version: version.current, error: { kind, message } });
}

scope.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  if (message.op === 'cancel') {
    const removed = queue.cancel(message.target);
    if (removed) {
      postError(removed.id, 'Cancelled', 'Cancelled');
    } else if (current === message.target) {
      abandoned.add(message.target);
    }
    return;
  }
  queue.push(message);
  schedule();
};

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  turn.port2.postMessage(null);
}

async function runNext(): Promise<void> {
  const job = queue.take();
  if (!job) {
    scheduled = false;
    return;
  }
  current = job.id;
  try {
    await execute(job);
  } finally {
    current = 0;
    endTurn(core ? () => core!.afterJob() : undefined, () => turn.port2.postMessage(null));
  }
}

async function execute(job: Request): Promise<void> {
  if (job.op === 'sizes') {
    // Internal background job: sizes are events, not replies. One is always posted (see runSizesJob).
    runSizesJob(core, job, post);
    return;
  }
  try {
    const { result, transfer } = await dispatch(job);
    if (abandoned.delete(job.id)) {
      if (result instanceof ImageBitmap) result.close();
      return;
    }
    post({ id: job.id, ok: true, version: version.current, result }, transfer);
  } catch (error) {
    abandoned.delete(job.id);
    const kind: ErrorKind = error instanceof WorkerFault ? error.kind : 'Internal';
    postError(job.id, kind, error instanceof Error ? error.message : String(error));
  }
}

interface Outcome {
  result: unknown;
  transfer?: Transferable[];
}

async function dispatch(job: Request): Promise<Outcome> {
  switch (job.op) {
    case 'init': {
      core ??= await loadCore(job.module);
      return { result: { ready: true } };
    }
    case 'open': {
      const open = requireCore();
      const opened = open.open(new Uint8Array(job.bytes), job.password);
      version.bump();
      queue.removeWhere((queued) => queued.op === 'sizes');
      // The pages as opened are uids "0".."n-1", all at rev 0. The sizes follow as sizes events.
      const uids = Array.from({ length: opened.pages }, (_unused, i) => String(i));
      const clean: HistoryState = { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
      post({ event: 'pages', version: version.current, uids, revs: new Array<number>(opened.pages).fill(0), history: clean });
      for (let from = 0; from < opened.pages; from += SIZE_CHUNK) {
        queue.push({ id: 0, pri: Priority.Background, op: 'sizes', from, count: Math.min(SIZE_CHUNK, opened.pages - from) });
      }
      schedule();
      const result: OpenResult = { ...opened, bytes: job.bytes };
      return { result, transfer: [job.bytes] };
    }
    case 'render': {
      const bitmap = await requireCore().render(job.args);
      return { result: bitmap, transfer: [bitmap] };
    }
    case 'text': {
      // Checks for a cancel between pages and yields between them, so a long text job stops early.
      const engine = requireCore();
      const expects = job.expects;
      // The page at each position must still be the page the caller asked for, so a moved page cancels the batch.
      if (expects?.[0] !== undefined && engine.locate(expects[0]) !== job.from) throw new WorkerFault('Cancelled', 'The page has changed');
      const result = await readTextPages({
        from: job.from,
        count: Math.min(job.count, TEXT_LIMIT),
        pageCount: engine.pageCount,
        readPage: (index) => engine.textPage(index),
        // A page whose uid@rev moved on since the caller asked is not read: the batch is Cancelled, not mixed.
        isCancelled: (index) =>
          abandoned.has(job.id) || (expects !== undefined && engine.locate(expects[index - job.from] ?? '') !== index),
        yieldTurn,
      });
      // Each page's character boundaries are one Float32Array: moved to the page, not copied.
      return { result, transfer: textTransferList(result) };
    }
    case 'apply': {
      checkBaseVersion(version.current, job.baseVersion);
      const applied = await requireCore().applyEdits(job.edits, editTick(job.id, labelFor(job.edits)), job.uidSeed);
      // A Cancel that arrived while the last page was being edited is seen here (messages are read at an await). The edit
      // is then taken back completely, with no redo left, and nothing is reported: the page list and version stay.
      if (applied.changed) await yieldTurn();
      if (abandoned.has(job.id)) {
        if (applied.changed) requireCore().editState?.discardLastStep(applied.uidSeed);
        throw new WorkerFault('Cancelled', 'The operation was cancelled');
      }
      // An edit that changed nothing made no step, so nothing is reported: the page list and the version stay.
      if (!applied.changed) return unchangedOutcome(applied.uidSeed);
      return editOutcome({ changed: true, uidSeed: applied.uidSeed });
    }
    case 'undo': {
      requireCore().undo();
      return editOutcome();
    }
    case 'discardLast': {
      requireCore().discardLast();
      return editOutcome();
    }
    case 'redo': {
      requireCore().redo();
      return editOutcome();
    }
    case 'save': {
      try {
        const saved = requireCore().save(job.samePath, job.diskUnchanged, job.dropEncryption === true);
        return { result: saved, transfer: [saved.bytes] };
      } finally {
        // A save spends what MuPDF can undo (see EditCore.markSaved), so the page learns the new undo state, whether or not
        // the save went on to succeed. The event comes before the reply.
        const edits = core?.editState;
        if (edits) post({ event: 'history', history: edits.history });
      }
    }
    case 'attachSource': {
      const attached = requireCore().attachSource(new Uint8Array(job.bytes), job.password);
      return { result: attached };
    }
    case 'sourceSize': {
      return { result: requireCore().sourceSize(job.sourceDocId, job.page) };
    }
    case 'detachSource': {
      requireCore().detachSource(job.sourceDocId);
      return { result: { detached: true } };
    }
    case 'extract': {
      const extracted = requireCore().extract(job.uids, { dropEncryption: job.dropEncryption === true, password: job.password });
      return { result: extracted, transfer: [extracted.bytes] };
    }
    case 'outline':
      return { result: requireCore().outline() };
    case 'metadata':
      return { result: requireCore().metadata() };
    case 'fingerprints':
      return { result: requireCore().fingerprints() };
    case 'stats':
      return { result: requireCore().stats() };
    case 'close':
      core?.close();
      queue.removeWhere((queued) => queued.op === 'sizes');
      return { result: { closed: true } };
    default:
      throw new WorkerFault('Unsupported', 'This change is not supported for this file.');
  }
}

function requireCore(): MupdfCore {
  if (!core) throw new WorkerFault('Internal', 'The engine is not initialised');
  return core;
}

/**
 * The checkpoint of a long edit. Between pages it reports progress (for a long edit), yields so a queued cancel can
 * arrive, and throws Cancelled when the running job was cancelled. The throw rolls the edit back (see EditCore.apply).
 */
function editTick(id: number, label: string): Tick {
  const started = Date.now();
  return async (done, total) => {
    if (total > PROGRESS_PAGES || Date.now() - started > PROGRESS_MS) {
      post({ event: 'progress', requestId: id, label, done, total });
    }
    await yieldTurn();
    if (abandoned.has(id)) throw new WorkerFault('Cancelled', 'The operation was cancelled');
  };
}

/**
 * After an edit, undo or redo: bumps the version, sends the page list with its sizes as one `pages` event, and
 * returns the undo state. Sizes queued for the old pages are dropped, since the page indices have changed.
 */
function unchangedOutcome(uidSeed: number): Outcome {
  const edits = requireCore().editState;
  if (!edits) throw new WorkerFault('Internal', 'No document is open');
  const result: EditOutcome = { version: version.current, history: edits.history, changed: false, uidSeed };
  return { result };
}

function editOutcome(extra: { changed?: boolean; uidSeed?: number } = {}): Outcome {
  const engine = requireCore();
  queue.removeWhere((queued) => queued.op === 'sizes');
  version.bump();
  const edits = engine.editState;
  if (!edits) throw new WorkerFault('Internal', 'No document is open');
  const pages = edits.pages();
  const sizes = engine.pageSizesNow();
  const history = edits.history;
  post({ event: 'pages', version: version.current, uids: pages.uids, revs: pages.revs, sizes, history }, [sizes.buffer]);
  const result: EditOutcome = { version: version.current, history, ...extra };
  return { result };
}

/** Hooks the compiled module into mupdf.js (see loadMu.ts) and makes the core around it. */
async function loadCore(module: WebAssembly.Module): Promise<MupdfCore> {
  const { mu, wasm } = await loadMu(module);
  return new MupdfCore(mu, wasm);
}
