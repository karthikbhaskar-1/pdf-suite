import { describe, expect, it, vi } from 'vitest';
import { afterFrames, quiescePage } from './quiesce';

describe('afterFrames', () => {
  it('resolves after the requested number of frames', async () => {
    const queue: Array<() => void> = [];
    const raf = (cb: () => void) => void queue.push(cb);
    let done = false;
    void afterFrames(2, 1000, raf).then(() => (done = true));
    expect(queue.length).toBe(1);
    queue.shift()!();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(queue.length).toBe(1);
    queue.shift()!();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('gives up after the timeout when no frame is produced', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      void afterFrames(2, 100, () => undefined).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(99);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves at once when there is no frame source, after the timeout', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      void afterFrames(2, 50, undefined).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(51);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('quiescePage', () => {
  it('cancels every render job, then waits for the frames', async () => {
    const order: string[] = [];
    const scheduler = {
      cancelWhere: vi.fn((p: (k: string) => boolean) => {
        order.push(`cancel:${p('any-key')}`);
      }),
    };
    await quiescePage(scheduler, async () => void order.push('frames'));
    expect(order).toEqual(['cancel:true', 'frames']);
  });
});
