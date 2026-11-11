// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrantPersistence } from './grantPersistence';

describe('GrantPersistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes once, after the pause, for a burst of changes', async () => {
    const write = vi.fn(async (_target: string, _bytes: Uint8Array) => undefined);
    let list = ['a'];
    const persist = new GrantPersistence('f.json', () => list, 250, write);
    persist.schedule();
    list = ['a', 'b'];
    persist.schedule();
    persist.schedule();
    await vi.advanceTimersByTimeAsync(249);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(write.mock.calls[0]![1])).toBe('["a","b"]');
  });

  it('flush writes a pending change at once', async () => {
    const write = vi.fn(async (_target: string, _bytes: Uint8Array) => undefined);
    const persist = new GrantPersistence('f.json', () => ['x'], 250, write);
    persist.schedule();
    expect(persist.pending).toBe(true);
    await persist.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(persist.pending).toBe(false);
  });

  it('never overlaps writes: a change during a write is written after it', async () => {
    let release!: () => void;
    const order: string[] = [];
    const write = vi.fn((_target: string, bytes: Uint8Array) => {
      order.push(`start ${new TextDecoder().decode(bytes)}`);
      return new Promise<void>((resolve) => {
        release = () => {
          order.push('end');
          resolve();
        };
      });
    });
    let list = ['one'];
    const persist = new GrantPersistence('f.json', () => list, 250, write);
    persist.schedule();
    const first = persist.flush();
    list = ['one', 'two'];
    persist.schedule();
    await vi.advanceTimersByTimeAsync(300);
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    release();
    await first;
    expect(order[0]).toBe('start ["one"]');
    expect(order[1]).toBe('end');
    expect(order[2]).toBe('start ["one","two"]');
  });

  it('two flushes that wait for the same write both wait for the write that follows it (no overlap, no early resolve)', async () => {
    const releases: Array<() => void> = [];
    let running = 0;
    let maxRunning = 0;
    const write = vi.fn(() => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<void>((resolve) => {
        releases.push(() => {
          running -= 1;
          resolve();
        });
      });
    });
    let list = ['one'];
    const persist = new GrantPersistence('f.json', () => list, 250, write);
    persist.schedule();
    const first = persist.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    list = ['one', 'two'];
    persist.schedule();
    let resolvedA = false;
    let resolvedB = false;
    const a = persist.flush().then(() => (resolvedA = true));
    const b = persist.flush().then(() => (resolvedB = true));
    await vi.advanceTimersByTimeAsync(0);
    releases[0]!();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(0);
    // The second write is in flight: neither flush may have resolved, and the writes never ran together.
    expect(resolvedA).toBe(false);
    expect(resolvedB).toBe(false);
    releases[1]!();
    await Promise.all([first, a, b]);
    expect(maxRunning).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('keeps the change pending when a write fails, so the next change retries it', async () => {
    const write = vi.fn(async () => {
      throw new Error('disk full');
    });
    const persist = new GrantPersistence('f.json', () => ['p'], 250, write);
    persist.schedule();
    await persist.flush();
    expect(persist.pending).toBe(true);
  });

  it('dispose cancels a scheduled write', async () => {
    const write = vi.fn(async (_target: string, _bytes: Uint8Array) => undefined);
    const persist = new GrantPersistence('f.json', () => [], 250, write);
    persist.schedule();
    persist.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
  });
});
