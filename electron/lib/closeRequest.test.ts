import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CloseRequest, NOT_RESPONDING_BOX, askWaitOrClose, cancelOnRendererTrouble } from './closeRequest';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CloseRequest', () => {
  it('closes after the timeout when the page never acknowledges (a hung renderer)', async () => {
    const send = vi.fn();
    const request = new CloseRequest(60_000, send);
    const result = request.start();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    let done = false;
    void result.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(result).resolves.toBe('close');
  });

  it('once the page has acknowledged there is no timeout: the prompt waits for the user', async () => {
    const request = new CloseRequest(60_000, vi.fn());
    const result = request.start();
    request.acknowledge();
    let decided: string | null = null;
    void result.then((d) => (decided = d));
    // An hour with the prompt on screen: the window is still waiting.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(decided).toBeNull();
    request.answer('cancel');
    await expect(result).resolves.toBe('cancel');
  });

  it('takes the answer of a page that acknowledged and then answered Save or Don\'t save', async () => {
    const request = new CloseRequest(1000, vi.fn());
    const result = request.start();
    request.acknowledge();
    request.answer('close');
    await expect(result).resolves.toBe('close');
  });

  it('ignores an answer or an acknowledgement after the request ended', async () => {
    const request = new CloseRequest(1000, vi.fn());
    const result = request.start();
    await vi.advanceTimersByTimeAsync(1001);
    await expect(result).resolves.toBe('close');
    expect(() => {
      request.answer('cancel');
      request.acknowledge();
    }).not.toThrow();
  });

  it.each(['render-process-gone', 'did-start-loading', 'unresponsive'])(
    'a renderer that %s after acknowledging settles the request as cancel, so the next close starts fresh',
    async (event) => {
      const contents = new EventEmitter();
      let current: CloseRequest | null = null;
      cancelOnRendererTrouble(contents, () => current);
      current = new CloseRequest(60_000, vi.fn());
      const result = current.start();
      current.acknowledge();
      contents.emit(event);
      await expect(result).resolves.toBe('cancel');
      // The next attempt is a new request, and it is not stuck behind the old one.
      const next = new CloseRequest(60_000, vi.fn());
      current = next;
      const second = next.start();
      next.answer('close');
      await expect(second).resolves.toBe('close');
    },
  );

  it('after an unresponsive cancel, the next attempt to a hung page (no acknowledgement) falls back to the timeout', async () => {
    const contents = new EventEmitter();
    let current: CloseRequest | null = null;
    cancelOnRendererTrouble(contents, () => current);
    current = new CloseRequest(60_000, vi.fn());
    const first = current.start();
    current.acknowledge();
    contents.emit('unresponsive');
    await expect(first).resolves.toBe('cancel');
    current = new CloseRequest(60_000, vi.fn());
    const retry = current.start();
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(retry).resolves.toBe('close');
  });

  it('an event with no request in flight does nothing', () => {
    const contents = new EventEmitter();
    cancelOnRendererTrouble(contents, () => null);
    expect(() => contents.emit('unresponsive')).not.toThrow();
  });
});

describe('answer() says whether the request was live (1.5.1 M3)', () => {
  it('true for the answer that settles a live request, false for a late answer after the request ended', async () => {
    const request = new CloseRequest(60_000, vi.fn());
    const result = request.start();
    request.acknowledge();
    expect(request.answer('close')).toBe(true);
    await expect(result).resolves.toBe('close');
    expect(request.answer('close')).toBe(false);
  });

  it('a late "Don\'t save" after an unresponsive cancel is not live, so the caller must not clear the recovery logs', async () => {
    const contents = new EventEmitter();
    let current: CloseRequest | null = null;
    cancelOnRendererTrouble(contents, () => current);
    current = new CloseRequest(60_000, vi.fn());
    const result = current.start();
    current.acknowledge();
    contents.emit('unresponsive');
    await expect(result).resolves.toBe('cancel');
    // The page, which was only slow, now answers.
    expect(current.answer('close')).toBe(false);
  });

  it('tells the page when the request ends as cancel (once), and not when the page itself answered', async () => {
    const onCancelled = vi.fn();
    const request = new CloseRequest(60_000, vi.fn(), { onCancelled });
    const result = request.start();
    request.acknowledge();
    request.cancel();
    request.cancel();
    await expect(result).resolves.toBe('cancel');
    expect(onCancelled).toHaveBeenCalledTimes(1);
    const answered = new CloseRequest(60_000, vi.fn(), { onCancelled });
    const second = answered.start();
    answered.answer('cancel');
    await second;
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });
});

