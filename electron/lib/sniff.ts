import * as fs from 'node:fs/promises';
import type { InputType } from '../../src/platform/desktop/contract';

/**
 * Looks at the start of a file before the whole of it is read. A file the user chose can be any type,
 * so the main process checks for the PDF header first and reads the rest only when it is there. A PDF
 * reader accepts the header anywhere in the first 1 KB, so leading junk inside that window is allowed.
 */
export const SNIFF_WINDOW_BYTES = 1024;
const HEADER = Buffer.from('%PDF-', 'latin1');

export type SniffResult = { kind: 'pdf' | 'not-pdf' | 'empty'; size: number };

/** Classifies a file from its size and its first bytes (at most SNIFF_WINDOW_BYTES of them). */
export function sniffHead(head: Uint8Array, size: number): SniffResult['kind'] {
  if (size === 0) return 'empty';
  const window = Buffer.from(head.subarray(0, SNIFF_WINDOW_BYTES));
  return window.indexOf(HEADER) >= 0 ? 'pdf' : 'not-pdf';
}

/** The subset of a file handle the sniff uses. Injected so tests can count the bytes read. */
export interface SniffHandle {
  stat(): Promise<{ size: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * Reads at most the first SNIFF_WINDOW_BYTES of a file and classifies it. The file is never read past
 * that window here, however large it is.
 */
export async function sniffFile(
  path: string,
  open: (path: string) => Promise<SniffHandle> = (p) => fs.open(p, 'r'),
): Promise<SniffResult> {
  const handle = await open(path);
  try {
    const { size } = await handle.stat();
    if (size === 0) return { kind: 'empty', size };
    const window = Buffer.alloc(Math.min(SNIFF_WINDOW_BYTES, size));
    const { bytesRead } = await handle.read(window, 0, window.length, 0);
    return { kind: sniffHead(window.subarray(0, bytesRead), size), size };
  } finally {
    await handle.close();
  }
}

// ---- Typing of job inputs (blueprint section 2): from magic bytes, and for text from the extension ------------------------------

const ascii = (head: Uint8Array, at: number, text: string): boolean => {
  if (head.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (head[at + i] !== text.charCodeAt(i)) return false;
  return true;
};
const bytesAt = (head: Uint8Array, at: number, values: readonly number[]): boolean =>
  head.length >= at + values.length && values.every((v, i) => head[at + i] === v);

const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.md', '.csv']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * What a file is, from its first bytes. PDF (the header anywhere in the first 1 KB); JPEG, PNG, TIFF, GIF, BMP and WebP as
 * `image`; text only for the extensions .txt .log .md .csv (a UTF-16 file has NUL bytes, so a byte order mark is allowed and
 * any other NUL means binary). Office files (by extension, or by their zip or OLE start) are `office`; HEIC, SVG and
 * everything else are `unsupported`. The engine decides the rest (an XFA form, a damaged PDF).
 */
export function classifyHead(head: Uint8Array, size: number, fileName: string): InputType {
  // An empty file has no first bytes to look at. An empty text file is typed as text, so that Combine can say it is empty (its read
  // answers `empty`); an empty file of any other name is not a file Combine can use.
  if (size === 0) return TEXT_EXTENSIONS.has(extensionOf(fileName)) ? 'text' : 'unsupported';
  if (Buffer.from(head.subarray(0, SNIFF_WINDOW_BYTES)).indexOf(HEADER) >= 0) return 'pdf';
  if (bytesAt(head, 0, [0xff, 0xd8, 0xff])) return 'image';
  if (bytesAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return 'image';
  if (bytesAt(head, 0, [0x49, 0x49, 0x2a, 0x00]) || bytesAt(head, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'image';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'image';
  if (ascii(head, 0, 'BM') && head.length > 14 && [12, 40, 52, 56, 64, 108, 124].includes(head[14]!)) return 'image';
  if (ascii(head, 4, 'ftyp')) return 'unsupported';
  const extension = extensionOf(fileName);
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (bytesAt(head, 0, [0x50, 0x4b, 0x03, 0x04]) || bytesAt(head, 0, [0xd0, 0xcf, 0x11, 0xe0])) return 'office';
  const textStart = Buffer.from(head.subarray(0, 1024)).toString('latin1').toLowerCase();
  if (textStart.includes('<svg')) return 'unsupported';
  if (TEXT_EXTENSIONS.has(extension)) {
    const bom16 = bytesAt(head, 0, [0xff, 0xfe]) || bytesAt(head, 0, [0xfe, 0xff]);
    if (bom16) return 'text';
    return head.subarray(0, 4096).includes(0) ? 'unsupported' : 'text';
  }
  return 'unsupported';
}

/** Types a file on disk by reading at most SNIFF_WINDOW_BYTES * 4 of it. */
export async function classifyFile(
  path: string,
  open: (path: string) => Promise<SniffHandle> = (p) => fs.open(p, 'r'),
): Promise<{ kind: InputType; size: number }> {
  const handle = await open(path);
  try {
    const { size } = await handle.stat();
    const window = Buffer.alloc(Math.min(4096, size));
    const { bytesRead } = size === 0 ? { bytesRead: 0 } : await handle.read(window, 0, window.length, 0);
    return { kind: classifyHead(window.subarray(0, bytesRead), size, path.split(/[\\/]/).pop() ?? path), size };
  } finally {
    await handle.close();
  }
}
