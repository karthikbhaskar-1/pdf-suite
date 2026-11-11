import { useUiStore } from '../../core/stores/uiStore';
import { useJobStore } from '../../core/stores/jobStore';
import { revealResult } from '../../features/jobs/splitFlow';
import { openResult } from '../../features/jobs/combineFlow';

/** Short messages, such as "Restored 3 tabs" or "Deleted 3 pages", with an optional button (Undo). They fade out on their own, except a sticky one, which has a Close button. */
export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const notice = useJobStore((s) => s.notice);
  return (
    <>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <span>{toast.message}</span>
            {toast.sticky && (
              <button type="button" className="job-notice-close" aria-label="Close" onClick={() => useUiStore.getState().dismissToast(toast.id)}>
                ×
              </button>
            )}
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  useUiStore.getState().dismissToast(toast.id);
                  toast.action?.run();
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      {/* The result notice of a job stays until it is closed or the next job starts. It sits at the left so it never covers a side sheet (the next job starts from one). */}
      <div className="toasts toasts-left" role="status" aria-live="polite">
        {notice && (
          <div key={`job-${notice.id}`} className="toast job-notice" data-job-notice={notice.failed ? 'failed' : 'done'}>
            <span>{notice.message}</span>
            {notice.resultIds[0] && (
              <button type="button" className="toast-action" onClick={() => void revealResult(notice.resultIds[0]!)}>
                Show in folder
              </button>
            )}
            {notice.openResultId && (
              <button type="button" className="toast-action" onClick={() => void openResult(notice.openResultId!)}>
                Open
              </button>
            )}
            <button type="button" className="job-notice-close" aria-label="Close" onClick={() => useJobStore.getState().dismissNotice()}>
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
