/**
 * Outline titles from a PDF can contain control characters (NUL, escape, and so on), which show as garbage
 * in the Bookmarks panel. Both engines strip them, so the same file shows the same titles.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function cleanOutlineTitle(title: string): string {
  return title.replace(CONTROL, '').trim();
}
