/**
 * The long-path spellings (the extended-length prefix, with or without UNC, and the device prefix) become the ordinary path. The
 * synchronous file identity helpers that lived here were removed in 1.5.8: they blocked the main thread and nothing used them.
 * Whether two spellings are one file is decided by canonicalSpelling, asynchronously.
 */
export function stripLongPathPrefix(path: string): string {
  if (path.toLowerCase().startsWith('\\\\?\\unc\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return path.slice(4);
  return path;
}
