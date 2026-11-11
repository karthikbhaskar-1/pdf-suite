import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { NO_DOCUMENT_ZOOM_REASON } from '../../core/commands/reasons';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { cancelOperation } from '../../features/documents/editOps';
import { useJobStore } from '../../core/stores/jobStore';
import { cancelJob } from '../../features/jobs/splitFlow';
import { statusText } from '../../features/jobs/jobMessages';
import { defaultUnitFor, describeSize } from '../../features/organizer/units';
import { pageIdFromUid } from '../../features/organizer/pageMath';
import { clampZoom, ZOOM_MAX, ZOOM_MIN } from '../../features/viewer/layout';
import { ChevronDownIcon, FitPageIcon, FitWidthIcon, ZoomInIcon, ZoomOutIcon } from '../icons';
import type { MenuEntry } from '../../core/layout/topBarRegistry';
import { MenuButton, ToolbarButton } from '../topbar/toolbarControls';
import { useSelectOnFocus } from '../topbar/selectOnFocus';
import { useActivePage } from '../topbar/usePageState';
import { requestViewer } from '../viewer/viewerBus';
import { sameLayout, statusLayout, type StatusLayout } from './statusLayout';

/**
 * Status bar (24 px). Left: "Page [n] of Y" with an editable page number (Enter goes to that page), then the document
 * info (page size, view rotation). Right: Fit page, Fit width, Zoom out, the zoom box (editable, with presets), Zoom in
 * and a slider. While a long page edit runs the bar shows that edit's progress, with Cancel.
 *
 * The viewer writes its scroll position to the pane's view on every frame. So no part of this bar reads the pane as a
 * whole: each part reads only the values it shows (the page, the zoom), and draws again only when one of them changes. A
 * scroll within a page therefore draws nothing here, and a scroll across a page edge changes only the page number.
 *
 * At narrow widths the bar leaves out, in this order: the slider, the document info, then Fit page and Fit width (which
 * then appear in the zoom presets menu). The zoom box and the page box always stay (see statusLayout.ts).
 */

/** The presets of the zoom menu, in percent. */
export const ZOOM_MENU_PRESETS = [50, 75, 100, 125, 150, 200, 400] as const;

/** Slider positions run 0 to 1000 and map to zoom on a log scale, so each part of the range is easy to hit. */
const SLIDER_STEPS = 1000;
const sliderToZoom = (position: number) => ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (position / SLIDER_STEPS);
const zoomToSlider = (zoom: number) => Math.round((Math.log(clampZoom(zoom) / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * SLIDER_STEPS);

/** One notch of Ctrl+wheel (I1): the slider's arrow keys use the same factor. */
const SLIDER_KEY_FACTOR = 1.1;

/**
 * The zoom (in percent) an arrow key on the slider gives (1.5.5 A1): the current percent times 1.1 (or divided by it),
 * rounded to a whole percent, and at least one percent away. Stays within 10 to 800%. Returns null for any other key.
 */
export function sliderKeyPercent(key: string, percent: number): number | null {
  const now = Math.round(percent);
  const min = Math.round(ZOOM_MIN * 100);
  const max = Math.round(ZOOM_MAX * 100);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(max, Math.max(now + 1, Math.round(now * SLIDER_KEY_FACTOR)));
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(min, Math.min(now - 1, Math.round(now / SLIDER_KEY_FACTOR)));
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return null;
  }
}

/** Reads a typed zoom such as "125", "125%" or " 80 %". Returns the zoom (1 = 100%), or null when it is not a number. */
export function parseZoomInput(text: string): number | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(text);
  if (!match) return null;
  const percent = Number.parseFloat(match[1]!.replace(',', '.'));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return clampZoom(percent / 100);
}

