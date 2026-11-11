import { describe, expect, it } from 'vitest';
import { assignMnemonics, buildMenuModel, menuCommandIds, windowTitle, type MenuContext, type MenuEnv, type MenuNode } from './menuModel';
import { CommandRegistry } from '../commands/registry';
import { registerBuiltins } from '../../app/registerBuiltins';
import { commands } from '../commands/registry';

const ctx: MenuContext = {
  desktop: true,
  recent: ['C:\\docs\\alpha.pdf', 'C:\\docs\\beta.pdf'],
  tabs: [
    { id: 't1', title: 'alpha.pdf', dirty: true, active: true },
    { id: 't2', title: 'beta.pdf', dirty: false, active: false },
  ],
  panels: [
    { id: 'thumbnails', title: 'Thumbnails' },
    { id: 'bookmarks', title: 'Bookmarks' },
  ],
  recolorModes: [
    { mode: 'off', label: 'Off' },
    { mode: 'invert', label: 'Invert' },
  ],
};

const env: MenuEnv = {
  has: () => true,
  labelOf: () => undefined,
  isEnabled: () => true,
  reasonDisabled: () => undefined,
  checked: () => undefined,
  shortcutFor: () => undefined,
};

/** The lists that have their own mnemonics: a menu's items and each submenu's items. */
function lists(nodes: readonly MenuNode[]): MenuNode[][] {
  const out: MenuNode[][] = [nodes as MenuNode[]];
  for (const node of nodes) if (node.kind === 'sub') out.push(...lists(node.items));
  return out;
}

