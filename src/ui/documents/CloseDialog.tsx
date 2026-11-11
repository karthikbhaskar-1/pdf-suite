import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { useUiStore } from '../../core/stores/uiStore';
import { answerClosePrompt, answerJobQuitPrompt, nameOfDoc, promptDocIds } from '../../features/documents/closeFlow';
import { QUIT_PROMPT_TEXT } from '../../features/jobs/jobMessages';
import { cycleFocus, focusableWithin, lastFocusedOutsideModal, makeAppInert, restoreFocus } from '../common/focusTrap';

/**
 * The password prompt's modal behaviour for these prompts: the rest of the app is inert, Tab stays inside the dialog, and
 * focus goes back to the element that had it before when the dialog closes (Cancel, Esc, or an answer).
 */
function useModalFocus(ref: RefObject<HTMLElement | null>): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const [previous] = useState(() => lastFocusedOutsideModal());
  useEffect(() => {
    const release = makeAppInert();
    return () => {
      release();
      restoreFocus(previous);
    };
  }, [previous]);
  return (event) => {
    if (event.key !== 'Tab' || !ref.current) return;
    const next = cycleFocus(focusableWithin(ref.current), document.activeElement as HTMLElement | null, event.shiftKey);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
}

/**
 * The close and quit prompt: Save, Don't save, Cancel. It opens only when a document has unsaved changes. This is the
 * second modal of the app; the password prompt is the first. Esc is Cancel.
 */
export function CloseDialog() {
  const jobPrompt = useUiStore((s) => s.jobQuitPrompt);
  return jobPrompt ? <JobQuitDialog /> : <SaveCloseDialog />;
}

/** Quitting while Split into Files runs: Stop and exit, or Cancel. Esc is Cancel. */
function JobQuitDialog() {
  const ref = useRef<HTMLDivElement>(null);
  const onTab = useModalFocus(ref);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void answerJobQuitPrompt(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop">
      <div ref={ref} onKeyDown={onTab} className="modal close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="job-quit-title" data-job-quit="true">
        <h2 id="job-quit-title">{QUIT_PROMPT_TEXT}</h2>
        <div className="modal-actions">
          <button type="button" className="primary-button" autoFocus onClick={() => void answerJobQuitPrompt(true)}>
            Stop and exit
          </button>
          <button type="button" onClick={() => void answerJobQuitPrompt(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function SaveCloseDialog() {
  const open = useUiStore((s) => s.closePrompt);
  return open ? <SaveCloseModal /> : null;
}

function SaveCloseModal() {
  const names = useMemo(() => promptDocIds(), []);
  const ref = useRef<HTMLDivElement>(null);
  const onTab = useModalFocus(ref);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void answerClosePrompt('cancel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const label = names.length === 1 ? nameOfDoc(names[0]!) : `${names.length} files`;
  const title = names.length === 1 ? `Save changes to ${label} before closing?` : `Save changes to ${names.length} files before closing?`;
  return (
    <div className="modal-backdrop">
      <div ref={ref} onKeyDown={onTab} className="modal close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-body">
        <h2 id="close-title">{title}</h2>
        <p id="close-body">Your changes will be lost if you don&apos;t save them.</p>
        <div className="modal-actions">
          <button type="button" className="primary-button" autoFocus onClick={() => void answerClosePrompt('save')}>
            Save
          </button>
          <button type="button" onClick={() => void answerClosePrompt('discard')}>
            Don&apos;t save
          </button>
          <button type="button" onClick={() => void answerClosePrompt('cancel')}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
