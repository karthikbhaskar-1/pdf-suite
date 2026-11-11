/**
 * The job worker (blueprint §1). It is started for one dialog or job and terminated when that ends, which is the only way to
 * return its WASM memory. It is not taken from the document pool, so a job never blocks a tab's renders. All the logic is in
 * jobCore.ts; this file only connects it to messages.
 */
import { loadMu } from './loadMu';
import { JobSession } from './jobCore';
import { browserWebpDecoder } from './webpDecoder';
import type { FromJob, ToJob } from './jobProtocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToJob>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let session: JobSession | null = null;
/** Messages that arrive while the WASM is still loading. */
let starting: Promise<void> | null = null;

const post = (message: FromJob, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

/** Tells the page a message could not be handled. id 0 is the worker itself (it could not start); the page fails init and every request. */
function postFailure(id: number, error: unknown): void {
  post({ t: 'error', id, kind: 'Internal', detail: error instanceof Error ? error.message : String(error) });
}

scope.onmessage = (event: MessageEvent<ToJob>) => {
  const message = event.data;
  if (message.t === 'init') {
    if (!starting) {
      starting = loadMu(message.module).then(({ mu }) => {
        session = new JobSession(mu, post, { decodeWebp: browserWebpDecoder });
        post({ t: 'ready' });
      });
      // The engine did not load: say so, instead of leaving the page waiting for `ready` for good.
      starting.catch((error: unknown) => postFailure(0, error));
    }
    return;
  }
  // Everything else waits for init (the page sends it first, but the WASM load is asynchronous).
  const id = (message as { id?: number }).id ?? 0;
  (starting ?? Promise.reject(new Error('The job worker was not initialised')))
    .then(() => session?.handle(message))
    .catch((error: unknown) => postFailure(id, error));
};
