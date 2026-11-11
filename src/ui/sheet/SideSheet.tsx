import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import {
  useSheetStore,
  type CropDraft,
  type CropScope,
  type CutDraft,
  type CutScope,
  type FromDraft,
  type InsertDraft,
  type InsertPosition,
  type ReplaceDraft,
  type RotateDraft,
  type SheetDraft,
  type SizeDraft,
  type SizeName,
} from '../../core/stores/sheetStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { useOverlayStore } from '../../core/stores/overlayStore';
import { useUiStore } from '../../core/stores/uiStore';
import { Priority } from '../../engine/renderScheduler';
import { BitmapCanvas } from '../thumbnails/BitmapCanvas';
import { useThumbnail } from '../thumbnails/useThumbnail';
import { attachPickedSource, orderOf } from '../../features/organizer/actions';
import { applySheet, autoCropFromSheet, cancelSheet, INSERT_RANGE_MESSAGE, MAX_INSERT_COUNT, useApplyStore } from '../../features/organizer/sheetActions';
import { hideSettings } from '../../features/compare/compareSession';
import { clampRotation, insertAnchor, pageIdFromUid, ROTATE_LIMIT } from '../../features/organizer/pageMath';
import {
  CUT_DEFAULT_PERCENT,
  CUT_MAX_PERCENT,
  CUT_MIN_PERCENT,
  CUT_MEASURING_MESSAGE,
  CUT_NO_MATCH_MESSAGE,
  CUT_PERCENT_MESSAGE,
  cutSummary,
  formatCutPercent,
  guideShape,
  parseCutPercent,
  snapCutPercent,
  stepCutPercent,
  wideChoiceLabel,
} from '../../features/organizer/cutMath';
import { useCutState } from './useCutState';
import { NumberField, Segmented, UnitSelect } from './sheetControls';
import { CompareBody, CompareFooter } from './CompareSheet';
import { parsePageRange } from '../../features/organizer/pageRange';
import { describeSize, fromPoints, sizeInPoints, SIZE_PRESETS, toPoints } from '../../features/organizer/units';
import { THUMB_WIDTH_PX } from '../../panels/thumbnails/ThumbnailsPanel';

/**
 * The right-docked side sheet of the page organizer: 320 px, no scrim, and a live preview where the sheet has one. Apply
 * makes the edit (one undo step); Cancel, the close button or Esc leaves the document as it was.
 */

const TITLES: Record<SheetDraft['kind'], string> = {
  insert: 'Insert pages',
  from: 'Insert from a PDF',
  replace: 'Replace page',
  rotate: 'Rotate pages',
  crop: 'Crop pages',
  size: 'Page size',
  cut: 'Cut pages in half',
  compare: 'Overlay to compare',
  confirmDelete: 'Delete pages?',
};

