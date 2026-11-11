import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { commands } from '../../core/commands/registry';
import { middleTruncate } from '../common/middleTruncate';
import { MENU_SPECS, assignMnemonics, buildMenuModel, windowTitle, type MenuContext, type MenuDef, type MenuEnv, type MenuItemNode, type MenuNode, type MenuSubNode } from '../../core/menus/menuModel';
import { keymap, fileService } from '../../app/services';
import { panels } from '../../core/layout/panelRegistry';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useFloatingStore } from '../../core/stores/floatingStore';
import { useRecolorStore } from '../../core/stores/recolorStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useUiStore } from '../../core/stores/uiStore';
import { selectActiveTab, selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { RECOLOR_MODES } from '../../features/recolor/recolorFilter';
import type { RecentFile } from '../../platform/fileService';
import { trackRestingPointer, type RestingPointer } from './restingPointer';

/**
 * The menu bar: a 28 px row above the tabs, with File, Edit, View, Pages, Window and Help. Every item is a registry command
 * (see core/menus/menuModel.ts). In the desktop app the row is also the window's drag area, and it shows the window title
 * in its middle. Alt (pressed and released alone) or F10 focuses the bar; the letters underlined while Alt is held open
 * the menus. Arrow keys move, Enter runs, Esc backs out and returns the focus to the page.
 */

/** The fixed top-level mnemonics: File, Edit, View, Pages, Window, Help. */
const TOP_LEVEL_KEYS = ['F', 'E', 'V', 'P', 'W', 'H'];

/** Space the window's own buttons take at the right of the row (the Windows title-bar overlay). */
export const WINDOW_BUTTONS_PX = 144;

/** What the keyboard can land on in a list: enabled items and submenus. Separators and disabled items are skipped. */
function navigable(nodes: readonly MenuNode[]): Array<MenuItemNode | MenuSubNode> {
  return nodes.filter((n): n is MenuItemNode | MenuSubNode => (n.kind === 'item' ? n.enabled : n.kind === 'sub'));
}

/** The label with its mnemonic letter underlined while the letters show. */
function Label({ text, mnemonic, show }: { text: string; mnemonic: number; show: boolean }) {
  if (mnemonic < 0 || !show) return <>{text}</>;
  return (
    <>
      {text.slice(0, mnemonic)}
      <span className="menu-mn">{text[mnemonic]}</span>
      {text.slice(mnemonic + 1)}
    </>
  );
}

/** Focus and open state of the bar. `sub` is the key of an open submenu of the open menu. */
interface BarState {
  open: string | null;
  active: boolean;
  top: number;
  item: number;
  sub: string | null;
  subItem: number;
}

/** The six top-level menus: fixed, so the closed bar needs no model at all. */
const HEADS: ReadonlyArray<{ id: string; label: string; mnemonic: number }> = MENU_SPECS.map((menu) => ({
  id: menu.id,
  label: menu.label,
  mnemonic: assignMnemonics([menu.label])[0] ?? -1,
}));

const NO_MENUS: MenuDef[] = [];

const CLOSED: BarState = { open: null, active: false, top: 0, item: 0, sub: null, subItem: 0 };

/**
 * The menu model, built only while a menu is open, and kept current while it is open: the enabled, checked and label states
 * read the stores the commands read, so it is rebuilt when one of them changes. With every menu closed nothing is built and
 * nothing is subscribed to, so the bar does not draw while the document scrolls.
 */
function useOpenMenus(open: boolean, recent: readonly string[]): MenuDef[] {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  // Subscribed before the first paint of the open menu, so no change between the build and the subscription is missed.
  useLayoutEffect(() => {
    if (!open) return;
    const stores = [useWorkspaceStore, useEditStore, useDocumentsStore, useSelectionStore, useUiStore, useRecolorStore, useFloatingStore];
    const offs = stores.map((store) => (store as { subscribe: (listener: () => void) => () => void }).subscribe(() => refresh()));
    return () => offs.forEach((off) => off());
  }, [open]);
  if (!open) return NO_MENUS;
  const workspace = useWorkspaceStore.getState();
  const edit = useEditStore.getState().byDoc;
  const ctx: MenuContext = {
    desktop: typeof window !== 'undefined' && window.pdfSuite !== undefined,
    recent: [...recent],
    tabs: workspace.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      dirty: tab.panes[0] ? edit[tab.panes[0].docId]?.history.dirty === true : false,
      active: tab.id === workspace.activeTabId,
    })),
    panels: panels.list().map((p) => ({ id: p.id, title: p.title })),
    recolorModes: RECOLOR_MODES.map((m) => ({ mode: m.mode, label: m.label })),
  };
  const env: MenuEnv = {
    has: (id) => commands.has(id),
    labelOf: (id) => commands.labelOf(id),
    isEnabled: (id) => commands.isEnabled(id),
    reasonDisabled: (id) => commands.reasonDisabled(id),
    checked: (id) => commands.get(id)?.checked?.(),
    shortcutFor: (id) => keymap.shortcutFor(id),
  };
  return buildMenuModel(ctx, env);
}

