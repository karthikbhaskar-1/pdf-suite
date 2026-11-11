// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PdfOpenError, plainMessage, readFailureMessage } from './errors';

describe('plainMessage (no raw engine codes reach the user)', () => {
  it('maps an open error kind to its plain sentence', () => {
    expect(plainMessage(new PdfOpenError('PasswordNeeded'), 'x')).toBe('This file needs a password.');
    expect(plainMessage(new PdfOpenError('Corrupt'), 'x')).toBe('This file is damaged.');
  });

  it('never shows a bare code word, even when it arrives as a plain Error', () => {
    // The raw code maps to its sentence, never shown as the code.
    expect(plainMessage(new Error('PasswordNeeded'), 'The file could not be saved.')).toBe('This file needs a password.');
    expect(plainMessage(new Error('MuPDFFault'), 'The file could not be saved.')).toBe('The file could not be saved.');
    const named = Object.assign(new Error('Corrupt'), { name: 'Corrupt' });
    expect(plainMessage(named, 'The file could not be saved.')).toBe('This file is damaged.');
  });

  it('maps worker kinds that are not open errors', () => {
    const conflict = Object.assign(new Error('Conflict'), { name: 'Conflict' });
    expect(plainMessage(conflict, 'x')).toBe('The pages changed while this ran. Try again.');
  });

  it('shows the specific Unsupported sentence, and the generic text only as a fallback', () => {
    const undo = Object.assign(new Error('Nothing to undo'), { name: 'Unsupported' });
    expect(plainMessage(undo, 'x')).toBe('Nothing to undo');
    const bare = Object.assign(new Error('Unsupported'), { name: 'Unsupported' });
    expect(plainMessage(bare, 'x')).toBe('This change is not supported for this file.');
    const empty = Object.assign(new Error(''), { name: 'Unsupported' });
    expect(plainMessage(empty, 'x')).toBe('This change is not supported for this file.');
  });

  it('keeps a sentence the engine wrote, and says nothing for a cancelled step', () => {
    expect(plainMessage(new Error('This file\'s password protection cannot be kept when saving.'), 'x')).toBe(
      'This file\'s password protection cannot be kept when saving.',
    );
    expect(plainMessage(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'x')).toBe('');
  });
});

describe('readFailureMessage (a file the desktop read refused)', () => {
  it('says "This isn\'t a PDF." for a file that is not one', () => {
    expect(readFailureMessage('not-pdf')).toBe("This isn't a PDF.");
  });
});
