// @vitest-environment node
// 1.3.2: every message of a job, checked against the UI spec itself (docs/milestone-1.3/1.3-ui-spec.md): each fixed string must
// appear in the spec word for word, and each template must give the spec's own example when filled with its values.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BLANK_CHOICES,
  CANCELLED_MESSAGE,
  CANNOT_KEEP_PASSWORD_MESSAGE,
  INTERNAL_MESSAGE,
  JOB_BUSY_REASON,
  QUIT_PROMPT_TEXT,
  SPLIT_ATTACHMENTS_NOTICE,
  SPLIT_CHECKING_MESSAGE,
  SPLIT_FORMS_NOTICE,
  SPLIT_REFUSALS,
  SPLIT_SAME_NAME_NOTE,
  SPLIT_UNSAVED_MESSAGE,
  STOPPED_RESPONDING_MESSAGE,
  foundBlanksText,
  formatLimit,
  hasMarksLabel,
  jobErrorMessage,
  OUT_OF_MEMORY_MESSAGE,
  lookingText,
  mainFailureMessage,
  splitDoneMessage,
  statusText,
} from './jobMessages';
import { NO_BLANKS_MESSAGE, NO_BOOKMARKS_MESSAGE } from './splitPlan';
import { BAD_NAME_MESSAGE, EMPTY_NAME_MESSAGE } from './nameRules';

const spec = readFileSync(new URL('../../../docs/milestone-1.3/1.3-ui-spec.md', import.meta.url), 'utf8');
/** The spec uses markdown; compare on its text with straight quotes as written. */
const inSpec = (text: string) => spec.includes(text);

describe('fixed messages are in the UI spec word for word', () => {
  const fixed: Array<[string, string]> = [
    ['busy reason', JOB_BUSY_REASON],
    ['quit prompt', QUIT_PROMPT_TEXT],
    ['cancelled', CANCELLED_MESSAGE],
    ['internal', INTERNAL_MESSAGE],
    ['stopped responding', STOPPED_RESPONDING_MESSAGE],
    ['unsaved', SPLIT_UNSAVED_MESSAGE],
    ['checking', SPLIT_CHECKING_MESSAGE],
    ['forms notice', SPLIT_FORMS_NOTICE],
    ['same name note', SPLIT_SAME_NAME_NOTE],
    ['form values lost', SPLIT_REFUSALS.FormValuesLost],
    ['password needed', SPLIT_REFUSALS.PasswordNeeded],
    ['too large', SPLIT_REFUSALS.TotalTooLarge],
    ['damaged', SPLIT_REFUSALS.Damaged],
    ['cannot keep password', CANNOT_KEEP_PASSWORD_MESSAGE],
    ['no bookmarks', NO_BOOKMARKS_MESSAGE],
    ['no blanks', NO_BLANKS_MESSAGE],
    ['empty name', EMPTY_NAME_MESSAGE],
    ['disk full text', mainFailureMessage('disk-full', 'X')],
    ['folder not writable', mainFailureMessage('folder-not-writable')],
    ['write failed', mainFailureMessage('write-failed')],
    ['input unreadable', jobErrorMessage('InputUnreadable', '«name»').replace('«name»', '«name»')],
    ['input changed', jobErrorMessage('InputChanged', '«name»')],
    ['check failed', jobErrorMessage('CheckFailed')],
  ];
  for (const [label, text] of fixed) {
    it(label, () => {
      // The spec writes the file name as "«name»".
      expect(inSpec(text), text).toBe(true);
    });
  }

  it("the attachments notice is the Combine wording with 'the new files'; the bad-name message is the spec's (its pipe is escaped in the table)", () => {
    expect(SPLIT_ATTACHMENTS_NOTICE).toBe('Files attached inside this document are not copied to the new files.');
    expect(inSpec('Files attached inside «a» are not copied to the new file.')).toBe(true);
    expect(inSpec(BAD_NAME_MESSAGE.replace('|', '\\|'))).toBe(true);
  });

  it('the layers notice of Split is the Combine wording with "the new files"', () => {
    expect(inSpec('have layers that can be shown and hidden') || inSpec('has layers that can be shown and hidden')).toBe(true);
    expect(inSpec('Layers and attachments use the Combine wording with "the new files"')).toBe(true);
  });
});

