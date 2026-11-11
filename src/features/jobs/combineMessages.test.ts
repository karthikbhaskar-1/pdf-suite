// @vitest-environment node
// 1.3.3: every word Combine shows, checked against the UI spec itself (docs/milestone-1.3/1.3-ui-spec.md, section 1): each fixed
// string must appear in the spec word for word, and each template must give the spec's own text when filled with «name» / «a».
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMBINE_EMPTY_MESSAGE,
  COMBINE_TARGET_IS_INPUT_MESSAGE,
  COMBINE_TARGET_OPEN_MESSAGE,
  COMBINE_TOO_MANY_MESSAGE,
  COMBINE_TOTAL_TOO_LARGE_MESSAGE,
  combineAttachmentsNotice,
  combineDamagedMessage,
  combineEmptyMessage,
  combineDoneMessage,
  combineErrorMessage,
  combineFormValuesMessage,
  combineFormsNotice,
  combineLayersNotice,
  combineOfficeMessage,
  combineOtherTypeMessage,
  combinePasswordCancelledMessage,
  combinePasswordNotice,
  combinePictureTooLargeMessage,
  combineTextNotice,
  combineTextTooLargeMessage,
  combineUnsavedMessage,
  combineXfaMessage,
  mainFailureMessage,
} from './jobMessages';

const spec = readFileSync(new URL('../../../docs/milestone-1.3/1.3-ui-spec.md', import.meta.url), 'utf8');
const inSpec = (text: string) => spec.includes(text);
const N = '«name»';

describe('Combine messages are in the UI spec word for word', () => {
  const fixed: Array<[string, string]> = [
    ['empty', COMBINE_EMPTY_MESSAGE],
    ['more than 500 files', COMBINE_TOO_MANY_MESSAGE],
    ['over 500 MB', COMBINE_TOTAL_TOO_LARGE_MESSAGE],
    ['save name is a listed file', COMBINE_TARGET_IS_INPUT_MESSAGE],
    ['save name is an open file', COMBINE_TARGET_OPEN_MESSAGE],
    ['office file', combineOfficeMessage(N)],
    ['other type', combineOtherTypeMessage(N)],
    ['damaged', combineDamagedMessage(N)],
    ['XFA form', combineXfaMessage(N)],
    ['form values cannot be kept', combineFormValuesMessage(N)],
    ['picture over 50 megapixels', combinePictureTooLargeMessage(N, false)],
    ['multi-page picture over 50 megapixels', combinePictureTooLargeMessage(N, true)],
    ['text over 32 MB', combineTextTooLargeMessage(N)],
    ['password cancelled', combinePasswordCancelledMessage(N)],
    ['unsaved changes', combineUnsavedMessage(N)],
    ['password notice', combinePasswordNotice(['«a»'])],
    ['forms notice', combineFormsNotice(['«a»', '«b»'])],
    ['layers notice', combineLayersNotice(['«a»'])],
    ['attachments notice', combineAttachmentsNotice(['«a»'])],
    ['done', combineDoneMessage(3, 'Combined.pdf', 16)],
    ['target-is-input in the main failures', mainFailureMessage('target-is-input')],
    ['target-open in the main failures', mainFailureMessage('target-open')],
  ];
  for (const [label, text] of fixed) {
    it(label, () => {
      expect(inSpec(text), text).toBe(true);
    });
  }

  it('the text notice with 14 characters, as in the spec (the spec writes «a»)', () => {
    expect(inSpec(combineTextNotice('«a»', 14))).toBe(true);
  });
});

describe('plural and singular', () => {
  it('names are listed with commas and the verbs follow', () => {
    expect(combineFormsNotice(['a.pdf', 'b.pdf', 'c.pdf'])).toMatch(/^Fillable forms in a\.pdf, b\.pdf, c\.pdf: /);
    expect(combinePasswordNotice(['a.pdf', 'b.pdf'])).toBe('The new file will not have a password, although a.pdf, b.pdf do.');
    expect(combineLayersNotice(['a.pdf', 'b.pdf'])).toMatch(/^a\.pdf, b\.pdf have layers/);
    expect(combineDoneMessage(1, 'X.pdf', 1)).toBe('Combined 1 file into X.pdf (1 page).');
  });
});

describe('a failure in the run says the same thing as when the file is added, ending "nothing was created"', () => {
  it('each kind a file can be refused with', () => {
    for (const kind of ['Damaged', 'Xfa', 'FormValuesLost', 'ImageTooLarge', 'TextTooLarge', 'PasswordNeeded', 'InputChanged', 'InputUnreadable'] as const) {
      expect(combineErrorMessage(kind, 'a.pdf'), kind).toMatch(/a\.pdf/);
    }
    for (const kind of ['Damaged', 'Xfa', 'FormValuesLost', 'ImageTooLarge', 'TextTooLarge'] as const) {
      expect(combineErrorMessage(kind, 'a.pdf'), kind).toMatch(/so nothing was created\.$/);
    }
    expect(combineErrorMessage('Internal', 'a.pdf')).toMatch(/^Something went wrong, so nothing was created/);
    expect(combineErrorMessage('ImageTooLarge', 'scan.tif', true)).toMatch(/a page that is too large/);
  });
});

describe('review fixes', () => {
  it('one unprintable character is "1 character"; an empty file has its own message', () => {
    expect(combineTextNotice('a.txt', 1)).toMatch(/^a\.txt has 1 character PDF Suite can't print yet/);
    expect(combineTextNotice('a.txt', 2)).toMatch(/^a\.txt has 2 characters PDF Suite/);
    expect(combineEmptyMessage('a.txt')).toBe('a.txt is empty, so it was not added.');
  });
});
