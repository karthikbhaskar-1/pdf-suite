// @vitest-environment jsdom
// The commands of Overlay to Compare (1.3.4): the entry in the Pages group and the palette words from the UI spec, which
// documents can start it, and F8 (show or hide the overlay), which acts only while comparing and is left alone otherwise.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../features/documents/closeFlow', () => ({ saveWithFeedback: vi.fn() }));
const { FakeDoc } = vi.hoisted(() => ({ FakeDoc: class { capabilities = { canEdit: true, htmlLayer: false }; detachSource = vi.fn(async () => ({})); } }));
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
import { createKeymap } from '../core/keymap/keymap';
import { attachKeymap } from '../core/keymap/keymapService';
import { sessionOf, useCompareStore } from '../core/stores/compareStore';
import { useDocumentsStore } from '../core/stores/documentsStore';
import { useEditStore } from '../core/stores/editStore';
import { useSheetStore } from '../core/stores/sheetStore';
import { useWorkspaceStore } from '../core/stores/workspaceStore';
import { registerOrganizerCommands } from './organizerCommands';

const DOC = 'doc1';
let detach: () => void;

beforeEach(() => {
  detach?.();
  useSheetStore.getState().close();
  useCompareStore.getState().end();
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

describe('Overlay to Compare commands', () => {
  it('the three commands have the palette words of the UI spec', () => {
    expect(commands.get('pages.overlay')?.label).toBe('Pages: Overlay to compare');
    expect(commands.get('pages.overlayLeave')?.label).toBe('Pages: Leave overlay compare');
    expect(commands.get('compare.toggle')).toBeDefined();
  });

  it('Overlay to compare needs an editable document, and opens the sheet on it', async () => {
    expect(commands.isEnabled('pages.overlay')).toBe(true);
    await commands.run('pages.overlay');
    expect(sessionOf(DOC)).not.toBeNull();
    expect(useSheetStore.getState().sheet).toEqual({ kind: 'compare', docId: DOC });
  });

  it('Leave overlay compare is off until a compare is on, and ends it', async () => {
    expect(commands.isEnabled('pages.overlayLeave')).toBe(false);
    await commands.run('pages.overlay');
    expect(commands.isEnabled('pages.overlayLeave')).toBe(true);
    await commands.run('pages.overlayLeave');
    expect(sessionOf(DOC)).toBeNull();
  });

  it('F8 shows and hides the overlay while comparing', async () => {
    await commands.run('pages.overlay');
    expect(sessionOf(DOC)!.show).toBe(true);
    const event = new KeyboardEvent('keydown', { key: 'F8', cancelable: true });
    window.dispatchEvent(event);
    expect(sessionOf(DOC)!.show).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', cancelable: true }));
    expect(sessionOf(DOC)!.show).toBe(true);
  });

  it('F8 outside a compare does nothing and is left alone', () => {
    const event = new KeyboardEvent('keydown', { key: 'F8', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(commands.isEnabled('compare.toggle')).toBe(false);
  });

  it('F8 works while the sheet is hidden, and no other shortcut was added for the commands', async () => {
    await commands.run('pages.overlay');
    useSheetStore.getState().close();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', cancelable: true }));
    expect(sessionOf(DOC)!.show).toBe(false);
    const keymap = createKeymap('desktop');
    for (const id of ['pages.overlay', 'pages.overlayLeave']) {
      expect(keymap.lookup(new KeyboardEvent('keydown', { key: 'F8' }))).toBe('compare.toggle');
      expect([...Array(12).keys()].every((i) => keymap.lookup(new KeyboardEvent('keydown', { key: `F${i + 1}` })) !== id)).toBe(true);
    }
  });
});
