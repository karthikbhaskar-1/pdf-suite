import { describe, expect, it } from 'vitest';
import {
  applyMatrix,
  customMatrix,
  hueRotateMatrix,
  matrixValues,
  multiplyMatrices,
  parseHexColor,
  recolorMatrix,
  type ColorMatrix,
  type RecolorSettings,
} from './recolorFilter';

const WHITE: [number, number, number] = [1, 1, 1];
const BLACK: [number, number, number] = [0, 0, 0];

function near(actual: [number, number, number], expected: [number, number, number]) {
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 2));
}

const settings = (mode: RecolorSettings['mode'], background = '#ffffff', text = '#000000'): RecolorSettings => ({
  mode,
  background,
  text,
});

describe('recolorMatrix', () => {
  it('returns no matrix when recoloring is off', () => {
    expect(recolorMatrix(settings('off'))).toBeNull();
  });

  it('inverts white to black and black to white', () => {
    const m = recolorMatrix(settings('invert')) as ColorMatrix;
    near(applyMatrix(m, WHITE), BLACK);
    near(applyMatrix(m, BLACK), WHITE);
  });

  it('night mode gives dark paper with light text', () => {
    const m = recolorMatrix(settings('night')) as ColorMatrix;
    near(applyMatrix(m, WHITE), BLACK);
    expect(applyMatrix(m, BLACK)[0]).toBeGreaterThan(0.9);
  });

  it('high contrast pushes mid greys toward the extremes', () => {
    const m = recolorMatrix(settings('contrast')) as ColorMatrix;
    expect(applyMatrix(m, [0.4, 0.4, 0.4])[0]).toBeLessThan(0.4);
    expect(applyMatrix(m, [0.6, 0.6, 0.6])[0]).toBeGreaterThan(0.6);
  });

  it('sepia tints grey toward a warm colour', () => {
    const [r, g, b] = applyMatrix(recolorMatrix(settings('sepia')) as ColorMatrix, [0.5, 0.5, 0.5]);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});

describe('custom recolor', () => {
  it('maps black to the text colour and white to the background colour', () => {
    const m = customMatrix('#fbf6ea', '#1d2026');
    near(applyMatrix(m, BLACK), parseHexColor('#1d2026', [0, 0, 0]));
    near(applyMatrix(m, WHITE), parseHexColor('#fbf6ea', [1, 1, 1]));
  });

  it('blends greys between the two colours', () => {
    expect(applyMatrix(customMatrix('#ffffff', '#000000'), [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.5, 1);
  });

  it('falls back to white and black for colour text that does not parse', () => {
    const m = customMatrix('not a colour', '#zzz');
    near(applyMatrix(m, WHITE), WHITE);
    near(applyMatrix(m, BLACK), BLACK);
  });
});

describe('colour helpers', () => {
  it('parses six and three digit hex colours', () => {
    expect(parseHexColor('#ff8000', [0, 0, 0])[1]).toBeCloseTo(128 / 255);
    expect(parseHexColor('#f00', [0, 0, 0])).toEqual([1, 0, 0]);
  });

  it('composes matrices so that the second one is applied first', () => {
    const identity = multiplyMatrices(hueRotateMatrix(0), hueRotateMatrix(0));
    near(applyMatrix(identity, [0.2, 0.5, 0.9]), [0.2, 0.5, 0.9]);
  });

  it('writes the matrix as twenty space-separated numbers', () => {
    const values = matrixValues(recolorMatrix(settings('invert')) as ColorMatrix);
    expect(values.split(' ')).toHaveLength(20);
  });
});
