import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCompareStore, type CompareAddTo, type CompareLook, type CompareSession } from '../../core/stores/compareStore';
import { useDocumentsStore } from '../../core/stores/documentsStore';
import { useEditStore } from '../../core/stores/editStore';
import { useSelectionStore } from '../../core/stores/selectionStore';
import { selectPane, useWorkspaceStore } from '../../core/stores/workspaceStore';
import { fitToPage, sizesDiffer, OVERLAY_SCALE_MAX, OVERLAY_SCALE_MIN } from '../../engine/overlayPlacement';
import {
  COMPARE_DIFFERENCES_LEGEND,
  COMPARE_DIFFERENT_SIZE,
  COMPARE_NOT_COPIED,
  COMPARE_NO_FILE,
  addProblem,
  clampOffset,
  clampPage,
  compareTargets,
  fileLine,
  nudgeStep,
  openingText,
  parseSizePercent,
  partnerOf,
  thisPageLine,
  unsavedText,
} from '../../features/compare/compareMath';
import {
  changeCompare,
  chooseOpenFile,
  chooseOverlayFile,
  ensureOverlaySize,
  leaveCompare,
  openFilesFor,
  overlayFileUnsaved,
  toggleShow,
} from '../../features/compare/compareSession';
import { pageIdFromUid, pageUidFromId } from '../../features/organizer/pageMath';
import { fromPoints, toPoints } from '../../features/organizer/units';
import type { LengthUnit } from '../../core/stores/sheetStore';
import { Segmented, UnitSelect } from './sheetControls';

/**
 * The body and footer of the Overlay to Compare sheet (1.3.4, UI spec section 4). Every control changes the compare store, and
 * the viewer follows it at once; nothing in the document changes until "Add overlay to pages".
 */

/** The session of this sheet's document, or null once it has ended. */
function useSession(docId: string): CompareSession | null {
  return useCompareStore((s) => (s.session?.docId === docId ? s.session : null));
}

/** The position (0-based) of the focused pane's current page in this document, or 0. */
function useCurrentPosition(docId: string): number {
  const order = useEditStore((s) => s.byDoc[docId]?.uids);
  const currentId = useWorkspaceStore((s) => {
    const pane = selectPane(s, s.activePaneId);
    return pane && pane.docId === docId ? pane.view.pageId : null;
  });
  return useMemo(() => {
    if (!order || currentId === null) return 0;
    const uid = pageUidFromId(docId, currentId);
    const at = uid === null ? -1 : order.indexOf(uid);
    return at >= 0 ? at : 0;
  }, [order, currentId, docId]);
}

/**
 * A number field that keeps what the user types until it is valid: a value that is not (yet) a number in range is shown with
 * an error and changes nothing, so typing "1" on the way to "150" does not jump. A change from outside (an arrow button, Fit
 * to page) replaces the text.
 */
