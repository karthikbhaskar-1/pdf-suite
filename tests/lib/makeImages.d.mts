export function colourAt(x: number, y: number, w: number, h: number, seed?: number): [number, number, number];
export function rgbPixels(w: number, h: number, seed?: number): Uint8Array;
export function makePng(w: number, h: number, seed?: number, dpi?: number): Uint8Array;
export function makeBmp(w: number, h: number, seed?: number): Uint8Array;
export function makeGif(w: number, h: number, seed?: number): Uint8Array;
export function makeTiff(pages: Array<{ w: number; h: number; seed?: number; dpi?: number; orientation?: number }>): Uint8Array;
export function withExif(jpeg: Uint8Array, options?: { orientation?: number; dpi?: number }): Uint8Array;
export function makePackBitsFax(frames: number, w: number, h: number, stripe?: number): Uint8Array;
