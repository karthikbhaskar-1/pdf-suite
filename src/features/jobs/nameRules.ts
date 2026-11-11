/**
 * File names for Split into Files (blueprint B4 "Names", UI spec section 2). Pure.
 *
 *   count, blank, size: "<name> - part 01.pdf"
 *   bookmarks:          "<name> - 01 <bookmark title>.pdf"
 * The number is at least 2 digits wide and wide enough for the part count. A bookmark title is cut to the leaf-name rule and
 * to 80 characters; an empty one is "Untitled". Main applies the same leaf-name rule again and never overwrites: a name that
 * is taken gets " (2)".
 */

/** The most characters of the name the user types. */
export const MAX_BASE_NAME_LENGTH = 100;
export const MAX_TITLE_LENGTH = 80;

export const EMPTY_NAME_MESSAGE = 'Enter a name for the new files.';
export const BAD_NAME_MESSAGE = "A file name can't contain \\ / : * ? \" < > |";

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_GLOBAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** The default name for the new files: the source's name without its .pdf. */
export function defaultBaseName(fileName: string): string {
  const stem = fileName.replace(/\.pdf$/i, '');
  const cleaned = cleanSegment(stem, MAX_BASE_NAME_LENGTH);
  return cleaned === '' ? 'Document' : cleaned;
}

/** The message for a name the user typed, or null when it is fine. */
export function validateBaseName(name: string): string | null {
  if (name.trim() === '') return EMPTY_NAME_MESSAGE;
  if (FORBIDDEN.test(name)) return BAD_NAME_MESSAGE;
  return null;
}

/** Digits of the part number: at least two, and enough for `count` parts. */
export function numberWidth(count: number): number {
  return Math.max(2, String(Math.max(1, count)).length);
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Forbidden characters become "-"; white space is tidied; the result is cut to `max` characters and has no trailing dot or space. */
export function cleanSegment(text: string, max: number): string {
  const replaced = text.replace(/[\t\n\r\f\v]+/g, ' ').replace(FORBIDDEN_GLOBAL, '-').replace(/\s+/g, ' ').trim();
  const cut = Array.from(replaced).slice(0, max).join('');
  return cut.replace(/[. ]+$/, '').replace(/^[. ]+/, '');
}

/** A bookmark title as part of a file name. */
export function titleForName(title: string): string {
  const cleaned = cleanSegment(title, MAX_TITLE_LENGTH);
  return cleaned === '' ? 'Untitled' : cleaned;
}

/** "<name> - part 03.pdf" */
export function countPartName(baseName: string, number: number, width: number): string {
  return `${baseName.trim()} - part ${pad(number, width)}.pdf`;
}

/** "<name> - 03 <title>.pdf" */
export function bookmarkPartName(baseName: string, number: number, width: number, title: string): string {
  return `${baseName.trim()} - ${pad(number, width)} ${titleForName(title)}.pdf`;
}

/** The example line of the sheet: the first name, "…", and the last name. One name when there is only one. */
export function exampleLine(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names[0]!} … ${names[names.length - 1]!}`;
}
