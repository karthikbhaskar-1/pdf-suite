// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MupdfCore, PERIODIC_SHRINK_JOBS, SHRINK_GROWTH_BYTES } from './core';

/** A stand-in for the MuPDF module and its WASM heap. Only the parts the shrink policy touches are real. */
function setup(initialHeap: number) {
  const mu = { shrinkStore: vi.fn() };
  const wasm = { HEAPU8: new Uint8Array(initialHeap) };
  const core = new MupdfCore(mu as never, wasm);
  return { core, mu, wasm };
}

describe('MupdfCore store shrinking', () => {
  it('trims the store on a fixed cadence while the heap is steady', () => {
    const { core, mu } = setup(64 * 1024 * 1024);
    for (let i = 0; i < PERIODIC_SHRINK_JOBS; i++) core.afterJob();
    expect(mu.shrinkStore).toHaveBeenCalledTimes(1);
    expect(mu.shrinkStore).toHaveBeenLastCalledWith(50);
  });

  it('empties the store as soon as the WASM heap has grown, without waiting for the cadence', () => {
    const { core, mu, wasm } = setup(64 * 1024 * 1024);
    core.afterJob();
    expect(mu.shrinkStore).not.toHaveBeenCalled();
    // A page with large images grows the heap.
    wasm.HEAPU8 = new Uint8Array(64 * 1024 * 1024 + SHRINK_GROWTH_BYTES);
    core.afterJob();
    expect(mu.shrinkStore).toHaveBeenCalledWith(100);
  });

  it('does not shrink again for the same heap size', () => {
    const { core, mu, wasm } = setup(64 * 1024 * 1024);
    core.afterJob();
    wasm.HEAPU8 = new Uint8Array(64 * 1024 * 1024 + SHRINK_GROWTH_BYTES);
    core.afterJob();
    core.afterJob();
    expect(mu.shrinkStore.mock.calls.filter(([percent]) => percent === 100)).toHaveLength(1);
  });
});
