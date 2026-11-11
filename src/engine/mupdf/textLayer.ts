/**
 * The selectable text layer, and the rotation of text runs for an extra page rotation. Runs are in points,
 * in the page's display space. Each run becomes one absolutely positioned span, transformed so its box
 * follows the run's direction and height. The spans are transparent (see .textLayer in viewer.css), so
 * only selection and copy use them.
 */
import { normalizeRotation } from './core';
import type { RunData } from './protocol';

/** What a run needs to be placed: its text and its three vectors. Any engine run with these fits. */
export type PlaceableRun = Pick<RunData, 'text' | 'origin' | 'along' | 'up'>;

type Matrix6 = [number, number, number, number, number, number];

/**
 * Turns a run from the page's display space into the page shown with an extra rotation. The turns are
 * clockwise, the same as the rendered bitmap. `width` and `height` are the page's display size.
 */
export function rotateRun<T extends PlaceableRun>(run: T, width: number, height: number, rotation: number): T {
  const turn = normalizeRotation(rotation);
  if (turn === 0) return run;
  const point = (p: { x: number; y: number }) => {
    switch (turn) {
      case 90:
        return { x: height - p.y, y: p.x };
      case 180:
        return { x: width - p.x, y: height - p.y };
      default:
        return { x: p.y, y: width - p.x };
    }
  };
  const vector = (v: { x: number; y: number }) => {
    switch (turn) {
      case 90:
        return { x: -v.y, y: v.x };
      case 180:
        return { x: -v.x, y: -v.y };
      default:
        return { x: v.y, y: -v.x };
    }
  };
  return { ...run, origin: point(run.origin), along: vector(run.along), up: vector(run.up) };
}

/** Where a run's span goes: its CSS transform and font size, at a zoom `scale` (pixels per point). */
export function runPlacement(run: PlaceableRun, scale: number): { fontSize: number; matrix: Matrix6; alongPx: number } {
  const alongLength = Math.hypot(run.along.x, run.along.y);
  const upLength = Math.hypot(run.up.x, run.up.y);
  const along = alongLength > 0 ? { x: run.along.x / alongLength, y: run.along.y / alongLength } : { x: 1, y: 0 };
  // The span's local y axis points down, which is the opposite of `up`.
  const down = upLength > 0 ? { x: -run.up.x / upLength, y: -run.up.y / upLength } : { x: 0, y: 1 };
  // The span's top-left corner is the run's origin moved up by its height.
  const topLeft = { x: (run.origin.x + run.up.x) * scale, y: (run.origin.y + run.up.y) * scale };
  return {
    fontSize: Math.max(1, upLength * scale),
    matrix: [along.x, along.y, down.x, down.y, topLeft.x, topLeft.y],
    alongPx: alongLength * scale,
  };
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Width of `text` at `fontSize` pixels, or 0 when there is no canvas to measure with. */
function measureWidth(text: string, fontSize: number): number {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return 0;
  measureContext.font = `${fontSize}px sans-serif`;
  return measureContext.measureText(text).width;
}

/**
 * Fills `container` with one span per run and returns a function that removes them. Each span is stretched
 * horizontally so its natural width matches the run's width on the page.
 */
export function buildTextLayer(container: HTMLElement, runs: readonly PlaceableRun[], scale: number): () => void {
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const { fontSize, matrix, alongPx } = runPlacement(run, scale);
    const natural = measureWidth(run.text, fontSize);
    const stretch = natural > 0 ? alongPx / natural : 1;
    const span = document.createElement('span');
    span.textContent = run.text;
    span.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'white-space:pre',
      'color:transparent',
      'transform-origin:0 0',
      'font-family:sans-serif',
      'line-height:1',
      `font-size:${fontSize}px`,
      `transform:matrix(${matrix.map((v) => v.toFixed(4)).join(',')}) scale(${stretch.toFixed(4)},1)`,
    ].join(';');
    fragment.appendChild(span);
  }
  container.replaceChildren(fragment);
  return () => container.replaceChildren();
}