describe('menu bar model', () => {
  it('has the six menus in order, with the fixed mnemonics F, E, V, P, W, H', () => {
    const menus = buildMenuModel(ctx, env);
    expect(menus.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Pages', 'Window', 'Help']);
    expect(menus.map((m) => m.label[m.mnemonic]?.toUpperCase())).toEqual(['F', 'E', 'V', 'P', 'W', 'H']);
  });

  it('every menu item names a registered command', () => {
    registerBuiltins();
    const registered = new Set(commands.list().map((def) => def.id));
    const named = menuCommandIds(ctx);
    expect(named.length).toBeGreaterThan(40);
    expect(named.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('no menu list has a duplicate mnemonic letter', () => {
    const menus = buildMenuModel(ctx, env);
    for (const menu of menus) {
      for (const list of lists(menu.items)) {
        const letters = list
          .filter((n): n is Extract<MenuNode, { label: string; mnemonic: number }> => n.kind !== 'sep')
          .filter((n) => n.mnemonic >= 0)
          .map((n) => n.label[n.mnemonic]!.toLowerCase());
        expect(new Set(letters).size, `${menu.label}: ${letters.join(',')}`).toBe(letters.length);
      }
    }
  });

  it('the Window menu lists each open tab, with a bullet on the unsaved ones and a check on the active one', () => {
    const window = buildMenuModel(ctx, env).find((m) => m.label === 'Window')!;
    const tabs = window.items.filter((n): n is Extract<MenuNode, { kind: 'item' }> => n.kind === 'item' && n.command === 'window.focusTab');
    expect(tabs.map((t) => t.label)).toEqual(['• alpha.pdf', 'beta.pdf']);
    expect(tabs.map((t) => t.checked)).toEqual([true, false]);
    expect(tabs[0]?.arg).toBe('t1');
  });

  it('recent files are named by their file name, then Clear List', () => {
    const file = buildMenuModel(ctx, env).find((m) => m.label === 'File')!;
    const recent = file.items.find((n) => n.kind === 'sub' && n.label === 'Open Recent');
    expect(recent && recent.kind === 'sub' ? recent.items.map((n) => (n.kind === 'item' ? n.label : '|')) : []).toEqual([
      'alpha.pdf',
      'beta.pdf',
      '|',
      'Clear List',
    ]);
  });

  it('the Pages menu has the Pages group entries, in the group order', () => {
    const pages = buildMenuModel(ctx, env).find((m) => m.label === 'Pages')!;
    const ids = pages.items.filter((n) => n.kind === 'item').map((n) => (n.kind === 'item' ? n.command : ''));
    expect(ids.slice(0, 4)).toEqual(['pages.insert', 'pages.insertLined', 'pages.insertGrid', 'pages.insertFromPdf']);
    expect(ids).toContain('pages.delete');
    // The new Pages items follow Reverse after a divider, in the UI spec's order (section 0): Combine (1.3.3), Split into Files, Cut
    // Pages in Half, and Overlay to Compare (1.3.4) last.
    expect(ids.at(-5)).toBe('pages.reverse');
    expect(ids.at(-4)).toBe('pages.combine');
    expect(ids.at(-3)).toBe('pages.splitFiles');
    expect(ids.at(-2)).toBe('pages.cutHalf');
    expect(ids.at(-1)).toBe('pages.overlay');
  });

  it('desktop-only items are left out of the web build (no Exit, no logs folder)', () => {
    const web = buildMenuModel({ ...ctx, desktop: false }, env);
    const commandsWeb = menuCommandIds({ ...ctx, desktop: false });
    expect(commandsWeb).not.toContain('file.exit');
    expect(commandsWeb).not.toContain('help.logs');
    expect(web.find((m) => m.label === 'File')!.items.some((n) => n.kind === 'item' && n.command === 'file.exit')).toBe(false);
  });

  it('a disabled command is shown disabled, with its reason', () => {
    const disabled: MenuEnv = { ...env, isEnabled: (id) => id !== 'edit.undo', reasonDisabled: (id) => (id === 'edit.undo' ? 'Nothing to undo' : undefined) };
    const edit = buildMenuModel(ctx, disabled).find((m) => m.label === 'Edit')!;
    const undo = edit.items.find((n) => n.kind === 'item' && n.command === 'edit.undo');
    expect(undo && undo.kind === 'item' ? [undo.enabled, undo.disabledReason] : []).toEqual([false, 'Nothing to undo']);
  });

  it('accelerators and check states come from the registry', () => {
    const registry = new CommandRegistry();
    registry.register({ id: 'view.toolbar', label: 'Toolbar', run: () => undefined, checked: () => true });
    const view = buildMenuModel(
      { ...ctx, panels: [] },
      { ...env, checked: (id) => registry.get(id)?.checked?.(), shortcutFor: (id) => (id === 'palette.open' ? 'Ctrl+K' : undefined) },
    ).find((m) => m.label === 'View')!;
    // View > Toolbar is a submenu since 1.2.2: Show Toolbar and Show Labels.
    const toolbarMenu = view.items.find((n) => n.kind === 'sub' && n.label === 'Toolbar');
    const toolbar = toolbarMenu && toolbarMenu.kind === 'sub' ? toolbarMenu.items.find((n) => n.kind === 'item' && n.command === 'view.toolbar') : undefined;
    expect(toolbar && toolbar.kind === 'item' ? [toolbar.checked, toolbar.check] : []).toEqual([true, 'check']);
    const edit = buildMenuModel(ctx, { ...env, shortcutFor: (id) => (id === 'palette.open' ? 'Ctrl+K' : undefined) }).find((m) => m.label === 'Edit')!;
    const palette = edit.items.find((n) => n.kind === 'item' && n.command === 'palette.open');
    expect(palette && palette.kind === 'item' ? palette.accelerator : undefined).toBe('Ctrl+K');
  });
});

describe('mnemonics', () => {
  it('takes the first free letter of each label, with no repeats', () => {
    expect(assignMnemonics(['Open', 'Open Recent', 'Save', 'Save As…'])).toEqual([0, 1, 0, 1]);
    expect(assignMnemonics(['Save', 'Save As'])).toEqual([0, 1]);
    expect(assignMnemonics(['Zoom', 'zoom'])).toEqual([0, 1]);
    expect(assignMnemonics(['…', '1'])).toEqual([-1, -1]);
  });
});

describe('window title', () => {
  it('is the file name with the app name, and the bullet only while there are unsaved changes', () => {
    expect(windowTitle('notes.pdf', false)).toBe('notes.pdf — PDF Suite');
    expect(windowTitle('notes.pdf', true)).toBe('notes.pdf • — PDF Suite');
    expect(windowTitle(null, false)).toBe('PDF Suite');
  });
});

describe('menu items of ticket 1.2.2', () => {
  const find = (nodes: readonly MenuNode[], command: string): Extract<MenuNode, { kind: 'item' }> | undefined => {
    for (const node of nodes) {
      if (node.kind === 'item' && node.command === command) return node;
      if (node.kind === 'sub') {
        const hit = find(node.items, command);
        if (hit) return hit;
      }
    }
    return undefined;
  };

  it('the File menu says "Open…", as the menu bar spec does', () => {
    const file = buildMenuModel(ctx, { ...env, labelOf: (id) => (id === 'file.open' ? 'Open PDF' : undefined) }).find((m) => m.label === 'File')!;
    expect(find(file.items, 'file.open')?.label).toBe('Open…');
  });

  it('Close All shows its shortcut from the keymap', () => {
    const file = buildMenuModel(ctx, { ...env, shortcutFor: (id) => (id === 'file.closeAll' ? 'Ctrl+Shift+W' : undefined) }).find((m) => m.label === 'File')!;
    expect(find(file.items, 'file.closeAll')?.accelerator).toBe('Ctrl+Shift+W');
    expect(find(file.items, 'file.closeAll')?.label).toBe('Close All');
  });

  it('View > Toolbar is a submenu with Show Toolbar and Show Labels, both checkable', () => {
    const view = buildMenuModel(ctx, env).find((m) => m.label === 'View')!;
    const toolbar = view.items.find((n) => n.kind === 'sub' && n.label === 'Toolbar');
    expect(toolbar && toolbar.kind === 'sub' ? toolbar.items.map((n) => (n.kind === 'item' ? [n.command, n.label, n.check] : n.kind)) : []).toEqual([
      ['view.toolbar', 'Show Toolbar', 'check'],
      ['view.toolbar.labels', 'Show Labels', 'check'],
    ]);
  });

  it('the Show Labels state comes from the registry', () => {
    const view = buildMenuModel(ctx, { ...env, checked: (id) => id === 'view.toolbar.labels' }).find((m) => m.label === 'View')!;
    expect(find(view.items, 'view.toolbar.labels')?.checked).toBe(true);
    expect(find(view.items, 'view.toolbar')?.checked).toBe(false);
  });
});

describe('the window title (1.2.2; the name is cut by middleTruncate, 1.5.5 D6)', () => {
  it('the unsaved dot and the app name come after the name in the title text', () => {
    expect(windowTitle('A very long file name.pdf', true)).toBe('A very long file name.pdf • — PDF Suite');
  });
});
