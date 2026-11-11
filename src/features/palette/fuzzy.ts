/**
 * Fuzzy matching for the command palette. Every character of the query must appear in the text,
 * in order. Runs of adjacent characters and matches at the start of a word score higher.
 */

/** Score of `query` against `text`, higher is better. Null when the query does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 2;
    if (at === 0 || /\W/.test(t.charAt(at - 1))) score += 1;
    score -= (at - from) * 0.05;
    previous = at;
    from = at + 1;
  }
  return score;
}

export interface PaletteEntry {
  id: string;
  label: string;
  shortcut?: string;
}

/** Entries that match `query`, best first. Ties keep the original order. */
export function filterEntries<T extends PaletteEntry>(entries: readonly T[], query: string): T[] {
  const scored: Array<{ entry: T; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const score = fuzzyScore(query, entry.label);
    if (score !== null) scored.push({ entry, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.entry);
}
