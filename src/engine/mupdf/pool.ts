/**
 * Starts MuPDF workers. The WASM is compiled once per page, and the compiled module is posted to each worker.
 * The pool keeps one warm spare, so opening a document does not wait for a worker to start.
 */
import { WorkerClient } from './client';
import { Priority } from './protocol';

/** The WASM file that mupdf.js ships. Vite emits it as an asset, so it is served next to the app. */
const WASM_URL = new URL('../../../node_modules/mupdf/dist/mupdf-wasm.wasm', import.meta.url);

let compiled: Promise<WebAssembly.Module> | null = null;

/**
 * Compiles the WASM once. Streams it when the server sends application/wasm, and falls back to reading the
 * bytes otherwise (a file:// or packaged origin may not). A failed compile is retried on the next call.
 */
export function compileMuPdf(): Promise<WebAssembly.Module> {
  if (!compiled) {
    const attempt = compileFromUrl(WASM_URL.href);
    compiled = attempt;
    attempt.catch(() => {
      if (compiled === attempt) compiled = null;
    });
  }
  return compiled;
}

async function compileFromUrl(url: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error('A part of PDF Suite could not be loaded. Close PDF Suite and start it again.');
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

/** Starts one worker and gives it the compiled module. Resolves when the worker is ready. */
export async function spawnWorker(): Promise<WorkerClient> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const client = new WorkerClient(worker);
  try {
    await client.request({ op: 'init', module: await compileMuPdf() }, Priority.Visible);
    return client;
  } catch (error) {
    client.terminate();
    throw error;
  }
}

/**
 * Hands out ready workers. After each hand-out a new spare starts in the background, so there is always one
 * ready for the next document.
 */
export class WorkerPool {
  private spare: Promise<WorkerClient | null> | null = null;

  constructor(private readonly spawn: () => Promise<WorkerClient>) {}

  /** Starts the spare now, so the first open does not wait for it. */
  prewarm(): void {
    this.spare ??= this.spawnSpare();
  }

  /** Returns a ready worker, using the warm spare when there is one. */
  async take(): Promise<WorkerClient> {
    const warm = this.spare;
    this.spare = this.spawnSpare();
    const client = warm ? await warm : null;
    return client ?? this.spawn();
  }

  private spawnSpare(): Promise<WorkerClient | null> {
    return this.spawn().catch(() => null);
  }
}

export const workerPool = new WorkerPool(spawnWorker);
