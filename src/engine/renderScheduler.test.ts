import { describe, expect, it } from 'vitest';
import { Priority, RenderScheduler } from './renderScheduler';

/** A job that waits until released by the test. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('RenderScheduler', () => {
  it('runs at most the configured number of jobs at once, most urgent first', async () => {
    const scheduler = new RenderScheduler(2);
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const job = (name: string) => {
      const g = gate();
      gates.set(name, g);
      return scheduler.schedule(name, name.startsWith('v') ? Priority.Visible : Priority.Thumbnail, async () => {
        order.push(name);
        await g.promise;
        return name;
      });
    };

    const a = job('t1');
    const b = job('t2');
    const c = job('v1'); // queued after two running jobs, but more urgent than t3
    const d = job('t3');
    expect(order).toEqual(['t1', 't2']);

    gates.get('t1')?.release();
    await a.promise;
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['t1', 't2', 'v1']);

    gates.get('t2')?.release();
    gates.get('v1')?.release();
    gates.get('t3')?.release();
    await Promise.all([b.promise, c.promise, d.promise]);
    expect(order).toEqual(['t1', 't2', 'v1', 't3']);
  });

  it('removes a queued job when it is cancelled, so it never runs', async () => {
    const scheduler = new RenderScheduler(1);
    const running = gate();
    const first = scheduler.schedule('first', Priority.Visible, () => running.promise);
    let ran = false;
    const second = scheduler.schedule('second', Priority.Visible, async () => {
      ran = true;
    });

    second.cancel();
    await expect(second.promise).rejects.toMatchObject({ name: 'AbortError' });
    running.release();
    await first.promise;
    expect(ran).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('shares one promise between jobs with the same key', async () => {
    const scheduler = new RenderScheduler(2);
    let runs = 0;
    const run = async () => {
      runs += 1;
      return 42;
    };
    const one = scheduler.schedule('same', Priority.Prefetch, run);
    const two = scheduler.schedule('same', Priority.Visible, run);
    expect(await one.promise).toBe(42);
    expect(await two.promise).toBe(42);
    expect(runs).toBe(1);
  });
});

describe('RenderScheduler priorities follow the viewer', () => {
  it('orders visible pages, then text, then prefetch, then thumbnails', () => {
    expect(Priority.Visible).toBeLessThan(Priority.Text);
    expect(Priority.Text).toBeLessThan(Priority.Prefetch);
    expect(Priority.Prefetch).toBeLessThan(Priority.Thumbnail);
  });

  it('lowers the priority of a queued job as well as raising it, so a page that leaves the screen yields', async () => {
    const scheduler = new RenderScheduler(1);
    const running = gate();
    const blocker = scheduler.schedule('blocker', Priority.Visible, () => running.promise);
    const order: string[] = [];
    const a = scheduler.schedule('a', Priority.Visible, async () => void order.push('a'));
    const b = scheduler.schedule('b', Priority.Visible, async () => void order.push('b'));
    // a was visible when queued, and has scrolled away; b is now the visible one.
    scheduler.reprioritize('a', Priority.Prefetch);
    running.release();
    await Promise.all([blocker.promise, a.promise, b.promise]);
    expect(order).toEqual(['b', 'a']);
  });

  it('a second request for a queued key sets its priority, so the page it wants comes first', async () => {
    const scheduler = new RenderScheduler(1);
    const running = gate();
    const blocker = scheduler.schedule('blocker', Priority.Visible, () => running.promise);
    const order: string[] = [];
    const low = scheduler.schedule('low', Priority.Prefetch, async () => void order.push('low'));
    const other = scheduler.schedule('other', Priority.Text, async () => void order.push('other'));
    scheduler.schedule('low', Priority.Visible, async () => void order.push('never'));
    running.release();
    await Promise.all([blocker.promise, low.promise, other.promise]);
    expect(order).toEqual(['low', 'other']);
  });
});

describe('RenderScheduler pacing while the viewer scrolls fast', () => {
  /** A scheduler whose animation frames are advanced by the test. */
  function paced(concurrency = 4) {
    const frames: Array<() => void> = [];
    const scheduler = new RenderScheduler(concurrency, (callback) => void frames.push(callback));
    const nextFrame = async () => {
      const due = frames.splice(0);
      for (const callback of due) callback();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { scheduler, nextFrame, pendingFrames: () => frames.length };
  }
  const started = (order: string[], name: string) => async () => void order.push(name);

  it('starts at most one render per frame', async () => {
    const { scheduler, nextFrame } = paced();
    scheduler.setPaced(true);
    const order: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((n) => scheduler.schedule(n, Priority.Prefetch, started(order, n)));
    await Promise.resolve();
    expect(order).toEqual(['a']);
    await nextFrame();
    expect(order).toEqual(['a', 'b']);
    await nextFrame();
    await nextFrame();
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    await Promise.all(jobs.map((j) => j.promise));
  });

  it('never starts a queued render that was cancelled, and the cancelled one takes no frame', async () => {
    const { scheduler, nextFrame } = paced();
    scheduler.setPaced(true);
    const order: string[] = [];
    const a = scheduler.schedule('a', Priority.Visible, started(order, 'a'));
    const b = scheduler.schedule('b', Priority.Visible, started(order, 'b'));
    const c = scheduler.schedule('c', Priority.Visible, started(order, 'c'));
    b.cancel();
    await expect(b.promise).rejects.toMatchObject({ name: 'AbortError' });
    await nextFrame();
    await nextFrame();
    expect(order).toEqual(['a', 'c']);
    await Promise.all([a.promise, c.promise]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('leaves normal mode unchanged: everything starts at once up to the concurrency', async () => {
    const { scheduler, pendingFrames } = paced(3);
    const order: string[] = [];
    const running = gate();
    const jobs = ['a', 'b', 'c', 'd'].map((n) =>
      scheduler.schedule(n, Priority.Prefetch, async () => {
        order.push(n);
        await running.promise;
      }),
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(pendingFrames()).toBe(0);
    running.release();
    await Promise.all(jobs.map((j) => j.promise));
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the visible page first: it takes the next frame ahead of older, less urgent jobs', async () => {
    const { scheduler, nextFrame } = paced();
    scheduler.setPaced(true);
    const order: string[] = [];
    scheduler.schedule('first', Priority.Prefetch, started(order, 'first'));
    scheduler.schedule('p1', Priority.Prefetch, started(order, 'p1'));
    scheduler.schedule('t1', Priority.Thumbnail, started(order, 't1'));
    const visible = scheduler.schedule('visible', Priority.Visible, started(order, 'visible'));
    await nextFrame();
    expect(order).toEqual(['first', 'visible']);
    await nextFrame();
    await nextFrame();
    expect(order).toEqual(['first', 'visible', 'p1', 't1']);
    await visible.promise;
  });

  it('does not pace text jobs', async () => {
    const { scheduler } = paced();
    scheduler.setPaced(true);
    const order: string[] = [];
    scheduler.schedule('page', Priority.Visible, started(order, 'page'));
    scheduler.schedule('text1', Priority.Text, started(order, 'text1'));
    scheduler.schedule('text2', Priority.Text, started(order, 'text2'));
    await Promise.resolve();
    expect(order).toEqual(['page', 'text1', 'text2']);
  });

  it('starts the whole queue when pacing ends, without waiting for frames', async () => {
    const { scheduler } = paced();
    scheduler.setPaced(true);
    const order: string[] = [];
    const jobs = ['a', 'b', 'c'].map((n) => scheduler.schedule(n, Priority.Visible, started(order, n)));
    await Promise.resolve();
    expect(order).toEqual(['a']);
    scheduler.setPaced(false);
    await Promise.all(jobs.map((j) => j.promise));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a frame that never comes cannot stall the queue (the default frame has a timer fallback)', async () => {
    const scheduler = new RenderScheduler(2);
    scheduler.setPaced(true);
    const order: string[] = [];
    const jobs = ['a', 'b'].map((n) => scheduler.schedule(n, Priority.Visible, started(order, n)));
    await Promise.all(jobs.map((j) => j.promise));
    expect(order).toEqual(['a', 'b']);
  });
});
