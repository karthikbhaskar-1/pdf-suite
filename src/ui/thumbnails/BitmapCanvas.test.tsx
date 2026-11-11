import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { BitmapCanvas } from './BitmapCanvas';

const drawImage = vi.fn();
const original = HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  drawImage.mockClear();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage }) as unknown as CanvasRenderingContext2D) as never;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = original;
});

describe('BitmapCanvas and bitmaps the cache has closed', () => {
  it('draws a live bitmap', () => {
    const live = { width: 40, height: 30, close: vi.fn() } as unknown as ImageBitmap;
    render(<BitmapCanvas bitmap={live} label="page" />);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it('does not draw a bitmap that was closed, and never closes one itself', () => {
    const closed = { width: 0, height: 0, close: vi.fn() } as unknown as ImageBitmap;
    expect(() => render(<BitmapCanvas bitmap={closed} label="page" />)).not.toThrow();
    expect(drawImage).not.toHaveBeenCalled();
    expect(closed.close).not.toHaveBeenCalled();
  });

  it('renders nothing to draw while there is no bitmap yet', () => {
    expect(() => render(<BitmapCanvas bitmap={null} label="page" />)).not.toThrow();
    expect(drawImage).not.toHaveBeenCalled();
  });
});
