// Pure coverage logic of the thumbnail-list scan (see uids() in matrix-lib.mjs). No imports and no outer references:
// matrix-lib sends this function's source into the page, so it must stay self-contained.
//
// rows: the drawn rows as { top, height } in list content coordinates (any order).
// view: { from, to, scrollHeight } where from/to is the visible range of the list's content (to is already clamped to
//        scrollHeight, so a list shorter than the viewport has from 0 and to = scrollHeight).
// Returns { covered, reason, missing }, where missing is the content ranges [start, end] that should show rows but have none.
//
// Rules, from the rows' real positions (no uniform row height assumed):
//   - a row must start at or above the top of the range (or, at the very start of the list, within the list's top padding);
//   - consecutive rows must not leave a hole bigger than the list's own row spacing (the smallest gap seen between rows);
//   - the last row must reach the bottom of the range, or, when the range ends at the end of the content, reach the end
//     of the content (within the list's bottom padding).
export function coverage(rows, view, padding = 24) {
  const { from, to, scrollHeight } = view;
  const sorted = [...rows].filter((r) => Number.isFinite(r.top) && Number.isFinite(r.height)).sort((a, b) => a.top - b.top);
  if (to <= from) return { covered: true, reason: 'empty range', missing: [] };
  if (sorted.length === 0) return { covered: false, reason: 'no rows drawn', missing: [[from, to]] };
  const spacings = [];
  for (let i = 1; i < sorted.length; i++) spacings.push(sorted[i].top - (sorted[i - 1].top + sorted[i - 1].height));
  const spacing = spacings.length > 0 ? Math.max(0, Math.min(...spacings)) : 0;
  const tolerance = spacing + 2;
  const missing = [];
  const first = sorted[0];
  const startLimit = from <= 1 ? padding : 1;
  if (first.top > from + startLimit) missing.push([from, first.top]);
  for (let i = 1; i < sorted.length; i++) {
    const holeStart = sorted[i - 1].top + sorted[i - 1].height;
    if (sorted[i].top - holeStart > tolerance && sorted[i].top > from && holeStart < to) missing.push([holeStart, sorted[i].top]);
  }
  const last = sorted.at(-1);
  const bottom = last.top + last.height;
  const atEnd = to >= scrollHeight - 1;
  if (bottom < to - (atEnd ? padding : 1)) missing.push([bottom, to]);
  return { covered: missing.length === 0, reason: missing.length === 0 ? 'covered' : 'rows missing', missing };
}