/** "Page [n] of Y": the page number is a box. */
function PageStatus({ word }: { word: boolean }) {
  const { paneId, index, total } = useActivePage();
  const current = index >= 0 ? String(index + 1) : '1';
  const [draft, setDraft] = useState<string | null>(null);
  const select = useSelectOnFocus();

  const go = (value: string) => {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number) || total === 0) return;
    requestViewer(paneId, { kind: 'goto', index: Math.min(Math.max(number, 1), total) - 1 });
  };

  return (
    <span className="status-page">
      {word && <label htmlFor="status-page-box">Page</label>}
      <input
        id="status-page-box"
        className="status-input status-page-box"
        type="text"
        inputMode="numeric"
        aria-label="Go to page"
        value={draft ?? current}
        onFocus={select.onFocus}
        onMouseUp={select.onMouseUp}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          select.onBlur();
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            go(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.currentTarget.blur();
          }
        }}
      />
      <span className="status-of">of {total}</span>
    </span>
  );
}

/**
 * The chip that says a selection is in charge (1.5.5 A5): shown when pages are selected and the selection is not just the
 * current page. A button: it clears the page selection and puts focus in the page box. Not a live region.
 */
export function selectionChipCount(selectedIds: readonly string[], uids: readonly string[], docId: string, currentPageId: string | null): number {
  const ids = new Set(selectedIds);
  const picked = uids.filter((uid) => ids.has(pageIdFromUid(docId, uid)));
  if (picked.length === 0) return 0;
  if (picked.length === 1 && currentPageId !== null && pageIdFromUid(docId, picked[0]!) === currentPageId) return 0;
  return picked.length;
}

const NO_UIDS: readonly string[] = [];

function SelectionChip({ short }: { short: boolean }) {
  const { docId, index } = useActivePage();
  const pageId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.view.pageId ?? null);
  const selected = useSelectionStore((s) => s.pageIds);
  const uids = useEditStore((s) => (docId ? s.byDoc[docId]?.uids : undefined)) ?? NO_UIDS;
  const count = docId ? selectionChipCount(selected, uids, docId, pageId) : 0;
  if (count === 0) return null;
  const noun = count === 1 ? 'page' : 'pages';
  const label = short ? `${count} selected` : `${count} ${noun} selected`;
  return (
    <button
      type="button"
      className="status-chip"
      title={`Page commands act on the selected pages, not on page ${index + 1}. Click to clear the selection.`}
      aria-label={`${count} ${noun} selected. Page commands act on ${count === 1 ? 'it' : 'them'}. Clear selection.`}
      onClick={() => {
        useSelectionStore.getState().clear();
        document.getElementById('status-page-box')?.focus();
      }}
    >
      {label}
      <span aria-hidden="true"> ×</span>
    </button>
  );
}

/** The document info: the size of the page on screen, and the view rotation when it is turned. It gives way first. */
function DocumentInfo() {
  const { docId, index } = useActivePage();
  const size = useDocumentsStore((s) => {
    const doc = docId ? s.docs[docId] : undefined;
    const ref = doc?.pages[index];
    const measured = ref ? doc?.sizes[ref.srcIndex] : undefined;
    return measured ? `${measured.width}\u0001${measured.height}` : '';
  });
  const rotation = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.view.rotation ?? 0);
  const parts: string[] = [];
  if (size) {
    const [width, height] = size.split('\u0001').map(Number);
    parts.push(describeSize(width!, height!, defaultUnitFor(typeof navigator === 'undefined' ? undefined : navigator.language)));
  }
  if (rotation) parts.push(`Rotated ${rotation}°`);
  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  return (
    <span className="status-info" title={text}>
      {text}
    </span>
  );
}

