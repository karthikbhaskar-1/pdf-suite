import { TOO_LARGE_TO_OPEN } from '../core/fileLimits';

export type PdfErrorKind =
  | 'PasswordNeeded'
  | 'WrongPassword'
  | 'Corrupt'
  | 'NotPdf'
  | 'Empty'
  /** Desktop: the path no longer exists. */
  | 'Missing'
  /** Desktop: the file exists but could not be read. */
  | 'Unreadable'
  /** Desktop: the file is larger than the app reads in one go. */
  | 'TooLarge';

/** Typed failure from opening a PDF. `kind` is the reliable discriminator. */
export class PdfOpenError extends Error {
  readonly kind: PdfErrorKind;

  constructor(kind: PdfErrorKind) {
    super(kind);
    this.name = 'PdfOpenError';
    this.kind = kind;
  }
}

export function isPdfOpenError(error: unknown): error is PdfOpenError {
  return error instanceof PdfOpenError;
}

/** Plain-English text shown inline in a tab for each error kind (from the UI spec). */
export const ERROR_MESSAGES: Record<PdfErrorKind, string> = {
  Corrupt: 'This file is damaged.',
  NotPdf: "This isn't a PDF.",
  Empty: 'This file is empty.',
  PasswordNeeded: 'This file needs a password.',
  WrongPassword: 'Wrong password, try again.',
  Missing: 'This file was moved, renamed or deleted.',
  Unreadable: 'This file could not be read.',
  TooLarge: TOO_LARGE_TO_OPEN,
};

/** Plain English for the engine's worker error kinds that are not open errors (see mupdf/protocol.ts ErrorKind). */
const WORKER_KIND_MESSAGES: Record<string, string> = {
  Conflict: 'The pages changed while this ran. Try again.',
  Unsupported: 'This change is not supported for this file.',
  NeedsEncryptionChoice: "This file's password protection cannot be kept when saving.",
  Internal: 'Something went wrong, so this was not done. If it happens again, Help ▸ Open Logs Folder has the details.',
};

/** The name of the error an edit gets when its document went away under it (closed, or replaced by a reopen). Never shown. */
export const DOCUMENT_GONE = 'DocumentGone';

/**
 * The text to show the user for any failure. Engine error kinds (PasswordNeeded, Corrupt, ...) are never shown raw:
 * they map to the spec text above. Other errors show their own message when it is a sentence. A bare code-like word
 * (such as "Corrupt") is not a sentence, so the fallback is used instead. Cancelled work returns ''.
 */
export function plainMessage(error: unknown, fallback: string): string {
  if (isPdfOpenError(error)) return ERROR_MESSAGES[error.kind];
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'Cancelled') return '';
  const message = error instanceof Error ? error.message : '';
  // Unsupported carries the engine's own sentence for the user ("Nothing to undo"); the generic text is only the fallback.
  if (name === 'Unsupported' && message !== '' && !/^[A-Z][A-Za-z]+$/.test(message)) return message;
  if (name in WORKER_KIND_MESSAGES) return WORKER_KIND_MESSAGES[name]!;
  if (message in ERROR_MESSAGES) return ERROR_MESSAGES[message as PdfErrorKind];
  if (message in WORKER_KIND_MESSAGES) return WORKER_KIND_MESSAGES[message]!;
  if (message === '' || /^[A-Z][A-Za-z]+$/.test(message)) return fallback;
  return message;
}

/** The text for a file the desktop read refused (see ReadFailure in platform/desktop/contract.ts). */
export function readFailureMessage(reason: 'missing' | 'unreadable' | 'too-large' | 'invalid-argument' | 'not-pdf' | 'empty'): string {
  switch (reason) {
    case 'not-pdf':
      return ERROR_MESSAGES.NotPdf;
    case 'empty':
      return ERROR_MESSAGES.Empty;
    case 'missing':
      return ERROR_MESSAGES.Missing;
    case 'too-large':
      return ERROR_MESSAGES.TooLarge;
    default:
      return ERROR_MESSAGES.Unreadable;
  }
}
