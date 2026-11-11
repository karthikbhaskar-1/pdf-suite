// 1.5.8 review B2: the Content-Security-Policy of the packaged app does not depend on session.webRequest.onHeadersReceived (which Electron
// does not promise to run for a protocol.handle scheme). The app:// response carries the header itself and the built index.html carries
// the same policy as a meta tag. The page cannot eval a string, cannot run an injected inline script, and cannot connect to another
// origin, and a packaged app ignores ELECTRON_RENDERER_URL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launch, closeAll } from './helpers.mjs';

after(closeAll);

/** A local http server that counts every request it gets (a stand-in for "the outside"). */
async function listen() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    res.end('<!doctype html><title>outside</title><p>outside</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { hits, port, origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('the app:// response carries the policy as a header (not only through onHeadersReceived), and the built page has it as a meta tag', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state', { timeout: 15000 });
    const header = await s.app.evaluate(async ({ net }) => {
      const response = await net.fetch('app://pdf-suite/index.html');
      return response.headers.get('content-security-policy');
    });
    assert.ok(header, 'the app:// HTML response has a Content-Security-Policy header');
    assert.match(header, /^default-src 'none';/);
    assert.equal(header.split('; ').find((d) => d.startsWith('script-src')), "script-src 'self' 'wasm-unsafe-eval'", 'scripts: same origin and wasm only, no string eval, no inline');
    assert.match(header, /connect-src 'self'(;|$)/);
    assert.match(header, /frame-ancestors 'none'/);

    const meta = await s.win.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null);
    assert.ok(meta, 'the built index.html has the policy as a meta tag');
    assert.equal(meta, header.replace("; frame-ancestors 'none'", ''), 'the meta tag is the header policy without frame-ancestors');
  } finally {
    await s.close();
  }
});

test('eval of a string and an injected inline script are blocked in the packaged app', async () => {
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state', { timeout: 15000 });
    const result = await s.win.evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
      // The tries run in a timer task of the page, not inside this evaluate call: the debugger lets code it starts evaluate strings
      // whatever the policy says, so only a call made by the page itself shows what the policy does.
      const fromPage = (code) =>
        new Promise((resolve) =>
          setTimeout(() => {
            try {
              resolve(`ran:${code()}`);
            } catch (e) {
              resolve(`blocked:${e?.name}`);
            }
          }, 0),
        );
      // eslint-disable-next-line no-eval
      const evalResult = await fromPage(() => eval('1'));
      const functionResult = await fromPage(() => new Function('return 2')());
      window.__stringTimer = false;
      setTimeout('window.__stringTimer = true', 0);
      window.__injected = false;
      const script = document.createElement('script');
      script.textContent = 'window.__injected = true;';
      document.body.appendChild(script);
      const attribute = document.createElement('img');
      attribute.setAttribute('onerror', 'window.__injectedHandler = true');
      attribute.src = 'data:image/png;base64,';
      document.body.appendChild(attribute);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { evalResult, functionResult, injected: window.__injected, stringTimer: window.__stringTimer, handler: window.__injectedHandler === true, violations };
    });
    assert.equal(result.evalResult, 'blocked:EvalError', `eval('1'): ${result.evalResult}`);
    assert.equal(result.functionResult, 'blocked:EvalError', `new Function: ${result.functionResult}`);
    assert.equal(result.stringTimer, false, 'setTimeout with a string did not run it');
    assert.equal(result.injected, false, 'an injected inline script did not run');
    assert.equal(result.handler, false, 'an inline event handler attribute did not run');
    assert.ok(result.violations.some((d) => /script-src/.test(d)), `the browser reported script-src violations: ${result.violations.join(',')}`);
  } finally {
    await s.close();
  }
});

test('the page cannot connect to another origin (connect-src), and the server never sees a request', async () => {
  const outside = await listen();
  const s = await launch();
  try {
    await s.win.waitForSelector('.empty-state', { timeout: 15000 });
    const result = await s.win.evaluate(async (url) => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
      let fetched;
      try {
        const r = await fetch(url, { mode: 'no-cors' });
        fetched = `allowed:${r.type}`;
      } catch (e) {
        fetched = `blocked:${e?.message}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { fetched, violations };
    }, `${outside.origin}/probe`);
    assert.match(result.fetched, /^blocked/, result.fetched);
    assert.ok(result.violations.includes('connect-src'), `a connect-src violation was reported: ${result.violations.join(',')}`);
    assert.deepEqual(outside.hits, [], 'the local server received no request');
  } finally {
    await s.close();
    await outside.close();
  }
});

test('a packaged app ignores ELECTRON_RENDERER_URL: it loads app://, and the named server is never asked', async () => {
  const outside = await listen();
  const s = await launch({ env: { ELECTRON_RENDERER_URL: outside.origin } });
  try {
    await s.win.waitForSelector('.empty-state', { timeout: 15000 });
    assert.match(s.win.url(), /^app:\/\/pdf-suite\//);
    assert.deepEqual(outside.hits, [], 'the server named by ELECTRON_RENDERER_URL received no request');
  } finally {
    await s.close();
    await outside.close();
  }
});
