import { knobs } from '../../engine/testKnobs';

/**
 * How long the viewer must be still during a scrollbar drag before it asks for pages again. While the thumb
 * moves, every page passed on the way would be rendered and then thrown away, so nothing is requested until
 * the thumb pauses for this long, or the drag ends.
 */
export const DRAG_PAUSE_MS = knobs.dragPauseMs;

/** Tracks one scrollbar drag. Times are milliseconds on any monotonic clock (performance.now in the app). */
export class DragHold {
  private dragging = false;
  private lastMove = Number.NEGATIVE_INFINITY;

  /** The thumb was grabbed. */
  begin(now: number): void {
    this.dragging = true;
    this.lastMove = now;
  }

  /** The viewer scrolled. Counts only during a drag. */
  moved(now: number): void {
    if (this.dragging) this.lastMove = now;
  }

  /** The button was released. */
  end(): void {
    this.dragging = false;
  }

  /** True while page requests must wait: a drag is on and the viewer moved within the pause window. */
  isHeld(now: number): boolean {
    return this.dragging && now - this.lastMove < DRAG_PAUSE_MS;
  }

  /** The time the hold lifts if the viewer stays still, or null when no hold is pending. */
  liftsAt(): number | null {
    return this.dragging ? this.lastMove + DRAG_PAUSE_MS : null;
  }
}
