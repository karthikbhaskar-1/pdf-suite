// Starts the Vite dev server, builds the Electron bundles, and launches the desktop app against the
// dev server. Editing renderer code hot-reloads. Editing electron/ needs this command run again.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { buildElectron } from './build-electron.mjs';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const PORT = 5173;

const server = await createServer({ server: { port: PORT, strictPort: true } });
await server.listen();
await buildElectron();

const child = spawn(electronBinary, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${PORT}` },
});

const stop = (code) => {
  void server.close().finally(() => process.exit(code));
};
child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => child.kill());
