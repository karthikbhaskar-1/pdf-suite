/**
 * Every word a job shows, in one pure file that is tested against the UI spec (docs/milestone-1.3/1.3-ui-spec.md, sections 0
 * and 2). The worker's `detail` is never shown. "«name»" is a file name.
 */
import type { JobErrorKind, JobPhase } from '../../engine/mupdf/jobProtocol';
import type { JobFailReason } from '../../platform/desktop/contract';
import { COMBINE_TOO_LARGE, EDIT_LIMIT_TEXT } from '../../core/fileLimits';

export type JobKind = 'split' | 'combine';

export const JOB_BUSY_REASON = 'PDF Suite is still working on your files. Wait for it to finish, or cancel it.';
export const QUIT_PROMPT_TEXT = 'PDF Suite is still working on your files. Stop and exit?';
export const STOPPED_RESPONDING_MESSAGE = 'PDF Suite stopped responding while working on your files, so it stopped. Your files were not changed.';
export const CANCELLED_MESSAGE = 'Cancelled. No files were created and your original files were not changed.';
export const OUT_OF_MEMORY_MESSAGE = 'PDF Suite did not have enough memory for these files, so nothing was created. Your files were not changed. Try again with fewer or smaller files.';
/** The same failure in Split, which has one file and no "fewer or smaller files" to try. */
export const SPLIT_OUT_OF_MEMORY_MESSAGE = 'PDF Suite did not have enough memory to split this document, so nothing was created. Your file was not changed. Close other tabs and try again.';
export const INTERNAL_MESSAGE = 'Something went wrong, so nothing was created. Your files were not changed. If it happens again, Help ▸ Open Logs Folder has the details.';

const VERB: Record<JobKind, string> = { split: 'Splitting into files', combine: 'Combining files' };

export interface StatusText {
  /** The text of the status bar and the progress bar's aria-valuetext. Null for `looking`: that phase shows in the sheet. */
  text: string | null;
  /** 'fill' follows done and total; 'stripe' is the moving stripe with no percentage. */
  bar: 'fill' | 'stripe';
  /** 0-100 for a filled bar. */
  percent: number;
}

/** The status bar text for a progress message (UI spec section 0, "Jobs"). */
export function statusText(
  kind: JobKind,
  progress: { phase: JobPhase; done: number; total: number; unit: 'files' | 'pages' },
  cancelling: boolean,
): StatusText {
  if (cancelling) return { text: 'Cancelling…', bar: 'stripe', percent: 0 };
  const verb = VERB[kind];
  const { phase, done, total, unit } = progress;
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
  const one = total === 1;
  const noun = unit === 'pages' ? (one ? 'page' : 'pages') : one ? 'file' : 'files';
  switch (phase) {
    case 'looking':
      return { text: null, bar: 'fill', percent };
    case 'reading':
    case 'copying':
      return { text: `${verb} · ${done} of ${total} ${noun}`, bar: 'fill', percent };
    case 'saving':
    case 'writing':
      if (unit === 'files') {
        // The file being saved is the one after the files already done.
        const n = Math.min(total, done + 1);
        return { text: kind === 'split' ? `${verb} · saving file ${n} of ${total}` : `${verb} · saving…`, bar: 'fill', percent: Math.round((n / Math.max(1, total)) * 100) };
      }
      return { text: `${verb} · saving…`, bar: 'stripe', percent: 0 };
    case 'checking':
      return { text: `${verb} · checking the new ${kind === 'split' ? 'files' : 'file'}…`, bar: 'stripe', percent: 0 };
  }
}

/** "10 MB" or "512 KB" for a size limit in bytes. */
export function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (bytes >= 1024 * 1024) return `${Number.isInteger(mb) ? mb : Math.round(mb * 10) / 10} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** A size for the sheet's header line, "48.2 MB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** The result notice of a finished split. `oversize` has one entry per single page that is over the size limit. */
export function splitDoneMessage(name: string, files: number, oversize: ReadonlyArray<{ page: number; limitBytes: number; leafName: string }> = []): string {
  const base = `Split ${name} into ${files} ${files === 1 ? 'file' : 'files'}.`;
  const extra = oversize.map((o) => ` Page ${o.page} is larger than ${formatLimit(o.limitBytes)} by itself, so “${o.leafName}” is over the limit.`);
  return base + extra.join('');
}

/** The result notice of a failed job (UI spec section 0). `name` is the file the kind is about, when it has one. */
export function jobErrorMessage(kind: JobErrorKind, name = 'The file', job: JobKind = 'combine'): string {
  switch (kind) {
    case 'Cancelled':
      return CANCELLED_MESSAGE;
    case 'InputUnreadable':
      return `${name} could not be read, so nothing was created. Your files were not changed.`;
    case 'InputChanged':
      return `${name} was changed while PDF Suite was working, so nothing was created. Try again.`;
    case 'CheckFailed':
      return 'The new file did not pass its check, so nothing was saved. Your files were not changed.';
    case 'Damaged':
      return `${name} is damaged or is not a PDF, so nothing was created.`;
    case 'Xfa':
      return `${name} is a kind of form that can't be split yet, so nothing was created.`;
    case 'FormValuesLost':
      return `${name} can't be used, because what is filled in on its form could not be kept, so nothing was created.`;
    case 'TotalTooLarge':
      return COMBINE_TOO_LARGE;
    case 'PasswordNeeded':
    case 'WrongPassword':
      return `${name} needs its password, so nothing was created.`;
    case 'CannotKeepPassword':
      return CANNOT_KEEP_PASSWORD_MESSAGE;
    case 'NoBookmarks':
      return 'This document has no bookmarks to split by.';
    case 'OutOfMemory':
      return job === 'split' ? SPLIT_OUT_OF_MEMORY_MESSAGE : OUT_OF_MEMORY_MESSAGE;
    case 'ImageTooLarge':
    case 'TextTooLarge':
    case 'Internal':
      return INTERNAL_MESSAGE;
  }
}

