/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildContentSecurityPolicy } from './electron/lib/security';

/**
 * The built index.html carries the packaged app's Content-Security-Policy as a meta tag as well (the main process also sends it as a
 * header on the app:// response). Build only: the dev server needs inline scripts for React refresh and a websocket for hot reload,
 * and its policy is the header the main process sends for the dev origin.
 */
function contentSecurityPolicyMeta(): Plugin {
  return {
    name: 'pdf-suite-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: buildContentSecurityPolicy(undefined, { forMeta: true }) },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicyMeta()],
  build: {
    target: 'es2022',
  },
  // Workers are ES modules, so the MuPDF worker can use dynamic import for the WASM engine.
  worker: {
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.ts', 'tests/lib/**/*.test.mjs'],
  },
});
