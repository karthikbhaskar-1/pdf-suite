// @vitest-environment jsdom
// 1.5.10: a file over the edit limit (500 MB) opens view-only. Every editing command, Save and Save As are off with one reason, the
// tooltip and menus read it from disabledReason, and a shortcut pressed on the document says it in a toast. The same commands are on
// for an ordinary document (the control that keeps this test from passing for the wrong reason).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../features/documents/closeFlow', () => ({ saveWithFeedback: vi.fn() }));
const { FakeDoc, mode } = vi.hoisted(() => {
  const mode = { viewOnly: true };
  class FakeDoc {
    get capabilities() {
      return mode.viewOnly ? { canEdit: false, htmlLayer: false, viewOnly: true } : { canEdit: true, htmlLayer: false };
    }
    detachSource = vi.fn(async () => ({}));
  }
  return { FakeDoc, mode };
});
vi.mock('./services', () => ({ documentRegistry: { get: () => ({ doc: new FakeDoc() }) }, fileService: {} }));
vi.mock('../engine/mupdf/mupdfDocument', () => ({ MupdfDocument: FakeDoc }));
vi.mock('../platform/desktop/bridge', () => ({ getDesktopBridge: () => null }));
vi.mock('../features/documents/editOps', () => ({
  WAIT_MESSAGE: 'Wait for the current change to finish.',
  applyPageEdits: vi.fn(async () => true),
  attachSourceLogged: vi.fn(),
  discardLastPageEdit: vi.fn(),
  redoPageEdit: vi.fn(),
  undoPageEdit: vi.fn(),
}));

import { commands } from '../core/commands/registry';
import { VIEW_ONLY_REASON } from '../core/fileLimits';
import { VIEW_ONLY_REASON as REASON_FROM_REASONS } from '../core/commands/reasons';
import { useDocumentsStore } from '../core/stores/documentsStore';
import { useEditStore } from '../core/stores/editStore';
import { useUiStore } from '../core/stores/uiStore';
import { useWorkspaceStore } from '../core/stores/workspaceStore';
import { registerOrganizerCommands } from './organizerCommands';
import { registerJobCommands } from './jobCommands';

const DOC = 'path:C:/docs/big.pdf';

/** Every command that changes the document or writes it, by the kind of edit it makes. */
const EDITING: Array<[string, string]> = [
  ['save', 'file.save'],
  ['save as', 'file.saveAs'],
  ['undo', 'edit.undo'],
  ['redo', 'edit.redo'],
  ['organizer: insert blank', 'pages.insert'],
  ['organizer: insert lined', 'pages.insertLined'],
  ['organizer: insert grid', 'pages.insertGrid'],
  ['insert from PDF', 'pages.insertFromPdf'],
  ['replace', 'pages.replace'],
  ['delete', 'pages.delete'],
  ['duplicate', 'pages.duplicate'],
  ['rotate right', 'pages.rotateRight'],
  ['rotate left', 'pages.rotateLeft'],
  ['rotate 180', 'pages.rotate180'],
  ['rotate custom', 'pages.rotateCustom'],
  ['crop', 'pages.crop'],
  ['auto-crop', 'pages.autoCrop'],
  ['page size', 'pages.size'],
  ['cut pages in half', 'pages.cutHalf'],
  ['overlay', 'pages.overlay'],
  ['reverse', 'pages.reverse'],
  ['extract', 'pages.extract'],
  ['move up', 'pages.moveUp'],
  ['move down', 'pages.moveDown'],
  ['move to the start', 'pages.moveStart'],
  ['move to the end', 'pages.moveEnd'],
  ['split into files', 'pages.splitFiles'],
];

beforeEach(() => {
  mode.viewOnly = true;
  useWorkspaceStore.setState({
    tabs: [{ id: 't1', title: 'big.pdf', origin: { kind: 'path', path: 'C:/docs/big.pdf' }, status: { kind: 'ready' }, panes: [{ id: 'p1', docId: DOC, view: { pageId: `${DOC}:0`, zoom: 1, fit: 'width', offset: 0, rotation: 0 } }], split: null }],
    activeTabId: 't1',
    activePaneId: 'p1',
  } as never);
  useDocumentsStore.setState({ docs: { [DOC]: { docId: DOC, name: 'big.pdf', pageCount: 3, pages: [], sizes: [] } } } as never);
  useEditStore.setState({
    progress: {},
    saving: {},
    byDoc: { [DOC]: { version: 1, uids: ['0', '1', '2'], revs: [0, 0, 0], sizes: null, history: { dirty: false, canUndo: true, canRedo: true, undoLabel: null, redoLabel: null } } },
  } as never);
  try {
    registerOrganizerCommands();
    registerJobCommands();
  } catch {
    // Registered by an earlier test in this file.
  }
});

describe('a view-only document (the file is over 500 MB)', () => {
  it('the reason is one sentence, shared by the reasons file', () => {
    expect(REASON_FROM_REASONS).toBe(VIEW_ONLY_REASON);
    expect(VIEW_ONLY_REASON).toContain('over 500 MB');
  });

  it.each(EDITING)('%s is off, and the tooltip says why', (_label, id) => {
    expect(commands.get(id), id).toBeDefined();
    expect(commands.isEnabled(id), id).toBe(false);
    expect(commands.reasonDisabled(id), id).toBe(VIEW_ONLY_REASON);
  });

  it('a command that is off does not run', async () => {
    expect(await commands.run('pages.rotateRight')).toBe(false);
    expect(await commands.run('file.save')).toBe(false);
  });

  it('a shortcut on a blocked editing command or Save says the reason in a toast', () => {
    const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
    for (const id of ['pages.delete', 'file.save', 'pages.rotateRight']) {
      commands.get(id)!.onBlockedKey!();
    }
    expect(toasts().filter((m) => m === VIEW_ONLY_REASON).length).toBeGreaterThan(0);
  });
});

describe('an ordinary document: the same commands are on', () => {
  it.each([
    ['save', 'file.save'],
    ['save as', 'file.saveAs'],
    ['insert blank', 'pages.insert'],
    ['rotate right', 'pages.rotateRight'],
    ['cut', 'pages.cutHalf'],
    ['overlay', 'pages.overlay'],
    ['undo', 'edit.undo'],
  ])('%s is on', (_label, id) => {
    mode.viewOnly = false;
    expect(commands.isEnabled(id), id).toBe(true);
    expect(commands.reasonDisabled(id), id).toBeUndefined();
  });
});
