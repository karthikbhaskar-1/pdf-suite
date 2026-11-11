/** Where the app is running. The desktop shell (Electron) sets `pdfSuite` on window through its preload. */
export type Runtime = 'web' | 'desktop';

export function detectRuntime(env: object = globalThis): Runtime {
  return Boolean((env as { pdfSuite?: unknown }).pdfSuite) ? 'desktop' : 'web';
}