export function SideSheet() {
  const sheet = useSheetStore((s) => s.sheet);
  const activeDocId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const menuOpen = useOverlayStore((s) => s.menu !== null || s.paletteOpen);
  const closePrompt = useUiStore((s) => s.closePrompt || s.sourcePassword !== null);

  // A sheet acts on one document. Showing another document closes it.
  useEffect(() => {
    if (sheet && activeDocId !== sheet.docId) useSheetStore.getState().close();
  }, [sheet, activeDocId]);

  // Esc cancels the sheet, unless a menu, the palette, the close prompt or a Help panel has the key, or an inner control has
  // already used it (the find box): Esc closes one thing (1.5.5 section 0).
  const helpOpen = useUiStore((s) => s.helpDialog !== null);
  useEffect(() => {
    if (!sheet) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || menuOpen || closePrompt || helpOpen || event.defaultPrevented) return;
      event.preventDefault();
      cancelSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, menuOpen, closePrompt, helpOpen]);

  // The sheet takes the keyboard in the frame it appears and gives it back when it closes (1.5.5 C2). It stays non-modal.
  const rootRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const kind = sheet?.kind ?? null;
  const docId = sheet?.docId ?? null;
  useLayoutEffect(() => {
    if (sheet) {
      if (!wasOpen.current) {
        wasOpen.current = true;
        const active = document.activeElement;
        openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      if (rootRef.current) focusSheet(rootRef.current, sheet);
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const back = openerRef.current;
      openerRef.current = null;
      if (back && back.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
      // The opener may refuse the focus (hidden, or no longer focusable): then the page of the focused pane gets it.
      if (!back || document.activeElement !== back) document.querySelector<HTMLElement>('.main')?.focus();
    }
    // Only a sheet that opens (or another kind taking its place) moves the focus; a redraw of the same sheet does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, docId]);

  const applying = useApplyStore((s) => s.applying && s.docId === docId);
  if (!sheet) return null;
  return (
    <aside ref={rootRef} className="side-sheet" role="dialog" aria-label={TITLES[sheet.kind]} data-sheet={sheet.kind}>
      <header className="side-sheet-head">
        <h2>{TITLES[sheet.kind]}</h2>
        {sheet.kind === 'compare' && (
          // [»] hides the sheet and keeps comparing. The × next to it leaves the compare (the UI spec's two different exits).
          <button type="button" className="side-sheet-close side-sheet-hide" aria-label="Hide settings" title="Hide settings and keep comparing" onClick={() => hideSettings()}>
            »
          </button>
        )}
        <button type="button" className="side-sheet-close" aria-label={sheet.kind === 'compare' ? 'Leave compare' : 'Close sheet'} onClick={() => cancelSheet()}>
          ×
        </button>
      </header>
      <div className="side-sheet-body">
        {/* While Apply runs the fields are read-only, so the sheet shows what is being applied (1.5.5 C5). */}
        <fieldset className="side-fieldset" disabled={applying}>
          <SheetBody sheet={sheet} />
        </fieldset>
      </div>
      <SheetFooter sheet={sheet} />
    </aside>
  );
}

/** Where focus goes when a sheet opens (1.5.5 C2). Overlay to compare takes its own focus (CompareSheet). */
function focusSheet(root: HTMLElement, sheet: SheetDraft): void {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector);
  const chosen = (group: string) => q(`[role="radiogroup"][aria-label="${group}"] [aria-checked="true"]`);
  const field = (label: string) => q(`input[aria-label="${label}"]`);
  let target: HTMLElement | null = null;
  switch (sheet.kind) {
    case 'insert':
      target = chosen('Page type');
      break;
    case 'from':
      target = sheet.sourceDocId === null ? q('[data-sheet-browse]') : field('Page range');
      break;
    case 'replace':
      target = sheet.sourceDocId === null ? q('[data-sheet-browse]') : field('Page in the PDF');
      break;
    case 'rotate':
      target = field('Angle in degrees');
      break;
    case 'crop':
      target = field('Top margin');
      break;
    case 'size':
      target = chosen('Size');
      break;
    case 'cut':
      target = chosen('Cut into');
      break;
    case 'confirmDelete':
      // The safe choice: Enter cancels.
      target = q('.side-sheet-foot .side-button');
      break;
    case 'compare':
      return;
  }
  if (!target) return;
  target.focus();
  if (target instanceof HTMLInputElement) target.select();
}

function SheetFooter({ sheet }: { sheet: SheetDraft }) {
  const [localBusy, setLocalBusy] = useState(false);
  const applying = useApplyStore((s) => s.applying && s.docId === sheet.docId);
  const cancelling = useApplyStore((s) => s.closeRequested && s.docId === sheet.docId);
  const footRef = useRef<HTMLDivElement>(null);
  const wasApplying = useRef(false);
  const focusBefore = useRef<HTMLElement | null>(null);
  const busy = localBusy || applying;
  const run = async () => {
    const active = document.activeElement;
    focusBefore.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setLocalBusy(true);
    try {
      await applySheet(sheet);
    } finally {
      setLocalBusy(false);
    }
  };
  // An Apply that leaves the sheet open gives the focus back to where it was (the fields were read-only meanwhile); after a
  // change cancelled from the status bar, focus goes to Apply (1.5.5 C5).
  useEffect(() => {
    if (wasApplying.current && !busy) {
      const state = useApplyStore.getState();
      const apply = footRef.current?.querySelector<HTMLElement>('.side-primary, .side-danger');
      const back = focusBefore.current;
      focusBefore.current = null;
      const target = state.focusApply ? apply : back && back.isConnected && !(back as HTMLButtonElement).disabled ? back : apply;
      target?.focus();
      if (state.focusApply) useApplyStore.setState({ focusApply: false });
    }
    wasApplying.current = busy;
  }, [busy]);
  const cancelButton = (
    <button type="button" className="side-button" disabled={cancelling} onClick={() => cancelSheet()}>
      {cancelling ? 'Cancelling…' : 'Cancel'}
    </button>
  );
  if (sheet.kind === 'compare') return <CompareFooter docId={sheet.docId} busy={busy} run={() => void run()} />;
  if (sheet.kind === 'confirmDelete') {
    const count = sheet.uids.length;
    return (
      <div ref={footRef} className="side-sheet-foot">
        {cancelButton}
        <button type="button" className="side-button side-danger" disabled={busy} onClick={() => void run()}>
          Delete {count} {count === 1 ? 'page' : 'pages'}
        </button>
      </div>
    );
  }
  return (
    <div ref={footRef} className="side-sheet-foot">
      {cancelButton}
      {sheet.kind === 'cut' ? (
        <CutApply sheet={sheet} busy={busy} run={() => void run()} />
      ) : (
        <button type="button" className="side-button side-primary" disabled={busy} onClick={() => void run()}>
          Apply
        </button>
      )}
    </div>
  );
}

/** Apply of the Cut sheet: off while the position is not a number from 30 to 70 or "Apply to" names no page. */
function CutApply({ sheet, busy, run }: { sheet: CutDraft; busy: boolean; run: () => void }) {
  const { problem } = useCutState(sheet);
  return (
    <button type="button" className="side-button side-primary" disabled={busy || problem !== null} title={problem ?? undefined} onClick={run}>
      Apply
    </button>
  );
}

function SheetBody({ sheet }: { sheet: SheetDraft }): ReactNode {
  switch (sheet.kind) {
    case 'insert':
      return <InsertBody sheet={sheet} />;
    case 'from':
      return <FromBody sheet={sheet} />;
    case 'replace':
      return <ReplaceBody sheet={sheet} />;
    case 'rotate':
      return <RotateBody sheet={sheet} />;
    case 'crop':
      return <CropBody sheet={sheet} />;
    case 'size':
      return <SizeBody sheet={sheet} />;
    case 'cut':
      return <CutBody sheet={sheet} />;
    case 'compare':
      return <CompareBody docId={sheet.docId} />;
    case 'confirmDelete':
      return (
        <p className="side-text">
          This removes {sheet.uids.length} of {sheet.total} pages, more than half of the document. Apply deletes them, and Undo
          in the bar that follows brings them back.
        </p>
      );
  }
}

/* Shared pieces (Segmented, UnitSelect and NumberField live in sheetControls.tsx) */

const POSITION_OPTIONS: Array<{ value: InsertPosition; label: string }> = [
  { value: 'before', label: 'Before current page' },
  { value: 'after', label: 'After current page' },
  { value: 'at', label: 'At page number' },
];

/** The page the new pages follow, in words: "after page 3", or "at the start". */
function anchorText(order: readonly string[], pageIndex: number, position: InsertPosition, at: number): string {
  const anchor = insertAnchor(order, pageIndex, position, at);
  if (anchor === null) return 'at the start';
  return `after page ${order.indexOf(anchor) + 1}`;
}

/** A page-shaped preview of a size, with the template's lines or grid. */
function PaperPreview({ width, height, template }: { width: number; height: number; template?: 'blank' | 'lined' | 'grid' }) {
  const ratio = width > 0 && height > 0 ? width / height : 8.5 / 11;
  return (
    <div className="side-paper-wrap" aria-hidden="true">
      <div className={`side-paper side-paper-${template ?? 'blank'}`} style={{ aspectRatio: String(ratio) }} />
    </div>
  );
}

/** The current page's thumbnail, for previews. Renders nothing when the page is not known. */
function PagePreview({ docId, pageId, transform, children }: { docId: string; pageId: string; transform?: string; children?: ReactNode }) {
  const doc = useDocumentsStore((s) => s.docs[docId]);
  const ref = doc?.pages.find((p) => p.id === pageId);
  const bitmap = useThumbnail({
    docId,
    srcIndex: ref?.srcIndex ?? 0,
    content: ref?.content,
    rotation: ref?.rotation ?? 0,
    widthPx: THUMB_WIDTH_PX,
    priority: Priority.Thumbnail,
  });
  return (
    <div className="side-page-preview">
      <div className="side-page-turn" style={transform ? { transform } : undefined}>
        {bitmap ? <BitmapCanvas bitmap={bitmap} label="Preview of the current page" className="thumb-image" /> : <div className="thumb-image thumb-blank" />}
        {children}
      </div>
    </div>
  );
}

/* Insert */

function InsertBody({ sheet }: { sheet: InsertDraft }) {
  const update = useSheetStore((s) => s.update);
  const order = orderOf(sheet.docId);
  const size = sizeInPoints(sheet.size, sheet.custom, sheet.unit);
  const summary = `Adds ${sheet.count} ${sheet.template === 'blank' ? 'blank' : sheet.template} ${sheet.count === 1 ? 'page' : 'pages'} ${anchorText(order, sheet.pageIndex, sheet.position, sheet.at)}.`;
  return (
    <>
      <Segmented<InsertDraft['template']>
        label="Page type"
        value={sheet.template}
        options={[
          { value: 'blank', label: 'Blank' },
          { value: 'lined', label: 'Lined' },
          { value: 'grid', label: 'Grid' },
        ]}
        onChange={(template) => update({ template })}
      />
      <PaperPreview width={size.width} height={size.height} template={sheet.template} />
      <label className="side-field">
        <span>Size</span>
        <select
          aria-label="Page size"
          className="side-input"
          value={sheet.size}
          onChange={(e) => update({ size: e.target.value as SizeName })}
        >
          <option value="letter">Letter</option>
          <option value="a4">A4</option>
          <option value="legal">Legal</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {sheet.size === 'custom' && (
        <div className="side-row">
          <NumberField label="Custom width" value={sheet.custom.width} min={0.1} onChange={(width) => update({ custom: { ...sheet.custom, width } })} />
          <NumberField label="Custom height" value={sheet.custom.height} min={0.1} onChange={(height) => update({ custom: { ...sheet.custom, height } })} />
          <UnitSelect value={sheet.unit} onChange={(unit) => update({ unit })} />
        </div>
      )}
      <label className="side-field">
        <span>Number of pages</span>
        <input
          type="number"
          aria-label="Number of pages"
          className="side-input"
          min={1}
          max={1000}
          value={sheet.count}
          onChange={(e) => {
            const next = e.target.valueAsNumber;
            if (Number.isFinite(next)) update({ count: next });
          }}
        />
      </label>
      <label className="side-field">
        <span>Position</span>
        <select
          aria-label="Position"
          className="side-input"
          value={sheet.position}
          onChange={(e) => update({ position: e.target.value as InsertPosition })}
        >
          {POSITION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {sheet.position === 'at' && (
        <NumberField label="Position number" value={sheet.at} min={1} max={order.length + 1} onChange={(at) => update({ at })} />
      )}
      <p className="side-text side-summary">{summary}</p>
    </>
  );
}

/* From PDF */

function FromBody({ sheet }: { sheet: FromDraft }) {
  const update = useSheetStore((s) => s.update);
  const [browsing, setBrowsing] = useState(false);
  const order = orderOf(sheet.docId);
  const range = sheet.sourceDocId === null ? null : parsePageRange(sheet.range, sheet.sourcePages);
  const browse = async () => {
    setBrowsing(true);
    try {
      const picked = await attachPickedSource(sheet.docId);
      if (picked) update({ sourceDocId: picked.sourceDocId, sourceName: picked.name, sourcePages: picked.pages, range: '' } as Partial<FromDraft>);
    } finally {
      setBrowsing(false);
    }
  };
  return (
    <>
      <div className="side-row">
        <button type="button" className="side-button" data-sheet-browse="true" disabled={browsing} onClick={() => void browse()}>
          Browse for a PDF…
        </button>
      </div>
      <p className="side-text">
        {sheet.sourceName ? `${sheet.sourceName}, ${sheet.sourcePages} ${sheet.sourcePages === 1 ? 'page' : 'pages'}` : 'No PDF chosen yet.'}
      </p>
      <label className="side-field">
        <span>Pages (for example 1-5, 8)</span>
        <input
          type="text"
          aria-label="Page range"
          className="side-input"
          placeholder="1-5, 8"
          value={sheet.range}
          onChange={(e) => update({ range: e.target.value } as Partial<FromDraft>)}
        />
      </label>
      <label className="side-field">
        <span>Position</span>
        <select
          aria-label="Position"
          className="side-input"
          value={sheet.position}
          onChange={(e) => update({ position: e.target.value as InsertPosition } as Partial<FromDraft>)}
        >
          {POSITION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {sheet.position === 'at' && (
        <NumberField
          label="Position number"
          value={sheet.at}
          min={1}
          max={order.length + 1}
          onChange={(at) => update({ at } as Partial<FromDraft>)}
        />
      )}
      {range && range.ok && range.pages.length > MAX_INSERT_COUNT && <p className="side-text side-error">{INSERT_RANGE_MESSAGE}</p>}
      {range && range.ok && range.pages.length <= MAX_INSERT_COUNT && (
        <p className="side-text side-summary">
          Inserts {range.pages.length} {range.pages.length === 1 ? 'page' : 'pages'} {anchorText(order, sheet.pageIndex, sheet.position, sheet.at)}.
        </p>
      )}
      {range && !range.ok && <p className="side-text side-error">{range.message}</p>}
    </>
  );
}

/* Replace */

function ReplaceBody({ sheet }: { sheet: ReplaceDraft }) {
  const update = useSheetStore((s) => s.update);
  const [browsing, setBrowsing] = useState(false);
  const browse = async () => {
    setBrowsing(true);
    try {
      const picked = await attachPickedSource(sheet.docId);
      if (picked) update({ sourceDocId: picked.sourceDocId, sourceName: picked.name, sourcePages: picked.pages, sourcePage: 1 } as Partial<ReplaceDraft>);
    } finally {
      setBrowsing(false);
    }
  };
  return (
    <>
      <p className="side-text">This replaces page {sheet.pageNumber} of this file.</p>
      <div className="side-row">
        <button type="button" className="side-button" data-sheet-browse="true" disabled={browsing} onClick={() => void browse()}>
          Browse for a PDF…
        </button>
      </div>
      <p className="side-text">
        {sheet.sourceName ? `${sheet.sourceName}, ${sheet.sourcePages} ${sheet.sourcePages === 1 ? 'page' : 'pages'}` : 'No PDF chosen yet.'}
      </p>
      {sheet.sourceDocId !== null && (
        <NumberField
          label="Page in the PDF"
          value={sheet.sourcePage}
          min={1}
          max={sheet.sourcePages}
          onChange={(sourcePage) => update({ sourcePage } as Partial<ReplaceDraft>)}
        />
      )}
    </>
  );
}

/* Rotate */

function RotateBody({ sheet }: { sheet: RotateDraft }) {
  const update = useSheetStore((s) => s.update);
  const setDegrees = (degrees: number) => update({ degrees } as Partial<RotateDraft>);
  const count = sheet.uids.length;
  const shown = clampRotation(sheet.degrees);
  const native = Number.isInteger(sheet.degrees) && sheet.degrees % 90 === 0;
  const pageId = pageIdOf(sheet);
  return (
    <>
      <PagePreview docId={sheet.docId} pageId={pageId} transform={`rotate(${sheet.degrees}deg)`} />
      <div className="side-row side-presets" role="group" aria-label="Presets">
        <button type="button" className="side-button" onClick={() => setDegrees(-90)}>
          Left 90°
        </button>
        <button type="button" className="side-button" onClick={() => setDegrees(90)}>
          Right 90°
        </button>
        <button type="button" className="side-button" onClick={() => setDegrees(180)}>
          180°
        </button>
        <button type="button" className="side-button" onClick={() => setDegrees(0)}>
          Reset
        </button>
      </div>
      <label className="side-field">
        <span>Custom angle: {shown}°</span>
        <input
          type="range"
          aria-label="Rotation angle"
          min={-ROTATE_LIMIT}
          max={ROTATE_LIMIT}
          step={0.1}
          value={shown}
          onChange={(e) => setDegrees(clampRotation(e.target.valueAsNumber))}
        />
      </label>
      <div className="side-row">
        <NumberField
          label="Angle in degrees"
          value={sheet.degrees}
          min={-ROTATE_LIMIT}
          max={ROTATE_LIMIT}
          step={0.1}
          onChange={(value) => setDegrees(clampRotation(value))}
        />
        <span className="side-text">degrees</span>
      </div>
      <p className="side-text side-summary">
        {sheet.degrees === 0
          ? 'Choose an angle to rotate the pages.'
          : `Rotates ${count} ${count === 1 ? 'page' : 'pages'} by ${sheet.degrees}°${native ? '.' : ' (a custom rotation).'}`}
      </p>
    </>
  );
}

/** The page the rotate preview shows: the first target page. */
function pageIdOf(sheet: RotateDraft): string {
  const uid = sheet.uids[0];
  return uid ? pageIdFromUid(sheet.docId, uid) : '';
}

/* Crop */

const SCOPE_OPTIONS: Array<{ value: CropScope; label: string }> = [
  { value: 'current', label: 'Current page' },
  { value: 'selected', label: 'Selected pages' },
  { value: 'all', label: 'All pages' },
  { value: 'odd', label: 'Odd pages' },
  { value: 'even', label: 'Even pages' },
];

function CropBody({ sheet }: { sheet: CropDraft }) {
  const update = useSheetStore((s) => s.update);
  const [autoBusy, setAutoBusy] = useState(false);
  const setMargin = (edge: keyof CropDraft['margins'], value: number) => {
    update({ margins: { ...sheet.margins, [edge]: Math.max(0, toPoints(value, sheet.unit)) } } as Partial<CropDraft>);
  };
  const shown = (edge: keyof CropDraft['margins']) => fromPoints(sheet.margins[edge], sheet.unit);
  const auto = async () => {
    setAutoBusy(true);
    try {
      await autoCropFromSheet();
    } finally {
      setAutoBusy(false);
    }
  };
  return (
    <>
      <label className="side-field">
        <span>Apply to</span>
        <select
          aria-label="Apply to"
          className="side-input"
          value={sheet.scope}
          onChange={(e) => update({ scope: e.target.value as CropScope } as Partial<CropDraft>)}
        >
          {SCOPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="side-row">
        <span className="side-text">Margins</span>
        <UnitSelect value={sheet.unit} onChange={(unit) => update({ unit } as Partial<CropDraft>)} />
      </div>
      <div className="side-margins">
        {/* Each letter sits next to its own box, so the four boxes fall in the two wide columns and are the same width. */}
        <span className="side-margin-label" aria-hidden="true">T</span>
        <NumberField label="Top margin" value={shown('top')} min={0} onChange={(v) => setMargin('top', v)} />
        <span className="side-margin-label" aria-hidden="true">B</span>
        <NumberField label="Bottom margin" value={shown('bottom')} min={0} onChange={(v) => setMargin('bottom', v)} />
        <span className="side-margin-label" aria-hidden="true">L</span>
        <NumberField label="Left margin" value={shown('left')} min={0} onChange={(v) => setMargin('left', v)} />
        <span className="side-margin-label" aria-hidden="true">R</span>
        <NumberField label="Right margin" value={shown('right')} min={0} onChange={(v) => setMargin('right', v)} />
      </div>
      <p className="side-text">Drag the box on the page, or type the margins.</p>
      <div className="side-row">
        <button type="button" className="side-button" disabled={autoBusy || sheet.autoApplied} onClick={() => void auto()}>
          Auto-crop
        </button>
        {sheet.autoApplied && <span className="side-text">Auto-crop applied. Cancel undoes it.</span>}
      </div>
    </>
  );
}

/* Page size */

function SizeBody({ sheet }: { sheet: SizeDraft }) {
  const update = useSheetStore((s) => s.update);
  const size = sizeInPoints(sheet.size, sheet.custom, sheet.unit);
  const count = sheet.scope === 'all' ? orderOf(sheet.docId).length : sheet.uids.length;
  return (
    <>
      <Segmented<SizeName>
        label="Size"
        value={sheet.size}
        options={[
          { value: 'letter', label: 'Letter' },
          { value: 'a4', label: 'A4' },
          { value: 'custom', label: 'Custom' },
        ]}
        onChange={(value) => update({ size: value } as Partial<SizeDraft>)}
      />
      <PaperPreview width={size.width} height={size.height} />
      {sheet.size === 'custom' && (
        <div className="side-row">
          <NumberField label="Custom width" value={sheet.custom.width} min={0.1} onChange={(width) => update({ custom: { ...sheet.custom, width } } as Partial<SizeDraft>)} />
          <NumberField label="Custom height" value={sheet.custom.height} min={0.1} onChange={(height) => update({ custom: { ...sheet.custom, height } } as Partial<SizeDraft>)} />
          <UnitSelect value={sheet.unit} onChange={(unit) => update({ unit } as Partial<SizeDraft>)} />
        </div>
      )}
      <Segmented<'scale' | 'center'>
        label="Fit"
        value={sheet.fit}
        options={[
          { value: 'scale', label: 'Scale to fit' },
          { value: 'center', label: 'Center' },
        ]}
        onChange={(fit) => update({ fit } as Partial<SizeDraft>)}
      />
      <label className="side-field">
        <span>Apply to</span>
        <select
          aria-label="Apply to"
          className="side-input"
          value={sheet.scope}
          onChange={(e) => update({ scope: e.target.value as 'selected' | 'all' } as Partial<SizeDraft>)}
        >
          <option value="selected">Selected pages</option>
          <option value="all">All pages</option>
        </select>
      </label>
      <p className="side-text side-summary">
        Sets {count} {count === 1 ? 'page' : 'pages'} to {sheet.size === 'custom' ? describeSize(size.width, size.height, sheet.unit) : SIZE_PRESETS[sheet.size].label}.
      </p>
    </>
  );
}

/* Cut pages in half */

function CutBody({ sheet }: { sheet: CutDraft }) {
  const update = useSheetStore((s) => s.update);
  const state = useCutState(sheet);
  const percent = parseCutPercent(sheet.percentText);
  // The slider and the guide stay at the last valid value while the typed text is not valid (1.5.5 C4).
  const shownPercent = Math.round(state.shownAt * 1000) / 10;
  const horizontal = sheet.direction === 'horizontal';
  const count = state.targets.uids.length;

  const setPercent = (value: number) => update({ percentText: formatCutPercent(snapCutPercent(value)) } as Partial<CutDraft>);
  const onSliderKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // The slider can sit on any tenth. An arrow goes to the next multiple of 0.5 in its direction, Page Up and Page Down move 5,
    // and Home and End go to the ends (1.5.5 C4).
    const now = shownPercent;
    const moves: Record<string, number | undefined> = {
      ArrowRight: stepCutPercent(now, 1),
      ArrowUp: stepCutPercent(now, 1),
      ArrowLeft: stepCutPercent(now, -1),
      ArrowDown: stepCutPercent(now, -1),
      PageUp: now + 5,
      PageDown: now - 5,
      Home: CUT_MIN_PERCENT,
      End: CUT_MAX_PERCENT,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    update({ percentText: formatCutPercent(Math.min(CUT_MAX_PERCENT, Math.max(CUT_MIN_PERCENT, next))) } as Partial<CutDraft>);
  };
  // The box is the exact control: a valid number with more than one decimal is rounded when the box loses focus or Enter is pressed.
  const tidyBox = () => {
    if (percent !== null && sheet.percentText !== formatCutPercent(percent)) update({ percentText: formatCutPercent(percent) } as Partial<CutDraft>);
  };

  // The preview shows the current page of the focused pane (else the first page), with the same guide the pages get.
  // Only the current page's id is read, so a scroll that stays on the page does not redraw the preview.
  const currentId = useWorkspaceStore((s) => {
    const pane = selectPane(s, s.activePaneId);
    return pane && pane.docId === sheet.docId ? pane.view.pageId : null;
  });
  const order = orderOf(sheet.docId);
  const previewId =
    currentId && order.some((uid) => pageIdFromUid(sheet.docId, uid) === currentId)
      ? currentId
      : order[0] !== undefined
        ? pageIdFromUid(sheet.docId, order[0])
        : '';
  const shape = guideShape(sheet.direction, state.shownAt, sheet.first, 0);
  const pct = (v: number) => `${v * 100}%`;

  return (
    <>
      <PagePreview docId={sheet.docId} pageId={previewId}>
        <svg className="cut-preview-svg" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" data-cut-preview-line="true">
          <line x1={shape.line[0].x} y1={shape.line[0].y} x2={shape.line[1].x} y2={shape.line[1].y} className="cut-guide-line" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="cut-guide-mark" aria-hidden="true" data-cut-preview-mark="1" style={{ left: pct(shape.first.x), top: pct(shape.first.y) }}>
          1
        </span>
        <span className="cut-guide-mark" aria-hidden="true" data-cut-preview-mark="2" style={{ left: pct(shape.second.x), top: pct(shape.second.y) }}>
          2
        </span>
      </PagePreview>
      <div className="side-field">
        <span>Cut into</span>
        <Segmented<CutDraft['direction']>
          label="Cut into"
          value={sheet.direction}
          options={[
            { value: 'vertical', label: 'Left and right' },
            { value: 'horizontal', label: 'Top and bottom' },
          ]}
          onChange={(direction) => update({ direction } as Partial<CutDraft>)}
        />
      </div>
      <div className="side-field">
        <span>Cut position</span>
        <div className="side-row">
          <input
            type="range"
            aria-label={`Cut position, percent of the page ${horizontal ? 'height' : 'width'}`}
            className="cut-slider"
            min={CUT_MIN_PERCENT}
            max={CUT_MAX_PERCENT}
            step={0.1}
            value={shownPercent}
            aria-valuetext={`${shownPercent}%`}
            onChange={(e) => setPercent(e.target.valueAsNumber)}
            onKeyDown={onSliderKey}
          />
          <input
            type="text"
            inputMode="decimal"
            aria-label="Cut position in percent"
            aria-invalid={percent === null}
            className="side-input cut-percent"
            value={sheet.percentText}
            onChange={(e) => update({ percentText: e.target.value } as Partial<CutDraft>)}
            onBlur={tidyBox}
            onKeyDown={(e) => {
              if (e.key === 'Enter') tidyBox();
            }}
          />
          <span className="side-text">%</span>
          <button type="button" className="side-button" onClick={() => setPercent(CUT_DEFAULT_PERCENT)}>
            Center
          </button>
        </div>
        {percent === null && (
          <p className="side-text side-error" role="alert">
            {CUT_PERCENT_MESSAGE}
          </p>
        )}
      </div>
      {!horizontal && (
        <div className="side-field">
          <span>Page order</span>
          <Segmented<'left' | 'right'>
            label="Page order"
            value={sheet.first}
            options={[
              { value: 'left', label: 'Left page first' },
              { value: 'right', label: 'Right page first' },
            ]}
            onChange={(first) => update({ first } as Partial<CutDraft>)}
          />
          <p className="side-text">Choose Right page first for books read right to left.</p>
        </div>
      )}
      <label className="side-field">
        <span>Apply to</span>
        <select
          aria-label="Apply to"
          className="side-input"
          value={sheet.scope}
          onChange={(e) => update({ scope: e.target.value as CutScope } as Partial<CutDraft>)}
        >
          <option value="current">Current page</option>
          <option value="selected">Selected pages</option>
          <option value="all">All pages</option>
          <option value="wide">{wideChoiceLabel(sheet.direction)}</option>
        </select>
      </label>
      <p className="side-text side-summary" aria-live="polite" data-cut-summary="true">
        {state.targets.unmeasured ? CUT_MEASURING_MESSAGE : count === 0 ? CUT_NO_MATCH_MESSAGE : cutSummary(count)}
      </p>
    </>
  );
}
