/** True for a message a user can read: no raw error names, codes, stack text or object dumps. */
export function plainEnglish(text) {
  if (!text) return true;
  // Raw error names and Node error codes: ENOENT, EPERM, TypeError, AbortError ...
  if (/\b(E[A-Z]{4,}|[A-Z][a-z]+Error)\b/.test(text)) return false;
  return !/(Error:|\bat \w+ \(|\bundefined\b|\bnull\b|\[object|\bNaN\b|0x[0-9a-f]{2,}|mupdf|wasm|\{"|\bstack\b|exception|\bInternal\b|\bConflict\b|\bUnsupported\b|invalid-argument|write-failed)/i.test(text);
}
