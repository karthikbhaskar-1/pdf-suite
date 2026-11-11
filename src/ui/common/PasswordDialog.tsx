import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { cancelPassword, submitPassword } from '../../features/documents/documentService';
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { cycleFocus, focusableWithin, lastFocusedOutsideModal, makeAppInert, restoreFocus } from './focusTrap';

/** The password prompt. It is the only modal in the app. The password is used once and never stored. */
export function PasswordDialog() {
  const tabId = useUiStore((s) => s.passwordTabId);
  if (!tabId) return null;
  return <PasswordModal key={tabId} tabId={tabId} />;
}

/**
 * The dialog itself. While it is open, the rest of the app is inert, Tab stays inside the dialog,
 * Escape cancels, and focus goes back to the element that had it before the dialog opened.
 */
function PasswordModal({ tabId }: { tabId: string }) {
  const error = useUiStore((s) => s.passwordError);
  const title = useWorkspaceStore((s) => s.tabs.find((t) => t.id === tabId)?.title ?? 'PDF');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // Read during the first render, before the input's autoFocus moves focus.
  const [previous] = useState(() => lastFocusedOutsideModal());
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Everything behind the dialog is inert: the app's own children, except this dialog's backdrop.
    const release = makeAppInert();
    return () => {
      release();
      restoreFocus(previous);
    };
  }, [previous]);

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelPassword(tabId);
      return;
    }
    if (event.key !== 'Tab' || !formRef.current) return;
    const next = cycleFocus(focusableWithin(formRef.current), document.activeElement as HTMLElement | null, event.shiftKey);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const password = value;
    setValue('');
    await submitPassword(tabId, password);
    setBusy(false);
  };

  return (
    <div className="modal-backdrop">
      <form
        ref={formRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pw-title"
        onKeyDown={onKeyDown}
        onSubmit={(e) => void onSubmit(e)}
      >
        <h2 id="pw-title">Password needed</h2>
        <p className="tb-muted">{title} is protected.</p>
        <input
          type="password"
          autoFocus
          aria-label="Password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => cancelPassword(tabId)}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            Open
          </button>
        </div>
      </form>
    </div>
  );
}
