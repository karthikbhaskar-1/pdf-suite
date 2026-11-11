/**
 * "A pointer that is not moving never changes a highlighted row" (1.5.5 spec, section 0). A menu or a list that appears or
 * scrolls under a resting pointer makes the browser send enter events for the row under it, with no pointer movement. This
 * gate lets hover through only after the pointer has really moved since the last key press: a pointer event at another
 * position than the one the pointer rested at. It is used by the menu bar (and its submenus) and the command palette.
 */
export interface RestingPointer {
  /** True when hover may change the highlight now. */
  allowed(): boolean;
  /** Stops listening. */
  stop(): void;
}

export function trackRestingPointer(options: { startDisarmed?: boolean } = {}): RestingPointer {
  // A tracker made after a key press (the palette, opened by Ctrl+K) starts disarmed: the pointer may already be resting.
  let armed = options.startDisarmed !== true;
  let last: { x: number; y: number } | null = null;
  let rest: { x: number; y: number } | null = null;

  const onKey = () => {
    armed = false;
    rest = last;
  };
  const onPointer = (event: Event) => {
    if (!(event instanceof MouseEvent)) return;
    const here = { x: event.clientX, y: event.clientY };
    if (!armed) {
      // The first position seen while disarmed is where the pointer rests; only a later event elsewhere arms.
      if (rest === null) rest = here;
      else if (rest.x !== here.x || rest.y !== here.y) armed = true;
    }
    last = here;
  };

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointermove', onPointer, true);
  window.addEventListener('pointerover', onPointer, true);
  window.addEventListener('pointerdown', onPointer, true);
  return {
    allowed: () => armed,
    stop: () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointermove', onPointer, true);
      window.removeEventListener('pointerover', onPointer, true);
      window.removeEventListener('pointerdown', onPointer, true);
    },
  };
}
