import type { PageEdit } from './protocol';

/**
 * The word for what an Insert adds: "blank", "lined" or "grid". When one apply inserts pages of more than one kind, or
 * the edits are not blank-page inserts, there is no single word and the result is an empty string.
 */
export function insertKindWord(edits: readonly PageEdit[]): string {
  const kinds = new Set<string>();
  for (const edit of edits) if (edit.op === 'insertBlank') kinds.add(edit.template);
  return kinds.size === 1 ? [...kinds][0]! : '';
}

/** "blank pages", "lined pages", "grid page" and so on, with "pages" alone for a mix. */
export function insertedNoun(edits: readonly PageEdit[], count: number): string {
  const noun = count === 1 ? 'page' : 'pages';
  const kind = insertKindWord(edits);
  return kind ? `${kind} ${noun}` : noun;
}
