/**
 * The two file-size limits, in bytes (owner's delegate, 2026-11-10, "Largest supported file"; measured in
 * docs/milestone-1.5/measurements.md L1). This leaf file has no imports, so the job worker bundle can use it; everything else
 * reaches the numbers through platform/desktop/contract.ts (which re-exports them) and builds its words from
 * core/fileLimits.ts.
 *
 * MAX_EDIT_BYTES: the largest file that is edited and saved, and the most one edit, save, Combine or recovery stash may hold. The
 * save fails every time above about 550 to 650 MB (the WASM memory runs out), so a larger file is not edited at all.
 * MAX_VIEW_BYTES: the largest file that opens. A file between the two opens view-only; a larger one is refused.
 */
export const MAX_EDIT_BYTES = 500 * 1024 * 1024;
export const MAX_VIEW_BYTES = 1024 * 1024 * 1024;
