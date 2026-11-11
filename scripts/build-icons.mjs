// Rasterizes build/icon.svg into the PNG sizes and a multi-size build/icon.ico.
// Run once with: node scripts/build-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, 'build');
const ICONS_DIR = join(BUILD_DIR, 'icons');
const SVG_PATH = join(BUILD_DIR, 'icon.svg');
const ICO_PATH = join(BUILD_DIR, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

mkdirSync(ICONS_DIR, { recursive: true });

const svg = readFileSync(SVG_PATH, 'utf8');
const pngs = [];
for (const size of SIZES) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  const outPath = join(ICONS_DIR, `icon-${size}.png`);
  writeFileSync(outPath, png);
  pngs.push(png);
  console.log(`wrote ${outPath} (${size}px)`);
}

const ico = await pngToIco(pngs);
writeFileSync(ICO_PATH, ico);
console.log(`wrote ${ICO_PATH} (${SIZES.join(', ')} px)`);
