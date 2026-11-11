import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * One tooltip for the whole app. Any element with a data-tooltip attribute gets it: it appears 500 ms after the pointer
 * rests on the element, or after the keyboard focuses it, and goes when the pointer leaves, the focus moves, a key is
 * pressed or the mouse button goes down. The text is read from the attribute when it appears, so it is always current.
 * The tooltip never takes the pointer or the focus.
 */

export const TOOLTIP_DELAY_MS = 500;

interface Shown {
  text: string;
  left: number;
  top: number;
  above: boolean;
}

/** True when the keyboard moved the focus to the element (not a click). */
function focusedByKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(':focus-visible');
  } catch {
    return false;
  }
}

function anchorOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
}

export function TooltipHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The tooltip is centered on its button. Near a window edge it is moved in, so it is never cut off.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    const box = el.getBoundingClientRect();
    const overRight = box.right - (window.innerWidth - 4);
    const overLeft = 4 - box.left;
    if (overRight > 0) el.style.left = `${shown.left - overRight}px`;
    else if (overLeft > 0) el.style.left = `${shown.left + overLeft}px`;
  }, [shown]);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // What started the tooltip: the pointer resting on a control, or the keyboard focusing it.
    let source: 'pointer' | 'focus' | null = null;
    // Where the pointer was last seen, and where it was when the keyboard focus started a tooltip.
    let last = { x: -1, y: -1 };
    let atFocus = { x: -1, y: -1 };

    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      current = null;
      source = null;
      setShown(null);
    };
    const start = (el: HTMLElement, from: 'pointer' | 'focus') => {
      if (el === current) return;
      hide();
      current = el;
      source = from;
      if (from === 'focus') atFocus = last;
      timer = setTimeout(() => {
        const text = el.getAttribute('data-tooltip');
        if (!text || !el.isConnected) return;
        const box = el.getBoundingClientRect();
        // Below the element, centered on it; above it when there is no room underneath.
        const below = box.bottom + 6 + 32 < window.innerHeight;
        setShown({ text, left: box.left + box.width / 2, top: below ? box.bottom + 6 : box.top - 6, above: !below });
      }, TOOLTIP_DELAY_MS);
    };

    // A tooltip that the keyboard started is not the pointer's to cancel. When a control is used, the bar can change under a
    // pointer that has not moved (a menu opens, a layout settles), and the browser then reports the pointer as entering or
    // leaving whatever is under it. Those reports come with the old coordinates, and must not take the tooltip away.
    const pointerMoved = (event: PointerEvent) => Math.hypot(event.clientX - atFocus.x, event.clientY - atFocus.y) >= 4;
    const onMove = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY };
    };
    const onOver = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY };
      if (source === 'focus' && !pointerMoved(event)) return;
      const el = anchorOf(event.target);
      if (el) start(el, 'pointer');
      else if (current) hide();
    };
    const onOut = (event: PointerEvent) => {
      if (source !== 'pointer') return;
      if (current && !current.contains(event.relatedTarget as Node | null)) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const el = anchorOf(event.target);
      // Only keyboard focus shows a tooltip. A click focuses the button too, and must not.
      if (el && focusedByKeyboard(event.target)) start(el, 'focus');
      else hide();
    };

    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      clearTimeout(timer);
    };
  }, []);

  if (!shown) return null;
  return (
    <div ref={ref} role="tooltip" className={shown.above ? 'tooltip tooltip-above' : 'tooltip'} style={{ left: shown.left, top: shown.top }}>
      {shown.text}
    </div>
  );
}
