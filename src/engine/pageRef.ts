import type { PageRef } from '../core/model/types';

/**
 * The one place a page of the page list becomes an engine page index. Every UI read of a page's
 * `srcIndex` goes through this function, and the engine interface takes the index it returns. A
 * later engine (MuPDF in 1.2) that needs a different index only changes this function.
 * The contract is written at the top of ./types.ts.
 */
export function engineIndexOf(ref: Pick<PageRef, 'srcIndex'>): number {
  return ref.srcIndex;
}