function CommitField({
  label,
  value,
  parse,
  format = (n) => String(n),
  onCommit,
  error,
  className = 'side-input',
}: {
  label: string;
  value: number;
  parse: (text: string) => number | null;
  format?: (value: number) => string;
  onCommit: (value: number) => void;
  error: string;
  className?: string;
}) {
  const [text, setText] = useState(format(value));
  const invalid = parse(text) === null;
  useEffect(() => {
    // An outside change shows at once, unless the typed text already means this value.
    setText((now) => (parse(now) === value ? now : format(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid}
        title={invalid ? error : undefined}
        className={className}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = parse(e.target.value);
          if (next !== null) onCommit(next);
        }}
        onBlur={() => {
          if (parse(text) === null) setText(format(value));
        }}
      />
    </>
  );
}

const parsePlain = (text: string): number | null => (/^-?\d+(\.\d*)?$|^-?\.\d+$/.test(text.trim()) ? Number(text) : null);
const parsePercent = (text: string): number | null => {
  const n = parsePlain(text);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};

export function CompareBody({ docId }: { docId: string }) {
  const session = useSession(docId);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const docs = useDocumentsStore((s) => s.docs);
  const edits = useEditStore((s) => s.byDoc);
  const position = useCurrentPosition(docId);
  const baseSize = useDocumentsStore((s) => s.docs[docId]?.sizes[position]);

  // Focus starts on "Choose a PDF…" (the spec's focus rule for this sheet).
  useEffect(() => {
    chooseRef.current?.focus();
  }, []);

  const partner = session ? partnerOf(session, position) : null;
  const sizeKnown = session && partner !== null ? session.sizes[partner] : undefined;
  useEffect(() => {
    if (partner !== null) void ensureOverlaySize(docId, partner);
  }, [docId, partner, session?.attach, session?.phase]);

  // The files that are open in other tabs, and whether each has unsaved changes. Recomputed when documents or edits change.
  const openFiles = useMemo(() => openFilesFor(docId), [docs, edits, docId]);
  if (!session) return null;

  const set = (patch: Partial<CompareSession>) => changeCompare(patch);
  const pagesOfOverlay = session.file?.pages ?? 0;
  const pageW = baseSize?.width ?? 612;
  const pageH = baseSize?.height ?? 792;
  const different = baseSize !== undefined && sizeKnown !== undefined && sizesDiffer(baseSize, sizeKnown);
  const unit: LengthUnit = session.unit;
  const unsaved = overlayFileUnsaved(session);

  const choose = async () => {
    setBusy(true);
    try {
      await chooseOverlayFile(docId);
    } finally {
      setBusy(false);
    }
  };
  const chooseOpen = async (value: string) => {
    const entry = openFiles.find((f) => f.docId === value);
    if (!entry) return;
    setBusy(true);
    try {
      await chooseOpenFile(docId, entry.path, entry.name);
    } finally {
      setBusy(false);
    }
  };

  const nudge = (ax: number, ay: number, shift: boolean) => {
    const step = nudgeStep(shift);
    set({ dx: clampOffset(session.dx + ax * step, pageW), dy: clampOffset(session.dy + ay * step, pageH) });
  };
  const onPadKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number] | undefined> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    nudge(move[0], move[1], event.shiftKey);
  };
  const fit = () => {
    if (!baseSize || !sizeKnown) return;
    const placement = fitToPage(baseSize, sizeKnown);
    set({ dx: placement.dx, dy: placement.dy, size: Math.round(placement.scale * 10000) / 100 });
  };

  const line = busy || session.note !== null ? (session.note ?? openingText(session.file?.name ?? '')) : session.file ? fileLine(session.file.name, session.file.pages) : COMPARE_NO_FILE;

  return (
    <>
      <div className="side-field">
        <span>Lay over this document</span>
        <div className="side-row">
          <button ref={chooseRef} type="button" className="side-button" disabled={busy} onClick={() => void choose()}>
            Choose a PDF…
          </button>
          <select
            aria-label="Open files"
            className="side-input side-unit"
            value=""
            disabled={busy || openFiles.length === 0}
            onChange={(e) => void chooseOpen(e.target.value)}
          >
            <option value="">Open files ▾</option>
            {openFiles.map((f) => (
              <option key={f.docId} value={f.docId}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <p className="side-text" aria-live="polite" data-compare-file="true">
          {line}
        </p>
        {unsaved && session.file && <p className="side-text" data-compare-unsaved="true">{unsavedText(session.file.name)}</p>}
      </div>

      <label className="side-check">
        <input type="checkbox" checked={session.show} onChange={() => toggleShow(docId)} aria-label="Show overlay" />
        <span>Show overlay (F8)</span>
      </label>

      <div className="side-field">
        <span>Look</span>
        <Segmented<CompareLook>
          label="Look"
          value={session.look}
          options={[
            { value: 'both', label: 'Both' },
            { value: 'seethrough', label: 'See-through' },
            { value: 'differences', label: 'Differences' },
          ]}
          onChange={(look) => set({ look })}
        />
        {session.look === 'differences' && (
          <p className="side-text" data-compare-legend="true">
            {COMPARE_DIFFERENCES_LEGEND}
          </p>
        )}
      </div>

      {session.look === 'seethrough' && (
        <div className="side-field">
          <span>Opacity</span>
          <div className="side-row">
            <input
              type="range"
              aria-label="Opacity of the overlay, percent"
              className="cut-slider"
              min={0}
              max={100}
              step={1}
              value={session.opacity}
              onChange={(e) => set({ opacity: e.target.valueAsNumber })}
            />
            <CommitField label="Opacity in percent" className="side-input cut-percent" value={session.opacity} parse={parsePercent} onCommit={(opacity) => set({ opacity })} error="Enter a number from 0 to 100." />
            <span className="side-text">%</span>
          </div>
        </div>
      )}

      <div className="side-field" role="radiogroup" aria-label="Match pages">
        <span>Match pages</span>
        <label className="side-check">
          <input type="radio" name="compare-match" checked={session.match === 'sequential'} onChange={() => set({ match: 'sequential' })} aria-label="Page by page" />
          <span>Page by page, overlay starts at page</span>
          <CommitField
            label="Overlay start page"
            className="side-input side-page-field"
            value={session.startPage}
            parse={(t) => {
              const n = parsePlain(t);
              return n !== null && Number.isInteger(n) && n >= 1 && n <= Math.max(1, pagesOfOverlay) ? n : null;
            }}
            onCommit={(startPage) => set({ startPage: clampPage(startPage, pagesOfOverlay), match: 'sequential' })}
            error={`Enter a page from 1 to ${pagesOfOverlay}.`}
          />
        </label>
        <label className="side-check">
          <input type="radio" name="compare-match" checked={session.match === 'fixed'} onChange={() => set({ match: 'fixed' })} aria-label="Same overlay page on every page" />
          <span>Same overlay page on every page:</span>
          <CommitField
            label="Overlay page on every page"
            className="side-input side-page-field"
            value={session.fixedPage}
            parse={(t) => {
              const n = parsePlain(t);
              return n !== null && Number.isInteger(n) && n >= 1 && n <= Math.max(1, pagesOfOverlay) ? n : null;
            }}
            onCommit={(fixedPage) => set({ fixedPage: clampPage(fixedPage, pagesOfOverlay), match: 'fixed' })}
            error={`Enter a page from 1 to ${pagesOfOverlay}.`}
          />
        </label>
      </div>

      <div className="side-field">
        <span>Line up</span>
        <div className="compare-lineup">
          <div className="compare-pad" role="group" aria-label="Line up" onKeyDown={onPadKey}>
            <button type="button" className="side-button compare-pad-up" aria-label="Move the overlay up" onClick={(e) => nudge(0, -1, e.shiftKey)}>
              ↑
            </button>
            <button type="button" className="side-button compare-pad-left" aria-label="Move the overlay left" onClick={(e) => nudge(-1, 0, e.shiftKey)}>
              ←
            </button>
            <button type="button" className="side-button compare-pad-reset" onClick={() => set({ dx: 0, dy: 0, size: 100 })}>
              Reset
            </button>
            <button type="button" className="side-button compare-pad-right" aria-label="Move the overlay right" onClick={(e) => nudge(1, 0, e.shiftKey)}>
              →
            </button>
            <button type="button" className="side-button compare-pad-down" aria-label="Move the overlay down" onClick={(e) => nudge(0, 1, e.shiftKey)}>
              ↓
            </button>
          </div>
          <div className="compare-numbers">
            <label className="side-row">
              <span className="side-text compare-label">Across</span>
              <CommitField
                label="Across"
                value={fromPoints(session.dx, unit)}
                parse={parsePlain}
                onCommit={(v) => set({ dx: clampOffset(toPoints(v, unit), pageW) })}
                error="Enter a number."
              />
            </label>
            <label className="side-row">
              <span className="side-text compare-label">Down</span>
              <CommitField
                label="Down"
                value={fromPoints(session.dy, unit)}
                parse={parsePlain}
                onCommit={(v) => set({ dy: clampOffset(toPoints(v, unit), pageH) })}
                error="Enter a number."
              />
            </label>
            <UnitSelect value={unit} onChange={(next) => set({ unit: next })} />
            <label className="side-row">
              <span className="side-text compare-label">Size</span>
              <CommitField
                label="Size in percent"
                value={session.size}
                parse={parseSizePercent}
                onCommit={(size) => set({ size })}
                error={`Enter a size from ${OVERLAY_SCALE_MIN * 100} to ${OVERLAY_SCALE_MAX * 100}.`}
              />
              <span className="side-text">%</span>
            </label>
            <button type="button" className="side-button" disabled={!baseSize || !sizeKnown} onClick={fit}>
              Fit to page
            </button>
          </div>
        </div>
        {different && (
          <p className="side-text" data-compare-size="true">
            {COMPARE_DIFFERENT_SIZE}
          </p>
        )}
      </div>

      <p className="side-text side-summary" aria-live="polite" data-compare-page="true">
        {session.file ? thisPageLine(partner) : ''}
      </p>

      <AddToField docId={docId} session={session} />
    </>
  );
}

/** "Add to": the pages the overlay goes on, with how many of them have an overlay page right now. */
function AddToField({ docId, session }: { docId: string; session: CompareSession }) {
  const targets = useCompareTargets(docId, session);
  return (
    <label className="side-field">
      <span>Add to</span>
      <select aria-label="Add to" className="side-input" value={session.addTo} onChange={(e) => changeCompare({ addTo: e.target.value as CompareAddTo })}>
        <option value="current">Current page</option>
        <option value="selected">Selected pages</option>
        <option value="all">All matched pages</option>
      </select>
      <span className="side-text" aria-live="polite" data-compare-count="true">
        {session.file ? `${targets.pairs.length} ${targets.pairs.length === 1 ? 'page' : 'pages'} would get an overlay page.` : ''}
      </span>
    </label>
  );
}

/** The pages "Add to" names, read from the live page list, selection and current page (see compareTargets). */
type ScopeSession = Pick<CompareSession, 'addTo' | 'match' | 'startPage' | 'fixedPage' | 'file'>;

const NO_SESSION: ScopeSession = { addTo: 'current', match: 'sequential', startPage: 1, fixedPage: 1, file: null };

export function useCompareTargets(docId: string, session: ScopeSession) {
  const order = useEditStore((s) => s.byDoc[docId]?.uids);
  const selectedIds = useSelectionStore((s) => s.pageIds);
  const currentId = useWorkspaceStore((s) => {
    const pane = selectPane(s, s.activePaneId);
    return pane && pane.docId === docId ? pane.view.pageId : null;
  });
  return useMemo(() => {
    const uids = order ?? [];
    const chosen = new Set(selectedIds);
    const selected = uids.filter((uid) => chosen.has(pageIdFromUid(docId, uid)));
    const current = currentId === null ? null : pageUidFromId(docId, currentId);
    return compareTargets({ order: uids, selected, current }, session.addTo, session);
  }, [order, selectedIds, currentId, docId, session.addTo, session.match, session.startPage, session.fixedPage, session.file]);
}

/** Leave compare and Add overlay to pages, with the notes under the button. */
export function CompareFooter({ docId, busy, run }: { docId: string; busy: boolean; run: () => void }) {
  const session = useSession(docId);
  const targets = useCompareTargets(docId, session ?? NO_SESSION);
  if (!session) return null;
  const problem = addProblem(session, targets);
  return (
    <div className="side-sheet-foot compare-foot">
      <div className="compare-foot-buttons">
        <button type="button" className="side-button" onClick={() => leaveCompare(docId)}>
          Leave compare
        </button>
        <button type="button" className="side-button side-primary" disabled={busy || problem !== null} title={problem ?? undefined} onClick={run}>
          Add overlay to pages
        </button>
      </div>
      {session.look === 'differences' && problem !== null && (
        <p className="side-text" data-compare-viewonly="true">
          {problem}
        </p>
      )}
      <p className="side-text">{COMPARE_NOT_COPIED}</p>
    </div>
  );
}
