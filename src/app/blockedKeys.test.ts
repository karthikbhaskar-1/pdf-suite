// @vitest-environment jsdom
// A shortcut pressed while its command is off says why, in a toast, instead of doing nothing: Ctrl+D pressed again while
// the first duplicate is still running (the progress of a running edit is set), Ctrl+D during a save, and Undo during an edit.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../features/documents/closeFlow', () => ({ saveWithFeedback: vi.fn() }));
const { FakeDoc } = vi.hoisted(() => ({ FakeDoc: class { capabilities = { canEdit: true, htmlLayer: false }; } }));
vi.mock('./services', () => ({ documentRegistry: { get: () => ({ doc: new FakeDoc() }) }, fileService: {} }));
vi.mock('../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeDoc }));

import { commands } from '../core/commands/registry';
import { createKeymap } from '../core/keymap/keymap';
import { attachKeymap } from '../core/keymap/keymapService';
import { useDocumentsStore } from '../core/stores/documentsStore';
import { useEditStore } from '../core/stores/editStore';
import { useUiStore } from '../core/stores/uiStore';
import { useWorkspaceStore } from '../core/stores/workspaceStore';
import { BUSY_MESSAGE } from '../features/organizer/actions';
import { registerOrganizerCommands, SAVING_REASON } from './organizerCommands';

const DOC = 'doc1';
let detach: () => void;

beforeEach(() => {
  detach?.();
  useUiStore.setState({ toasts: [] });
  useWorkspaceStore.setState({
    tabs: [{ id: 't1', title: 'a.pdf', origin: { kind: 'path', path: 'a.pdf' }, status: { kind: 'ready' }, panes: [{ id: 'p1', docId: DOC, view: { pageId: `${DOC}:0`, zoom: 1, fit: 'width', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 't1',
    activePaneId: 'p1',
  } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'a.pdf', pageCount: 2, pages: [], sizes: [] } } } as never);
  useEditStore.setState({ progress: {}, saving: {}, byDoc: { [DOC]: { version: 1, uids: ['0', '1'], revs: [0, 0], sizes: null, history: { dirty: false, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null } } } } as never);
  try {
    registerOrganizerCommands();
  } catch {
    // Registered by an earlier test in this file.
  }
  detach = attachKeymap(createKeymap('desktop'), commands, window);
});

const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));
const messages = () => useUiStore.getState().toasts.map((t) => t.message);

describe('blocked shortcuts say why', () => {
  it('Ctrl+D while an edit is running is refused with the wait message', () => {
    useEditStore.setState({ progress: { [DOC]: { label: 'Duplicate', done: 0, total: 0 } } } as never);
    press({ key: 'd', ctrlKey: true });
    expect(messages()).toEqual([BUSY_MESSAGE]);
  });

  it('Ctrl+D while the document is saving says it is saving', () => {
    useEditStore.setState({ saving: { [DOC]: true } } as never);
    press({ key: 'd', ctrlKey: true });
    expect(messages()).toEqual([SAVING_REASON]);
  });

  it('Undo off after a failed save gives the reason as its disabled reason, and Ctrl+Z says it', () => {
    const reason = 'Changes made before the save that failed are kept, but can no longer be undone.';
    useEditStore.setState({
      byDoc: { [DOC]: { version: 1, uids: ['0', '1'], revs: [0, 0], sizes: null, history: { dirty: true, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, undoBlockedReason: reason } } },
    } as never);
    expect(commands.isEnabled('edit.undo')).toBe(false);
    expect(commands.reasonDisabled('edit.undo')).toBe(reason);
    press({ key: 'z', ctrlKey: true });
    expect(messages()).toEqual([reason]);
  });

  it('Undo off with nothing to undo has no reason and stays quiet', () => {
    expect(commands.reasonDisabled('edit.undo')).toBeUndefined();
    press({ key: 'z', ctrlKey: true });
    expect(messages()).toEqual([]);
  });

  it('says nothing, and leaves the key alone, when the command is off for another reason', () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, activePaneId: null } as never);
    const event = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(messages()).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
