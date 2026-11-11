/**
 * Decodes a WebP picture inside the job worker with the browser's own decoder (MuPDF cannot read WebP, probe D2) and hands it on
 * as PNG. `createImageBitmap` has applied the picture's orientation. The size is checked before anything is drawn.
 */
import { JobFault } from './jobProtocol';
import { MAX_PICTURE_PIXELS, type WebpDecoder } from './imagePage';
import { webpSize } from './exif';

export const browserWebpDecoder: WebpDecoder | null =
  typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
    ? async (bytes) => {
        // The header says how big it is: a picture over the limit is refused before it is decoded (a huge WebP would use gigabytes).
        const stated = webpSize(bytes);
        if (stated && stated.width * stated.height > MAX_PICTURE_PIXELS) throw new JobFault('ImageTooLarge', `${stated.width} x ${stated.height} pixels`);
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/webp' }));
        try {
          const { width, height } = bitmap;
          if (width * height > MAX_PICTURE_PIXELS) throw new JobFault('ImageTooLarge', `${width} x ${height} pixels`);
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('No 2d context');
          context.drawImage(bitmap, 0, 0);
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          return { width, height, png: new Uint8Array(await blob.arrayBuffer()) };
        } finally {
          bitmap.close();
        }
      }
    : null;
