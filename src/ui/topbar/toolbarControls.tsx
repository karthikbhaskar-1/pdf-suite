import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { commands } from '../../core/commands/registry';
import type { MenuEntry } from '../../core/layout/topBarRegistry';
import { keymap, fileService } from '../../app/services';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useFloatingStore } from '../../core/stores/floatingStore';
import { useRecolorStore } from '../../core/stores/recolorStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useUiStore } from '../../core/stores/uiStore';
import { selectActiveTab, selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import type { RecentFile } from '../../platform/fileService';
import { ChevronDownIcon } from '../icons';
import { ariaShortcut, tooltipText } from './shortcutText';

/**
 * The building blocks of the top bar (ticket 1.2.2): an icon button for a command, a menu button, a split button and the
 * popup menu they share with the "…" overflow menu. Icons are 18 px in 32 by 32 buttons; a label shows beside the icon
 * only when Show Labels is on and there is room. Tooltips come from data-tooltip (see Tooltip.tsx).
 */

export const ICON_PX = 18;

/**
 * What a command's enabled state can depend on in the workspace: the tabs, the active pane and its page, and whether the
 * tab is split. The viewer writes its scroll position to the pane's view on every frame, so the whole workspace is not
 * watched: only this key, which changes when the user's page does.
 */
function workspaceKey(state: ReturnType<typeof useWorkspaceStore.getState>): string {
  const pane = selectPane(state, state.activePaneId);
  return `${state.activeTabId}|${state.activePaneId}|${state.tabs.length}|${pane?.view.pageId ?? ''}|${selectActiveTab(state)?.panes.length ?? 0}`;
}

/** The buttons that want to re-check their command. One listener per store serves all of them. */
const stateListeners = new Set<() => void>();
let stateWatching = false;

function notifyStateListeners(): void {
  for (const listener of stateListeners) listener();
}

/** Starts the store listeners the first time a button needs them. They stay for the life of the app. */
function watchStores(): void {
  if (stateWatching) return;
  stateWatching = true;
  let last = workspaceKey(useWorkspaceStore.getState());
  useWorkspaceStore.subscribe((state) => {
    const key = workspaceKey(state);
    if (key === last) return;
    last = key;
    notifyStateListeners();
  });
  // Enabled state also depends on the selection, the page list and the edit history.
  for (const store of [useSelectionStore, useEditStore, useDocumentsStore]) store.subscribe(notifyStateListeners);
}

/**
 * Enabled state, reason and shortcut of a command. It re-checks when the active tab, pane or page, the selection, the
 * documents or the edit history change, and the button renders again only when the answer (or its reason) differs. A scroll
 * within a page changes none of these, so it costs the buttons nothing.
 */
export function useCommandState(commandId: string): { enabled: boolean; reason: string | undefined; shortcut: string | undefined } {
  const [, setSeen] = useState('');
  useEffect(() => {
    watchStores();
    const check = () => setSeen(`${commands.isEnabled(commandId)}|${commands.reasonDisabled(commandId) ?? ''}`);
    check();
    stateListeners.add(check);
    return () => void stateListeners.delete(check);
  }, [commandId]);
  const enabled = commands.isEnabled(commandId);
  return { enabled, reason: enabled ? undefined : commands.reasonDisabled(commandId), shortcut: keymap.shortcutFor(commandId) };
}

/** The recently opened files, for the Recent menu. They are read each time that menu opens. */
export const useRecentStore = create<{ files: RecentFile[]; refresh: () => void }>()((set) => ({
  files: [],
  refresh: () => void fileService.listRecent(10).then((files) => set({ files })),
}));

/** Re-renders while mounted whenever a store a menu row reads changes. Used by open popups only. */
function useStoresTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const stores = [useWorkspaceStore, useSelectionStore, useEditStore, useDocumentsStore, useFloatingStore, useRecolorStore, useUiStore, useRecentStore];
    const offs = stores.map((store) => (store as { subscribe: (listener: () => void) => () => void }).subscribe(bump));
    return () => offs.forEach((off) => off());
  }, []);
}

