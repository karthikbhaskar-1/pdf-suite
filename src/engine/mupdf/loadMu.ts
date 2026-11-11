/**
 * Hooks the compiled WASM module into mupdf.js, then imports mupdf. Shared by the document worker (worker.ts) and the job
 * worker (jobWorker.ts). The import must come after the hook, because mupdf.js instantiates its WASM when it is first
 * evaluated, so this runs once per worker.
 */
import type * as Mu from 'mupdf';

export interface LoadedMu {
  mu: typeof Mu;
  /** The Emscripten module object, which exposes the heap (HEAPU8) and the stext accessors. */
  wasm: unknown;
}

export async function loadMu(module: WebAssembly.Module): Promise<LoadedMu> {
  const host = globalThis as unknown as { $libmupdf_wasm_Module?: unknown };
  host.$libmupdf_wasm_Module = {
    instantiateWasm(imports: WebAssembly.Imports, ready: (instance: WebAssembly.Instance, compiled: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(module, imports).then((instance) => ready(instance, module));
      return {};
    },
  };
  const mu = await import('mupdf');
  // MuPDF reports repairs such as a broken xref as warnings. They are expected for damaged files, and the
  // app reports the outcome itself, so they are not written to the console.
  mu.setLog({ error: () => undefined, warning: () => undefined });
  return { mu, wasm: host.$libmupdf_wasm_Module };
}