describe('templates give the spec\'s own examples', () => {
  it('the status bar texts', () => {
    const copying = statusText('split', { phase: 'copying', done: 3, total: 5, unit: 'files' }, false);
    expect(copying.text).toBe('Splitting into files · 3 of 5 files');
    expect(statusText('combine', { phase: 'copying', done: 12, total: 16, unit: 'pages' }, false).text).toBe('Combining files · 12 of 16 pages');
    expect(statusText('split', { phase: 'saving', done: 2, total: 12, unit: 'files' }, false).text).toBe('Splitting into files · saving file 3 of 12');
    expect(statusText('combine', { phase: 'saving', done: 0, total: 0, unit: 'pages' }, false).text).toBe('Combining files · saving…');
    expect(statusText('combine', { phase: 'checking', done: 0, total: 1, unit: 'files' }, false).text).toBe('Combining files · checking the new file…');
    expect(statusText('split', { phase: 'checking', done: 0, total: 1, unit: 'files' }, false).text).toBe('Splitting into files · checking the new files…');
    expect(statusText('split', { phase: 'looking', done: 4, total: 9, unit: 'pages' }, false).text).toBeNull();
    expect(statusText('split', { phase: 'copying', done: 1, total: 9, unit: 'files' }, true).text).toBe('Cancelling…');
    // They are all in the spec (its table and examples).
    for (const text of ['Combining files · 12 of 16 pages', 'Splitting into files · saving file 3 of 12', 'Combining files · saving…', 'Combining files · checking the new file…', 'Splitting into files · checking the new files…', 'Cancelling…']) {
      expect(inSpec(text), text).toBe(true);
    }
  });

  it('the bar fills with a count and moves without one', () => {
    expect(statusText('split', { phase: 'copying', done: 1, total: 4, unit: 'files' }, false)).toMatchObject({ bar: 'fill', percent: 25 });
    expect(statusText('split', { phase: 'checking', done: 1, total: 4, unit: 'files' }, false).bar).toBe('stripe');
    expect(statusText('split', { phase: 'saving', done: 1, total: 4, unit: 'pages' }, false).bar).toBe('stripe');
  });

  it('the done notice and the oversize addition', () => {
    expect(splitDoneMessage('Report.pdf', 12)).toBe('Split Report.pdf into 12 files.');
    expect(inSpec('Split Report.pdf into 12 files.')).toBe(true);
    const text = splitDoneMessage('Report.pdf', 12, [{ page: 14, limitBytes: 10 * 1024 * 1024, leafName: 'Report - part 05.pdf' }]);
    expect(text).toContain('Page 14 is larger than 10 MB by itself, so “Report - part 05.pdf” is over the limit.');
    expect(inSpec('Page 14 is larger than 10 MB by itself, so “Report - part 05.pdf” is over the limit.')).toBe(true);
    expect(splitDoneMessage('A.pdf', 1)).toBe('Split A.pdf into 1 file.');
  });

  it('the disk-full message names the drive', () => {
    expect(mainFailureMessage('disk-full', 'D')).toBe('There is not enough space on drive D:. Nothing was written.');
  });

  it('the blank-page search lines', () => {
    expect(lookingText(40, 120)).toBe('Looking for blank pages… 40 of 120');
    expect(inSpec('Looking for blank pages… 40 of 120')).toBe(true);
    expect(foundBlanksText(6)).toBe('Found 6 blank pages. Untick any that should not start a new file.');
    expect(foundBlanksText(1)).toBe('Found 1 blank page. Untick any that should not start a new file.');
    expect(inSpec('Found 6 blank pages. Untick any that should not start a new file.')).toBe(true);
    // The second choice, its help and its list item are the calibration ruling's words.
    const ruling = readFileSync(new URL('../../../docs/milestone-1.5/blank-calibration.md', import.meta.url), 'utf8');
    expect(foundBlanksText(6, true)).toBe('Found 6 blank or nearly blank pages. Pages marked “has marks” are not empty. Untick any that should not start a new file.');
    expect(ruling.includes(foundBlanksText(6, true).replace('6', 'N'))).toBe(true);
    expect(ruling.includes(BLANK_CHOICES.normal.help)).toBe(true);
    expect(ruling.includes(BLANK_CHOICES.loose.help)).toBe(true);
    expect(ruling.includes(hasMarksLabel(7))).toBe(true);
    expect(ruling.includes('**What counts as blank**')).toBe(true);
  });

  it('size limits read as the sheet types them', () => {
    expect(formatLimit(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatLimit(512 * 1024)).toBe('512 KB');
    expect(formatLimit(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('every kind a job can end with has a message, and none shows the worker detail', () => {
    for (const kind of ['Cancelled', 'InputUnreadable', 'InputChanged', 'PasswordNeeded', 'WrongPassword', 'Damaged', 'Xfa', 'FormValuesLost', 'ImageTooLarge', 'TextTooLarge', 'TotalTooLarge', 'CannotKeepPassword', 'NoBookmarks', 'CheckFailed', 'OutOfMemory', 'Internal'] as const) {
      const text = jobErrorMessage(kind, 'Report.pdf');
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/undefined|\[object/);
    }
    for (const reason of ['disk-full', 'folder-not-writable', 'target-is-input', 'target-open', 'write-failed', 'invalid'] as const) {
      expect(mainFailureMessage(reason, 'C').length).toBeGreaterThan(10);
    }
  });
});

describe('not enough memory (1.3 spec failure table)', () => {
  it('says plainly that nothing was created and the files are unchanged', () => {
    expect(jobErrorMessage('OutOfMemory', 'a.pdf')).toBe('PDF Suite did not have enough memory for these files, so nothing was created. Your files were not changed. Try again with fewer or smaller files.');
  });
  it('Split has its own sentence, and the spec table holds both', () => {
    const split = 'PDF Suite did not have enough memory to split this document, so nothing was created. Your file was not changed. Close other tabs and try again.';
    expect(jobErrorMessage('OutOfMemory', 'a.pdf', 'split')).toBe(split);
    expect(jobErrorMessage('OutOfMemory', 'a.pdf', 'combine')).toBe(OUT_OF_MEMORY_MESSAGE);
    expect(inSpec(split)).toBe(true);
    expect(inSpec(OUT_OF_MEMORY_MESSAGE)).toBe(true);
  });
});