/** The result notice for a failure in the main process (UI spec section 0). `drive` is the letter of a full disk. */
export function mainFailureMessage(reason: JobFailReason, drive?: string): string {
  switch (reason) {
    case 'disk-full':
      return `There is not enough space on drive ${drive ?? 'X'}:. Nothing was written.`;
    case 'folder-not-writable':
      return "PDF Suite can't write to that folder. Choose another folder.";
    case 'write-failed':
      return 'The new file could not be written, so nothing was created. Your files were not changed.';
    case 'target-is-input':
      return 'Choose a different name: that file is one of the files being combined.';
    case 'target-open':
      return 'Choose a different name: that file is open in PDF Suite.';
    case 'invalid':
      return INTERNAL_MESSAGE;
  }
}

/** Under the "Keep the password" box, when the protection cannot be kept (UI spec section 2). */
export const CANNOT_KEEP_PASSWORD_MESSAGE =
  "This document's password protection can't be kept in the new files. To split it anyway, untick “Keep the password on the new files”. The new files will then open without a password.";

/** What the Split sheet shows instead of its controls when the saved file cannot be split (UI spec section 2, opening check). */
export const SPLIT_REFUSALS = {
  FormValuesLost: "This document can't be split yet, because what is filled in on its form could not be kept in the new files. The document is not changed.",
  PasswordNeeded: 'This document was not split, because it needs its password.',
  TotalTooLarge: `This document is too large to split (the limit is ${EDIT_LIMIT_TEXT}).`,
  Damaged: "The saved file is damaged, so it can't be split. Try File ▸ Save As first, then split the new copy.",
  Xfa: "This document is a kind of form that can't be split yet. The document is not changed.",
  Unreadable: "The saved file could not be read, so it can't be split. The document is not changed.",
} as const;
export type SplitRefusalKind = keyof typeof SPLIT_REFUSALS;

export const SPLIT_UNSAVED_MESSAGE = 'Save your changes first? Split works from the saved file.';
export const SPLIT_CHECKING_MESSAGE = 'Checking this document…';

export const SPLIT_FORMS_NOTICE =
  'This document has a fillable form. In the new files, what is filled in stays visible but the boxes can no longer be typed in. This document is not changed.';
export const SPLIT_LAYERS_NOTICE =
  'This document has layers that can be shown and hidden. In the new files they become part of the page, and hidden ones become visible.';
export const SPLIT_ATTACHMENTS_NOTICE = 'Files attached inside this document are not copied to the new files.';
export const SPLIT_SAME_NAME_NOTE = 'If a file with that name is already there, the new one gets “(2)”. Nothing is replaced.';

/** "Looking for blank pages… 40 of 120" and the lines around it. */
export const lookingText = (done: number, total: number) => `Looking for blank pages… ${done} of ${total}`;
export const foundBlanksText = (n: number, nearly = false) =>
  nearly
    ? `Found ${n} blank or nearly blank ${n === 1 ? 'page' : 'pages'}. Pages marked “has marks” are not empty. Untick any that should not start a new file.`
    : `Found ${n} blank ${n === 1 ? 'page' : 'pages'}. Untick any that should not start a new file.`;
/** The two choices of "What counts as blank", with the help line of each (docs/milestone-1.5/blank-calibration.md). */
export const BLANK_CHOICES = {
  normal: { label: 'Blank pages', help: 'Empty pages, and scanned pages with only dust, punch holes or edge shadows.' },
  loose: {
    label: 'Blank and nearly blank pages',
    help: 'Also pages with very little on them, such as a page number, a short line or a streak. These pages may hold something you need: check the list.',
  },
} as const;
/** The list item of a page that is blank only at the wider choice. */
export const hasMarksLabel = (page: number) => `Page ${page} · has marks`;

// ---- Combine (UI spec section 1) ------------------------------------------------------------------------------------------------

