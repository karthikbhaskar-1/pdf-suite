const BACKSLASH = '\\';

/**
 * The canonical form of a Windows path: back slashes, no repeated or trailing separators, "." and ".." resolved, lower case.
 * It is the same normalisation the main process uses for its path grants (electron/lib/pathGrants.ts grantKey), written here
 * because the page cannot import Node's path module. Two spellings of one file give one canonical form. It names a file
 * for COMPARISON only (the registry's "is this document already open", the recovery key); the path itself is never
 * rewritten with it.
 */
export function canonicalPath(path: string): string {
  const slashed = path.replace(/\//g, BACKSLASH);
  const unc = slashed.startsWith(BACKSLASH + BACKSLASH);
  const segments = (unc ? slashed.slice(2) : slashed).split(BACKSLASH).filter((part) => part !== '' && part !== '.');
  // The root parts a ".." must not remove: the drive ("c:"), or the server and share of a UNC path.
  const drive = !unc && /^[a-zA-Z]:$/.test(segments[0] ?? '');
  const rootParts = unc ? 2 : drive ? 1 : 0;
  const parts: string[] = [];
  for (const part of segments) {
    if (part === '..') {
      if (parts.length > rootParts) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return ((unc ? BACKSLASH + BACKSLASH : '') + parts.join(BACKSLASH)).toLowerCase();
}
