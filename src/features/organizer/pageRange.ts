/**
 * Page ranges as typed in the From PDF sheet: "1-5, 8". Pages are 1-based and inclusive. The result is ascending, without
 * repeats, so the pages keep their order in the source file.
 */
export type RangeResult = { ok: true; pages: number[] } | { ok: false; message: string };

export function parsePageRange(text: string, pageCount: number): RangeResult {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false, message: 'Enter the pages to insert, such as 1-5, 8.' };
  const found = new Set<number>();
  for (const part of parts) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) return { ok: false, message: `"${part}" is not a page or a page range.` };
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > pageCount || from > to) {
      return { ok: false, message: `${part} is outside 1-${pageCount}.` };
    }
    for (let page = from; page <= to; page++) found.add(page);
  }
  return { ok: true, pages: [...found].sort((a, b) => a - b) };
}