/** The zoom box: a percentage that can be typed, with a menu of presets (and Fit page and Fit width at narrow widths). */
function ZoomBox({ paneId, zoom, fitInMenu }: { paneId: string | null; zoom: number; fitInMenu: boolean }) {
  const percent = Math.round(zoom * 100);
  const [draft, setDraft] = useState<string | null>(null);
  const select = useSelectOnFocus();

  const apply = (text: string) => {
    const next = parseZoomInput(text);
    if (next !== null) requestViewer(paneId, { kind: 'setZoom', zoom: next });
  };
  const presetRows = (): MenuEntry[] => [
    ...(fitInMenu
      ? ([{ kind: 'command', command: 'view.fitPage', label: 'Fit page' }, { kind: 'command', command: 'view.fitWidth', label: 'Fit width' }, { kind: 'sep' }] as MenuEntry[])
      : []),
    ...ZOOM_MENU_PRESETS.map((p): MenuEntry => ({ kind: 'run', label: `${p}%`, checked: p === percent, run: () => requestViewer(paneId, { kind: 'setZoom', zoom: p / 100 }) })),
  ];

  return (
    <span className="status-zoom-box">
      <span className="tb-tip" data-tooltip={paneId === null ? NO_DOCUMENT_ZOOM_REASON : undefined}>
      <input
        className="status-input status-zoom-input"
        type="text"
        inputMode="numeric"
        aria-label="Zoom level"
        disabled={paneId === null}
        value={draft ?? `${percent}%`}
        // The text stays as it is on focus (the value must not change, or the selection would be lost): it is all selected, so
        // typing replaces it.
        onFocus={select.onFocus}
        onMouseUp={select.onMouseUp}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          select.onBlur();
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            apply(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.currentTarget.blur();
          }
        }}
      />
      </span>
      <MenuButton
        label="Zoom presets"
        name="Zoom presets"
        icon={<ChevronDownIcon size={12} />}
        chevron={false}
        entries={presetRows}
        disabled={paneId === null}
        alignEnd
        up
        className="status-presets"
        tip={paneId === null ? NO_DOCUMENT_ZOOM_REASON : 'Zoom presets'}
      />
    </span>
  );
}

/** Fit page, Fit width, Zoom out, the zoom box, Zoom in and the slider. */
function ZoomControls({ layout }: { layout: StatusLayout }) {
  const paneId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.id ?? null);
  const zoom = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.view.zoom ?? 1);
  const fit = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.view.fit);
  return (
    <div className="status-zoom" role="group" aria-label="Zoom">
      {layout.fit && (
        <span className="status-fit">
          <ToolbarButton commandId="view.fitPage" label="Fit page" icon={<FitPageIcon size={16} />} pressed={fit === 'page'} className="status-btn" />
          <ToolbarButton commandId="view.fitWidth" label="Fit width" icon={<FitWidthIcon size={16} />} pressed={fit === 'width'} className="status-btn" />
        </span>
      )}
      <ToolbarButton commandId="view.zoomOut" label="Zoom out" icon={<ZoomOutIcon size={16} />} className="status-btn" />
      <ZoomBox paneId={paneId} zoom={zoom} fitInMenu={!layout.fit} />
      <ToolbarButton commandId="view.zoomIn" label="Zoom in" icon={<ZoomInIcon size={16} />} className="status-btn" />
      {layout.slider && (
        <span className="tb-tip" data-tooltip={paneId === null ? NO_DOCUMENT_ZOOM_REASON : undefined}>
        <input
          className="status-slider"
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          aria-label="Zoom slider"
          aria-valuetext={`${Math.round(zoom * 100)}%`}
          disabled={paneId === null}
          value={zoomToSlider(zoom)}
          onChange={(e) => requestViewer(paneId, { kind: 'setZoom', zoom: sliderToZoom(Number(e.target.value)) })}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            // Keys work in zoom percent, not in slider positions (1.5.5 A1). Dragging keeps the fine scale.
            if (e.key === 'PageUp' || e.key === 'PageDown') {
              e.preventDefault();
              requestViewer(paneId, { kind: 'zoomStep', direction: e.key === 'PageUp' ? 1 : -1 });
              return;
            }
            const percent = sliderKeyPercent(e.key, zoom * 100);
            if (percent === null) return;
            e.preventDefault();
            requestViewer(paneId, { kind: 'setZoom', zoom: percent / 100 });
          }}
        />
        </span>
      )}
    </div>
  );
}

/**
 * The progress footer goes away when its job ends or Cancel is pressed. A button that holds focus and then leaves the page
 * drops focus to the body, so the keyboard user would start again from the top: focus goes to the main area instead.
 * Focus counts as "inside" until it moves to another element (a disabled Cancel blurs with no target).
 */
