import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { saveWithFeedback, extractWithFeedback } = vi.hoisted(() => ({
  saveWithFeedback: vi.fn(async (_docId: string, _options?: unknown) => 'saved' as const),
  extractWithFeedback: vi.fn(async (_docId: string, _uids: string[], _name: string, _options?: unknown) => 'saved' as const),
}));

vi.mock('../../features/documents/closeFlow', () => ({ saveWithFeedback, extractWithFeedback }));
const { dismissNotRestored, reopenAfterHang } = vi.hoisted(() => ({
  dismissNotRestored: vi.fn(),
  reopenAfterHang: vi.fn(async (_docId: string) => undefined),
}));
vi.mock('../../features/documents/editOps', () => ({ discardRecovered: vi.fn(), keepRecovered: vi.fn(), dismissNotRestored, reopenAfterHang }));
vi.mock('../../features/documents/saveDocument', () => ({ keepMyVersion: vi.fn(async () => undefined) }));
const { viewOnly } = vi.hoisted(() => ({ viewOnly: { on: false } }));
vi.mock('../../features/documents/viewOnly', () => ({ isViewOnly: () => viewOnly.on }));

import { useEditStore } from '../../core/stores/editStore';
import { MAY_BE_TOO_LARGE_QUESTION, VIEW_ONLY_NOTICE } from '../../core/fileLimits';
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
import { useUiStore } from '../../core/stores/uiStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { DocumentBars } from './DocumentBars';

const DOC = 'path:C:\\old.pdf';
const TARGET = 'C:\\Docs\\me\\copy.pdf';

beforeEach(() => {
  vi.clearAllMocks();
  viewOnly.on = false;
  useWorkspaceStore.setState({
    tabs: [
      {
        id: 'tab1',
        title: 'old.pdf',
        origin: { kind: 'path', path: 'C:\\old.pdf' },
        status: { kind: 'ready' },
        panes: [{ id: 'pane1', docId: DOC, view: { pageId: '0', zoom: 1, fit: 'width', offset: 0, rotation: 0 } }],
        split: null,
      },
    ],
    activeTabId: 'tab1',
    activePaneId: 'pane1',
  } as never);
});

afterEach(() => {
  cleanup();
  useUiStore.getState().setEncryptionChoice(null);
  useUiStore.getState().setLargeSave(null);
  useEditStore.setState({ recoveryNotice: {}, notRestored: {}, unresponsive: {}, recovered: {}, changedOnDisk: {} });
});

describe('Save without a password (ticket 1.2.1 review, items 6 and 9)', () => {
  it('after Save As, saves to the path the user picked, not to the encrypted original', async () => {
    useUiStore.getState().setEncryptionChoice(DOC, { target: TARGET });
    render(<DocumentBars />);
    fireEvent.click(screen.getByText('Save without a password'));
    await waitFor(() => expect(saveWithFeedback).toHaveBeenCalled());
    expect(saveWithFeedback).toHaveBeenCalledWith(DOC, { dropEncryption: true, targetPath: TARGET });
    expect(extractWithFeedback).not.toHaveBeenCalled();
  });

  it('a plain Save that needed the choice stays on the document own path', async () => {
    useUiStore.getState().setEncryptionChoice(DOC, { target: null });
    render(<DocumentBars />);
    fireEvent.click(screen.getByText('Save without a password'));
    await waitFor(() => expect(saveWithFeedback).toHaveBeenCalled());
    expect(saveWithFeedback).toHaveBeenCalledWith(DOC, { dropEncryption: true, targetPath: undefined });
  });

  it('an extract carries on as an extract to its own target, with the same pages', async () => {
    useUiStore.getState().setEncryptionChoice(DOC, { target: TARGET, extract: { uids: ['1', '2'], name: 'old.pdf' } });
    render(<DocumentBars />);
    expect(screen.getByText(/extracted pages/)).toBeTruthy();
    fireEvent.click(screen.getByText('Save without a password'));
    await waitFor(() => expect(extractWithFeedback).toHaveBeenCalled());
    expect(extractWithFeedback).toHaveBeenCalledWith(DOC, ['1', '2'], 'old.pdf', { dropEncryption: true, targetPath: TARGET });
    expect(saveWithFeedback).not.toHaveBeenCalled();
    await waitFor(() => expect(useUiStore.getState().encryptionChoice).toBeNull());
    expect(useUiStore.getState().encryptionPending).toBeNull();
  });
});

