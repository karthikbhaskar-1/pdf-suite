import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useOverlayStore, type MenuItem } from '../../core/stores/overlayStore';

/** The open context menu, if any. Closes on Escape, on a press outside it, and when an item runs. */
export function ContextMenu() {
  const menu = useOverlayStore((s) => s.menu);
  const close = useOverlayStore((s) => s.closeMenu);
  const ref = useRef<HTMLDivElement>(null);

  // A menu opened from the keyboard takes the focus (its first enabled item) and gives it back where it was when it closes.
  const keyboard = menu?.keyboard === true;
  useLayoutEffect(() => {
    if (!menu || !keyboard) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button.context-item:not(:disabled)')?.focus();
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || ref.current?.contains(now) === true;
      if (lost && previous && previous.isConnected) previous.focus();
    };
    // Per opened menu, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, keyboard]);

  // Arrow keys, Home and End move between the items of a keyboard-opened menu.
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button.context-item:not(:disabled)') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu, close]);

  if (!menu) return null;
  const left = Math.min(menu.x, window.innerWidth - 220);
  const top = Math.min(menu.y, window.innerHeight - 40 * Math.min(menu.items.length, 12));
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left, top }} onKeyDown={onMenuKeyDown} onContextMenu={(e) => e.preventDefault()}>
      <MenuList items={menu.items} onDone={close} />
    </div>
  );
}

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  return (
    <>
      {items.map((item) =>
        item.separator ? (
          <hr key={item.id} className="context-sep" />
        ) : item.items ? (
          <Submenu key={item.id} item={item} onDone={onDone} />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="context-item"
            disabled={item.disabled}
            onClick={() => {
              onDone();
              item.onSelect?.();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="context-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </>
  );
}

function Submenu({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="context-group">
      <button type="button" role="menuitem" aria-expanded={open} className="context-item" onClick={() => setOpen((o) => !o)}>
        <span>{item.label}</span>
        <span className="context-shortcut">›</span>
      </button>
      {open && (
        <div className="context-sub">
          <MenuList items={item.items ?? []} onDone={onDone} />
        </div>
      )}
    </div>
  );
}
