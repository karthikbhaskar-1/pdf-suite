import * as path from 'node:path';

/** The custom scheme the packaged renderer loads from: app://pdf-suite/index.html. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'pdf-suite';

/**
 * Content Security Policy. The pdf.js worker is a same-origin script (worker-src 'self', with blob:
 * for pdf.js's fallback). 'wasm-unsafe-eval' is for the MuPDF WASM engine that comes in Milestone 1.2.
 * Styles allow inline because React sets style attributes at runtime.
 */
export function buildContentSecurityPolicy(devOrigin?: string, options: { forMeta?: boolean } = {}): string {
  const policy = buildPolicy(devOrigin);
  // A policy in a meta tag cannot carry frame-ancestors: the browser ignores it and logs an error.
  return options.forMeta ? policy.replace("; frame-ancestors 'none'", '') : policy;
}

function buildPolicy(devOrigin?: string): string {
  if (devOrigin) {
    // Vite's dev server needs inline scripts for React refresh, and a websocket for hot reload.
    return [
      "default-src 'none'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${devOrigin}`,
      `connect-src 'self' ${devOrigin} ${devOrigin.replace(/^http/, 'ws')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The response the app scheme hands the page. An HTML response carries the Content-Security-Policy header itself: Electron does not
 * promise that session.webRequest.onHeadersReceived runs for a protocol.handle response, and the policy must not depend on it.
 * Other responses (scripts, styles, images, wasm) pass unchanged.
 */
export function withContentSecurityPolicy(response: Response, file: string, csp: string): Response {
  const isHtml = /\.html?$/i.test(file) || (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
  if (!isHtml) return response;
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', csp);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** True for the packaged app's own pages, and for the dev server origin when one is given. */
export function isAppUrl(url: string, devOrigin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST) return true;
  return devOrigin !== undefined && parsed.origin === devOrigin;
}

/**
 * Navigation rule for every window and frame: the app may only load its own pages. Anything else
 * (an http link, a file path, another app) is blocked.
 */
export function isAllowedNavigation(url: string, devOrigin?: string): boolean {
  return isAppUrl(url, devOrigin);
}

/**
 * Maps a request path on the app scheme to a file inside `root`. Returns null for anything that
 * escapes `root` (".." segments, encoded separators, NUL) or is not a usable path. "/" maps to index.html.
 */
export function resolveAppAsset(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '' || decoded === '/' ? 'index.html' : decoded.replace(/^[\\/]+/, '');
  const segments = relative.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, ...segments);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}
