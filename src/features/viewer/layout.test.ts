import { describe, expect, it } from 'vitest';
import { createPageList } from '../../core/model/pageList';
import { anchorAt, buildLayout, currentAnchor, fitZoom, keepJump, onScrollViewport, viewportSettled, scrollForAnchor, stepZoom, topPointAt, visibleRange, PAGE_GAP_PT } from './layout';

const DOC = 'b'.repeat(64);

describe('viewer layout', () => {
  it('stacks pages with gaps and swaps size for quarter turns', () => {
    const pages = createPageList(DOC, 2);
    const layout = buildLayout(pages, [
      { width: 100, height: 200 },
      { width: 100, height: 200 },
    ]);
    expect(layout.boxes[0]?.top).toBe(PAGE_GAP_PT);
    expect(layout.boxes[1]?.top).toBe(PAGE_GAP_PT + 200 + PAGE_GAP_PT);

    const turned = buildLayout(
      pages.map((p, i) => (i === 0 ? { ...p, rotation: 90 as const } : p)),
      [{ width: 100, height: 200 }, { width: 100, height: 200 }],
    );
    expect(turned.boxes[0]).toMatchObject({ width: 200, height: 100 });
  });

  it('uses the first measured size for pages not measured yet', () => {
    const layout = buildLayout(createPageList(DOC, 2), [{ width: 300, height: 400 }, undefined]);
    expect(layout.boxes[1]).toMatchObject({ width: 300, height: 400 });
  });

  it('finds the visible range with overscan, using points scaled by zoom', () => {
    const pages = createPageList(DOC, 50);
    const layout = buildLayout(pages, []);
    // Each page is 792 pt tall, with 12 pt gaps. At zoom 1 and a 1000 px viewport at the top:
    const { first, last } = visibleRange(layout, 0, 1000, 1, 0);
    expect(first).toBe(0);
    expect(last).toBe(1);
    const padded = visibleRange(layout, 0, 1000, 1, 2);
    expect(padded.first).toBe(0);
    expect(padded.last).toBe(3);
  });

  it('keeps the anchor page when scrolling by its fraction', () => {
    const layout = buildLayout(createPageList(DOC, 3), []);
    const box = layout.boxes[1];
    expect(box).toBeDefined();
    const point = (box?.top ?? 0) + (box?.height ?? 0) * 0.25;
    expect(anchorAt(layout, point)).toMatchObject({ index: 1 });
    expect(anchorAt(layout, point).fraction).toBeCloseTo(0.25);
  });

  it('reads back the page a go-to scrolled to, even when the browser rounds scrollTop down', () => {
    // Pages of odd heights (A4-like) at fractional zooms put the page tops on non-integer pixels.
    const heights = [841.89, 792, 595.28, 841.89, 1000];
    const layout = buildLayout(
      createPageList(DOC, heights.length),
      heights.map((height) => ({ width: 612, height })),
    );
    for (const zoom of [0.37, 0.93, 1, 1.25, 1.7]) {
      for (let index = 0; index < layout.boxes.length; index++) {
        const target = scrollForAnchor(layout, index, 0, zoom, 0);
        // A browser stores scrollTop as whole pixels, so the position can come back a fraction lower.
        const stored = Math.floor(target);
        expect(anchorAt(layout, topPointAt(stored, zoom)).index).toBe(index);
      }
    }
  });

  it('steps through zoom presets and clamps at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(8, 1)).toBe(8);
  });

  it('D2: one step list both ways, 10 to 800', () => {
    expect(stepZoom(4, 1)).toBe(6);
    expect(stepZoom(6, 1)).toBe(8);
    expect(stepZoom(8, 1)).toBe(8);
    expect(stepZoom(8, -1)).toBe(6);
    expect(stepZoom(6, -1)).toBe(4);
    expect(stepZoom(0.25, -1)).toBe(0.1);
    expect(stepZoom(0.1, -1)).toBe(0.1);
    expect(stepZoom(0.1, 1)).toBe(0.25);
    // Between two steps: the nearest step in that direction.
    expect(stepZoom(0.87, 1)).toBe(1);
    expect(stepZoom(0.87, -1)).toBe(0.75);
    expect(stepZoom(5, 1)).toBe(6);
    expect(stepZoom(5, -1)).toBe(4);
    // Up and down are inverse over the whole list.
    let z = 0.1;
    const up = [z];
    while (stepZoom(z, 1) !== z) up.push((z = stepZoom(z, 1)));
    expect(up).toEqual([0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]);
    const down = [z];
    while (stepZoom(z, -1) !== z) down.push((z = stepZoom(z, -1)));
    expect(down).toEqual([...up].reverse());
  });

  it('fits width and page into the viewport', () => {
    expect(fitZoom('width', { width: 500, height: 100 }, 524, 800)).toBeCloseTo(1);
    // The page's height fills the viewer height (the sheet gaps scroll away), so 532 px / 1000 pt.
    expect(fitZoom('page', { width: 500, height: 1000 }, 532, 532)).toBeCloseTo(0.532, 3);
    // Fit page on the open window of the 1.2.1 spec: 671 px high, a Letter page fills the height.
    expect(fitZoom('page', { width: 612, height: 792 }, 1141, 671)).toBeCloseTo(671 / 792, 4);
  });
});

