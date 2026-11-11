// @vitest-environment jsdom
// File, Exit must not call window.close() in the desktop app: Electron destroys the window without running its 'close'
// handler for that, so the Save / Don't save / Cancel prompt was skipped. It asks the main process to close the window.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge } = vi.hoisted(() => ({
  bridge: {
    app: { requestClose: vi.fn(async () => undefined) },
    recent: { clear: vi.fn() },
  },
}));
vi.mock('../platform/desktop/bridge', () => ({ getDesktopBridge: () => bridge, pathSource: (path: string) => ({ kind: 'path', path }) }));

import { commands } from '../core/commands/registry';
import { registerMenuCommands } from './menuCommands';

beforeEach(() => {
  bridge.app.requestClose.mockClear();
});

describe('File, Exit', () => {
  it('asks the main process to close the window and does not call window.close()', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    registerMenuCommands();
    await commands.run('file.exit');
    expect(bridge.app.requestClose).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('is the only way out: no other source file closes the window from the page', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && /\bwindow\.close\(/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };
    walk(join(process.cwd(), 'src'));
    // menuCommands keeps the web build's fallback (no desktop bridge, nothing to ask).
    expect(offenders.map((p) => p.split('\\').join('/').split('/src/')[1])).toEqual(['app/menuCommands.ts']);
  });
});
