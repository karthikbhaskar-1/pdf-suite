import type { EngineDocument, PageSize } from './types';

export type { PageSize } from './types';

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Measures every page in order, a few at a time, yielding to the main thread between chunks.
 * Stops early when `isAlive` returns false (for example after the tab closed).
 */
export async function measureInBackground(
  doc: EngineDocument,
  pageCount: number,
  isAlive: () => boolean,
  onChunk: (entries: Array<{ srcIndex: number; size: PageSize }>) => void,
  chunkSize = 20,
): Promise<void> {
  for (let start = 0; start < pageCount; start += chunkSize) {
    if (!isAlive()) return;
    const end = Math.min(pageCount, start + chunkSize);
    const entries: Array<{ srcIndex: number; size: PageSize }> = [];
    for (let i = start; i < end; i++) {
      if (!isAlive()) return;
      try {
        entries.push({ srcIndex: i, size: await doc.pageSize(i) });
      } catch {
        // A page that cannot be measured keeps the default size.
      }
    }
    onChunk(entries);
    await yieldToMain();
  }
}
