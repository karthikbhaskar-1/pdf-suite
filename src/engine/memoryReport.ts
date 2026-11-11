import { bitmapCache } from './bitmapCache';

export interface BitmapReport {
  /** Page bitmaps in the shared cache, at every scale. */
  pageCount: number;
  pageBytes: number;
  /** Thumbnails in the same cache. */
  thumbCount: number;
  thumbBytes: number;
  /** Bytes of every bitmap in the shared budget. */
  budgetBytes: number;
}

/** Bytes and counts of the cached bitmaps, split between pages and thumbnails. For the memory probes. */
export function bitmapReport(): BitmapReport {
  const report: BitmapReport = { pageCount: 0, pageBytes: 0, thumbCount: 0, thumbBytes: 0, budgetBytes: bitmapCache.bytes };
  for (const [key, , bytes] of bitmapCache.entries()) {
    if (key.startsWith('thumb|')) {
      report.thumbCount += 1;
      report.thumbBytes += bytes;
    } else {
      report.pageCount += 1;
      report.pageBytes += bytes;
    }
  }
  return report;
}
