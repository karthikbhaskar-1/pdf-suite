import { PdfOpenError, type PdfErrorKind } from '../../engine/errors';
import type { DocumentSource } from '../../engine/types';
import type { PdfSuiteApi, ReadFailure } from './contract';

/** The preload bridge, or null when the app runs in a browser. */
export function getDesktopBridge(): PdfSuiteApi | null {
  return typeof window !== 'undefined' && window.pdfSuite ? window.pdfSuite : null;
}

/** The last path segment, for both Windows and POSIX separators. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** A path source for a file on disk. Bytes are not copied into the app. */
export function pathSource(path: string): DocumentSource {
  return { kind: 'path', path, name: fileNameOf(path) };
}

const REASON_TO_ERROR: Record<ReadFailure, PdfErrorKind> = {
  missing: 'Missing',
  unreadable: 'Unreadable',
  'too-large': 'TooLarge',
  'invalid-argument': 'Unreadable',
  'not-pdf': 'NotPdf',
  empty: 'Empty',
};

/**
 * Reads a file by path through the main process. Throws PdfOpenError for missing, unreadable,
 * oversized, empty and non-PDF files, so the tab shows the matching inline message.
 */
export async function readDesktopFile(path: string): Promise<Uint8Array> {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('Opening files by path needs the desktop app.');
  const result = await bridge.files.read(path);
  if (!result.ok) throw new PdfOpenError(REASON_TO_ERROR[result.reason]);
  if (!(result.bytes instanceof ArrayBuffer)) throw new PdfOpenError('Unreadable');
  return new Uint8Array(result.bytes);
}
