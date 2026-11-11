// Bundles the Electron main process and preload into electron-dist/ as CommonJS.
// The preload runs in Electron's sandbox, which accepts only a single self-contained file, so every
// module it uses is bundled into it. Electron itself stays external.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function buildElectron() {
  const shared = {
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'warning',
  };
  await build({ ...shared, entryPoints: ['electron/main.ts'], outfile: 'electron-dist/main.cjs' });
  await build({ ...shared, entryPoints: ['electron/preload.ts'], outfile: 'electron-dist/preload.cjs' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildElectron();
  console.log('Electron bundles written to electron-dist/');
}
