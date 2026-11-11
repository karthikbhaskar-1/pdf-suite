import { useState, type ReactNode } from 'react';
import { useEditStore } from '../../core/stores/editStore';
import { useUiStore } from '../../core/stores/uiStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { discardRecovered, dismissNotRestored, keepRecovered, reopenAfterHang } from '../../features/documents/editOps';
import { keepMyVersion } from '../../features/documents/saveDocument';
import { isViewOnly } from '../../features/documents/viewOnly';
import { MAY_BE_TOO_LARGE_QUESTION, VIEW_ONLY_NOTICE } from '../../core/fileLimits';
import { extractWithFeedback, saveWithFeedback } from '../../features/documents/closeFlow';
import {
  NOT_RESTORED_CHANGED_MESSAGE,
  NOT_RESTORED_FAILED_MESSAGE,
  RECOVERED_STOPPED_SENTENCE,
  RECOVERY_FAILED_MESSAGE,
  RECOVERY_OFF_MESSAGE,
  REOPEN_CHANGED_QUESTION,
  REOPEN_LOSS_QUESTION,
  REOPEN_TIP,
  UNRESPONSIVE_MESSAGE,
} from '../../features/recovery/recoveryMessages';

/**
 * Info bars under the tabs, for the focused document: a file that changed on disk, unsaved edits restored from an earlier
 * session, a file over the edit limit that opened view-only (the notice stays), crash recovery that is off, failed or did not restore (these stay until the file is saved or the user dismisses
 * them, unlike a toast), an engine that stopped answering, and a save that needs a choice about encryption.
 */

/** The bar for a file that has gone from its place (1.5.5 D4). */
export const MISSING_FILE_MESSAGE = 'This file was moved, renamed or deleted. Save will create it again.';

/** The same bar for a file over the edit limit, which cannot be saved (provisional wording; the string pass may adjust it). */
export const MISSING_VIEW_ONLY_MESSAGE = 'This file was moved, renamed or deleted. It is over 500 MB, so PDF Suite cannot save it again.';

/** What the two buttons of the "changed on disk" bar do, in the words of the "nothing was saved" message. */
export const KEEP_TIP = "Keep my version saves your changes over the other program's file.";
export const RELOAD_TIP = "Reload discards your changes and shows the other program's file.";

function pushError(error: unknown): void {
  useUiStore.getState().pushToast(error instanceof Error && error.message ? error.message : 'That did not work. Try again.');
}

/** Reload: the file is read again from disk. The unsaved edits are dropped, as the bar says. */
async function reloadFromDisk(docId: string): Promise<void> {
  try {
    await discardRecovered(docId);
    useEditStore.getState().setChangedOnDisk(docId, false);
  } catch (error) {
    pushError(error);
  }
}

/** Keep my version: the banner goes, the next save writes the document's own pages over the file, and the watch restarts. */
function keepVersion(docId: string): void {
  void keepMyVersion(docId).catch(pushError);
}

/**
 * "Save without a password": carried out on the path the user picked (a Save As or an extract target), never on the
 * document's own file, which may be the encrypted original.
 */
async function saveWithoutEncryption(docId: string): Promise<void> {
  const pending = useUiStore.getState().encryptionPending;
  const target = pending?.target ?? undefined;
  const result = pending?.extract
    ? await extractWithFeedback(docId, pending.extract.uids, pending.extract.name, { dropEncryption: true, targetPath: target })
    : await saveWithFeedback(docId, { dropEncryption: true, targetPath: target });
  if (result === 'saved') useUiStore.getState().setEncryptionChoice(null);
}

/** "Save anyway": the save the question was about runs, with its real size check after the bytes are made. */
function saveAnyway(docId: string): void {
  const pending = useUiStore.getState().largeSave;
  useUiStore.getState().setLargeSave(null);
  void saveWithFeedback(docId, { ...(pending?.docId === docId ? pending.options : {}), confirmedLarge: true });
}

/** Reopen: the user chose to restart a document whose engine stopped answering. The recovery log is replayed onto it. */
function reopen(docId: string): void {
  reopenAfterHang(docId).catch(pushError);
}

