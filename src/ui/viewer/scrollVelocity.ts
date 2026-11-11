import { useSyncExternalStore } from 'react';
import { renderScheduler } from '../../engine/renderScheduler';
import { knobs } from '../../engine/testKnobs';

/** Above this speed, in viewport heights per second, the viewer counts as scrolling fast. */
export const FAST_VIEWPORTS_PER_SECOND = knobs.fastViewportsPerSecond;
/** Scrolling is settled after this long without a scroll event. */
export const SETTLE_MS = knobs.settleMs;

/** Measures the scroll speed of one scroller, in viewport heights per second, smoothed over scroll events. */
function createTracker(onChange: (fast: boolean) => void) {
  let fast = false;
  let speed = 0;
  let lastTop = 0;
  let lastTime = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: boolean) => {
    if (next === fast) return;
    fast = next;
    onChange(next);
  };
  return {
    isFast: () => fast,
    scrolled(target: HTMLElement): void {
      const now = performance.now();
      if (lastTime > 0 && now > lastTime) {
        const seconds = (now - lastTime) / 1000;
        const instant = Math.abs(target.scrollTop - lastTop) / Math.max(1, target.clientHeight) / seconds;
        speed = 0.5 * speed + 0.5 * instant;
      }
      lastTop = target.scrollTop;
      lastTime = now;
      set(speed > FAST_VIEWPORTS_PER_SECOND);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        speed = 0;
        lastTime = 0;
        set(false);
      }, SETTLE_MS);
    },
  };
}

const listeners = new Set<() => void>();

/**
 * While either scroller moves fast, the render scheduler starts at most one bitmap render per animation frame (see
 * RenderScheduler pacing): hundreds of renders a second would otherwise queue up GPU uploads and drain as a long frame.
 */
function updatePacing(): void {
  renderScheduler.setPaced(viewer.isFast() || thumbnails.isFast());
}

/** The page viewer. Its speed also switches pages to the lower scale (see useFastScrolling). */
const viewer = createTracker(() => {
  updatePacing();
  for (const listener of listeners) listener();
});
/** The thumbnail list. Only the render pacing follows it: thumbnails are already small. */
const thumbnails = createTracker(updatePacing);

/**
 * Watches the scrollers. Listens in the capture phase because scroll events do not bubble.
 */
function onScroll(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains('viewer')) viewer.scrolled(target);
  else if (target.classList.contains('thumb-list')) thumbnails.scrolled(target);
}

if (typeof document !== 'undefined') {
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
}

/** True while the viewer is moving fast. Pages then render at reduced resolution. */
export function useFastScrolling(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => viewer.isFast(),
    () => false,
  );
}
