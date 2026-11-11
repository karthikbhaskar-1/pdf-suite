import { afterEach, describe, expect, it } from 'vitest';
import { makeAppInert, restoreFocus } from './focusTrap';

afterEach(() => {
  document.body.innerHTML = '';
});

function app() {
  document.body.innerHTML = '<div class="app"><div id="a"></div><main class="main" tabindex="-1"></main><div class="modal-backdrop" id="b"></div></div>';
  return document.getElementById('a')!;
}

describe('makeAppInert', () => {
  it('is counted: the app stays inert until every holder has released it', () => {
    const a = app();
    const releaseCombine = makeAppInert();
    const releaseClose = makeAppInert();
    expect(a.hasAttribute('inert')).toBe(true);
    expect(document.getElementById('b')!.hasAttribute('inert')).toBe(false);
    releaseCombine();
    expect(a.hasAttribute('inert')).toBe(true);
    releaseClose();
    expect(a.hasAttribute('inert')).toBe(false);
  });

  it('honours skip', () => {
    const a = app();
    const release = makeAppInert((el) => el.id === 'a');
    expect(a.hasAttribute('inert')).toBe(false);
    release();
  });
});

describe('restoreFocus', () => {
  it('focuses the previous element, or .main when it is gone', () => {
    app();
    const btn = document.createElement('button');
    document.querySelector('.app')!.appendChild(btn);
    restoreFocus(btn);
    expect(document.activeElement).toBe(btn);
    btn.remove();
    restoreFocus(btn);
    expect(document.activeElement).toBe(document.querySelector('.main'));
  });
});
