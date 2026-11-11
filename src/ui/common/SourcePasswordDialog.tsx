import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useUiStore } from '../../core/stores/uiStore';
import { answerSourcePassword } from '../../features/organizer/sourcePassword';
import { cycleFocus, focusableWithin, lastFocusedOutsideModal, makeAppInert, restoreFocus } from './focusTrap';

/**
 * The password prompt for a PDF picked in Insert or Replace. Same look and keys as the prompt for opening a file: the rest
 * of the app is inert, Tab stays inside, Esc is Cancel, and focus goes back afterwards. The password goes to the caller
 * once and is not stored.
 */
export function SourcePasswordDialog() {
  const prompt = useUiStore((s) => s.sourcePassword);
  if (!prompt) return null;
  return <SourcePasswordModal name={prompt.name} error={prompt.error} />;
}

function SourcePasswordModal({ name, error }: { name: string; error: string | null }) {
  const [value, setValue] = useState('');
  const [previous] = useState(() => lastFocusedOutsideModal());
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
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
      answerSourcePassword(null);
      return;
    }
    if (event.key !== 'Tab' || !formRef.current) return;
    const next = cycleFocus(focusableWithin(formRef.current), document.activeElement as HTMLElement | null, event.shiftKey);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = value;
    setValue('');
    answerSourcePassword(password);
  };

  return (
    <div className="modal-backdrop">
      <form ref={formRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="spw-title" onKeyDown={onKeyDown} onSubmit={onSubmit}>
        <h2 id="spw-title">Password needed</h2>
        <p className="tb-muted">{name} is protected. Enter its password to use its pages.</p>
        <input type="password" autoFocus aria-label="Password" value={value} onChange={(e) => setValue(e.target.value)} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={() => answerSourcePassword(null)}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            Use password
          </button>
        </div>
      </form>
    </div>
  );
}
