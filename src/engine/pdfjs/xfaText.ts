/**
 * The text of an XFA page, as search runs. pdf.js returns an XFA page's text from getTextContent without any
 * position (each item has only its string). The XFA tree that getXfa returns has the positions: each element's
 * left and top are relative to its parent, and a wrapper element has the field's width and height. A text value
 * takes the box of its nearest sized ancestor, so a match highlights its field. The boxes are approximate within
 * a field, and exact for a field with one text value.
 */
import type { TextRun } from '../types';

/** One node of the XFA tree, as pdf.js returns it. Only the parts read here are typed. */
export interface XfaNode {
  name: string;
  value?: string;
  attributes?: { style?: Record<string, string> };
  children?: XfaNode[];
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number | null;
}

function pixels(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Text runs of an XFA page tree, in reading order, in page points (top-left origin, unrotated). */
export function xfaTextRuns(root: XfaNode): TextRun[] {
  const runs: TextRun[] = [];
  const visit = (node: XfaNode, originX: number, originY: number, box: Box | null): void => {
    const style = node.attributes?.style ?? {};
    const x = originX + (pixels(style.left) ?? 0);
    const y = originY + (pixels(style.top) ?? 0);
    const width = pixels(style.width);
    const height = pixels(style.height);
    const fontSize = pixels(style.fontSize) ?? box?.fontSize ?? null;
    const own: Box | null = width !== undefined && height !== undefined ? { x, y, width, height, fontSize } : box;
    if (own && typeof node.value === 'string' && node.value.trim() !== '') {
      const size = own.fontSize ?? own.height;
      runs.push({
        text: node.value,
        origin: { x: own.x, y: own.y + own.height },
        along: { x: own.width, y: 0 },
        up: { x: 0, y: -size },
      });
    }
    for (const child of node.children ?? []) visit(child, x, y, own ? { ...own, fontSize } : box);
  };
  visit(root, 0, 0, null);
  return runs;
}
