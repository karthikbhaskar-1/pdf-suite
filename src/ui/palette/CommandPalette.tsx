import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { commands } from '../../core/commands/registry';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { keymap } from '../../app/services';
import { filterEntries, type PaletteEntry } from '../../features/palette/fuzzy';
import { trackRestingPointer, type RestingPointer } from '../menubar/restingPointer';

/** Page Down and Page Up move the highlight by this many rows. */
const PAGE_ROWS = 8;

/** Ctrl+K command palette: every registered command, with its shortcut. Fuzzy filter, Enter runs. */
export function CommandPalette() {
  const open = useOverlayStore((s) => s.paletteOpen);
  // The dialog is mounted only while the palette is open, so each open starts from a fresh query and row. Nothing from the
  // previous open can be drawn, and no reset has to run after the first frame.
  return open ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const setOpen = useOverlayStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const rowId = (index: number) => `${listId}-row-${index}`;
  // Hover moves the highlight only on real pointer movement: a row that scrolls under a resting pointer does not take it.
  const pointer = useRef<RestingPointer | null>(null);
  useEffect(() => {
    pointer.current = trackRestingPointer({ startDisarmed: true });
    return () => pointer.current?.stop();
  }, []);

  // Focus the input as soon as the dialog is in the page (before the next paint, so a key typed right after Ctrl+K lands
  // in it), and give focus back to where it was when the dialog goes away. If a command moved focus itself, that stays.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || now === input.current;
      if (lost && previous && previous !== document.body && previous.isConnected) previous.focus();
    };
  }, []);

  // The commands and their labels are listed on each open, so commands registered later still show up. Whether each is
  // enabled is not kept here: it is read again on every render (below), because it depends on the document, the
  // selection and the page, which can change while the palette is open or just before it opens.
  const base = useMemo<PaletteEntry[]>(
    () =>
      commands
        .list()
        .map((def) => ({ id: def.id, label: def.label, shortcut: keymap.shortcutFor(def.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );

  // Re-render when a store that commands read from changes, so the enabled state follows it.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stores = [useDocumentsStore, useEditStore, useSelectionStore, useWorkspaceStore];
    const offs = stores.map((store) => store.subscribe(() => refresh()));
    return () => offs.forEach((off) => off());
  }, []);

  const matches = filterEntries(base, query).map((entry) => ({ ...entry, enabled: commands.isEnabled(entry.id) }));

  const current = Math.min(active, Math.max(0, matches.length - 1));

  // The highlighted row is always in view.
  useEffect(() => {
    document.getElementById(rowId(current))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, query]);

  const run = (id: string) => {
    // Checked again now: the state shown may be older than the key press or click.
    if (!commands.isEnabled(id)) {
      refresh();
      return;
    }
    setOpen(false);
    void commands.run(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(current + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      setActive(Math.min(current + PAGE_ROWS, matches.length - 1));
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      setActive(Math.max(current - PAGE_ROWS, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = matches[current];
      if (chosen) run(chosen.id);
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={matches.length > 0 ? rowId(current) : undefined}
          aria-label="Type a command"
          placeholder="Type a command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul id={listId} className="palette-list" role="listbox" aria-label="Commands">
          {matches.map((entry, i) => {
            const reason = entry.enabled ? undefined : commands.reasonDisabled(entry.id);
            return (
            <li
              key={entry.id}
              id={rowId(i)}
              role="option"
              aria-label={entry.enabled ? undefined : `${entry.label}. Not available${reason ? `: ${reason}` : ''}`}
              aria-selected={i === current}
              aria-disabled={!entry.enabled}
              title={reason}
              className={`palette-item${i === current ? ' palette-active' : ''}${entry.enabled ? '' : ' palette-disabled'}`}
              onPointerEnter={() => pointer.current?.allowed() && setActive(i)}
              onPointerMove={() => pointer.current?.allowed() && i !== current && setActive(i)}
              onClick={() => run(entry.id)}
            >
              <span>{entry.label}</span>
              {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
            </li>
            );
          })}
        </ul>
        <div className="palette-empty" role="status">
          {matches.length === 0 ? 'No commands match' : ''}
        </div>
      </div>
    </div>
  );
}