describe('the save that may be over the size limit', () => {
  it('asks the question in the agreed words, with Cancel as the default button', () => {
    useUiStore.getState().setLargeSave({ docId: DOC, options: {} });
    render(<DocumentBars />);
    expect(MAY_BE_TOO_LARGE_QUESTION).toBe(
      'This document may be larger than 500 MB, the most PDF Suite can save. If it is, the save will not finish and these changes can no longer be undone. Save anyway?',
    );
    expect(screen.getByText(MAY_BE_TOO_LARGE_QUESTION)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
  });

  it('Cancel closes the question and saves nothing', () => {
    useUiStore.getState().setLargeSave({ docId: DOC, options: {} });
    render(<DocumentBars />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(useUiStore.getState().largeSave).toBeNull();
    expect(saveWithFeedback).not.toHaveBeenCalled();
  });

  it('Save anyway runs the save again with the same choices, confirmed', async () => {
    useUiStore.getState().setLargeSave({ docId: DOC, options: { saveAs: true } });
    render(<DocumentBars />);
    fireEvent.click(screen.getByText('Save anyway'));
    await waitFor(() => expect(saveWithFeedback).toHaveBeenCalledWith(DOC, { saveAs: true, confirmedLarge: true }));
    expect(useUiStore.getState().largeSave).toBeNull();
  });
});

describe('crash-recovery bars (ticket 1.5.1 R5, R6; wording from the 1.5.5 UI spec section 6)', () => {
  it('the exact words', () => {
    expect(RECOVERY_FAILED_MESSAGE).toBe(
      'Crash recovery has stopped for this file, because PDF Suite could not write its recovery copy. Your latest changes are not protected until you save.',
    );
    expect(RECOVERY_OFF_MESSAGE).toBe('Crash recovery is off for this file until you save it, because it now includes pages from a password-protected PDF.');
    expect(NOT_RESTORED_CHANGED_MESSAGE).toBe(
      'Unsaved edits from an earlier session were not restored, because this file has changed since then. You are seeing the file as it is on disk.',
    );
    expect(NOT_RESTORED_FAILED_MESSAGE).toBe('Unsaved edits from an earlier session could not be restored. You are seeing the file as it is on disk.');
  });

  it('a failed recovery write shows an alert bar with Save now; a failed or cancelled save leaves it up; nobody can dismiss it', async () => {
    useEditStore.getState().setRecoveryNotice(DOC, { kind: 'write-failed' });
    render(<DocumentBars />);
    const bar = screen.getByText(RECOVERY_FAILED_MESSAGE).closest('.doc-bar')!;
    expect(bar.getAttribute('role')).toBe('alert');
    expect(bar.querySelectorAll('button')).toHaveLength(1);
    saveWithFeedback.mockResolvedValueOnce('cancelled' as never);
    fireEvent.click(screen.getByText('Save now'));
    await waitFor(() => expect(saveWithFeedback).toHaveBeenCalledWith(DOC));
    expect(screen.queryByText(RECOVERY_FAILED_MESSAGE)).not.toBeNull();
  });

  it('recovery switched off by a protected source shows the same sentence as before, as a status bar with Save now', () => {
    useEditStore.getState().setRecoveryNotice(DOC, { kind: 'protected-source' });
    render(<DocumentBars />);
    expect(screen.getByText(RECOVERY_OFF_MESSAGE).closest('.doc-bar')!.getAttribute('role')).toBe('status');
    expect(screen.queryByText('Save now')).not.toBeNull();
  });

  it('no toast is shown with the bar', () => {
    useUiStore.setState({ toasts: [] });
    useEditStore.getState().setRecoveryNotice(DOC, { kind: 'write-failed' });
    render(<DocumentBars />);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('"not restored" shows an alert bar with OK, for each reason; OK asks for the bar to go and nothing else', () => {
    useEditStore.getState().setNotRestored(DOC, 'file-changed');
    render(<DocumentBars />);
    expect(screen.getByText(NOT_RESTORED_CHANGED_MESSAGE).closest('.doc-bar')!.getAttribute('role')).toBe('alert');
    fireEvent.click(screen.getByText('OK'));
    expect(dismissNotRestored).toHaveBeenCalledWith(DOC);
    cleanup();
    useEditStore.getState().setNotRestored(DOC, 'failed');
    render(<DocumentBars />);
    expect(screen.queryByText(NOT_RESTORED_FAILED_MESSAGE)).not.toBeNull();
  });

  it('both a recovery bar and a "not restored" bar can show together', () => {
    useEditStore.getState().setNotRestored(DOC, 'failed');
    useEditStore.getState().setRecoveryNotice(DOC, { kind: 'write-failed' });
    render(<DocumentBars />);
    expect(screen.queryByText(NOT_RESTORED_FAILED_MESSAGE)).not.toBeNull();
    expect(screen.queryByText(RECOVERY_FAILED_MESSAGE)).not.toBeNull();
  });

  it('the Recovered bar says when recording had stopped', () => {
    useEditStore.getState().setRecovered(DOC, { edits: 3, loggingStopped: true });
    render(<DocumentBars />);
    expect(screen.getByText(`Recovered unsaved edits (3). ${RECOVERED_STOPPED_SENTENCE}`)).toBeTruthy();
    cleanup();
    useEditStore.getState().setRecovered(DOC, { edits: 3 });
    render(<DocumentBars />);
    expect(screen.queryByText(new RegExp(RECOVERED_STOPPED_SENTENCE))).toBeNull();
  });

  it('a document that stopped responding: Wait puts the bar away, Reopen runs only when pressed and has the spec tooltip', async () => {
    useEditStore.getState().setUnresponsive(DOC, true);
    render(<DocumentBars />);
    expect(screen.queryByText(UNRESPONSIVE_MESSAGE)).not.toBeNull();
    expect(reopenAfterHang).not.toHaveBeenCalled();
    expect(screen.getByText('Reopen').getAttribute('title')).toBe(REOPEN_TIP);
    expect(REOPEN_TIP).toBe('Closes this document and opens it again with your unsaved edits.');
    fireEvent.click(screen.getByText('Reopen'));
    await waitFor(() => expect(reopenAfterHang).toHaveBeenCalledWith(DOC));
    fireEvent.click(screen.getByText('Wait'));
    expect(useEditStore.getState().unresponsive[DOC]).toBeUndefined();
  });

  it('Reopen while crash recovery is stopped asks first; Cancel is the default and nothing is reopened; Reopen then goes ahead', async () => {
    useEditStore.getState().setRecoveryNotice(DOC, { kind: 'write-failed' });
    useEditStore.getState().setUnresponsive(DOC, true);
    render(<DocumentBars />);
    fireEvent.click(screen.getByText('Reopen'));
    expect(reopenAfterHang).not.toHaveBeenCalled();
    expect(REOPEN_LOSS_QUESTION).toBe('Edits made after crash recovery stopped will be lost if you reopen. Reopen anyway?');
    expect(screen.queryByText(REOPEN_LOSS_QUESTION)).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(screen.getByText('Cancel'));
    expect(reopenAfterHang).not.toHaveBeenCalled();
    expect(screen.queryByText(REOPEN_LOSS_QUESTION)).toBeNull();
    expect(screen.queryByText(UNRESPONSIVE_MESSAGE)).not.toBeNull();
    fireEvent.click(screen.getByText('Reopen'));
    fireEvent.click(screen.getByText('Reopen'));
    await waitFor(() => expect(reopenAfterHang).toHaveBeenCalledWith(DOC));
  });

  it('Reopen after the file changed on disk asks first, with its own question; Cancel does nothing', async () => {
    useEditStore.getState().setChangedOnDisk(DOC, true);
    useEditStore.getState().setUnresponsive(DOC, true);
    render(<DocumentBars />);
    fireEvent.click(screen.getByText('Reopen'));
    expect(reopenAfterHang).not.toHaveBeenCalled();
    expect(REOPEN_CHANGED_QUESTION).toBe('This file changed on disk, so your unsaved edits cannot be restored if you reopen. Reopen anyway?');
    expect(screen.queryByText(REOPEN_CHANGED_QUESTION)).not.toBeNull();
    expect(screen.queryByText(REOPEN_LOSS_QUESTION)).toBeNull();
    fireEvent.click(screen.getByText('Cancel'));
    expect(reopenAfterHang).not.toHaveBeenCalled();
    useEditStore.getState().setChangedOnDisk(DOC, false);
  });

  it('Reopen with crash recovery working asks no extra question', async () => {
    useEditStore.getState().setUnresponsive(DOC, true);
    render(<DocumentBars />);
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.queryByText(REOPEN_LOSS_QUESTION)).toBeNull();
    await waitFor(() => expect(reopenAfterHang).toHaveBeenCalledWith(DOC));
  });
});

describe('a file over the edit limit (1.5.10)', () => {
  it('shows the view-only notice, which says why and what still works, and has no button (it stays)', () => {
    viewOnly.on = true;
    const { container } = render(<DocumentBars />);
    const bar = container.querySelector('[data-view-only="true"]')!;
    expect(bar.textContent).toBe(VIEW_ONLY_NOTICE);
    expect(bar.textContent).toMatch(/over 500 MB/);
    expect(bar.querySelectorAll('button')).toHaveLength(0);
    expect(bar.getAttribute('role')).toBe('status');
  });

  it('the "changed on disk" bar has no Keep my version for a view-only document (it can never be saved), and keeps Reload', () => {
    useEditStore.setState({ changedOnDisk: { [DOC]: true } });
    viewOnly.on = true;
    render(<DocumentBars />);
    expect(screen.getByText('Reload')).toBeTruthy();
    expect(screen.queryByText('Keep my version')).toBeNull();
    cleanup();
    viewOnly.on = false;
    render(<DocumentBars />);
    expect(screen.getByText('Keep my version')).toBeTruthy();
  });

  it('shows nothing for an ordinary document', () => {
    const { container } = render(<DocumentBars />);
    expect(container.querySelector('[data-view-only]')).toBeNull();
  });
});

describe('a file that has gone from its place (1.5.5 D4)', () => {
  it('shows the bar with Save, Save As… and Dismiss, in place of the "changed on disk" bar', () => {
    useEditStore.getState().setChangedOnDisk(DOC, true);
    useEditStore.getState().setMissingOnDisk(DOC, true);
    render(<DocumentBars />);
    const bar = screen.getByText('This file was moved, renamed or deleted. Save will create it again.').closest('.doc-bar')!;
    expect(bar.getAttribute('role')).toBe('status');
    expect(screen.queryByText('This file changed on disk.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveWithFeedback).toHaveBeenCalledWith(DOC);
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    expect(saveWithFeedback).toHaveBeenCalledWith(DOC, { saveAs: true });
  });

  it('a view-only document gets the honest wording and Dismiss only', () => {
    viewOnly.on = true;
    useEditStore.getState().setMissingOnDisk(DOC, true);
    render(<DocumentBars />);
    expect(screen.getByText('This file was moved, renamed or deleted. It is over 500 MB, so PDF Suite cannot save it again.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save As…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useEditStore.getState().missingOnDisk[DOC]).toBeUndefined();
  });

  it('the "changed on disk" bar comes back when the file is seen again', () => {
    useEditStore.getState().setChangedOnDisk(DOC, true);
    useEditStore.getState().setMissingOnDisk(DOC, true);
    const { rerender } = render(<DocumentBars />);
    expect(screen.queryByText('This file changed on disk.')).toBeNull();
    useEditStore.getState().setMissingOnDisk(DOC, false);
    rerender(<DocumentBars />);
    expect(screen.getByText('This file changed on disk.')).toBeTruthy();
  });

  it('Dismiss hides the bar', () => {
    useEditStore.getState().setMissingOnDisk(DOC, true);
    render(<DocumentBars />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('This file was moved, renamed or deleted. Save will create it again.')).toBeNull();
    expect(useEditStore.getState().missingOnDisk[DOC]).toBeUndefined();
  });

  it('closing the tab (clear) removes the flag', () => {
    useEditStore.getState().setMissingOnDisk(DOC, true);
    useEditStore.getState().clear(DOC);
    expect(useEditStore.getState().missingOnDisk[DOC]).toBeUndefined();
  });
});