/** The label span of a button. It is always in the DOM so the bar can measure it; it is out of the flow when it does not show. */
function LabelText({ text, show }: { text: string; show: boolean }) {
  return (
    <span className={show ? 'tb-label' : 'tb-label tb-label-off'} aria-hidden="true">
      {text}
    </span>
  );
}

interface ToolbarButtonProps {
  commandId: string;
  /** The label: beside the icon when labels show, in the overflow menu, and the tooltip unless `tip` is given. */
  label: string;
  /** The accessible name when it is not the label (Undo names the action). */
  name?: string;
  icon: ReactNode;
  /** Whether the label shows beside the icon. Leave it out for a button that never has a label (it then has none in the DOM). */
  showLabel?: boolean;
  /** A toggle: the pressed state, or undefined for a plain button. */
  pressed?: boolean;
  className?: string;
  /** A second tooltip line (and the accessible description) naming the pages the command will act on (1.5.5 D5). */
  targetLine?: string | null;
}

/** An icon button that runs a registered command. */
export function ToolbarButton({ commandId, label, name, icon, showLabel, pressed, className, targetLine }: ToolbarButtonProps) {
  const { enabled, reason, shortcut } = useCommandState(commandId);
  const descriptionId = useId();
  const text = name ?? label;
  const base = reason ?? tooltipText(text, shortcut);
  const tip = targetLine ? `${base}
${targetLine}` : base;
  return (
    <span className="tb-tip" data-tooltip={tip}>
      <button
        type="button"
        className={`tb-btn${showLabel ? ' tb-btn-labeled' : ''}${className ? ` ${className}` : ''}`}
        disabled={!enabled}
        data-tooltip={tip}
        aria-label={text}
        aria-keyshortcuts={ariaShortcut(shortcut)}
        aria-pressed={pressed}
        aria-describedby={targetLine ? descriptionId : undefined}
        onClick={() => void commands.run(commandId)}
      >
        {icon}
        {showLabel !== undefined && <LabelText text={label} show={showLabel} />}
      </button>
      {targetLine && (
        <span id={descriptionId} hidden>
          {targetLine}
        </span>
      )}
    </span>
  );
}

interface MenuButtonProps {
  label: string;
  /** The accessible name when it is not the label. */
  name?: string;
  icon: ReactNode;
  showLabel?: boolean;
  /** The rows of the menu. Read while it is open, so they stay current. */
  entries: () => MenuEntry[];
  /** Called each time the menu opens (the Recent menu reads the list then). */
  onOpen?: () => void;
  /** Shows a chevron after the icon. */
  chevron?: boolean;
  /** Aligns the menu with the button's right edge. */
  alignEnd?: boolean;
  /** The button is off (the status bar's zoom presets with no document open). Its tooltip is the label. */
  disabled?: boolean;
  /** Opens the menu above the button (the status bar is at the bottom of the window). */
  up?: boolean;
  className?: string;
  tip?: string;
}

