/**
 * The classic menu bar (File, Edit, View, Pages, Window, Help), generated from the command registry. Every item names a
 * registered command; the label, accelerator, enabled state and check state come from the registry. Nothing here touches
 * the DOM or the stores, so the model can be tested on its own (see menuModel.test.ts).
 */

/** What the menus need to know about the app right now. */
export interface MenuContext {
  /** True in the desktop app, which has Exit and the logs folder. */
  desktop: boolean;
  /** Recent file paths, newest first (at most ten). */
  recent: readonly string[];
  /** Open tabs in tab order. `dirty` is true while the tab's document has unsaved changes. */
  tabs: ReadonlyArray<{ id: string; title: string; dirty: boolean; active: boolean }>;
  /** Registered panels, in rail order. */
  panels: ReadonlyArray<{ id: string; title: string }>;
  /** Page color modes, in the order the Page Colors menu lists them. */
  recolorModes: ReadonlyArray<{ mode: string; label: string }>;
}

/** The registry and keymap, as the model reads them. */
export interface MenuEnv {
  has(commandId: string): boolean;
  labelOf(commandId: string): string | undefined;
  isEnabled(commandId: string): boolean;
  reasonDisabled(commandId: string): string | undefined;
  checked(commandId: string): boolean | undefined;
  shortcutFor(commandId: string): string | undefined;
}

export type CheckKind = 'check' | 'radio';

export interface MenuItemNode {
  kind: 'item';
  key: string;
  command: string;
  label: string;
  /** Index in `label` of the mnemonic letter, or -1 when the item has none. */
  mnemonic: number;
  accelerator?: string;
  enabled: boolean;
  disabledReason?: string;
  checked?: boolean;
  check?: CheckKind;
  /** The argument the command runs with (a recent file, a tab id). */
  arg?: string;
}

export interface MenuSubNode {
  kind: 'sub';
  key: string;
  label: string;
  mnemonic: number;
  items: MenuNode[];
}

export interface MenuSepNode {
  kind: 'sep';
}

export type MenuNode = MenuItemNode | MenuSubNode | MenuSepNode;

export interface MenuDef {
  id: string;
  label: string;
  mnemonic: number;
  items: MenuNode[];
}

/** One entry of the menu spec: a command, a separator, a submenu, or a list filled from the context. */
export type Spec =
  | { cmd: string; label?: string; check?: CheckKind; desktopOnly?: boolean }
  | { sep: true; desktopOnly?: boolean }
  | { sub: string; items: Spec[] }
  | { dynamic: 'recent' | 'panels' | 'tabs' | 'recolor' | 'pages' };

/** The page commands in the order of the Pages group. The Pages menu lists them the same way. */
export const PAGES_MENU: Spec[] = [
  { cmd: 'pages.insert', label: 'Insert Blank Page…' },
  { cmd: 'pages.insertLined', label: 'Insert Lined Page…' },
  { cmd: 'pages.insertGrid', label: 'Insert Grid Page…' },
  { cmd: 'pages.insertFromPdf', label: 'Insert from PDF…' },
  { sep: true },
  { cmd: 'pages.delete', label: 'Delete Pages' },
  { sep: true },
  { cmd: 'pages.rotateRight', label: 'Rotate Right 90°' },
  { cmd: 'pages.rotateLeft', label: 'Rotate Left 90°' },
  { cmd: 'pages.rotate180', label: 'Rotate 180°' },
  { cmd: 'pages.rotateCustom', label: 'Custom Angle…' },
  { sep: true },
  { cmd: 'pages.crop', label: 'Crop Pages…' },
  { cmd: 'pages.autoCrop', label: 'Auto-Crop' },
  { cmd: 'pages.size', label: 'Page Size…' },
  { sep: true },
  { cmd: 'pages.duplicate', label: 'Duplicate' },
  { cmd: 'pages.replace', label: 'Replace…' },
  { cmd: 'pages.reverse', label: 'Reverse' },
  { sep: true },
  { cmd: 'pages.combine', label: 'Combine Files…' },
  { cmd: 'pages.splitFiles', label: 'Split into Files…' },
  { cmd: 'pages.cutHalf', label: 'Cut Pages in Half…' },
  { cmd: 'pages.overlay', label: 'Overlay to Compare…' },
];

