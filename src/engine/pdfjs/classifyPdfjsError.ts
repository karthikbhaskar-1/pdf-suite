import { PdfOpenError } from '../errors';

/**
 * Maps any error thrown by pdf.js while opening a document to a typed error.
 * pdf.js reports a missing or wrong password with PasswordException (code 1 or 2).
 * Everything else that gets past the header check is treated as damage.
 */
export function classifyPdfjsError(error: unknown, hadPassword: boolean): PdfOpenError {
  if (error instanceof PdfOpenError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  if (name === 'PasswordException') {
    if (code === 1) return new PdfOpenError(hadPassword ? 'WrongPassword' : 'PasswordNeeded');
    if (code === 2) return new PdfOpenError('WrongPassword');
  }
  return new PdfOpenError('Corrupt');
}