describe('the page the user is on (1.2.2): a short last page can never reach the top of the viewer', () => {
  // Eight pages, 100 pt wide; the last two are short (50 pt), so at the end of the document the viewer's top is on page 6.
  const sizes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ width: 100, height: n >= 7 ? 50 : 300 }));
  const layout = buildLayout(createPageList(DOC, 8), sizes);
  const viewportPt = 200;
  const endScroll = layout.height - viewportPt; // the farthest the viewer can scroll (zoom 1)
  const top = (scroll: number) => topPointAt(scroll, 1);

  it('shows the premise: scrolled to the end, the top of the viewer is on an earlier page than the last', () => {
    expect(anchorAt(layout, top(endScroll)).index).toBeLessThan(7);
  });

  it('after a jump to page n, the current page is n, also when n is one of the last pages', () => {
    for (let n = 0; n < 8; n++) {
      const reachable = Math.min(scrollForAnchor(layout, n, 0, 1, 0), endScroll);
      expect(currentAnchor(layout, top(reachable), { atEnd: reachable >= endScroll - 1, jumpIndex: n }), `page ${n + 1}`).toEqual({ index: n, fraction: 0 });
    }
  });

  it('scrolled to the very end, the current page is the last page', () => {
    expect(currentAnchor(layout, top(endScroll), { atEnd: true, jumpIndex: null }).index).toBe(7);
  });

  it('anywhere else, it is the page at the top, as before', () => {
    const scroll = scrollForAnchor(layout, 3, 0.5, 1, 0);
    expect(currentAnchor(layout, top(scroll), { atEnd: false, jumpIndex: null })).toEqual(anchorAt(layout, top(scroll)));
    expect(currentAnchor(layout, top(scroll), { atEnd: false }).index).toBe(3);
  });

  it('keeps a jump index inside the document, and works with no pages', () => {
    expect(currentAnchor(layout, 0, { atEnd: false, jumpIndex: 99 }).index).toBe(7);
    expect(currentAnchor(layout, 0, { atEnd: false, jumpIndex: -3 }).index).toBe(0);
    expect(currentAnchor(buildLayout(createPageList(DOC, 0), []), 0, { atEnd: true })).toEqual({ index: 0, fraction: 0 });
  });
});

