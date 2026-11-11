// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISK_WATCH_INTERVAL_MS, fileChanged, startDiskWatch } from './diskWatch';
import type { FileStat } from '../../platform/desktop/contract';

const SEEN: FileStat = { size: 1000, modified: 1_700_000_000_000 } as FileStat;

/** Lets the pending stat promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fileChanged', () => {
  it('is false for the same size and modified time, and true for a change or a missing file', () => {
    expect(fileChanged(SEEN, { ...SEEN })).toBe(false);
    expect(fileChanged(SEEN, { ...SEEN, size: 1001 })).toBe(true);
    expect(fileChanged(SEEN, { ...SEEN, modified: SEEN.modified + 1 })).toBe(true);
    expect(fileChanged(SEEN, null)).toBe(true);
  });
});

describe('startDiskWatch', () => {
  it('checks every 5 seconds and reports a change once', async () => {
    let current: FileStat | null = { ...SEEN };
    const stat = vi.fn(async () => current);
    const onChanged = vi.fn();
    const target = new EventTarget();
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat, isActive: () => true, onChanged, target });

    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();

    current = { ...SEEN, size: 2000 };
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(onChanged).toHaveBeenCalledTimes(1);

    // The watch has reported; it does not report the change again. (Changed in 1.2.2: it goes on looking, only for a file
    // that goes missing while the user is still deciding.)
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 3);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('after a change was reported, a file that then goes missing still gets its one notice', async () => {
    let current: FileStat | null = { ...SEEN, size: 2000 };
    const onChanged = vi.fn();
    const onMissing = vi.fn();
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat: async () => current, isActive: () => true, onChanged, onMissing, target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(onChanged).toHaveBeenCalledTimes(1);
    current = null;
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 3);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('also checks when the window gets focus', async () => {
    const stat = vi.fn(async () => ({ ...SEEN, size: 1 }) as FileStat);
    const onChanged = vi.fn();
    const target = new EventTarget();
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat, isActive: () => true, onChanged, target });
    target.dispatchEvent(new Event('focus'));
    await settle();
    expect(stat).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not report the app’s own save', async () => {
    const stat = vi.fn(async () => ({ ...SEEN, size: 5 }) as FileStat);
    const onChanged = vi.fn();
    let saving = true;
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat, isActive: () => true, isSaving: () => saving, onChanged, target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(stat).not.toHaveBeenCalled();
    saving = false;
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('compares with the stamp left by a save that finished while the stat ran', async () => {
    let stamp: FileStat | undefined = { ...SEEN };
    let resolveStat!: (value: FileStat | null) => void;
    const stat = vi.fn(() => new Promise<FileStat | null>((resolve) => (resolveStat = resolve)));
    const onChanged = vi.fn();
    startDiskWatch({ path: 'a.pdf', seen: () => stamp, stat, isActive: () => true, onChanged, target: new EventTarget() });
    const pending = vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    await pending;
    // The app saved: the disk now has the new size, and the new stamp is recorded before the stat returns.
    stamp = { ...SEEN, size: 3000 };
    resolveStat({ ...SEEN, size: 3000 });
    await settle();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('stops by itself once the document is closed', async () => {
    let open = true;
    const stat = vi.fn(async () => ({ ...SEEN, size: 9 }) as FileStat);
    const onChanged = vi.fn();
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat, isActive: () => open, onChanged, target: new EventTarget() });
    open = false;
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 2);
    expect(stat).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  // Changed in 1.2.2 (orchestrator ruling): a file that is gone is not a "changed on disk" choice. There is nothing to reload,
  // and Save creates the file again. The watch says so once, quietly, and goes on.
  it('a file that is gone is reported once as missing, not as changed, and the watch goes on', async () => {
    const onChanged = vi.fn();
    const onMissing = vi.fn();
    const stat = vi.fn(async () => null);
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat, isActive: () => true, onChanged, onMissing, target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 4);
    expect(stat).toHaveBeenCalledTimes(4);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reports a missing file again only after it has been seen again', async () => {
    let current: FileStat | null = null;
    const onChanged = vi.fn();
    const onMissing = vi.fn();
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat: async () => current, isActive: () => true, onChanged, onMissing, target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 2);
    expect(onMissing).toHaveBeenCalledTimes(1);
    current = { ...SEEN }; // back, as it was
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(onChanged).not.toHaveBeenCalled();
    current = null;
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(onMissing).toHaveBeenCalledTimes(2);
  });

  it('says when a file reported missing is seen in its place again (once)', async () => {
    let current: FileStat | null = null;
    const onMissing = vi.fn();
    const onFound = vi.fn();
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat: async () => current, isActive: () => true, onChanged: vi.fn(), onMissing, onFound, target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 2);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
    current = { ...SEEN };
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 3);
    expect(onFound).toHaveBeenCalledTimes(1);
  });

  it('a file that comes back different is a change to choose about', async () => {
    let current: FileStat | null = null;
    const onChanged = vi.fn();
    startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat: async () => current, isActive: () => true, onChanged, onMissing: vi.fn(), target: new EventTarget() });
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    current = { ...SEEN, size: SEEN.size + 1 };
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('the returned function stops the watch', async () => {
    const stat = vi.fn(async () => ({ ...SEEN, size: 9 }) as FileStat);
    const stop = startDiskWatch({ path: 'a.pdf', seen: () => SEEN, stat, isActive: () => true, onChanged: vi.fn(), target: new EventTarget() });
    stop();
    await vi.advanceTimersByTimeAsync(DISK_WATCH_INTERVAL_MS * 2);
    expect(stat).not.toHaveBeenCalled();
  });
});