/** The menus, in bar order. */
export const MENU_SPECS: ReadonlyArray<{ id: string; label: string; items: Spec[] }> = [
  {
    id: 'file',
    label: 'File',
    items: [
      { cmd: 'file.open', label: 'Open…' },
      { sub: 'Open Recent', items: [{ dynamic: 'recent' }] },
      { sep: true },
      { cmd: 'file.save' },
      { cmd: 'file.saveAs', label: 'Save As…' },
      { cmd: 'pages.extract', label: 'Extract Pages…' },
      { sep: true },
      { cmd: 'pages.combine', label: 'Combine Files…' },
      { cmd: 'pages.splitFiles', label: 'Split into Files…' },
      { sep: true },
      { cmd: 'tab.close', label: 'Close Tab' },
      { cmd: 'file.closeAll', label: 'Close All' },
      { sep: true },
      { cmd: 'file.properties', label: 'Document Properties…' },
      { sep: true, desktopOnly: true },
      { cmd: 'file.exit', label: 'Exit', desktopOnly: true },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { cmd: 'edit.undo' },
      { cmd: 'edit.redo' },
      { sep: true },
      { cmd: 'page.copy', label: 'Copy' },
      { cmd: 'page.selectAll', label: 'Select All' },
      { sep: true },
      { cmd: 'search.open', label: 'Find…' },
      { cmd: 'search.next', label: 'Find Next' },
      { cmd: 'search.prev', label: 'Find Previous' },
      { cmd: 'nav.goto', label: 'Go to Page…' },
      { sep: true },
      { cmd: 'palette.open', label: 'Command Palette…' },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      { cmd: 'view.zoomIn', label: 'Zoom In' },
      { cmd: 'view.zoomOut', label: 'Zoom Out' },
      { cmd: 'view.actualSize', label: 'Actual Size' },
      { sep: true },
      { cmd: 'view.fitPage', label: 'Fit Page', check: 'radio' },
      { cmd: 'view.fitWidth', label: 'Fit Width', check: 'radio' },
      { sep: true },
      {
        sub: 'Rotate View',
        items: [
          { cmd: 'page.rotateView', label: 'Clockwise' },
          { cmd: 'view.rotateCounter', label: 'Counter-clockwise' },
        ],
      },
      {
        sub: 'Split',
        items: [
          { cmd: 'split.none', label: 'None', check: 'radio' },
          { cmd: 'split.vertical', label: 'Vertical', check: 'radio' },
          { cmd: 'split.horizontal', label: 'Horizontal', check: 'radio' },
        ],
      },
      { sep: true },
      { cmd: 'view.loupe', label: 'Loupe', check: 'check' },
      { cmd: 'view.panZoom', label: 'Pan and Zoom', check: 'check' },
      { sub: 'Panels', items: [{ dynamic: 'panels' }] },
      { sub: 'Page Colors', items: [{ dynamic: 'recolor' }] },
      {
        sub: 'Theme',
        items: [
          { cmd: 'theme.system', label: 'System', check: 'radio' },
          { cmd: 'theme.light', label: 'Light', check: 'radio' },
          { cmd: 'theme.dark', label: 'Dark', check: 'radio' },
        ],
      },
      { sep: true },
      {
        sub: 'Toolbar',
        items: [
          { cmd: 'view.toolbar', label: 'Show Toolbar', check: 'check' },
          { cmd: 'view.toolbar.labels', label: 'Show Labels', check: 'check' },
        ],
      },
      { cmd: 'view.fullscreen', label: 'Full Screen' },
    ],
  },
  { id: 'pages', label: 'Pages', items: [{ dynamic: 'pages' }] },
  {
    id: 'window',
    label: 'Window',
    items: [
      { cmd: 'tab.next', label: 'Next Tab' },
      { cmd: 'tab.prev', label: 'Previous Tab' },
      { sep: true },
      { dynamic: 'tabs' },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [
      { cmd: 'help.shortcuts', label: 'Keyboard Shortcuts…' },
      { cmd: 'help.logs', label: 'Open Logs Folder', desktopOnly: true },
      { sep: true },
      { cmd: 'help.about', label: 'About PDF Suite…' },
    ],
  },
];

/**
 * The mnemonic letter of each label in a list: the first letter of the label that no earlier label in the same list has
 * taken. Returns the index of that letter in each label, or -1 when every letter is taken. Separators are not labels.
 */
export function assignMnemonics(labels: readonly string[]): number[] {
  const taken = new Set<string>();
  return labels.map((label) => {
    for (let i = 0; i < label.length; i++) {
      const letter = label[i]!.toLowerCase();
      if (!/[a-z]/.test(letter) || taken.has(letter)) continue;
      taken.add(letter);
      return i;
    }
    return -1;
  });
}

/** The name of a file for the title: its last path segment. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * The window title, shown in the menu row and in the document title: "<file> — PDF Suite", with a bullet before the dash
 * while the document has unsaved changes.
 */
export function windowTitle(fileName: string | null, dirty: boolean): string {
  if (!fileName) return 'PDF Suite';
  return `${fileName}${dirty ? ' •' : ''} — PDF Suite`;
}

/** Builds the menu bar from the spec, the context and the registry. */
export function buildMenuModel(ctx: MenuContext, env: MenuEnv): MenuDef[] {
  return MENU_SPECS.map((menu) => {
    const items = nodesOf(menu.items, `${menu.id}.`, ctx, env);
    return { id: menu.id, label: menu.label, mnemonic: assignMnemonics([menu.label])[0] ?? -1, items };
  });
}

/** The nodes of one list. Mnemonics are assigned within this list, so each submenu is independent. */
function nodesOf(specs: readonly Spec[], prefix: string, ctx: MenuContext, env: MenuEnv): MenuNode[] {
  const raw: MenuNode[] = [];
  specs.forEach((spec, index) => {
    const key = `${prefix}${index}`;
    if ('sep' in spec) {
      if (spec.desktopOnly && !ctx.desktop) return;
      raw.push({ kind: 'sep' });
    } else if ('sub' in spec) {
      raw.push({ kind: 'sub', key, label: spec.sub, mnemonic: -1, items: nodesOf(spec.items, `${key}.`, ctx, env) });
    } else if ('dynamic' in spec) {
      raw.push(...dynamicNodes(spec.dynamic, key, ctx, env));
    } else {
      if (spec.desktopOnly && !ctx.desktop) return;
      raw.push(leaf(spec.cmd, spec.label, { check: spec.check }, key, env));
    }
  });
  const marks = assignMnemonics(raw.map((node) => (node.kind === 'sep' ? '' : node.label)));
  return raw.map((node, i) => (node.kind === 'sep' ? node : { ...node, mnemonic: marks[i] ?? -1 }));
}

/** A menu item for a command. Its label, accelerator and states come from the registry. */
function leaf(
  command: string,
  label: string | undefined,
  options: { check?: CheckKind; arg?: string; disabled?: boolean; checked?: boolean },
  key: string,
  env: MenuEnv,
): MenuItemNode {
  const known = env.has(command);
  // An item with an argument (a recent file, a tab) is enabled when the command is; the argument is what it acts on.
  const enabled = known && !options.disabled && (options.arg !== undefined || env.isEnabled(command));
  const node: MenuItemNode = {
    kind: 'item',
    key,
    command,
    label: label ?? env.labelOf(command) ?? command,
    mnemonic: -1,
    accelerator: env.shortcutFor(command),
    enabled,
    checked: options.checked ?? (options.check ? env.checked(command) : undefined),
  };
  if (options.check) node.check = options.check;
  if (!enabled && known) {
    const reason = env.reasonDisabled(command);
    if (reason) node.disabledReason = reason;
  }
  if (options.arg !== undefined) node.arg = options.arg;
  return node;
}

function dynamicNodes(kind: 'recent' | 'panels' | 'tabs' | 'recolor' | 'pages', key: string, ctx: MenuContext, env: MenuEnv): MenuNode[] {
  switch (kind) {
    case 'recent': {
      const items: MenuNode[] = ctx.recent.map((path, i) => leaf('file.openRecent', fileNameOf(path), { arg: path }, `${key}.${i}`, env));
      if (items.length === 0) items.push(leaf('file.openRecent', 'No Recent Files', { disabled: true }, `${key}.none`, env));
      items.push({ kind: 'sep' }, leaf('file.clearRecent', 'Clear List', {}, `${key}.clear`, env));
      return items;
    }
    case 'panels':
      return ctx.panels.map((p) => leaf(`panel.${p.id}`, p.title, { check: 'check' }, `${key}.${p.id}`, env));
    case 'recolor':
      return ctx.recolorModes.map((m) => leaf(`view.recolor.${m.mode}`, m.label, { check: 'radio' }, `${key}.${m.mode}`, env));
    case 'tabs': {
      if (ctx.tabs.length === 0) return [leaf('window.focusTab', 'No Open Files', { disabled: true }, `${key}.none`, env)];
      return ctx.tabs.map((tab) =>
        leaf('window.focusTab', `${tab.dirty ? '• ' : ''}${tab.title}`, { check: 'radio', arg: tab.id, checked: tab.active }, `${key}.${tab.id}`, env),
      );
    }
    case 'pages':
      return nodesOf(PAGES_MENU, `${key}.`, ctx, env);
  }
}

/** Every command the menus can name in this context, for the test that checks they are all registered. */
export function menuCommandIds(ctx: MenuContext): string[] {
  const ids = new Set<string>();
  const walk = (nodes: readonly MenuNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'item') ids.add(node.command);
      else if (node.kind === 'sub') walk(node.items);
    }
  };
  const env: MenuEnv = {
    has: () => true,
    labelOf: () => undefined,
    isEnabled: () => true,
    reasonDisabled: () => undefined,
    checked: () => undefined,
    shortcutFor: () => undefined,
  };
  for (const menu of buildMenuModel(ctx, env)) walk(menu.items);
  return [...ids];
}
