import type { CommandRegistry } from '../commands/registry';
import type { Keymap } from './keymap';

/** Keys typed into these elements are text, not shortcuts, unless Ctrl or Alt is held. */
function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** True while a modal dialog (the close prompt, a password prompt, any aria-modal dialog) is open. */
export function isModalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"], .modal-backdrop') !== null;
}

/**
 * Listens for key presses on `target` and runs the matching command. Returns a detach
 * function. Calls preventDefault only when a command actually ran.
 */
export function attachKeymap(
  keymap: Keymap,
  registry: CommandRegistry,
  target: Window | HTMLElement = window,
): () => void {
  const onKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.defaultPrevented || event.isComposing) return;
    // Document shortcuts must not act on the document under a modal prompt; the dialog's own keys (Tab, Enter, Esc) are its own.
    if (isModalOpen()) return;
    const modified = event.ctrlKey || event.altKey;
    if (!modified && isTextTarget(event.target)) return;

    const commandId = keymap.lookup(event);
    if (!commandId) return;
    // In a text field, editing keys belong to the field (its own undo, copy and select all), not to the document.
    if (isTextTarget(event.target) && (commandId.startsWith('edit.') || commandId === 'page.copy' || commandId === 'page.selectAll')) {
      return;
    }
    if (!registry.isEnabled(commandId)) {
      const blocked = registry.get(commandId)?.onBlockedKey;
      // A blocked key that had something to say (a toast) is consumed; one that had nothing to say is left alone.
      if (blocked && blocked() !== false) event.preventDefault();
      return;
    }
    event.preventDefault();
    void registry.run(commandId);
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
