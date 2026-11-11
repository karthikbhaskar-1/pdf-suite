import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type RefObject } from 'react';
import { useCombineStore } from '../../core/stores/combineStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useUiStore } from '../../core/stores/uiStore';
import { thumbnailCache } from '../../engine/thumbnailCache';
import { getDesktopBridge } from '../../platform/desktop/bridge';
import {
  COMBINE_EMPTY_MESSAGE,
  COMBINE_READING_TEXT,
  COMBINE_TOTAL_TOO_LARGE_MESSAGE,
  combineSummary,
  formatSize,
} from '../../features/jobs/jobMessages';
import { blockOf, hasRange, noticesFor, pagesOfRow, selectedSet, totals, type CombineRow, type PictureSize, type TextSize } from '../../features/jobs/combinePlan';
import {
  addFilesFromPicker,
  addOpenFiles,
  addPaths,
  closeCombine,
  dragSelectedTo,
  moveSelected,
  openDocumentPaths,
  removeSelected,
  requestPreviewPages,
  saveOpenFile,
  setPageOption,
  setRangeText,
  setSelection,
  sortRowsByName,
  startCombine,
  thumbKey,
  togglePreviewPage,
  unsavedOpenFiles,
} from '../../features/jobs/combineFlow';
import { BitmapCanvas } from '../thumbnails/BitmapCanvas';
import { cycleFocus, focusableWithin, makeAppInert } from '../common/focusTrap';

/**
 * The Combine window (UI spec section 1): a centred window of 880 x 600 (at least 720 x 480) with the file list, a preview of
 * the selected file's pages, the notices before the run and the options. It is the third modal of the app after the password and
 * close prompts; focus stays inside it and Esc closes it. Everything is reachable with the keyboard.
 */
export function CombineWindow() {
  const open = useCombineStore((s) => s.open);
  return open ? <Window /> : null;
}

const DRAG_TYPE = 'application/x-pdfsuite-combine-row';

