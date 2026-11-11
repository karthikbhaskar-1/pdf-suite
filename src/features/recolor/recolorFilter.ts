/**
 * Page recoloring as color matrices. Each mode becomes one feColorMatrix (4 rows of 5 values:
 * R, G, B, A each as a weighted sum of R, G, B, A plus an offset, on 0..1 channels).
 */

export type RecolorMode = 'off' | 'invert' | 'sepia' | 'night' | 'contrast' | 'custom';

export const RECOLOR_MODES: ReadonlyArray<{ mode: RecolorMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'invert', label: 'Invert' },
  { mode: 'sepia', label: 'Sepia' },
  { mode: 'night', label: 'Night' },
  { mode: 'contrast', label: 'High contrast' },
  { mode: 'custom', label: 'Custom' },
];

export interface RecolorSettings {
  mode: RecolorMode;
  /** Color that white paper becomes in Custom mode. "#rrggbb". */
  background: string;
  /** Color that black text becomes in Custom mode. "#rrggbb". */
  text: string;
}

export const DEFAULT_RECOLOR: RecolorSettings = {
  mode: 'off',
  background: '#fbf6ea',
  text: '#1d2026',
};

/** A 4x5 color matrix, row-major: 20 numbers. */
export type ColorMatrix = number[];

const INVERT: ColorMatrix = [
  -1, 0, 0, 0, 1,
  0, -1, 0, 0, 1,
  0, 0, -1, 0, 1,
  0, 0, 0, 1, 0,
];

const SEPIA: ColorMatrix = [
  0.393, 0.769, 0.189, 0, 0,
  0.349, 0.686, 0.168, 0, 0,
  0.272, 0.534, 0.131, 0, 0,
  0, 0, 0, 1, 0,
];

const CONTRAST: ColorMatrix = [
  1.8, 0, 0, 0, -0.4,
  0, 1.8, 0, 0, -0.4,
  0, 0, 1.8, 0, -0.4,
  0, 0, 0, 1, 0,
];

/** Rotates hue by `degrees`, using the SVG hueRotate formula. */
export function hueRotateMatrix(degrees: number): ColorMatrix {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0, 0,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** Composes two matrices: the result applies `second` first, then `first`. */
export function multiplyMatrices(first: ColorMatrix, second: ColorMatrix): ColorMatrix {
  const out: number[] = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (first[row * 5 + k] ?? 0) * (second[k * 5 + col] ?? 0);
      // The offset column of `first` multiplies the implicit 1 in the last row of `second`.
      if (col === 4) sum += first[row * 5 + 4] ?? 0;
      out.push(sum);
    }
  }
  return out;
}

/** "#rgb" or "#rrggbb" to channels in 0..1. Anything else falls back to `fallback`. */
export function parseHexColor(value: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m || !m[1]) return fallback;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const channel = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
  return [channel(0), channel(1), channel(2)];
}

/**
 * Custom mode maps luminance onto the two colors: black becomes `text`, white becomes
 * `background`, and everything between is a blend. Same as "text + (background - text) * luma".
 */
export function customMatrix(background: string, text: string): ColorMatrix {
  const [br, bg, bb] = parseHexColor(background, [1, 1, 1]);
  const [tr, tg, tb] = parseHexColor(text, [0, 0, 0]);
  const luma = [0.2126, 0.7152, 0.0722];
  const row = (target: number, offset: number) => [
    (target - offset) * luma[0]!,
    (target - offset) * luma[1]!,
    (target - offset) * luma[2]!,
    0,
    offset,
  ];
  // Each channel's target and offset come from the background and text colors.
  return [...row(br, tr), ...row(bg, tg), ...row(bb, tb), 0, 0, 0, 1, 0];
}

/** The color matrix for a recolor setting, or null when pages are shown as they are. */
export function recolorMatrix(settings: RecolorSettings): ColorMatrix | null {
  switch (settings.mode) {
    case 'off':
      return null;
    case 'invert':
      return INVERT;
    case 'sepia':
      return SEPIA;
    case 'night':
      // Invert first, then rotate hue by 180 degrees: dark paper with light text, colors kept.
      return multiplyMatrices(hueRotateMatrix(180), INVERT);
    case 'contrast':
      return CONTRAST;
    case 'custom':
      return customMatrix(settings.background, settings.text);
  }
}

/** The matrix as the `values` attribute of feColorMatrix. */
export function matrixValues(matrix: ColorMatrix): string {
  return matrix.map((n) => Number(n.toFixed(4))).join(' ');
}

/** Applies a matrix to one RGB color (0..1), clamping the result. For tests and previews. */
export function applyMatrix(matrix: ColorMatrix, rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const apply = (row: number) => {
    const value =
      (matrix[row * 5] ?? 0) * r + (matrix[row * 5 + 1] ?? 0) * g + (matrix[row * 5 + 2] ?? 0) * b + (matrix[row * 5 + 4] ?? 0);
    return Math.min(1, Math.max(0, value));
  };
  return [apply(0), apply(1), apply(2)];
}