export function MenuBar() {
  // The closed bar reads only what it shows: the title, the unsaved mark and which menu is open. The rows of a menu and their
  // enabled states are built while a menu is open (below), so scrolling never draws the bar.
  const tabTitle = useWorkspaceStore((s) => selectActiveTab(s)?.title ?? null);
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId ?? null);
  const dirty = useEditStore((s) => (docId !== null ? s.byDoc[docId]?.history.dirty === true : false));
  const [recent, setRecent] = useState<string[]>([]);
  const [bar, setBar] = useState<BarState>(CLOSED);
  const [altHeld, setAltHeld] = useState(false);
  const rowRef = useRef<HTMLElement>(null);
  const barRef = useRef(bar);
  barRef.current = bar;
  // Hover changes a highlighted row only after the pointer has really moved since the last key press.
  const pointerRef = useRef<RestingPointer | null>(null);
  useEffect(() => {
    pointerRef.current = trackRestingPointer();
    return () => pointerRef.current?.stop();
  }, []);
  const canHover = () => pointerRef.current?.allowed() !== false;

  const title = windowTitle(tabTitle, dirty);
  // The title is split so that only the file name gives way when the row is narrow. The name is cut in the middle: its
  // start and its end (with the extension) stay in view. The unsaved bullet and the app name form a tail that never gives way.
  const titleName = middleTruncate(tabTitle ?? '');
  const titleTail = tabTitle !== null ? `${dirty ? ' •' : ''} — PDF Suite` : 'PDF Suite';

  const menus = useOpenMenus(bar.open !== null, recent);
  const menusRef = useRef<MenuDef[]>(menus);
  menusRef.current = menus;

  // Where the focus was before the bar took it, so that Esc can give it back.
  const returnRef = useRef<HTMLElement | null>(null);
  const remember = () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body && !rowRef.current?.contains(el)) returnRef.current = el;
  };
  const focusPage = () => {
    const back = returnRef.current;
    returnRef.current = null;
    if (back && back.isConnected) back.focus();
    else document.querySelector<HTMLElement>('.main')?.focus();
  };

  const loadRecent = () => {
    void fileService.listRecent(10).then((files: RecentFile[]) => setRecent(files.flatMap((f) => (f.kind === 'path' ? [f.path] : []))));
  };

  const openTop = (index: number) => {
    const menu = HEADS[index];
    if (!menu) return;
    if (!barRef.current.active && barRef.current.open === null) remember();
    if (menu.id === 'file') loadRecent();
    setBar({ open: menu.id, active: true, top: index, item: 0, sub: null, subItem: 0 });
  };

  const closeAll = (returnFocus: boolean) => {
    setBar(CLOSED);
    if (returnFocus) focusPage();
  };

  const run = (item: MenuItemNode) => {
    if (!item.enabled) return;
    closeAll(true);
    void commands.run(item.command, item.arg);
  };

  // The keyboard and pointer handlers are attached once and read the latest state through refs.
  useEffect(() => {
    let altDown = false;
    let altClean = false;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        if (!event.repeat) {
          altDown = true;
          altClean = true;
          setAltHeld(true);
        }
        return;
      }
      if (altDown) altClean = false;
      const state = barRef.current;
      const list = HEADS;
      const built = menusRef.current;
      if (event.key === 'F10' && !event.altKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        if (!state.active && state.open === null) remember();
        setBar({ ...CLOSED, active: true });
        return;
      }
      const engaged = state.active || state.open !== null;
      if (!engaged) {
        // Alt plus a letter opens a menu, unless the chord is a shortcut of its own (Alt+W closes a tab in the web build).
        if (event.altKey && !event.ctrlKey && event.key.length === 1 && !keymap.lookup(event)) {
          const top = TOP_LEVEL_KEYS.indexOf(event.key.toUpperCase());
          if (top >= 0) {
            event.preventDefault();
            openTop(top);
          }
        }
        return;
      }
      if (event.key === 'Tab') {
        // Tab leaves the bar and lets the browser move the focus on.
        closeAll(false);
        return;
      }
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const openMenu = built.find((m) => m.id === state.open);
      const items = openMenu ? navigable(openMenu.items) : [];
      const subNode = openMenu && state.sub ? openMenu.items.find((n) => n.kind === 'sub' && n.key === state.sub) : undefined;
      const subItems = subNode && subNode.kind === 'sub' ? navigable(subNode.items) : [];

      switch (event.key) {
        case 'Escape':
          consume();
          if (state.sub) setBar({ ...state, sub: null, subItem: 0 });
          else closeAll(true);
          return;
        case 'ArrowRight': {
          consume();
          if (!state.open) return setBar({ ...state, top: (state.top + 1) % list.length });
          if (state.sub) return undefined;
          const focused = items[state.item];
          if (focused?.kind === 'sub') return setBar({ ...state, sub: focused.key, subItem: 0 });
          return openTop((state.top + 1) % list.length);
        }
        case 'ArrowLeft': {
          consume();
          if (state.sub) return setBar({ ...state, sub: null, subItem: 0 });
          if (!state.open) return setBar({ ...state, top: (state.top + list.length - 1) % list.length });
          return openTop((state.top + list.length - 1) % list.length);
        }
        case 'ArrowDown':
        case 'ArrowUp': {
          consume();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          if (!state.open) return openTop(state.top);
          if (state.sub) {
            if (subItems.length) setBar({ ...state, subItem: (state.subItem + step + subItems.length) % subItems.length });
            return undefined;
          }
          if (items.length) setBar({ ...state, item: (state.item + step + items.length) % items.length });
          return undefined;
        }
        case 'Enter': {
          consume();
          if (!state.open) return openTop(state.top);
          if (state.sub) {
            const target = subItems[state.subItem];
            if (target?.kind === 'item') run(target);
            return undefined;
          }
          const focused = items[state.item];
          if (focused?.kind === 'sub') return setBar({ ...state, sub: focused.key, subItem: 0 });
          if (focused?.kind === 'item') run(focused);
          return undefined;
        }
        default:
          break;
      }

      // A letter with no modifier runs the open menu's item with that mnemonic, or opens a top-level menu.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        const letter = event.key.toLowerCase();
        const pool = subNode && subNode.kind === 'sub' ? subNode.items : openMenu?.items ?? [];
        const hit = pool.find((n): n is MenuItemNode => n.kind === 'item' && n.enabled && n.mnemonic >= 0 && n.label[n.mnemonic]?.toLowerCase() === letter);
        if (hit) {
          consume();
          run(hit);
          return;
        }
        if (!state.open) {
          const top = TOP_LEVEL_KEYS.indexOf(event.key.toUpperCase());
          if (top >= 0) {
            consume();
            openTop(top);
          }
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      setAltHeld(false);
      const clean = altClean;
      altDown = false;
      altClean = false;
      if (!clean) return;
      // A lone Alt press focuses the bar, or leaves it when it already has the focus.
      const state = barRef.current;
      if (state.active || state.open) closeAll(true);
      else {
        remember();
        setBar({ ...CLOSED, active: true });
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const state = barRef.current;
      const inside = rowRef.current?.contains(event.target as Node) === true;
      if (inside && !state.open && !state.active) remember();
      if ((state.open || state.active) && !inside) closeAll(false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
    // Written once: the handlers read the current state and menus through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showMnemonics = altHeld || bar.active;

  // Real DOM focus follows the bar's state: the focused top-level button, item or submenu item takes it.
  useEffect(() => {
    if (!bar.active) return;
    const target = rowRef.current?.querySelector<HTMLElement>('[data-menu-focus="true"]');
    if (target && document.activeElement !== target) target.focus();
  }, [bar]);

  return (
    <header className="menu-row" ref={rowRef}>
      <div className="menu-tops" role="menubar" aria-label="Menu bar">
        {HEADS.map((menu, index) => {
          const open = bar.open === menu.id;
          const built = open ? menus.find((m) => m.id === menu.id) : undefined;
          const focused = bar.active && bar.top === index && !open;
          return (
            <div key={menu.id} className="menu-top" role="none">
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                tabIndex={bar.top === index ? 0 : -1}
                data-menu-focus={bar.active && bar.top === index && !open ? 'true' : undefined}
                className={`menu-button${open || focused ? ' menu-button-on' : ''}`}
                onClick={() => (open ? closeAll(true) : openTop(index))}
                onPointerEnter={() => {
                  if (bar.open && bar.open !== menu.id && canHover()) openTop(index);
                }}
                onPointerMove={() => {
                  if (bar.open && bar.open !== menu.id && canHover()) openTop(index);
                }}
              >
                <Label text={menu.label} mnemonic={menu.mnemonic} show={showMnemonics} />
              </button>
              {open && built && <Dropdown menu={built} state={bar} setState={setBar} run={run} show={showMnemonics} canHover={canHover} />}
            </div>
          );
        })}
      </div>
      <div className="menu-title" title={title}>
        <span className="menu-title-name">
          <span className="menu-title-head">{titleName.head}</span>
          <span className="menu-title-end">{titleName.end}</span>
        </span>
        <span className="menu-title-tail">{titleTail}</span>
      </div>
      <div className="menu-window-space" aria-hidden="true" />
    </header>
  );
}

/** A dropdown list: items, separators, checks, radios, accelerators, and one level of submenus. */
function Dropdown({
  menu,
  state,
  setState,
  run,
  show,
  canHover,
}: {
  menu: MenuDef;
  state: BarState;
  setState: (next: BarState) => void;
  run: (item: MenuItemNode) => void;
  show: boolean;
  canHover: () => boolean;
}) {
  const focusedKey = navigable(menu.items)[state.item]?.key;
  return (
    <div className="menu-dropdown" role="menu" aria-label={menu.label}>
      {menu.items.map((node, i) => {
        if (node.kind === 'sep') return <hr key={`sep-${i}`} className="menu-sep" />;
        if (node.kind === 'sub') {
          const expanded = state.sub === node.key;
          const subFocus = expanded ? navigable(node.items)[state.subItem]?.key : undefined;
          return (
            <div key={node.key} role="none" className="menu-sub-wrap"
              onPointerEnter={() => canHover() && state.sub !== node.key && setState({ ...state, sub: node.key, subItem: 0 })}
              onPointerMove={() => canHover() && state.sub !== node.key && setState({ ...state, sub: node.key, subItem: 0 })}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={expanded}
                tabIndex={-1}
                data-menu-focus={focusedKey === node.key && state.sub === null ? 'true' : undefined}
                className={`menu-item${expanded || focusedKey === node.key ? ' menu-item-on' : ''}`}
                // A click opens the submenu and never closes it: the pointer entering the row has usually opened it already, and a click
                // that then closed it again (depending on whether the entering had been drawn yet) made the submenu come and go.
                onClick={() => setState({ ...state, sub: node.key, subItem: 0 })}
              >
                <span className="menu-check" />
                <span className="menu-label">
                  <Label text={node.label} mnemonic={node.mnemonic} show={show} />
                </span>
                <span className="menu-accel">›</span>
              </button>
              {expanded && (
                <div className="menu-dropdown menu-sub" role="menu" aria-label={node.label}>
                  {node.items.map((sub, j) =>
                    sub.kind === 'sep' ? (
                      <hr key={`s-${j}`} className="menu-sep" />
                    ) : sub.kind === 'item' ? (
                      <ItemRow key={sub.key} item={sub} focused={subFocus === sub.key} show={show} onRun={run} />
                    ) : null,
                  )}
                </div>
              )}
            </div>
          );
        }
        const focused = state.sub === null && focusedKey === node.key;
        return (
          <ItemRow
            key={node.key}
            item={node}
            focused={focused}
            show={show}
            onRun={run}
            onHover={() => canHover() && setState({ ...state, item: Math.max(0, navigable(menu.items).findIndex((n) => n.key === node.key)), sub: null })}
          />
        );
      })}
    </div>
  );
}

function ItemRow({
  item,
  focused,
  show,
  onRun,
  onHover,
}: {
  item: MenuItemNode;
  focused: boolean;
  show: boolean;
  onRun: (item: MenuItemNode) => void;
  onHover?: () => void;
}) {
  const mark = item.checked ? (item.check === 'radio' ? '●' : '✓') : '';
  const role = item.check === 'radio' ? 'menuitemradio' : item.check === 'check' ? 'menuitemcheckbox' : 'menuitem';
  return (
    <button
      type="button"
      role={role}
      aria-checked={item.check ? item.checked === true : undefined}
      tabIndex={-1}
      data-menu-focus={focused ? 'true' : undefined}
      className={`menu-item${focused ? ' menu-item-on' : ''}`}
      disabled={!item.enabled}
      title={item.disabledReason}
      onPointerEnter={onHover}
      onPointerMove={focused ? undefined : onHover}
      onClick={() => onRun(item)}
    >
      <span className="menu-check">{mark}</span>
      <span className="menu-label">
        <Label text={item.label} mnemonic={item.mnemonic} show={show} />
      </span>
      {item.accelerator && <span className="menu-accel">{item.accelerator}</span>}
    </button>
  );
}