function useFocusToMainOnUnmount(ref: RefObject<HTMLElement | null>): void {
  const inside = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onIn = () => {
      inside.current = true;
    };
    const onOut = (event: FocusEvent) => {
      if (event.relatedTarget) inside.current = false;
    };
    el.addEventListener('focusin', onIn);
    el.addEventListener('focusout', onOut);
    return () => {
      el.removeEventListener('focusin', onIn);
      el.removeEventListener('focusout', onOut);
      const active = document.activeElement;
      if (inside.current || el.contains(active)) {
        if (!active || active === document.body || el.contains(active)) document.querySelector<HTMLElement>('.main')?.focus();
      }
    };
  }, [ref]);
}

/**
 * The progress of a batch job (Split into Files). It shows on every tab, also with no document open, with Cancel in every
 * phase. The text follows the worker's phase (jobMessages.statusText); a phase without a count is a moving stripe.
 */
function JobStatus() {
  const job = useJobStore((s) => s.job);
  const footer = useRef<HTMLElement>(null);
  useFocusToMainOnUnmount(footer);
  if (!job) return null;
  const shown = statusText(job.kind, job, job.cancelling);
  // The blank-page search shows in the sheet, not here; the bar keeps its last text.
  const text = shown.text ?? statusText(job.kind, { ...job, phase: 'copying' }, job.cancelling).text ?? '';
  return (
    <footer ref={footer} className="status-bar status-progress" data-job-status={job.kind}>
      <span className="status-progress-label">{text}</span>
      <div
        className={shown.bar === 'stripe' ? 'status-progress-track status-progress-stripe' : 'status-progress-track'}
        role="progressbar"
        aria-label={text}
        aria-valuetext={text}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(shown.bar === 'fill' ? { 'aria-valuenow': shown.percent } : {})}
      >
        <div style={shown.bar === 'fill' ? { width: `${shown.percent}%` } : undefined} />
      </div>
      <button type="button" className="status-cancel" disabled={job.cancelling} onClick={() => cancelJob()}>
        Cancel
      </button>
    </footer>
  );
}

export function StatusBar() {
  const jobRunning = useJobStore((s) => s.job !== null);
  return jobRunning ? <JobStatus /> : <DocumentStatus />;
}

function DocumentStatus() {
  const docId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const progress = useEditStore((s) => (docId ? s.progress[docId] : undefined));
  const hasDoc = useDocumentsStore((s) => (docId ? s.docs[docId] !== undefined : false));
  if (docId && progress) return <OperationProgress docId={docId} progress={progress} />;
  return <StatusMain hasDoc={Boolean(docId) && hasDoc} />;
}

function OperationProgress({ docId, progress }: { docId: string; progress: { label: string; done: number; total: number } }) {
  const footer = useRef<HTMLElement>(null);
  useFocusToMainOnUnmount(footer);
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <footer ref={footer} className="status-bar status-progress">
      <span className="status-progress-label">
        {progress.label}
        {progress.total > 0 ? ` · ${progress.done} of ${progress.total}` : '…'}
      </span>
      <div
        className="status-progress-track"
        role="progressbar"
        aria-label={progress.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div style={{ width: `${percent}%` }} />
      </div>
      <button type="button" className="status-cancel" onClick={() => cancelOperation(docId)}>
        Cancel
      </button>
    </footer>
  );
}

/**
 * The bar with the page and the zoom controls. It watches its own width and leaves parts out as it narrows. With no document
 * it says "No file open" and the zoom controls stay, off: the bar does not change its shape (and a focused control is not
 * lost) when a tab is loading or asking for a password.
 */
function StatusMain({ hasDoc }: { hasDoc: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<StatusLayout>(() => statusLayout(Number.POSITIVE_INFINITY));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number) => {
      // A bar that has no width yet (not laid out, or hidden) says nothing about the room it will have.
      if (!(width > 0)) return;
      const next = statusLayout(width);
      // Only a change of layout draws the bar again, so a resize within one layout costs nothing.
      setLayout((now) => (sameLayout(now, next) ? now : next));
    };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) apply(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <footer className="status-bar" ref={ref}>
      <div className="status-left">
        {hasDoc ? (
          <>
            <PageStatus word={layout.pageWord} />
            <SelectionChip short={layout.shortChip} />
            {layout.info && <DocumentInfo />}
          </>
        ) : (
          <span>No file open</span>
        )}
      </div>
      <ZoomControls layout={layout} />
    </footer>
  );
}
