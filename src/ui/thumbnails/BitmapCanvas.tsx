import { useEffect, useRef } from 'react';

/**
 * Draws a rendered page bitmap onto a canvas that fills its box. The bitmap belongs to the cache, so
 * this never closes it. A bitmap the cache has already closed (width 0) is not drawn, because drawing
 * it would throw and leave the canvas blank. The hook that supplies the bitmap asks for the page again.
 */
export function BitmapCanvas({ bitmap, label, className }: { bitmap: ImageBitmap | null; label: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !bitmap || bitmap.width === 0) return;
    el.width = bitmap.width;
    el.height = bitmap.height;
    el.getContext('2d')?.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={canvas} className={className ?? 'overview-image'} role="img" aria-label={label} />;
}
