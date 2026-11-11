import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../commands/registry';
import { createKeymap } from './keymap';
import { attachKeymap } from './keymapService';

describe('attachKeymap with a disabled command', () => {
  it('calls onBlockedKey when the shortcut of a disabled command is pressed, and does not run it', () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    const blocked = vi.fn();
    registry.register({ id: 'pages.delete', label: 'Delete', enabled: () => false, onBlockedKey: blocked, run });
    const detach = attachKeymap(createKeymap('desktop'), registry, window);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', cancelable: true }));
    detach();
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('stays silent for a disabled command without a blocked handler', () => {
    const registry = new CommandRegistry();
    registry.register({ id: 'pages.delete', label: 'Delete', enabled: () => false, run: vi.fn() });
    const detach = attachKeymap(createKeymap('desktop'), registry, window);
    const event = new KeyboardEvent('keydown', { key: 'Delete', cancelable: true });
    window.dispatchEvent(event);
    detach();
    expect(event.defaultPrevented).toBe(false);
  });

  it('consumes the key when onBlockedKey had something to say, and leaves it alone when it returns false', () => {
    const registry = new CommandRegistry();
    let reason: boolean | void = true;
    registry.register({ id: 'pages.duplicate', label: 'Duplicate', enabled: () => false, onBlockedKey: () => reason, run: vi.fn() });
    const detach = attachKeymap(createKeymap('desktop'), registry, window);
    const said = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, cancelable: true });
    window.dispatchEvent(said);
    expect(said.defaultPrevented).toBe(true);
    reason = false;
    const silent = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, cancelable: true });
    window.dispatchEvent(silent);
    detach();
    expect(silent.defaultPrevented).toBe(false);
  });
});

describe('attachKeymap under an open modal', () => {
  it.each([
    ['an aria-modal dialog', '<div role="alertdialog" aria-modal="true"></div>'],
    ['a modal backdrop', '<div class="modal-backdrop"></div>'],
  ])('does not run or consume a document shortcut while %s is open', (_name, html) => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({ id: 'pages.delete', label: 'Delete', run });
    const detach = attachKeymap(createKeymap('desktop'), registry, window);
    document.body.insertAdjacentHTML('beforeend', `<div id="m">${html}</div>`);
    const event = new KeyboardEvent('keydown', { key: 'Delete', cancelable: true });
    window.dispatchEvent(event);
    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    document.getElementById('m')?.remove();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', cancelable: true }));
    detach();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
