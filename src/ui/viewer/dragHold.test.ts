import { describe, expect, it } from 'vitest';
import { DRAG_PAUSE_MS, DragHold } from './dragHold';

describe('DragHold', () => {
  it('holds nothing when no drag is on, so wheel scrolling requests pages at once', () => {
    const hold = new DragHold();
    hold.moved(0);
    expect(hold.isHeld(0)).toBe(false);
    expect(hold.liftsAt()).toBeNull();
  });

  it('holds while the thumb moves, and lifts once it has been still for the pause', () => {
    const hold = new DragHold();
    hold.begin(1000);
    expect(hold.isHeld(1000)).toBe(true);
    hold.moved(1500);
    expect(hold.isHeld(1500 + DRAG_PAUSE_MS - 1)).toBe(true);
    expect(hold.isHeld(1500 + DRAG_PAUSE_MS)).toBe(false);
    expect(hold.liftsAt()).toBe(1500 + DRAG_PAUSE_MS);
  });

  it('a pause in the middle of a drag lets requests through, and a new move holds again', () => {
    const hold = new DragHold();
    hold.begin(0);
    hold.moved(10);
    expect(hold.isHeld(200)).toBe(false);
    hold.moved(200);
    expect(hold.isHeld(210)).toBe(true);
  });

  it('lifts the hold at once when the drag ends', () => {
    const hold = new DragHold();
    hold.begin(0);
    hold.moved(5);
    hold.end();
    expect(hold.isHeld(6)).toBe(false);
    expect(hold.liftsAt()).toBeNull();
  });

  it('ignores scroll moves that are not part of a drag', () => {
    const hold = new DragHold();
    hold.begin(0);
    hold.end();
    hold.moved(50);
    hold.begin(100);
    // The 50 ms move before the drag does not count, so the hold runs from the grab.
    expect(hold.isHeld(100 + DRAG_PAUSE_MS - 1)).toBe(true);
    expect(hold.isHeld(100 + DRAG_PAUSE_MS)).toBe(false);
  });
});