export function DocumentBars() {
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const missing = useEditStore((s) => (docId ? s.missingOnDisk[docId] === true : false));
  // A file that is gone has nothing to reload: the "moved or deleted" bar replaces the "changed on disk" one.
  const changed = useEditStore((s) => (docId ? s.changedOnDisk[docId] === true && s.missingOnDisk[docId] !== true : false));
  const recovered = useEditStore((s) => (docId ? s.recovered[docId] : undefined));
  const notice = useEditStore((s) => (docId ? s.recoveryNotice[docId] : undefined));
  const notRestored = useEditStore((s) => (docId ? s.notRestored[docId] : undefined));
  const unresponsive = useEditStore((s) => (docId ? s.unresponsive[docId] === true : false));
  // Asked only when a reopen would lose edits: crash recovery has stopped for the document, or the file changed on disk
  // (the recovery copy is then not put back).
  const [confirmingReopen, setConfirmingReopen] = useState<string | null>(null);
  const encryption = useUiStore((s) => s.encryptionChoice);
  const pendingExtract = useUiStore((s) => s.encryptionPending?.extract !== undefined);
  const largeSave = useUiStore((s) => s.largeSave);
  const bars: ReactNode[] = [];

  // A file over the edit limit: the notice stays for as long as the document is open (it has no button, and cannot be dismissed).
  if (docId && isViewOnly(docId)) {
    bars.push(
      <div key="view-only" className="info-bar doc-bar" role="status" data-view-only="true">
        <span>{VIEW_ONLY_NOTICE}</span>
      </div>,
    );
  }
  if (docId && missing) {
    // A file over the edit limit (view-only) can never be saved, so the bar does not promise it and offers no Save.
    const canSave = !isViewOnly(docId);
    bars.push(
      <div key="missing" className="info-bar doc-bar" role="status">
        <span>{canSave ? MISSING_FILE_MESSAGE : MISSING_VIEW_ONLY_MESSAGE}</span>
        {canSave && (
          <button type="button" className="bar-button" onClick={() => void saveWithFeedback(docId)}>
            Save
          </button>
        )}
        {canSave && (
          <button type="button" className="bar-button" onClick={() => void saveWithFeedback(docId, { saveAs: true })}>
            Save As…
          </button>
        )}
        <button type="button" className="bar-button" onClick={() => useEditStore.getState().setMissingOnDisk(docId, false)}>
          Dismiss
        </button>
      </div>,
    );
  }
  if (docId && changed) {
    bars.push(
      <div key="changed" className="info-bar doc-bar" role="status">
        <span>This file changed on disk.</span>
        <button type="button" className="bar-button" title={RELOAD_TIP} onClick={() => void reloadFromDisk(docId)}>
          Reload
        </button>
        {!isViewOnly(docId) && (
          <button type="button" className="bar-button" title={KEEP_TIP} onClick={() => keepVersion(docId)}>
            Keep my version
          </button>
        )}
      </div>,
    );
  }
  if (docId && recovered) {
    bars.push(
      <div key="recovered" className="info-bar doc-bar" role="status">
        <span>
          Recovered unsaved edits ({recovered.edits}).{recovered.loggingStopped ? ` ${RECOVERED_STOPPED_SENTENCE}` : ''}
        </span>
        <button type="button" className="bar-button" onClick={() => keepRecovered(docId)}>
          Keep
        </button>
        <button
          type="button"
          className="bar-button"
          onClick={() => {
            discardRecovered(docId).catch(pushError);
          }}
        >
          Discard
        </button>
      </div>,
    );
  }
  if (docId && notice) {
    bars.push(
      <div key="recovery" className="info-bar doc-bar" role={notice.kind === 'write-failed' ? 'alert' : 'status'}>
        <span>{notice.kind === 'protected-source' ? RECOVERY_OFF_MESSAGE : RECOVERY_FAILED_MESSAGE}</span>
        <button type="button" className="bar-button" onClick={() => void saveWithFeedback(docId)}>
          Save now
        </button>
      </div>,
    );
  }
  if (docId && notRestored) {
    bars.push(
      <div key="not-restored" className="info-bar doc-bar" role="alert">
        <span>{notRestored === 'file-changed' ? NOT_RESTORED_CHANGED_MESSAGE : NOT_RESTORED_FAILED_MESSAGE}</span>
        <button type="button" className="bar-button" onClick={() => dismissNotRestored(docId)}>
          OK
        </button>
      </div>,
    );
  }
  if (docId && unresponsive && confirmingReopen === docId && (notice || changed)) {
    bars.push(
      <div key="reopen-confirm" className="info-bar doc-bar" role="alert">
        <span>{notice ? REOPEN_LOSS_QUESTION : REOPEN_CHANGED_QUESTION}</span>
        <button
          type="button"
          className="bar-button"
          onClick={() => {
            setConfirmingReopen(null);
            reopen(docId);
          }}
        >
          Reopen
        </button>
        <button type="button" className="bar-button" autoFocus onClick={() => setConfirmingReopen(null)}>
          Cancel
        </button>
      </div>,
    );
  } else if (docId && unresponsive) {
    bars.push(
      <div key="unresponsive" className="info-bar doc-bar" role="alert">
        <span>{UNRESPONSIVE_MESSAGE}</span>
        <button type="button" className="bar-button" onClick={() => useEditStore.getState().setUnresponsive(docId, false)}>
          Wait
        </button>
        <button type="button" className="bar-button" title={REOPEN_TIP} onClick={() => (notice || changed ? setConfirmingReopen(docId) : reopen(docId))}>
          Reopen
        </button>
      </div>,
    );
  }
  if (docId && encryption === docId) {
    bars.push(
      <div key="encryption" className="info-bar doc-bar" role="alert">
        <span>
          {pendingExtract
            ? "This file's password protection cannot be kept for the extracted pages."
            : "This file's password protection cannot be kept when saving."}
        </span>
        <button
          type="button"
          className="bar-button"
          onClick={() => void saveWithoutEncryption(docId)}
        >
          Save without a password
        </button>
        <button type="button" className="bar-button" onClick={() => useUiStore.getState().setEncryptionChoice(null)}>
          Cancel
        </button>
      </div>,
    );
  }
  if (docId && largeSave?.docId === docId) {
    bars.push(
      <div key="large-save" className="info-bar doc-bar" role="alert" data-large-save="true">
        <span>{MAY_BE_TOO_LARGE_QUESTION}</span>
        <button type="button" className="bar-button" onClick={() => saveAnyway(docId)}>
          Save anyway
        </button>
        <button type="button" className="bar-button" autoFocus onClick={() => useUiStore.getState().setLargeSave(null)}>
          Cancel
        </button>
      </div>,
    );
  }
  if (bars.length === 0) return null;
  return <div className="doc-bars">{bars}</div>;
}

