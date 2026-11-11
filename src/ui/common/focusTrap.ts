/**
 * The element Tab (or Shift+Tab) moves focus to, inside a list of focusable elements. Wraps at both
 * ends. When the current element is not in the list, Tab goes to the first and Shift+Tab to the last.
 * Returns null when the list is empty.
 */
export function cycleFocus<T>(items: readonly T[], current: T | null, backwards: boolean): T | null {
  if (items.length === 0) return null;
  const index = current === null ? -1 : items.indexOf(current);
  if (index < 0) return backwards ? (items[items.length - 1] ?? null) : (items[0] ?? null);
  const next = (index + (backwards ? -1 : 1) + items.length) % items.length;
  return items[next] ?? null;
}

/**
 * The last element outside any modal that had focus. Remembered as it moves, because the element can
 * lose focus before a modal opens: opening a file disables the Fit width button, and a disabled
 * button drops focus to the body.
 */
let lastFocusOutsideModal: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && !target.closest('.modal-backdrop')) lastFocusOutsideModal = target;
    },
    true,
  );
}

/** The element that had focus outside any modal most recently. Null when none has. */
export function lastFocusedOutsideModal(): HTMLElement | null {
  return lastFocusOutsideModal;
}

const FOCUSABLE ='button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** The enabled, focusable elements inside `root`, in document order. An element with tabindex -1 is not in the tab order (a roving tab stop). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1');
}

const inertCounts = new WeakMap<Element, number>();

/**
 * Makes the app's children inert (except modal backdrops and anything `skip` names) and returns the function that undoes
 * it. Counted per element: an element stays inert until every caller that made it inert has released it, so one dialog
 * closing cannot unblock the app while another is still open.
 */
export function makeAppInert(skip?: (el: HTMLElement) => boolean): () => void {
  const app = document.querySelector<HTMLElement>('.app');
  const made: HTMLElement[] = [];
  if (app) {
    for (const child of Array.from(app.children) as HTMLElement[]) {
      if (child.classList.contains('modal-backdrop') || skip?.(child)) continue;
      inertCounts.set(child, (inertCounts.get(child) ?? 0) + 1);
      child.setAttribute('inert', '');
      made.push(child);
    }
  }
  return () => {
    for (const child of made) {
      const left = (inertCounts.get(child) ?? 1) - 1;
      if (left <= 0) {
        inertCounts.delete(child);
        child.removeAttribute('inert');
      } else inertCounts.set(child, left);
    }
  };
}

/** Puts focus back on `previous` when it is still there and enabled; otherwise on the main area (its tab may be gone). */
export function restoreFocus(previous: HTMLElement | null): void {
  if (previous && previous.isConnected && !(previous as HTMLButtonElement).disabled) previous.focus();
  else document.querySelector<HTMLElement>('.main')?.focus();
}
