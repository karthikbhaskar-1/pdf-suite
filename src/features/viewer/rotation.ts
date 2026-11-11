import type { ViewRotation } from '../../core/model/types';

/** A box in points, or a rectangle inside one. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The next view rotation, clockwise, wrapping at 360. */
export function nextRotation(rotation: ViewRotation): ViewRotation {
  return ((rotation + 90) % 360) as ViewRotation;
}

/** Rotation of a page as shown: its list rotation plus the view rotation, modulo 360. */
export function effectiveRotation(pageRotation: number, viewRotation: number): number {
  return (((pageRotation + viewRotation) % 360) + 360) % 360;
}

/** Whether a rotation turns the page on its side (width and height swap). */
export function swapsAxes(rotation: number): boolean {
  return rotation % 180 !== 0;
}

/**
 * Maps a rectangle inside a box of `width` x `height` (before the rotation) to the same place in
 * the box after a clockwise `rotation`. Used to draw overlays, such as search highlights, that
 * were measured in unrotated page space.
 */
export function rotateRect(rect: Box, width: number, height: number, rotation: ViewRotation): Box {
  switch (rotation) {
    case 0:
      return { ...rect };
    case 90:
      return { x: height - (rect.y + rect.height), y: rect.x, width: rect.height, height: rect.width };
    case 180:
      return { x: width - (rect.x + rect.width), y: height - (rect.y + rect.height), width: rect.width, height: rect.height };
    case 270:
      return { x: rect.y, y: width - (rect.x + rect.width), width: rect.height, height: rect.width };
  }
}
