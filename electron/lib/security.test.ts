// @vitest-environment node
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, isAllowedNavigation, isAppUrl, resolveAppAsset, withContentSecurityPolicy } from './security';

const ROOT = path.resolve('/app/dist');

describe('navigation and app URLs', () => {
  it('allows the packaged app pages', () => {
    expect(isAllowedNavigation('app://pdf-suite/index.html')).toBe(true);
    expect(isAppUrl('app://pdf-suite/assets/pdf.worker.js')).toBe(true);
  });

  it('blocks web, file and other custom URLs', () => {
    expect(isAllowedNavigation('https://example.com/')).toBe(false);
    expect(isAllowedNavigation('file:///C:/Windows/notepad.exe')).toBe(false);
    expect(isAllowedNavigation('app://evil.example/index.html')).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)')).toBe(false);
  });

  it('allows the dev server origin only when one is given', () => {
    expect(isAllowedNavigation('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isAllowedNavigation('http://localhost:5173/', undefined)).toBe(false);
  });

  it('treats a malformed URL as not allowed', () => {
    expect(isAllowedNavigation('not a url')).toBe(false);
  });
});

describe('resolveAppAsset (app:// request paths)', () => {
  it('maps the root to index.html', () => {
    expect(resolveAppAsset(ROOT, '/')).toBe(path.join(ROOT, 'index.html'));
  });

  it('maps nested assets inside the root', () => {
    expect(resolveAppAsset(ROOT, '/assets/pdf.worker.min.mjs')).toBe(path.resolve(ROOT, 'assets', 'pdf.worker.min.mjs'));
  });

  it('refuses traversal out of the root, plain and encoded', () => {
    expect(resolveAppAsset(ROOT, '/../secret.txt')).toBeNull();
    expect(resolveAppAsset(ROOT, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveAppAsset(ROOT, '/assets/../../secret.txt')).toBeNull();
    expect(resolveAppAsset(ROOT, '/..\\secret.txt')).toBeNull();
  });

  it('refuses NUL bytes and malformed encodings', () => {
    expect(resolveAppAsset(ROOT, '/a%00b.js')).toBeNull();
    expect(resolveAppAsset(ROOT, '/%E0%A4%A')).toBeNull();
  });

  it('does not accept a sibling folder that shares the root prefix', () => {
    expect(resolveAppAsset(ROOT, '/../dist-evil/x.js')).toBeNull();
  });
});

describe('buildContentSecurityPolicy', () => {
  it('allows the pdf.js worker and the MuPDF WASM, and nothing remote', () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toMatch(/^default-src 'none';/);
    expect(csp).not.toContain('http:');
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('blocks objects, framing and form posts', () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('the meta-tag form is the same policy without frame-ancestors (a meta tag cannot carry it)', () => {
    const header = buildContentSecurityPolicy();
    const meta = buildContentSecurityPolicy(undefined, { forMeta: true });
    expect(meta).not.toContain('frame-ancestors');
    expect(header.replace("; frame-ancestors 'none'", '')).toBe(meta);
    expect(buildContentSecurityPolicy('http://localhost:5173', { forMeta: true })).not.toContain('frame-ancestors');
  });

  it('adds the dev server only in development', () => {
    const dev = buildContentSecurityPolicy('http://localhost:5173');
    expect(dev).toContain('http://localhost:5173');
    expect(dev).toContain('ws://localhost:5173');
  });
});

describe('withContentSecurityPolicy (the app scheme response)', () => {
  const csp = buildContentSecurityPolicy();

  it('an HTML response carries the policy as a header, with its body, status and other headers kept', async () => {
    const original = new Response('<html></html>', { status: 200, statusText: 'OK', headers: { 'content-type': 'text/html', 'x-keep': '1' } });
    const out = withContentSecurityPolicy(original, 'C:/app/dist/index.html', csp);
    expect(out.headers.get('content-security-policy')).toBe(csp);
    expect(out.headers.get('x-keep')).toBe('1');
    expect(out.status).toBe(200);
    expect(await out.text()).toBe('<html></html>');
  });

  it('an HTML response without a content type is recognised by the file name, and a policy already there is replaced', () => {
    const original = new Response('x', { headers: { 'content-security-policy': "default-src *" } });
    expect(withContentSecurityPolicy(original, 'C:/app/dist/index.html', csp).headers.get('content-security-policy')).toBe(csp);
  });

  it('a script or a wasm file passes unchanged', () => {
    const script = new Response('1', { headers: { 'content-type': 'text/javascript' } });
    expect(withContentSecurityPolicy(script, 'C:/app/dist/assets/a.js', csp)).toBe(script);
  });
});