describe('a pane keeps the page the user jumped to when its size changes (1.3.4 regression: a side sheet narrowed the panes)', () => {
  // Six landscape pages, 800 x 500 pt. The viewer shows them one and a half at a time and fits the width, so a narrower pane
  // means a smaller zoom, and the same scroll offset then lies on another page.
  const sizes = Array.from({ length: 6 }, () => ({ width: 800, height: 500 }));
  const layout = buildLayout(createPageList(DOC, 6), sizes);
  const viewport = 450;

  /** What the viewer reads at a scroll position: the end rule and the jump as the controller applies them. */
  const pageAt = (scrollTop: number, zoom: number, jump: { index: number; scrollTop: number } | null) => {
    const stillThere = jump !== null && Math.abs(scrollTop - jump.scrollTop) <= 1;
    const max = layout.height * zoom - viewport;
    return currentAnchor(layout, topPointAt(scrollTop, zoom), { atEnd: scrollTop >= max - 1, jumpIndex: stillThere ? jump.index : null }).index;
  };

  it('keeps the jump when the viewer moves itself to the same anchor at the new zoom, so the page does not change', () => {
    const wide = 0.8;
    const narrow = 0.4; // page 5 can no longer reach the top: the viewer is at the end
    // Jump to page 5 at the wide zoom: the farthest the viewer can scroll (page 5 cannot reach the top, nor can page 6).
    const jumped = Math.min(scrollForAnchor(layout, 4, 0, wide, 0), layout.height * wide - viewport);
    const jump = { index: 4, scrollTop: jumped };
    expect(pageAt(jumped, wide, jump)).toBe(4);
    // The panes narrow: the viewer re-anchors page 5 at the new zoom (as its layout effect does).
    const moved = Math.min(scrollForAnchor(layout, 4, 0, narrow, 0), layout.height * narrow - viewport);
    // Without the fix the jump is lost as soon as the scroll position changes, and the page is read from the top or the end.
    expect(pageAt(moved, narrow, jump)).not.toBe(4);
    // With the fix the jump moves with the viewer.
    const kept = keepJump(jump, 4, moved);
    expect(kept).toEqual({ index: 4, scrollTop: moved });
    expect(pageAt(moved, narrow, kept)).toBe(4);
  });

  it('keeps it through the two steps of one resize (the viewport first, then the fit zoom)', () => {
    const steps = [0.8, 0.8, 0.4, 0.9];
    let scroll = Math.min(scrollForAnchor(layout, 3, 0, steps[0]!, 0), layout.height * steps[0]! - viewport);
    let jump: { index: number; scrollTop: number } | null = { index: 3, scrollTop: scroll };
    for (const zoom of steps.slice(1)) {
      const target = Math.min(scrollForAnchor(layout, 3, 0, zoom, 0), layout.height * zoom - viewport);
      jump = keepJump(jump, 3, target);
      scroll = target;
      expect(pageAt(scroll, zoom, jump), `zoom ${zoom}`).toBe(3);
    }
  });

  it('a jump to a page the viewer is not anchored on is dropped, as before: the user is somewhere else', () => {
    expect(keepJump({ index: 4, scrollTop: 1000 }, 2, 380)).toBeNull();
    expect(keepJump(null, 0, 10)).toBeNull();
  });
});

describe('a scroll event before the pane has seen its new size is not the user (viewportSettled)', () => {
  it('is settled only when the measured size is the one the viewer last re-anchored for', () => {
    expect(viewportSettled({ width: 600, height: 400 }, { width: 600, height: 400 })).toBe(true);
    // A side sheet narrowed the pane, or an info bar made it taller: the browser clamped the scroll and sent an event first.
    expect(viewportSettled({ width: 280, height: 400 }, { width: 600, height: 400 })).toBe(false);
    expect(viewportSettled({ width: 600, height: 430 }, { width: 600, height: 400 })).toBe(false);
  });
});

describe('the guard does not fail closed (onScrollViewport)', () => {
  it('a settled pane handles the scroll and adopts nothing', () => {
    expect(onScrollViewport({ width: 600, height: 400 }, { width: 600, height: 400 })).toEqual({ handle: true, adopt: null });
  });

  it('a pane that moved without a resize event: the scroll is skipped once and the size adopted, and the next scroll is handled', () => {
    let seen = { width: 600, height: 400 };
    // Blink snapped the pane to 599.5 x 400.25: no resize observer event came, but the measured size differs.
    const measured = { width: 599.5, height: 400.25 };
    const first = onScrollViewport(measured, seen);
    expect(first.handle).toBe(false);
    expect(first.adopt).toEqual(measured);
    // The viewer adopts it (setViewport) and re-anchors: now it is settled.
    seen = first.adopt!;
    expect(onScrollViewport(measured, seen)).toEqual({ handle: true, adopt: null });
  });
});
