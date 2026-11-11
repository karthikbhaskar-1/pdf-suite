import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { registerBuiltins } from './registerBuiltins';

// Recovery reads IndexedDB, which jsdom does not have. The empty-state mount does not need it.
vi.mock('../features/recovery/recoveryService', () => ({
  openRecent: vi.fn(),
  restoreSession: vi.fn(async () => 0),
  startSnapshotWriter: vi.fn(() => () => undefined),
}));
vi.mock('../platform/recovery/fileCache', () => ({
  listRecentFiles: vi.fn(async () => []),
  getFile: vi.fn(async () => undefined),
  putFile: vi.fn(async () => undefined),
}));

describe('app shell', () => {
  it('mounts with the empty state and the top bar groups', () => {
    registerBuiltins();
    render(<App />);

    expect(screen.getByText('Drop a PDF here')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open PDF' })).toBeTruthy();
    // The top bar groups. The Zoom group moved to the status bar in 1.2.2, so it is no longer in the top bar.
    const toolbar = screen.getByRole('toolbar', { name: 'Toolbar' });
    expect(within(toolbar).getByRole('group', { name: 'File' })).toBeTruthy();
    expect(within(toolbar).getByRole('group', { name: 'Navigation' })).toBeTruthy();
    expect(within(toolbar).queryByRole('group', { name: 'Zoom' })).toBeNull();
    // The zoom controls are in the status bar, and are off while no file is open.
    const zoom = screen.getByRole('group', { name: 'Zoom' });
    expect(screen.getByRole('contentinfo').contains(zoom)).toBe(true);
    expect((within(zoom).getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('No file open')).toBeTruthy();
  });
});