describe('a page that does not answer: the Wait / Close question (1.5.1 M4)', () => {
  it('the box says exactly what the spec says; Wait is the default and also what Esc and the close button mean', () => {
    expect(NOT_RESPONDING_BOX).toMatchObject({
      title: 'PDF Suite',
      message: 'PDF Suite is not responding.',
      detail:
        'You can wait for it, or close it now. If you close it now, PDF Suite will try to bring back your unsaved changes the next time it starts, but some may be lost.',
      buttons: ['Wait', 'Close'],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it('askWaitOrClose maps the buttons: Wait (0) waits, Close (1) closes', async () => {
    const signal = new AbortController().signal;
    expect(await askWaitOrClose(async () => ({ response: 0 }), signal)).toBe('wait');
    expect(await askWaitOrClose(async () => ({ response: 1 }), signal)).toBe('close');
  });

  it('after the timeout it asks; Wait runs the 60 s timer again and asks again, with no limit; Close ends it as close', async () => {
    const answers: Array<'wait' | 'close'> = ['wait', 'wait', 'close'];
    const onNoAnswer = vi.fn(async () => answers.shift()!);
    const request = new CloseRequest(60_000, vi.fn(), { onNoAnswer });
    const result = request.start();
    let done = false;
    void result.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(onNoAnswer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(onNoAnswer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onNoAnswer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onNoAnswer).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(onNoAnswer).toHaveBeenCalledTimes(3);
    await expect(result).resolves.toBe('close');
  });

  it('the window never closes while the box is up and nobody has chosen', async () => {
    const request = new CloseRequest(1000, vi.fn(), { onNoAnswer: () => new Promise(() => undefined) });
    const result = request.start();
    let done = false;
    void result.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(done).toBe(false);
  });

  it('if the page wakes up and acknowledges while the box is up, the box is taken down and the prompt takes over', async () => {
    let dismissed: AbortSignal | undefined;
    const onNoAnswer = vi.fn(
      (signal: AbortSignal) =>
        new Promise<'wait' | 'close'>((_resolve, reject) => {
          dismissed = signal;
          signal.addEventListener('abort', () => reject(new Error('dismissed')));
        }),
    );
    const request = new CloseRequest(1000, vi.fn(), { onNoAnswer });
    const result = request.start();
    await vi.advanceTimersByTimeAsync(1001);
    expect(dismissed?.aborted).toBe(false);
    request.acknowledge();
    expect(dismissed?.aborted).toBe(true);
    // The dismissed box does not close the window: the page now owns the decision, with no timeout.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    request.answer('cancel');
    await expect(result).resolves.toBe('cancel');
  });

  it('a box that cannot be shown closes the window (the recovery logs are kept), as a hung page always did', async () => {
    const request = new CloseRequest(1000, vi.fn(), { onNoAnswer: async () => { throw new Error('no box'); } });
    const result = request.start();
    await vi.advanceTimersByTimeAsync(1001);
    await expect(result).resolves.toBe('close');
  });
});

describe('answerAfter: work before the window closes, only for a live request (1.5.1 M3)', () => {
  it('runs the work, then settles; the window closes only after the work finished', async () => {
    const request = new CloseRequest(60_000, vi.fn());
    const result = request.start();
    request.acknowledge();
    const order: string[] = [];
    void result.then(() => order.push('closed'));
    expect(
      await request.answerAfter('close', async () => {
        await Promise.resolve();
        order.push('cleared');
      }),
    ).toBe(true);
    await result;
    expect(order).toEqual(['cleared', 'closed']);
  });

  it('a stale answer (the request already ended as cancel) does not run the work at all', async () => {
    const request = new CloseRequest(60_000, vi.fn());
    const result = request.start();
    request.acknowledge();
    request.cancel();
    await result;
    const work = vi.fn(async () => undefined);
    expect(await request.answerAfter('close', work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it('while the work runs, an unresponsive cancel cannot end the request: the accepted answer stands', async () => {
    const request = new CloseRequest(60_000, vi.fn());
    const result = request.start();
    request.acknowledge();
    let release: () => void = () => undefined;
    const answered = request.answerAfter('close', () => new Promise<void>((resolve) => (release = resolve)));
    request.cancel();
    release();
    expect(await answered).toBe(true);
    await expect(result).resolves.toBe('close');
  });

  it('work that fails does not keep the window open', async () => {
    const request = new CloseRequest(60_000, vi.fn());
    const result = request.start();
    request.acknowledge();
    await request.answerAfter('close', async () => {
      throw new Error('disk');
    });
    await expect(result).resolves.toBe('close');
  });

  it('a second answer while the first is being handled is refused', async () => {
    const request = new CloseRequest(60_000, vi.fn());
    void request.start();
    request.acknowledge();
    let release: () => void = () => undefined;
    const first = request.answerAfter('close', () => new Promise<void>((resolve) => (release = resolve)));
    expect(await request.answerAfter('close', async () => undefined)).toBe(false);
    expect(request.answer('cancel')).toBe(false);
    release();
    await first;
  });
});
