/** Engine-neutral helpers for document metadata text. */

/**
 * Converts a PDF date ("D:YYYYMMDDHHmmSSOHH'mm'") to "YYYY-MM-DD HH:mm:ss". Missing parts
 * default to their first value. Returns undefined when the text is not a PDF date.
 */
export function parsePdfDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw.trim());
  if (!match) return undefined;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