/** A button that opens a menu of commands. Down arrow, Enter or Space opens it; arrows move, Enter runs, Esc closes. */
export function MenuButton({ label, name, icon, showLabel, entries, onOpen, chevron = true, alignEnd = false, up = false, disabled = false, className, tip }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const text = name ?? label;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    if (!open) onOpen?.();
    setOpen(!open);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      toggle();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="tb-menu" ref={wrapRef}>
      <span className="tb-tip" data-tooltip={open ? undefined : (tip ?? text)}>
        <button
          ref={triggerRef}
          type="button"
          className={`tb-btn tb-menu-button${chevron ? ' tb-has-chevron' : ''}${showLabel ? ' tb-btn-labeled' : ''}${className ? ` ${className}` : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={text}
          disabled={disabled}
          data-tooltip={open ? undefined : (tip ?? text)}
          onClick={toggle}
          onKeyDown={onKeyDown}
        >
          {icon}
          {showLabel !== undefined && <LabelText text={label} show={showLabel} />}
          {chevron && <ChevronDownIcon size={12} />}
        </button>
      </span>
      {open && (
        <MenuPopup
          label={text}
          entries={entries}
          alignEnd={alignEnd}
          up={up}
          onClose={(returnFocus) => {
            setOpen(false);
            if (returnFocus) triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** The two halves of a split button: the main command, and a caret that opens the other choices. */
export function SplitButton({ main, caret }: { main: ReactNode; caret: ReactNode }) {
  return (
    <div className="tb-split" role="group">
      {main}
      {caret}
    </div>
  );
}

/** The things in a popup that the arrow keys stop at: its rows and color pickers (not the disabled rows). */
const FOCUSABLE = '[data-tb-item]:not(:disabled)';

/** A popup menu under a toolbar button. It takes the focus when it opens and gives it back when it closes. */
export function MenuPopup({
  label,
  entries,
  alignEnd,
  up,
  onClose,
}: {
  label: string;
  entries: () => MenuEntry[];
  alignEnd: boolean;
  up: boolean;
  /** `returnFocus` is true when the popup should hand the focus back to its button. */
  onClose: (returnFocus: boolean) => void;
}) {
  useStoresTick();
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(alignEnd);
  const rows = entries();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A menu that would run off the right edge of the window opens toward the left instead.
    if (!flip && el.getBoundingClientRect().right > window.innerWidth - 4) setFlip(true);
    if (!el.contains(document.activeElement)) el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    // Focus the first row once, when the popup opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      event.stopPropagation();
      items[(next + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(at + 1);
      case 'ArrowUp':
        return move(at < 0 ? items.length - 1 : at - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(items.length - 1);
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        return onClose(true);
      case 'Tab':
        // Tab leaves the menu: the focus goes back to its button, and the browser moves it on from there.
        return onClose(true);
      default:
        return undefined;
    }
  };

  const pick = (action: () => void) => {
    onClose(true);
    action();
  };

  return (
    <div ref={ref} className={`menu-dropdown tb-popup${flip ? ' tb-popup-end' : ''}${up ? ' tb-popup-up' : ''}`} role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {rows.map((row, i) => {
        switch (row.kind) {
          case 'sep':
            return <hr key={`sep-${i}`} className="menu-sep" />;
          case 'heading':
            return (
              <div key={`h-${i}`} className={row.sub ? 'menu-heading menu-subheading' : 'menu-heading'} role="presentation">
                {row.label}
              </div>
            );
          case 'note':
            return (
              <div key={`n-${i}`} className="menu-note" role="presentation">
                {row.label}
              </div>
            );
          case 'color':
            return (
              <label key={`c-${i}`} className="tb-menu-color">
                {row.label}
                <input type="color" data-tb-item="" aria-label={row.ariaLabel} value={row.value} onChange={(e) => row.onChange(e.target.value)} />
              </label>
            );
          case 'run':
            return (
              <button
                key={`r-${i}`}
                type="button"
                role={row.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={row.checked}
                data-tb-item=""
                className="menu-item"
                onClick={() => pick(row.run)}
              >
                <span className="menu-check">{row.checked ? '●' : ''}</span>
                <span className="menu-label">{row.label}</span>
              </button>
            );
          case 'command': {
            const enabled = commands.isEnabled(row.command);
            const reason = enabled ? undefined : commands.reasonDisabled(row.command);
            const shortcut = keymap.shortcutFor(row.command);
            const role = row.check === 'radio' ? 'menuitemradio' : row.check === 'check' ? 'menuitemcheckbox' : 'menuitem';
            const mark = row.checked ? (row.check === 'radio' ? '●' : '✓') : '';
            return (
              <button
                key={`${row.command}-${i}`}
                type="button"
                role={role}
                aria-checked={row.check ? row.checked === true : undefined}
                aria-keyshortcuts={ariaShortcut(shortcut)}
                data-tb-item=""
                className="menu-item"
                disabled={!enabled}
                title={reason}
                onClick={() => (row.stay ? void commands.run(row.command) : pick(() => void commands.run(row.command)))}
              >
                <span className="menu-check">{mark}</span>
                <span className="menu-label">{row.label}</span>
                {shortcut && <span className="menu-accel">{shortcut}</span>}
              </button>
            );
          }
        }
      })}
    </div>
  );
}