function Window() {
  const rows = useCombineStore((s) => s.rows);
  const selected = useCombineStore((s) => s.selected);
  const focusId = useCombineStore((s) => s.focusId);
  const messages = useCombineStore((s) => s.messages);
  const s = useCombineStore();
  const askedPassword = useUiStore((u) => u.sourcePassword !== null || u.closePrompt || u.jobQuitPrompt);
  const docsCount = useDocumentsStore((d) => Object.keys(d.docs).length);
  const dirty = useEditStore((e) => e.byDoc);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const wasAsked = useRef(false);
  const lastFocus = useRef<HTMLElement | null>(null);

  const unsaved = useMemo(() => unsavedOpenFiles(), [rows, dirty, docsCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const openPaths = useMemo(() => openDocumentPaths(), [docsCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const notices = useMemo(() => noticesFor(rows), [rows]);
  const block = blockOf(rows);
  const sum = totals(rows);
  const focusRow = rows.find((r) => r.id === focusId) ?? null;

  // The rest of the app is inert while the window is open (the password and close prompts above it stay usable).
  useEffect(() => {
    return makeAppInert((el) => el.classList.contains('toasts'));
  }, []);

  // Focus on open: Add files… when the list is empty, else the list.
  useEffect(() => {
    (useCombineStore.getState().rows.length === 0 ? addRef.current : listRef.current)?.focus();
  }, []);

  // A prompt over the window (a password) takes focus; when it goes, focus comes back to where it was in the window.
  useEffect(() => {
    if (askedPassword) {
      wasAsked.current = true;
      return;
    }
    if (wasAsked.current) {
      wasAsked.current = false;
      const back = lastFocus.current;
      if (back && back.isConnected) back.focus();
      else listRef.current?.focus();
    }
  }, [askedPassword]);
  useEffect(() => {
    const track = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && rootRef.current?.contains(event.target)) lastFocus.current = event.target;
    };
    document.addEventListener('focusin', track);
    return () => document.removeEventListener('focusin', track);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (askedPassword) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeCombine();
      return;
    }
    if (event.key !== 'Tab' || !rootRef.current) return;
    const next = cycleFocus(focusableWithin(rootRef.current), document.activeElement as HTMLElement | null, event.shiftKey);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const hasFileDrag = (event: DragEvent) => !event.dataTransfer.types.includes(DRAG_TYPE);
  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (hasFileDrag(event)) event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = async (event: DragEvent) => {
    // Files dropped here are added to the list; they do not reach the app behind the window.
    event.preventDefault();
    event.stopPropagation();
    if (!hasFileDrag(event)) return;
    const paths = (await getDesktopBridge()?.files.takeDroppedPaths()) ?? [];
    if (paths.length > 0) void addPaths(paths);
  };

  const summary =
    block === 'too-large' ? COMBINE_TOTAL_TOO_LARGE_MESSAGE : combineSummary(sum.files, sum.pages, sum.bytes);

  return (
    <div className="modal-backdrop combine-backdrop" {...(askedPassword ? ({ inert: '' } as object) : {})} onDragOver={onDragOver} onDrop={onDrop}>
      <div ref={rootRef} className="combine-window" role="dialog" aria-modal="true" aria-labelledby="combine-title" data-combine="true" onKeyDown={onKeyDown}>
        <header className="combine-head">
          <h2 id="combine-title">Combine files</h2>
          <button type="button" className="combine-close" aria-label="Close" onClick={() => closeCombine()}>
            ×
          </button>
        </header>

        <div className="combine-tools" role="toolbar" aria-label="Files">
          <button ref={addRef} type="button" onClick={() => void addFilesFromPicker()}>
            Add files…
          </button>
          <button type="button" disabled={openPaths.length === 0} onClick={() => void addOpenFiles()}>
            Add open files
          </button>
          <button type="button" disabled={selected.length === 0} onClick={() => removeSelected()}>
            Remove
          </button>
          <button type="button" disabled={selected.length === 0} onClick={() => moveSelected('up')}>
            Move up
          </button>
          <button type="button" disabled={selected.length === 0} onClick={() => moveSelected('down')}>
            Move down
          </button>
          <button type="button" disabled={rows.length < 2} onClick={() => sortRowsByName()}>
            Sort by name
          </button>
        </div>

        <div className="combine-main">
          <section className="combine-files" aria-label="Files">
            <FileList listRef={listRef} rows={rows} selected={selected} focusId={focusId} notices={notices.length > 0} />
          </section>
          <section className="combine-preview" aria-label={focusRow ? `Preview: ${focusRow.name}` : 'Preview'}>
            <Preview row={focusRow} />
          </section>
        </div>

        <div className="combine-sr" role="status" aria-live="polite" data-combine-announce="true">
          {s.announcement}
        </div>

        <div className="combine-notes">
          {messages.map((m) => (
            <p key={m.id} className="combine-message" role="status" data-combine-message="true">
              <span>{m.text}</span>
              <button type="button" className="combine-dismiss" aria-label="Dismiss" onClick={() => useCombineStore.getState().dismissMessage(m.id)}>
                ×
              </button>
            </p>
          ))}
          {unsaved.map((u) => (
            <p key={u.docId} className="combine-message" role="status" data-combine-unsaved="true">
              <span>{`${u.name} has unsaved changes. The saved version will be used.`}</span>
              <button type="button" onClick={() => void saveOpenFile(u.docId)}>
                Save now
              </button>
            </p>
          ))}
          {notices.length > 0 && (
            <div id="combine-notices" className="combine-notices" role="status" data-combine-notices="true">
              <strong>Before you combine:</strong>
              {notices.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          )}
        </div>

        <div className="combine-options">
          <label>
            <input type="checkbox" checked={s.fileBookmarks} onChange={(e) => s.set({ fileBookmarks: e.target.checked })} /> Add a bookmark for each file
          </label>
          <label>
            Picture pages{' '}
            <select value={s.pictureSize} onChange={(e) => setPageOption({ pictureSize: e.target.value as PictureSize })}>
              <option value="image">Same size as the picture</option>
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={s.openWhenDone} onChange={(e) => s.set({ openWhenDone: e.target.checked })} /> Open the new file when it is ready
          </label>
          <label>
            Text pages{' '}
            <select value={s.textSize} onChange={(e) => setPageOption({ textSize: e.target.value as TextSize })}>
              <option value="Letter">Letter</option>
              <option value="A4">A4</option>
            </select>
          </label>
        </div>

        <footer className="combine-foot">
          <span className={block === 'too-large' ? 'combine-summary combine-error' : 'combine-summary'} aria-live="polite" data-combine-summary="true">
            {summary}
          </span>
          {s.targetMessage && (
            <span className="combine-error" role="alert" data-combine-target="true">
              {s.targetMessage}
            </span>
          )}
          <span className="combine-foot-actions">
            <button type="button" onClick={() => closeCombine()}>
              Cancel
            </button>
            <button type="button" className="primary-button" disabled={block !== null || s.starting} onClick={() => void startCombine()}>
              Combine…
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}

// ---- The list ---------------------------------------------------------------------------------------------------------------------

function FileList({
  listRef,
  rows,
  selected,
  focusId,
  notices,
}: {
  listRef: RefObject<HTMLDivElement>;
  rows: CombineRow[];
  selected: string[];
  focusId: string | null;
  notices: boolean;
}) {
  const [dropAt, setDropAt] = useState<number | null>(null);
  const anchor = useRef<string | null>(null);
  const selectedSetIds = new Set(selected);

  const indexOf = (id: string | null) => rows.findIndex((r) => r.id === id);

  const select = (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, id: string) => {
    if (event.shiftKey && anchor.current) {
      const a = indexOf(anchor.current);
      const b = indexOf(id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        setSelection(rows.slice(from, to + 1).map((r) => r.id), id);
        return;
      }
    }
    anchor.current = id;
    if (event.ctrlKey || event.metaKey) {
      setSelection(selectedSetIds.has(id) ? selected.filter((x) => x !== id) : [...selected, id], id);
    } else {
      setSelection([id], id);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in a row's own Pages field are the field's.
    if (event.target instanceof HTMLInputElement) return;
    const at = indexOf(focusId);
    if (event.altKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveSelected(event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : event.key === 'Home' ? 'first' : 'last');
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      removeSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(rows.map((r) => r.id), focusId ?? rows[0]?.id ?? null);
      return;
    }
    let to = at;
    if (event.key === 'ArrowDown') to = Math.min(rows.length - 1, at + 1);
    else if (event.key === 'ArrowUp') to = Math.max(0, at - 1);
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = rows.length - 1;
    else return;
    event.preventDefault();
    const target = rows[to];
    if (target) select(event, target.id);
  };

  const rowsRef = useRef<HTMLDivElement>(null);
  const insertionIndex = (clientY: number): number => {
    const nodes = rowsRef.current ? Array.from(rowsRef.current.querySelectorAll<HTMLElement>('[data-row-id]')) : [];
    for (let i = 0; i < nodes.length; i++) {
      const box = nodes[i]!.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return nodes.length;
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropAt(insertionIndex(event.clientY));
    // The list scrolls when the drag is near its top or bottom edge.
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientY < box.top + 24) event.currentTarget.scrollTop -= 12;
    else if (event.clientY > box.bottom - 24) event.currentTarget.scrollTop += 12;
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData(DRAG_TYPE);
    const place = insertionIndex(event.clientY);
    setDropAt(null);
    if (!id) return;
    dragSelectedTo(selectedSetIds.has(id) ? selected : [id], place);
  };

  if (rows.length === 0) {
    return (
      <div ref={listRef} className="combine-list combine-empty" role="listbox" aria-label="Files to combine" tabIndex={0} data-combine-list="true">
        <p className="combine-empty-text" data-combine-empty="true">
          {COMBINE_EMPTY_MESSAGE}
        </p>
      </div>
    );
  }
  return (
    <div
      ref={listRef}
      className="combine-list"
      role="listbox"
      aria-label="Files to combine"
      aria-multiselectable="true"
      aria-activedescendant={focusId ? `combine-${focusId}` : undefined}
      tabIndex={0}
      data-combine-list="true"
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={() => setDropAt(null)}
      onDrop={onDrop}
    >
      <div ref={rowsRef}>
        {rows.map((row, i) => (
          <div key={row.id}>
            {dropAt === i && <div className="combine-drop-line" aria-hidden="true" />}
            <Row row={row} index={i} total={rows.length} selected={selectedSetIds.has(row.id)} focused={row.id === focusId} notices={notices} onSelect={select} />
          </div>
        ))}
        {dropAt === rows.length && <div className="combine-drop-line" aria-hidden="true" />}
      </div>
    </div>
  );
}

function Row({
  row,
  index,
  total,
  selected,
  focused,
  notices,
  onSelect,
}: {
  row: CombineRow;
  index: number;
  total: number;
  selected: boolean;
  focused: boolean;
  notices: boolean;
  onSelect: (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, id: string) => void;
}) {
  useCombineStore((s) => s.thumbVersion);
  const result = pagesOfRow(row);
  const thumb = row.status === 'ready' ? thumbnailCache.get(thumbKey(row, 0)) : undefined;
  const warn = row.status === 'ready' && (row.gone === true || (row.facts?.fields ?? 0) > 0 || row.facts?.encrypted === true || row.facts?.layers === true || (row.facts?.attachments ?? 0) > 0 || (row.facts?.unprintable ?? 0) > 0);
  const detail =
    row.status !== 'ready' ? COMBINE_READING_TEXT : `${row.pages} ${row.pages === 1 ? 'page' : 'pages'} · ${formatSize(row.size)}`;
  return (
    <div
      id={`combine-${row.id}`}
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      className={`combine-row${selected ? ' is-selected' : ''}${focused ? ' is-focused' : ''}`}
      data-row-id={row.id}
      data-row-name={row.name}
      onMouseDown={(event) => {
        // A click in the Pages field belongs to the field, but still chooses the row.
        if (event.button === 0 && !(event.target instanceof HTMLElement && event.target.closest('.combine-handle'))) onSelect(event, row.id);
      }}
    >
      <span
        className="combine-handle"
        draggable
        aria-hidden="true"
        title="Drag to move"
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, row.id);
          event.dataTransfer.effectAllowed = 'move';
          if (!selected) onSelect({ shiftKey: false, ctrlKey: false, metaKey: false }, row.id);
        }}
      >
        ⠿
      </span>
      <span className="combine-row-thumb">{thumb && thumb.width > 0 ? <BitmapCanvas bitmap={thumb} label="" className="combine-thumb-canvas" /> : <span className="combine-thumb-grey" />}</span>
      <span className="combine-row-text">
        <span className="combine-row-name">{row.name}</span>
        <span className="combine-row-detail">{detail}</span>
        {row.status === 'ready' && hasRange(row) && (
          <span className="combine-row-range">
            <label>
              Pages{' '}
              <input
                type="text"
                value={row.rangeText}
                placeholder="All pages"
                tabIndex={focused ? 0 : -1}
                aria-label={`Pages of ${row.name}`}
                aria-invalid={!result.ok}
                aria-describedby={!result.ok ? `combine-range-${row.id}` : undefined}
                onChange={(e) => setRangeText(row.id, e.target.value)}
              />
            </label>
            {!result.ok && (
              <span id={`combine-range-${row.id}`} className="combine-error" role="alert" data-combine-range-error="true">
                {result.message}
              </span>
            )}
          </span>
        )}
      </span>
      {warn && (
        <span className="combine-warn" title="This file has a notice below" aria-label="Notice" {...(notices ? { 'aria-describedby': 'combine-notices' } : {})}>
          ⚠
        </span>
      )}
    </div>
  );
}

// ---- The preview ------------------------------------------------------------------------------------------------------------------

function Preview({ row }: { row: CombineRow | null }) {
  useCombineStore((s) => s.thumbVersion);
  const boxRef = useRef<HTMLDivElement>(null);
  const wanted = useRef(new Set<number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = row?.id ?? null;
  const ready = row?.status === 'ready';
  const pages = ready ? row.pages : 0;
  const optionKey = row ? `${row.kind}|${row.pages}` : '';
  // One page of the preview is in the tab order; the arrow keys move between pages.
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [id]);

  // Pages scrolled into view are asked for, a few at a time.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || id === null || !ready) return undefined;
    wanted.current = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) wanted.current.add(Number((entry.target as HTMLElement).dataset.page));
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const list = [...wanted.current].sort((a, b) => a - b);
          wanted.current = new Set();
          if (list.length > 0) void requestPreviewPages(id, list);
        }, 60);
      },
      { root: box, rootMargin: '120px' },
    );
    for (const cell of Array.from(box.querySelectorAll<HTMLElement>('[data-page]'))) observer.observe(cell);
    return () => {
      observer.disconnect();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, ready, optionKey]);

  if (!row) return <p className="combine-preview-empty">Select a file to see its pages.</p>;
  if (!ready) return <p className="combine-preview-empty" role="status">{COMBINE_READING_TEXT}</p>;
  const selected = selectedSet(row);
  const toggles = hasRange(row);
  return (
    <>
      <h3 className="combine-preview-title">{`Preview: ${row.name}`}</h3>
      <div
        ref={boxRef}
        className="combine-pages"
        data-combine-preview={row.id}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
          if (step === 0) return;
          event.preventDefault();
          const next = Math.max(0, Math.min(pages - 1, active + step));
          setActive(next);
          boxRef.current?.querySelector<HTMLElement>(`[data-page="${next}"]`)?.focus();
        }}
      >
        {Array.from({ length: pages }, (_v, i) => {
          const page = i + 1;
          const left = toggles && !selected.has(page);
          const bitmap = thumbnailCache.get(thumbKey(row, i));
          const picture = bitmap && bitmap.width > 0 ? <BitmapCanvas bitmap={bitmap} label="" className="combine-page-canvas" /> : <span className="combine-page-grey" />;
          const label = `Page ${page}${left ? ', left out' : ''}`;
          return toggles ? (
            <button
              key={page}
              type="button"
              role="checkbox"
              aria-checked={!left}
              aria-label={label}
              className={`combine-page${left ? ' is-left-out' : ''}`}
              data-page={i}
              data-left-out={left ? 'true' : 'false'}
              tabIndex={i === active ? 0 : -1}
              onFocus={() => setActive(i)}
              onClick={() => togglePreviewPage(row.id, page)}
            >
              {picture}
              <span className="combine-page-number">{page}</span>
            </button>
          ) : (
            <div key={page} className="combine-page" role="img" aria-label={`Page ${page}`} data-page={i}>
              {picture}
              <span className="combine-page-number">{page}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
