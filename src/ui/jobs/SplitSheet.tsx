import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useSheetStore } from '../../core/stores/sheetStore';
import { useSplitStore, type SplitSheet as SplitSheetState } from '../../core/stores/splitStore';
import { useWorkspaceStore } from '../../core/stores/workspaceStore';
import { selectPane } from '../../core/stores/workspaceStore';
import { useJobStore } from '../../core/stores/jobStore';
import {
  SPLIT_ATTACHMENTS_NOTICE,
  SPLIT_CHECKING_MESSAGE,
  SPLIT_FORMS_NOTICE,
  SPLIT_LAYERS_NOTICE,
  SPLIT_REFUSALS,
  SPLIT_SAME_NAME_NOTE,
  SPLIT_UNSAVED_MESSAGE,
  BLANK_CHOICES,
  foundBlanksText,
  hasMarksLabel,
  formatSize,
  lookingText,
} from '../../features/jobs/jobMessages';
import { MAX_BASE_NAME_LENGTH, validateBaseName } from '../../features/jobs/nameRules';
import { deriveSheet, type SplitMethod } from '../../features/jobs/splitSheetModel';
import { chooseFolder, chooseMethod, closeSplitSheet, saveAndContinue, settingsOf, startSplit, stopBlankSearch } from '../../features/jobs/splitFlow';
import type { BlankSensitivity } from '../../engine/mupdf/blankDetect';
import { requestViewer } from '../viewer/viewerBus';
import { useUiStore } from '../../core/stores/uiStore';

/**
 * The Split into Files side sheet (UI spec section 2): 320 px on the open document, working from its saved file. It shows only
 * what the stage allows: checking, "Save your changes first?", why this document cannot be split, or the controls.
 */

const METHODS: Array<{ value: SplitMethod; label: string }> = [
  { value: 'count', label: 'Page count' },
  { value: 'size', label: 'File size' },
  { value: 'blank', label: 'Blank pages' },
  { value: 'bookmarks', label: 'Bookmarks' },
];

const SENSITIVITY = (Object.keys(BLANK_CHOICES) as BlankSensitivity[]).map((value) => ({ value, label: BLANK_CHOICES[value].label }));

export function SplitSheet() {
  const sheet = useSplitStore((s) => s.sheet);
  const activeDocId = useWorkspaceStore((s) => selectPane(s, s.activePaneId)?.docId);
  const otherSheet = useSheetStore((s) => s.sheet !== null);
  const menuOpen = useUiStore((s) => s.closePrompt || s.jobQuitPrompt || s.passwordTabId !== null || s.sourcePassword !== null);
  const running = useJobStore((s) => s.job !== null);

  // The sheet acts on one document: showing another one, or opening another sheet, closes it (not while its job runs).
  useEffect(() => {
    if (!sheet || running) return;
    if (activeDocId !== sheet.docId || otherSheet) closeSplitSheet();
  }, [sheet, activeDocId, otherSheet, running]);

  useEffect(() => {
    if (!sheet || sheet.hidden) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || menuOpen) return;
      event.preventDefault();
      closeSplitSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, menuOpen]);

  if (!sheet || sheet.hidden) return null;
  return (
    <aside className="side-sheet" role="dialog" aria-label="Split into files" data-sheet="split" data-stage={sheet.stage}>
      <header className="side-sheet-head">
        <h2>Split into files</h2>
        <button type="button" className="side-sheet-close" aria-label="Close sheet" onClick={() => closeSplitSheet()}>
          ×
        </button>
      </header>
      <div className="side-sheet-body">
        <Body sheet={sheet} />
      </div>
      <Footer sheet={sheet} />
    </aside>
  );
}

function Body({ sheet }: { sheet: SplitSheetState }) {
  if (sheet.stage === 'unsaved') {
    return (
      <p className="side-text" data-split-message="unsaved">
        {SPLIT_UNSAVED_MESSAGE}
      </p>
    );
  }
  if (sheet.stage === 'checking') {
    return (
      <p className="side-text" role="status" data-split-message="checking">
        {SPLIT_CHECKING_MESSAGE}
      </p>
    );
  }
  if (sheet.stage === 'refused') {
    return (
      <p className="side-text side-error" role="alert" data-split-message="refused">
        {SPLIT_REFUSALS[sheet.refusal ?? 'Unreadable']}
      </p>
    );
  }
  return <Controls sheet={sheet} />;
}

