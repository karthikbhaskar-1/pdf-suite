import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScheduler } from '../../engine/renderScheduler';
import './scrollVelocity';
import { SETTLE_MS } from './scrollVelocity';

/** A scroller of the given class, 500 px tall, scrolled by `deltaPerEvent` px per event, `gapMs` apart. */
function fling(className: string, deltaPerEvent: number, events: number, gapMs: number): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  Object.defineProperty(el, 'clientHeight', { value: 500 });
  document.body.append(el);
  for (let i = 1; i <= events; i++) {
    vi.advanceTimersByTime(gapMs);
    el.scrollTop = i * deltaPerEvent;
    el.dispatchEvent(new Event('scroll'));
  }
  return el;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('render pacing follows scroll speed', () => {
  it.each(['viewer', 'thumb-list'])('paces renders while the %s scrolls fast, and releases when it settles', (className) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const paced = vi.spyOn(renderScheduler, 'setPaced');
    fling(className, 400, 6, 16); // 25 viewport heights a second
    expect(paced).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(paced).toHaveBeenLastCalledWith(false);
  });

  it('does not pace a slow scroll', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const paced = vi.spyOn(renderScheduler, 'setPaced');
    fling('viewer', 2, 6, 16);
    expect(paced).not.toHaveBeenCalledWith(true);
  });
});
