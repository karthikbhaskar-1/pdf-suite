/**
 * Reads the text of a run of pages inside the worker, and yields between pages. A worker runs one job at a
 * time, and its messages (cancels, more urgent requests) are handled only between tasks. Yielding after each
 * page lets a cancel that arrives during a long text job be seen, so the job stops at the next page.
 *
 * Kept apart from worker.ts so the loop can be tested without a worker.
 */
import { WorkerFault, type PageTextData } from './protocol';

export interface TextJobOptions {
  /** First page of the run. */
  from: number;
  /** Pages to read, counted from `from`. The caller applies its own limit. */
  count: number;
  /** Pages in the document. The run stops at the last one. */
  pageCount: number;
  /** Reads one page. Synchronous, so it runs to the end of the page. */
  readPage(index: number): PageTextData;
  /** True once the job has been cancelled, or the page at this index no longer has the content asked for. Checked before each page. */
  isCancelled(index: number): boolean;
  /** Lets other queued messages run before the next page. Resolves once they have. */
  yieldTurn(): Promise<void>;
}

/**
 * Reads the pages in order. Throws WorkerFault('Cancelled') as soon as a page starts after cancellation, so
 * no further page is read. The pages read so far are discarded by the caller, since the request is cancelled.
 */
export async function readTextPages(options: TextJobOptions): Promise<PageTextData[]> {
  const end = Math.min(options.from + options.count, options.pageCount);
  const out: PageTextData[] = [];
  for (let index = options.from; index < end; index++) {
    if (options.isCancelled(index)) throw new WorkerFault('Cancelled', 'Cancelled');
    out.push(options.readPage(index));
    await options.yieldTurn();
  }
  return out;
}

/**
 * A yield that lets already-queued messages run. It posts a message on its own channel, so the promise
 * resolves in a later task, after any message that was queued before it.
 */
export function createYielder(): () => Promise<void> {
  const channel = new MessageChannel();
  const waiting: Array<() => void> = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(null);
    });
}
