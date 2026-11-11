import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  FLOATING_MIN_HEIGHT,
  FLOATING_MIN_WIDTH,
  useFloatingStore,
  type FloatingId,
} from '../../core/stores/floatingStore';

interface FloatingWindowProps {
  id: FloatingId;
  title: string;
  children: ReactNode;
}

/**
 * A window that floats over the workspace. Drag the header to move it, drag the corner to resize.
 * Position and size are remembered. Close with the button or Esc while the window has focus.
 */
export function FloatingWindow({ id, title, children }: FloatingWindowProps) {
  const rect = useFloatingStore((s) => s.windows[id]);
  const close = () => useFloatingStore.getState().close(id);
  const drag = useRef<{ kind: 'move' | 'resize'; x: number; y: number; rect: typeof rect } | null>(null);

  const begin = (kind: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, x: event.clientX, y: event.clientY, rect: useFloatingStore.getState().windows[id] };
  };

  const update = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current?.rect) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.kind === 'move') {
      const x = Math.min(Math.max(0, current.rect.x + dx), window.innerWidth - 80);
      const y = Math.min(Math.max(0, current.rect.y + dy), window.innerHeight - 40);
      useFloatingStore.getState().move(id, { x, y });
    } else {
      const width = Math.max(FLOATING_MIN_WIDTH, current.rect.width + dx);
      const height = Math.max(FLOATING_MIN_HEIGHT, current.rect.height + dy);
      useFloatingStore.getState().move(id, { width, height });
    }
  };

  const end = () => {
    if (drag.current) useFloatingStore.getState().commitGeometry();
    drag.current = null;
  };

  return (
    <section
      className="floating"
      aria-label={title}
      tabIndex={-1}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onPointerDown={(e) => e.currentTarget.focus()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header
        className="floating-header"
        onPointerDown={begin('move')}
        onPointerMove={update}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span className="floating-title">{title}</span>
        <button type="button" className="floating-close" aria-label={`Close ${title}`} title="Close (Esc)" onPointerDown={(e) => e.stopPropagation()} onClick={close}>
          ×
        </button>
      </header>
      <div className="floating-body">{children}</div>
      <div
        className="floating-grip"
        role="separator"
        aria-label={`Resize ${title}`}
        onPointerDown={begin('resize')}
        onPointerMove={update}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </section>
  );
}
