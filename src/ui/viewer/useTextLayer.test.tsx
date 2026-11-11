import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { renderTextLayer } = vi.hoisted(() => ({ renderTextLayer: vi.fn(async () => () => undefined) }));
vi.mock('../../app/services', () => ({ documentRegistry: { get: () => ({ doc: { renderTextLayer } }) } }));

import { useTextLayer } from './useTextLayer';

describe('useTextLayer', () => {
  it('builds the layer again when the page content changes (Crop, Page size)', () => {
    const el = document.createElement('div');
    const ref = { current: el };
    const base = { docId: 'd', srcIndex: 0, rotation: 0, zoom: 1, enabled: true };
    const { rerender } = renderHook(({ content }) => useTextLayer(ref, { ...base, content }), { initialProps: { content: '3@0' } });
    expect(renderTextLayer).toHaveBeenCalledTimes(1);
    rerender({ content: '3@0' });
    expect(renderTextLayer).toHaveBeenCalledTimes(1);
    rerender({ content: '3@1' });
    expect(renderTextLayer).toHaveBeenCalledTimes(2);
  });
});
