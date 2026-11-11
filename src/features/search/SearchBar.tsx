import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { commands } from '../../core/commands/registry';
import { useSearchStore } from './searchStore';

/** Under this bar width the status shortens to "3 of 17" and the box may shrink to 96 px (1.5.5 A4). */
export const SEARCH_NARROW_PX = 640;

/** Whether a control can take focus back: still on screen and not disabled. */
function canFocus(el: HTMLElement | null): el is HTMLElement {
  return el !== null && el.isConnected && !(el as HTMLButtonElement).disabled && el !== document.body;
}

/** The Ctrl+F bar under the top bar: query, "n of N", previous and next, and the two match toggles. */
export function SearchBar() {
  const open = useSearchStore((s) => s.open);
  const query = useSearchStore((s) => s.query);
  const matchCase = useSearchStore((s) => s.matchCase);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const total = useSearchStore((s) => s.hits.length);
  const current = useSearchStore((s) => s.current);
  const running = useSearchStore((s) => s.running);
  const scanned = useSearchStore((s) => s.scanned);
  const pageTotal = useSearchStore((s) => s.total);
  const input = useRef<HTMLInputElement>(null);

  const bar = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  // The control that had focus when the bar opened; it gets focus back when the bar closes (1.5.5 A3, the Focus return rule).
  const returnTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      // Focus already inside the bar (Ctrl+F again): the remembered control is kept.
      if (active instanceof HTMLElement && active !== document.body && !bar.current?.contains(active)) returnTo.current = active;
      input.current?.focus();
      input.current?.select();
    } else if (!open && wasOpen.current) {
      const back = returnTo.current;
      returnTo.current = null;
      if (canFocus(back)) back.focus();
      else document.querySelector<HTMLElement>('.main')?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  useLayoutEffect(() => {
    const el = bar.current;
    if (!open || !el) return;
    const apply = (width: number) => {
      if (width > 0) setNarrow(width < SEARCH_NARROW_PX);
    };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) apply(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // Esc closes one thing: the find bar, and the key press stops here (1.5.5 section 0).
      event.preventDefault();
      event.stopPropagation();
      void commands.run('search.close');
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      // Ctrl+F again with focus in the box: the text is selected.
      event.preventDefault();
      event.currentTarget.select();
    } else if (event.key === 'F3' || event.key === 'Enter') {
      event.preventDefault();
      void commands.run(event.shiftKey ? 'search.prev' : 'search.next');
    }
  };

  const status =
    query === ''
      ? ''
      : total === 0
        ? running
          ? `Searching… ${scanned} of ${pageTotal}`
          : 'No matches'
        : `${current + 1} of ${total}${running && !narrow ? ` · ${scanned} of ${pageTotal} ${pageTotal === 1 ? 'page' : 'pages'}` : ''}`;

  return (
    <div className={narrow ? 'search-bar search-narrow' : 'search-bar'} role="search" ref={bar}>
      <input
        ref={input}
        className="search-input"
        type="text"
        aria-label="Find in document"
        placeholder="Find in document"
        value={query}
        onChange={(e) => useSearchStore.getState().setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="search-status" aria-live="polite">
        {status}
      </span>
      <button type="button" className="tb-button" aria-label="Previous match" aria-keyshortcuts="Shift+F3" title="Previous match (Shift+F3)" onClick={() => void commands.run('search.prev')}>
        ↑
      </button>
      <button type="button" className="tb-button" aria-label="Next match" aria-keyshortcuts="F3" title="Next match (F3)" onClick={() => void commands.run('search.next')}>
        ↓
      </button>
      <button
        type="button"
        className="tb-button"
        aria-label="Match case"
        aria-pressed={matchCase}
        title="Match case"
        onClick={() => void commands.run('search.toggleCase')}
      >
        Aa
      </button>
      <button
        type="button"
        className="tb-button"
        aria-pressed={wholeWord}
        title="Whole word"
        onClick={() => void commands.run('search.toggleWholeWord')}
      >
        Whole word
      </button>
      <button type="button" className="tb-button" aria-label="Close find bar" aria-keyshortcuts="Escape" title="Close (Esc)" onClick={() => void commands.run('search.close')}>
        ×
      </button>
    </div>
  );
}
