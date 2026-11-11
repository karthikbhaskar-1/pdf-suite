// Writes the fixtures the app-level probes use (built with the same tree builder as the engine probes).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { buildTree, reopen } from './e-lib';

const OUT = join(tmpdir(), 'pdfsuite-so7', 'fx') + '/';
it('fixtures', () => {
  mkdirSync(OUT, { recursive: true });
  const leaf = (name: string) => ({ name });
  const files = {
    // Three wide pages straight under the root, then a section whose /Pages node says /Rotate 90 (one page in it).
    'boundary-rotate.pdf': buildTree({ attrs: { MediaBox: [0, 0, 800, 500], font: 'Helvetica' }, kids: [leaf('wa'), leaf('wb'), leaf('wc'), { attrs: { Rotate: 90 }, kids: [leaf('rd')] }] }).bytes,
    // Two wide pages, then a section whose /Pages node carries a /CropBox.
    'boundary-crop.pdf': buildTree({ attrs: { MediaBox: [0, 0, 800, 500], font: 'Helvetica' }, kids: [leaf('wa'), leaf('wb'), { attrs: { CropBox: [100, 50, 700, 450] }, kids: [leaf('cc')] }] }).bytes,
    // The same shape with every attribute on the pages themselves: the control.
    'flat5.pdf': buildTree({ attrs: { MediaBox: [0, 0, 800, 500], font: 'Helvetica' }, kids: [leaf('fa'), leaf('fb'), leaf('fc'), leaf('fd'), leaf('fe')] }).bytes,
  };
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(OUT + name, bytes);
    expect(reopen(bytes).countPages()).toBeGreaterThan(2);
  }
});