export const COMBINE_EMPTY_MESSAGE = 'Add the files you want to combine. Drop them here, or choose Add files…';
export const COMBINE_READING_TEXT = 'Reading…';
export const COMBINE_TOO_MANY_MESSAGE = 'You can combine up to 500 files at once. The extra files were not added.';
export const COMBINE_TOTAL_TOO_LARGE_MESSAGE = COMBINE_TOO_LARGE;
export const COMBINE_TARGET_IS_INPUT_MESSAGE = 'Choose a different name: that file is one of the files being combined.';
export const COMBINE_TARGET_OPEN_MESSAGE = 'Choose a different name: that file is open in PDF Suite.';

export const combineOfficeMessage = (name: string) =>
  `${name} was not added. Word, Excel and PowerPoint files can't be combined yet. For now, save it as a PDF first, then add the PDF.`;
export const combineOtherTypeMessage = (name: string) =>
  `${name} was not added. PDF Suite can combine PDFs, pictures (JPEG, PNG, TIFF, GIF, BMP, WebP) and text files.`;
export const combineDamagedMessage = (name: string) => `${name} is damaged or is not a PDF, so it was not added.`;
export const combineXfaMessage = (name: string) => `${name} was not added. It is a kind of form that can't be combined yet.`;
export const combineFormValuesMessage = (name: string) => `${name} was not added, because what is filled in on its form could not be kept.`;
export const combinePictureTooLargeMessage = (name: string, multiPage: boolean) =>
  multiPage
    ? `${name} was not added, because one of its pages is too large (the limit is 50 megapixels a page).`
    : `${name} is too large a picture to add (the limit is 50 megapixels).`;
export const combineTextTooLargeMessage = (name: string) => `${name} is too large to add (text files can be up to 32 MB).`;
export const combinePasswordCancelledMessage = (name: string) => `${name} was not added because it needs a password.`;
export const combineUnsavedMessage = (name: string) => `${name} has unsaved changes. The saved version will be used.`;
export const combineEmptyMessage = (name: string) => `${name} is empty, so it was not added.`;
export const combineUnreadableMessage = (name: string) => `${name} could not be read, so it was not added.`;

/** "«a»", "«a» and «b»" is not used by the spec; its notices list names with commas: "«a», «b»". */
const names = (list: readonly string[]) => list.join(', ');

export const combineFormsNotice = (list: readonly string[]) =>
  `Fillable forms in ${names(list)}: what is filled in stays visible, but the boxes can no longer be typed in, and signatures can no longer be checked. Your original files are not changed.`;
export const combinePasswordNotice = (list: readonly string[]) => `The new file will not have a password, although ${names(list)} ${list.length === 1 ? 'does' : 'do'}.`;
export const combineLayersNotice = (list: readonly string[]) =>
  `${names(list)} ${list.length === 1 ? 'has' : 'have'} layers that can be shown and hidden. In the new file they become part of the page, and hidden ones become visible.`;
export const combineAttachmentsNotice = (list: readonly string[]) => `Files attached inside ${names(list)} are not copied to the new file.`;
export const combineTextNotice = (name: string, count: number) =>
  `${name} has ${count} ${count === 1 ? 'character' : 'characters'} PDF Suite can't print yet (it prints Latin, Greek and Cyrillic letters). Each will appear as “?”. The text file itself is not changed.`;

/** "Combined 3 files into Combined.pdf (16 pages)." */
export function combineDoneMessage(files: number, name: string, pages: number): string {
  return `Combined ${files} ${files === 1 ? 'file' : 'files'} into ${name} (${pages} ${pages === 1 ? 'page' : 'pages'}).`;
}

/** The "Pages" field's width of a picture and text size choice, for the footer: "3 files · 16 pages · 4.2 MB". */
export function combineSummary(files: number, pages: number, bytes: number): string {
  return `${files} ${files === 1 ? 'file' : 'files'} · ${pages} ${pages === 1 ? 'page' : 'pages'} · ${formatSize(bytes)}`;
}

/**
 * The result notice of a combine that failed on the worker's side (the same texts as when a file is added, ending "so nothing was
 * created", UI spec section 1). `name` is the file the error is about.
 */
export function combineErrorMessage(kind: JobErrorKind, name: string, multiPage = false): string {
  switch (kind) {
    case 'Damaged':
      return `${name} is damaged or is not a PDF, so nothing was created.`;
    case 'Xfa':
      return `${name} is a kind of form that can't be combined yet, so nothing was created.`;
    case 'FormValuesLost':
      return `${name} can't be used, because what is filled in on its form could not be kept, so nothing was created.`;
    case 'ImageTooLarge':
      return multiPage
        ? `${name} has a page that is too large (the limit is 50 megapixels a page), so nothing was created.`
        : `${name} is too large a picture (the limit is 50 megapixels), so nothing was created.`;
    case 'TextTooLarge':
      return `${name} is too large (text files can be up to 32 MB), so nothing was created.`;
    default:
      return jobErrorMessage(kind, name);
  }
}
