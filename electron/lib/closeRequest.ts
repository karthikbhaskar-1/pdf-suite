import type { CloseDecision } from '../../src/platform/desktop/contract';

/** What a close request does besides waiting (see CloseRequest). */
export interface CloseRequestHooks {
  /**
   * The page did not acknowledge in time. Resolves 'wait' (ask the page again after another timeout) or 'close'. The signal
   * is aborted when the question is no longer needed, so the box can be taken down.
   */
  onNoAnswer?(dismissed: AbortSignal): Promise<'wait' | 'close'>;
  /** The request ended as 'cancel' because the renderer is gone, reloading or hung: tell the page the prompt is stale. */
  onCancelled?(): void;
}

/** The options of the "not responding" box, in the words of docs/milestone-1.5/1.5.5-ui-spec.md section 6.3. */
export const NOT_RESPONDING_BOX = {
  title: 'PDF Suite',
  message: 'PDF Suite is not responding.',
  detail:
    'You can wait for it, or close it now. If you close it now, PDF Suite will try to bring back your unsaved changes the next time it starts, but some may be lost.',
  buttons: ['Wait', 'Close'],
  /** Wait is the default, and Esc and the box's close button also mean Wait. */
  defaultId: 0,
  cancelId: 0,
  noLink: true,
} as const;

/** Shows the box (`show` is dialog.showMessageBox without a parent window, with a signal) and returns the user's choice. */
export async function askWaitOrClose(
  show: (options: typeof NOT_RESPONDING_BOX, dismissed: AbortSignal) => Promise<{ response: number }>,
  dismissed: AbortSignal,
): Promise<'wait' | 'close'> {
  const { response } = await show(NOT_RESPONDING_BOX, dismissed);
  return response === 1 ? 'close' : 'wait';
}

/**
 * One close request to the page: "may this window close?". The page answers 'close' or 'cancel'; with unsaved edits the
 * answer waits for the user (Save / Don't save / Cancel).
 *
 * There are two stages. Until the page ACKNOWLEDGES the request, a timer runs: a page that never acknowledges (a hung
 * renderer) must not keep the window open for ever. When the timer fires the request asks the user (hooks.onNoAnswer: a
 * "PDF Suite is not responding. Wait / Close" box), and ends as 'close' only if the user chooses Close; Wait runs the timer
 * again, with no limit. Without that hook the request ends as 'close' at once, as before. Once the page has acknowledged,
 * it is showing the prompt (or answering at once), and there is no timeout at all: the window waits for the user, however
 * long that takes. A timeout there would close the window over a prompt that is still on screen.
 *
 * An answer is accepted only while the request is live. answer() says whether it was, so the caller can act on the
 * answer's side effects (clearing recovery logs) only for a live request: a late answer to a request that already ended
 * changes nothing.
 */
export class CloseRequest {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settle: ((decision: CloseDecision) => void) | null = null;
  private acknowledged = false;
  /** True while an accepted answer runs its work before settling (answerAfter): nothing else may end the request then. */
  private answering = false;
  /** Aborted when the question to the user is no longer needed (the page answered, or the request ended). */
  private box: AbortController | undefined;

  /**
   * @param ackTimeoutMs how long the page has to acknowledge
   * @param send sends the request to the page
   * @param hooks what to do when the page does not answer in time, and when the request is cancelled
   */
  constructor(
    private readonly ackTimeoutMs: number,
    private readonly send: () => void,
    private readonly hooks: CloseRequestHooks = {},
  ) {}

  /** Sends the request. Resolves with the page's answer, or 'close' when the page never acknowledged and the user chose Close. */
  start(): Promise<CloseDecision> {
    return new Promise((resolve) => {
      this.settle = (decision) => {
        clearTimeout(this.timer);
        this.box?.abort();
        this.settle = null;
        resolve(decision);
      };
      this.arm();
      this.send();
    });
  }

  private arm(): void {
    this.timer = setTimeout(() => void this.timedOut(), this.ackTimeoutMs);
  }

  /** The page did not acknowledge in time. */
  private async timedOut(): Promise<void> {
    this.timer = undefined;
    const settle = this.settle;
    if (!settle || this.acknowledged || this.answering) return;
    if (!this.hooks.onNoAnswer) {
      settle('close');
      return;
    }
    const box = new AbortController();
    this.box = box;
    let choice: 'wait' | 'close';
    try {
      choice = await this.hooks.onNoAnswer(box.signal);
    } catch {
      // The question could not be shown. A hung page must not keep the window open for ever, and the recovery logs are kept.
      choice = 'close';
    }
    if (this.box === box) this.box = undefined;
    // The request ended, or the page woke up and acknowledged, while the question was up: its answer no longer matters.
    if (this.settle !== settle || this.acknowledged || this.answering) return;
    if (choice === 'close') settle('close');
    else this.arm();
  }

  /** The page got the request. From here on there is no timeout, and a question to the user about it goes away. */
  acknowledge(): void {
    if (!this.settle) return;
    this.acknowledged = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.box?.abort();
  }

  /** The page's answer. Ignored when the request has ended. Returns whether the request was still live. */
  answer(decision: CloseDecision): boolean {
    if (!this.settle || this.answering) return false;
    this.settle(decision);
    return true;
  }

  /**
   * The page's answer, with work that must be done BEFORE the window may close, and only for a live request (the recovery
   * logs a "Don't save" removes). The answer is accepted first, so the request can no longer end as cancel while `beforeSettle`
   * runs, and the window closes only after it has finished. Returns false, without running `beforeSettle`, when the request
   * has ended or is already being answered.
   */
  async answerAfter(decision: CloseDecision, beforeSettle: () => Promise<void>): Promise<boolean> {
    if (!this.settle || this.answering) return false;
    this.answering = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.box?.abort();
    try {
      await beforeSettle();
    } catch {
      // The window still closes as the user chose; what could not be removed stays on disk (a recovery copy is offered later).
    }
    this.answering = false;
    this.settle?.(decision);
    return true;
  }

  /**
   * Ends the request as 'cancel' (the renderer it was asked of is gone, reloading or hung) and tells the hook, so the page can
   * take its prompt down. Ignored when it has ended.
   */
  cancel(): void {
    if (!this.settle || this.answering) return;
    this.settle('cancel');
    this.hooks.onCancelled?.();
  }

  /** Whether the page has acknowledged this request. */
  get isAcknowledged(): boolean {
    return this.acknowledged;
  }
}

/** The part of a web contents that cancelOnRendererTrouble listens to. */
export interface RendererEvents {
  on(event: 'render-process-gone' | 'did-start-loading' | 'unresponsive', listener: () => void): unknown;
}

/**
 * A close request that was acknowledged but never answered (the renderer crashed, reloaded, or hung while the prompt was
 * up) would stay open for ever and block every later close attempt. These three events therefore end it as 'cancel', so
 * the next attempt starts fresh. After an 'unresponsive' cancel the next attempt is not acknowledged by the hung page, so
 * it falls back to the ordinary no-acknowledgement timeout and the window still closes.
 */
export function cancelOnRendererTrouble(contents: RendererEvents, current: () => CloseRequest | null): void {
  for (const event of ['render-process-gone', 'did-start-loading', 'unresponsive'] as const) {
    contents.on(event, () => current()?.cancel());
  }
}
