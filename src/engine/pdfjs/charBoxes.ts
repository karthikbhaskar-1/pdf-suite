/**
 * Per-character advance boxes for one pdf.js text item. pdf.js gives only the width of the whole
 * item, so each character's share is measured with canvas measureText in the item's font, and the
 * shares are scaled so they add up to the item's width. Kerning and spacing that the shares do not
 * capture are absorbed by that scaling, so the boxes stay inside the item.
 */

/** Size the glyphs are measured at. The result is scaled to the item width, so the size only sets precision. */
const MEASURE_PX = 100;
/** Cached advances per (font, character). Cleared when it grows past this, so it stays small. */
const MAX_CACHED = 20_000;

let measureContext: CanvasRenderingContext2D | null | undefined;
const advances = new Map<string, number>();

function canvasContext(): CanvasRenderingContext2D | null {
  if (measureContext === undefined) {
    try {
      measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  return measureContext ?? null;
}

/**
 * True when pdf.js has registered the font under `name` and it has finished loading. pdf.js adds the
 * embedded font to document.fonts under the item's font name, once the page has rendered.
 */
export function isFontRegistered(name: string): boolean {
  if (typeof document === 'undefined' || !document.fonts) return false;
  let found = false;
  document.fonts.forEach((face) => {
    if (face.family.replace(/^["']|["']$/g, '') === name && face.status === 'loaded') found = true;
  });
  return found;
}

/** Canvas font for an item: the registered font under its name, then the style's family, then a generic family. */
function canvasFont(fontName: string, fallbackFamily: string | undefined): string {
  const fallback = fallbackFamily ? `, "${fallbackFamily.replace(/["']/g, '')}"` : '';
  return `${MEASURE_PX}px "${fontName.replace(/["']/g, '')}"${fallback}, sans-serif`;
}

/**
 * Advance of each UTF-16 unit of `text` in the item's font, at MEASURE_PX. Returns null when there is
 * no canvas to measure with (for example in a test without a browser canvas).
 */
export function measureAdvances(text: string, fontName: string, fallbackFamily: string | undefined): number[] | null {
  const ctx = canvasContext();
  if (!ctx) return null;
  ctx.font = canvasFont(fontName, fallbackFamily);
  // Widths are cached only once the embedded font is in place. Before that, the fallback font is measured.
  const cacheable = isFontRegistered(fontName);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const key = `${fontName}\u0000${ch}`;
    let width = cacheable ? advances.get(key) : undefined;
    if (width === undefined) {
      width = ctx.measureText(ch).width;
      if (cacheable) {
        if (advances.size >= MAX_CACHED) advances.clear();
        advances.set(key, width);
      }
    }
    out.push(width);
  }
  return out;
}

/**
 * Splits `length` into contiguous boxes, one per advance, in proportion to the advances. The last box
 * ends exactly at `length`. When every advance is zero, the boxes are equal.
 */
export function proportionalBoxes(advanceList: readonly number[], length: number): Array<{ start: number; end: number }> {
  const count = advanceList.length;
  if (count === 0) return [];
  const total = advanceList.reduce((sum, value) => sum + Math.max(0, value), 0);
  const boxes: Array<{ start: number; end: number }> = [];
  let at = 0;
  advanceList.forEach((value, i) => {
    const share = total > 0 ? Math.max(0, value) / total : 1 / count;
    const start = at;
    at = i === count - 1 ? length : at + share * length;
    boxes.push({ start, end: at });
  });
  return boxes;
}