function Footer({ sheet }: { sheet: SplitSheetState }) {
  const model = useMemo(() => (sheet.stage === 'ready' ? deriveSheet(settingsOf(sheet)) : null), [sheet]);
  if (sheet.stage === 'unsaved') {
    return (
      <div className="side-sheet-foot">
        <button type="button" className="side-button side-primary" autoFocus onClick={() => void saveAndContinue()}>
          Save and continue
        </button>
        <button type="button" className="side-button" onClick={() => closeSplitSheet()}>
          Cancel
        </button>
      </div>
    );
  }
  if (sheet.stage === 'refused') {
    return (
      <div className="side-sheet-foot">
        <button type="button" className="side-button" autoFocus onClick={() => closeSplitSheet()}>
          Close
        </button>
      </div>
    );
  }
  if (sheet.stage === 'checking') {
    return (
      <div className="side-sheet-foot">
        <button type="button" className="side-button" onClick={() => closeSplitSheet()}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="side-sheet-foot side-sheet-foot-split">
      <p className="side-text side-summary" aria-live="polite" data-split-summary="true">
        {model?.summary ?? ''}
      </p>
      <button type="button" className="side-button" onClick={() => closeSplitSheet()}>
        Cancel
      </button>
      <button type="button" className="side-button side-primary" disabled={!model?.canSplit} onClick={() => void startSplit()}>
        Split
      </button>
    </div>
  );
}

function Controls({ sheet }: { sheet: SplitSheetState }) {
  const update = useSplitStore((s) => s.update);
  const model = useMemo(() => deriveSheet(settingsOf(sheet)), [sheet]);
  const radios = useRef<HTMLDivElement>(null);
  const nameError = validateBaseName(sheet.baseName);
  const facts = sheet.facts;

  // Focus starts on the chosen "Split by" radio.
  useEffect(() => {
    radios.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);

  const onRadioKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const at = METHODS.findIndex((m) => m.value === sheet.method);
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    const next = METHODS[(at + step + METHODS.length) % METHODS.length]!;
    void chooseMethod(next.value);
    requestAnimationFrame(() => radios.current?.querySelector<HTMLInputElement>(`input[value="${next.value}"]`)?.focus());
  };

  const showPage = (page0: number) => {
    const pane = useWorkspaceStore.getState().tabs.flatMap((t) => t.panes).find((p) => p.docId === sheet.docId);
    if (pane) requestViewer(pane.id, { kind: 'goto', index: page0 });
  };

  return (
    <>
      <p className="side-text" data-split-source="true">
        {sheet.name} · {sheet.pages} {sheet.pages === 1 ? 'page' : 'pages'} · {formatSize(sheet.byteLength)}
      </p>

      <div className="side-field" role="radiogroup" aria-label="Split by" ref={radios} onKeyDown={onRadioKey}>
        <span>Split by</span>
        {METHODS.map((m) => (
          <label key={m.value} className="split-radio">
            <input type="radio" name="split-by" value={m.value} checked={sheet.method === m.value} onChange={() => void chooseMethod(m.value)} />
            {m.label}
            {m.value === 'bookmarks' && sheet.method === 'bookmarks' && sheet.entries !== null && sheet.entries.length > 0 ? (
              <span className="side-text"> {sheet.entries.length} top-level {sheet.entries.length === 1 ? 'bookmark' : 'bookmarks'}</span>
            ) : null}
          </label>
        ))}
      </div>

      {sheet.method === 'count' && (
        <label className="side-field">
          <span>Pages in each file</span>
          <input
            className="side-input"
            inputMode="numeric"
            aria-label="Pages in each file"
            aria-invalid={model.error !== null}
            value={sheet.perFileText}
            onChange={(e) => update({ perFileText: e.target.value })}
          />
        </label>
      )}

      {sheet.method === 'size' && (
        <div className="side-field">
          <span>Largest file</span>
          <div className="side-row">
            <input
              className="side-input"
              inputMode="decimal"
              aria-label="Largest file"
              aria-invalid={model.error !== null}
              value={sheet.sizeText}
              onChange={(e) => update({ sizeText: e.target.value })}
            />
            <select className="side-input side-unit" aria-label="Size unit" value={sheet.sizeUnit} onChange={(e) => update({ sizeUnit: e.target.value as 'MB' | 'KB' })}>
              <option value="MB">MB</option>
              <option value="KB">KB</option>
            </select>
          </div>
        </div>
      )}

      {sheet.method === 'blank' && (
        <div className="side-field" data-split-blank="true">
          <label className="side-field">
            <span>What counts as blank</span>
            <select
              className="side-input"
              aria-label="What counts as blank"
              value={sheet.sensitivity}
              onChange={(e) => {
                const sensitivity = e.target.value as BlankSensitivity;
                // Pages that hold something are not thrown away by choosing the wider option: they stay at the end of the file before.
                update({ sensitivity, unticked: [], ...(sensitivity === 'loose' ? { blankKeep: 'keepWithPrevious' as const } : {}) });
              }}
            >
              {SENSITIVITY.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <p className="side-text" data-split-blank-help="true">
            {BLANK_CHOICES[sheet.sensitivity].help}
          </p>
          {sheet.looking && (
            <div className="side-row" role="status">
              <span className="side-text">{lookingText(sheet.looking.done, sheet.looking.total)}</span>
              <button type="button" className="side-button" onClick={() => stopBlankSearch()}>
                Stop
              </button>
            </div>
          )}
          {!sheet.looking && sheet.measures !== null && model.blanks.length > 0 && (
            <>
              <p className="side-text" aria-live="polite">
                {foundBlanksText(model.blanks.length, sheet.sensitivity === 'loose')}
              </p>
              <div className="split-blank-list" role="group" aria-label="Blank pages">
                {model.blanks.map((page0) => (
                  <label key={page0} className="split-blank-item">
                    <input
                      type="checkbox"
                      aria-label={`Page ${page0 + 1}, starts a new file`}
                      checked={!sheet.unticked.includes(page0)}
                      onChange={(e) => update({ unticked: e.target.checked ? sheet.unticked.filter((p) => p !== page0) : [...sheet.unticked, page0] })}
                    />
                    <button type="button" className="split-link" onClick={() => showPage(page0)}>
                      {model.marked.includes(page0) ? hasMarksLabel(page0 + 1) : `Page ${page0 + 1}`}
                    </button>
                  </label>
                ))}
              </div>
              <div className="side-field" role="radiogroup" aria-label="Blank pages">
                <label className="split-radio">
                  <input type="radio" name="blank-keep" checked={sheet.blankKeep === 'drop'} onChange={() => update({ blankKeep: 'drop' })} />
                  Leave out
                </label>
                <label className="split-radio">
                  <input type="radio" name="blank-keep" checked={sheet.blankKeep === 'keepWithPrevious'} onChange={() => update({ blankKeep: 'keepWithPrevious' })} />
                  Keep at the end of the file before
                </label>
              </div>
            </>
          )}
        </div>
      )}

      {model.error && (
        <p className="side-text side-error" role="alert" data-split-error="true">
          {model.error}
        </p>
      )}
      {model.note && <p className="side-text">{model.note}</p>}

      <div className="side-field">
        <span>Save in</span>
        {sheet.folder ? (
          <p className="side-text split-folder" title={sheet.folder.label} data-split-folder="true">
            {middleTruncate(sheet.folder.label, 38)}
          </p>
        ) : (
          <p className="side-text" data-split-folder="none">
            No folder chosen yet
          </p>
        )}
        <button type="button" className="side-button" onClick={() => void chooseFolder()}>
          Choose folder…
        </button>
      </div>

      <label className="side-field">
        <span>File name</span>
        <input
          className="side-input"
          aria-label="File name"
          aria-invalid={nameError !== null}
          maxLength={MAX_BASE_NAME_LENGTH}
          value={sheet.baseName}
          onChange={(e) => update({ baseName: e.target.value })}
        />
        {nameError && (
          <p className="side-text side-error" role="alert">
            {nameError}
          </p>
        )}
      </label>
      <p className="side-text" aria-live="polite" data-split-example="true">
        Example: {model.example}
      </p>
      <p className="side-text">{SPLIT_SAME_NAME_NOTE}</p>

      {facts?.encrypted && (
        <div className="side-field">
          <label className="split-radio">
            <input type="checkbox" checked={sheet.keepPassword} onChange={(e) => update({ keepPassword: e.target.checked, passwordNote: null })} />
            Keep the password on the new files
          </label>
          {sheet.passwordNote && (
            <p className="side-text side-error" role="alert" data-split-password-note="true">
              {sheet.passwordNote}
            </p>
          )}
        </div>
      )}

      {facts && facts.fields > 0 && (
        <p className="side-text" role="status">
          {SPLIT_FORMS_NOTICE}
        </p>
      )}
      {facts?.layers && (
        <p className="side-text" role="status">
          {SPLIT_LAYERS_NOTICE}
        </p>
      )}
      {facts && facts.attachments > 0 && (
        <p className="side-text" role="status">
          {SPLIT_ATTACHMENTS_NOTICE}
        </p>
      )}
    </>
  );
}

/** A long path shortened in the middle ("D:\Example\…\Reports"). The full path is the tooltip. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
