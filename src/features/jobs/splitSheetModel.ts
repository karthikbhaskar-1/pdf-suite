/**
 * What the Split sheet shows and sends, worked out from its settings. Pure: the sheet draws it, the run sends `spec`.
 * Nothing here reads a document or a store.
 */
import type { SplitSpec } from '../../engine/mupdf/jobProtocol';
import { type BlankMeasure, type BlankSensitivity } from '../../engine/mupdf/blankDetect';
import { exampleLine, validateBaseName } from './nameRules';
import {
  NO_BLANKS_MESSAGE,
  NO_BOOKMARKS_MESSAGE,
  parsePagesPerFile,
  parseSizeLimit,
  planByBlank,
  planByBookmarks,
  planByCount,
  sizeExample,
  sizeNameWidth,
  type PlannedPart,
  type SizeUnit,
} from './splitPlan';
import { formatLimit } from './jobMessages';

export type SplitMethod = 'count' | 'size' | 'blank' | 'bookmarks';
export type BlankKeep = 'drop' | 'keepWithPrevious';

export interface SplitSettings {
  method: SplitMethod;
  pages: number;
  /** Bytes of the saved file. */
  byteLength: number;
  perFileText: string;
  sizeText: string;
  sizeUnit: SizeUnit;
  sensitivity: BlankSensitivity;
  /** Ink share and largest mark of every page once the blank-page search has finished; null before. */
  measures: readonly BlankMeasure[] | null;
  /** 0-based pages the user took off the blank list. */
  unticked: readonly number[];
  blankKeep: BlankKeep;
  /** Top-level bookmarks (1-based pages) once read; null before. */
  entries: ReadonlyArray<{ title: string; page: number }> | null;
  baseName: string;
  /** A folder has been chosen. */
  hasFolder: boolean;
  encrypted: boolean;
  keepPassword: boolean;
}

export interface SheetModel {
  /** The message under the method's box, or null. */
  error: string | null;
  /** A line under the controls ("Each file will be 10 MB or smaller..."), or null. */
  note: string | null;
  /** "Example: Report - part 01.pdf … Report - part 12.pdf" without the label. */
  example: string;
  /** "Makes 12 files." or the size sentence. */
  summary: string;
  /** The names of the files, for count, blank and bookmark splits. */
  parts: PlannedPart[] | null;
  /** The pages found blank (0-based), for the list. */
  blanks: number[];
  /** Of those, the pages that are blank only at "Blank and nearly blank pages": they have marks. */
  marked: number[];
  /** What Split sends, or null while the settings are not valid. */
  spec: SplitSpec | null;
  /** Split is on: valid settings and a folder. */
  canSplit: boolean;
}

const empty: SheetModel = { error: null, note: null, example: '', summary: '', parts: null, blanks: [], marked: [], spec: null, canSplit: false };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function deriveSheet(s: SplitSettings): SheetModel {
  const nameError = validateBaseName(s.baseName);
  const base = s.baseName.trim();
  const baseForExample = nameError ? 'Name' : base;
  const finish = (model: SheetModel): SheetModel => ({ ...model, canSplit: model.spec !== null && nameError === null && s.hasFolder });
  const password = s.encrypted ? { keep: s.keepPassword } : { keep: false };
  const spec = (plan: SplitSpec['plan'], extra: Partial<SplitSpec> = {}): SplitSpec => ({
    kind: 'split',
    baseName: base,
    plan,
    ...(s.encrypted && !password.keep ? { dropEncryption: true } : {}),
    ...extra,
  });
  const withParts = (parts: PlannedPart[], summary = `Makes ${plural(parts.length, 'file', 'files')}.`): SheetModel => ({
    ...empty,
    parts,
    example: exampleLine(parts.map((p) => p.leafName)),
    summary,
    spec: spec({ by: 'ranges', parts: parts.map((p) => ({ from: p.from, to: p.to, leafName: p.leafName })) }),
  });

  switch (s.method) {
    case 'count': {
      const parsed = parsePagesPerFile(s.perFileText, s.pages);
      if (!parsed.ok) return finish({ ...empty, error: parsed.message, example: exampleLine([`${baseForExample} - part 01.pdf`]) });
      return finish(withParts(planByCount(s.pages, parsed.value, baseForExample)));
    }
    case 'size': {
      const parsed = parseSizeLimit(s.sizeText, s.sizeUnit, s.byteLength);
      if (!parsed.ok) return finish({ ...empty, error: parsed.message, example: sizeExample(baseForExample, 2) });
      const width = sizeNameWidth(s.pages, s.byteLength, parsed.value);
      return finish({
        ...empty,
        example: sizeExample(baseForExample, width),
        summary: `Each file will be ${formatLimit(parsed.value)} or smaller. The number of files depends on the pages.`,
        spec: spec({ by: 'size', maxBytes: parsed.value }, { nameWidth: width }),
      });
    }
    case 'blank': {
      if (s.measures === null) return finish({ ...empty, example: exampleLine([`${baseForExample} - part 01.pdf`]) });
      const { blanks, marked, parts } = planByBlank(s.measures, s.sensitivity, new Set(s.unticked), s.blankKeep, baseForExample);
      const separators = blanks.filter((b) => !s.unticked.includes(b));
      if (blanks.length === 0) return finish({ ...empty, error: NO_BLANKS_MESSAGE, blanks, marked });
      if (separators.length === 0 || parts.length === 0) return finish({ ...empty, blanks, marked, summary: 'Makes 0 files.' });
      // The safety net: the summary says how many pages will not be in any file.
      const left = s.blankKeep === 'drop' ? separators.length : 0;
      const makes = `Makes ${plural(parts.length, 'file', 'files')}.`;
      return finish({ ...withParts(parts, left > 0 ? `${makes} ${plural(left, 'page', 'pages')} will be left out.` : makes), blanks, marked });
    }
    case 'bookmarks': {
      if (s.entries === null) return finish({ ...empty, example: exampleLine([`${baseForExample} - 01 Start.pdf`]) });
      const planned = planByBookmarks(s.entries, s.pages, baseForExample);
      if (!planned.ok) return finish({ ...empty, error: planned.message || NO_BOOKMARKS_MESSAGE });
      return finish(withParts(planned.value));
    }
  }
}
