import { PdfOpenError } from './errors';

/** pdf.js looks for the signature in the first 1024 bytes, so we do too. */
const HEADER_WINDOW = 1024;
const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Cheap checks that run before any engine sees the bytes. Returns an error, or null if plausible. */
export function precheckBytes(bytes: Uint8Array): PdfOpenError | null {
  if (bytes.byteLength === 0) return new PdfOpenError('Empty');
  const head = bytes.subarray(0, Math.min(bytes.byteLength, HEADER_WINDOW));
  return containsSignature(head) ? null : new PdfOpenError('NotPdf');
}

function containsSignature(head: Uint8Array): boolean {
  const last = head.length - SIGNATURE.length;
  for (let i = 0; i <= last; i++) {
    let match = true;
    for (let j = 0; j < SIGNATURE.length; j++) {
      if (head[i + j] !== SIGNATURE[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
