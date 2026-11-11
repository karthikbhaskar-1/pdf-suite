/** How many characters at the end of a name always stay in view (the extension and what comes before it). */
export const KEEP_END_CHARS = 12;

/**
 * A file name split for a place that is too narrow for it (the tabs; 1.5.5 D6): `head` may be cut short with an ellipsis by
 * the style, and `end`, the last 12 characters with the extension, always shows in full, so "…final v3.pdf" tells files
 * apart. `head` followed by `end` is always the whole name. A name of 12 characters or fewer is all `end`.
 */
export function middleTruncate(name: string): { head: string; end: string } {
  if (name.length <= KEEP_END_CHARS) return { head: '', end: name };
  // Never split a surrogate pair.
  let cut = name.length - KEEP_END_CHARS;
  const code = name.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  return { head: name.slice(0, cut), end: name.slice(cut) };
}
