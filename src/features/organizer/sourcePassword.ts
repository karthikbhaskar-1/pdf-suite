import { useUiStore } from '../../core/stores/uiStore';

/**
 * The password prompt for a PDF picked in Insert or Replace. The password is handed straight to the caller and kept
 * nowhere else: not in a store, a log, the recovery files or the recent list.
 */

let waiting: ((password: string | null) => void) | null = null;

/**
 * Opens the prompt for the file `name` and resolves with what the user typed, or null when they cancelled. `error` is
 * the plain message shown above the box after a wrong try.
 */
export function askSourcePassword(name: string, error: string | null = null): Promise<string | null> {
  // A second request while one is open cancels the first, so nothing waits forever.
  waiting?.(null);
  return new Promise((resolve) => {
    waiting = resolve;
    useUiStore.getState().setSourcePassword({ name, error });
  });
}

/** The dialog's answer: the typed password, or null for Cancel. */
export function answerSourcePassword(password: string | null): void {
  const resolve = waiting;
  waiting = null;
  useUiStore.getState().setSourcePassword(null);
  resolve?.(password);
}
