// @vitest-environment node
// 1.5.10 file-size limits (owner's delegate, 2026-11-10): one edit-and-save constant (500 MB), the view limit (1 GB), and every
// message built from them. Sizes are numbers here, never real files.
import { describe, expect, it } from 'vitest';
import {
  COMBINE_TOO_LARGE,
  EDIT_LIMIT_TEXT,
  SAVE_ENGINE_FAILED,
  SAVE_OUT_OF_MEMORY,
  SOURCE_TOO_LARGE,
  TOO_LARGE_TO_EXTRACT,
  TOO_LARGE_TO_OPEN,
  TOO_LARGE_TO_SAVE,
  VIEW_LIMIT_TEXT,
  VIEW_ONLY_NOTICE,
  VIEW_ONLY_REASON,
  addBlockedMessage,
  classifySize,
  estimatedSizeAfterAdd,
  limitLabel,
  sizeLabel,
  MAX_EDIT_BYTES,
  MAX_VIEW_BYTES,
} from './fileLimits';
import { ERROR_MESSAGES } from '../engine/errors';
import { MAX_TOTAL_INPUT_BYTES } from '../engine/mupdf/jobProtocol';
import { MAX_COMBINE_BYTES } from '../features/jobs/combinePlan';
import { SPLIT_REFUSALS, COMBINE_TOTAL_TOO_LARGE_MESSAGE } from '../features/jobs/jobMessages';
import { MAX_READ_BYTES, MAX_RECOVERY_BYTES, saveArgs } from '../platform/desktop/contract';

const MB = 1024 * 1024;

describe('the constants', () => {
  it('the edit limit is 500 x 1024 x 1024 bytes and the view limit is 1 GB', () => {
    expect(MAX_EDIT_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_VIEW_BYTES).toBe(1024 * 1024 * 1024);
  });
  it('recovery, Combine, a job input and a save all use the edit constant; reading uses the view constant', () => {
    expect(MAX_RECOVERY_BYTES).toBe(MAX_EDIT_BYTES);
    expect(MAX_COMBINE_BYTES).toBe(MAX_EDIT_BYTES);
    expect(MAX_TOTAL_INPUT_BYTES).toBe(MAX_EDIT_BYTES);
    expect(MAX_READ_BYTES).toBe(MAX_VIEW_BYTES);
  });
  it('a save of the main process refuses one byte over the edit limit and takes the limit itself', () => {
    const bytes = (length: number) => Object.create(ArrayBuffer.prototype, { byteLength: { value: length } }) as ArrayBuffer;
    expect(saveArgs(['C:/a.pdf', bytes(MAX_EDIT_BYTES)])).not.toBeNull();
    expect(saveArgs(['C:/a.pdf', bytes(MAX_EDIT_BYTES + 1)])).toBeNull();
  });
});

describe('the thresholds, by size (never a real file)', () => {
  it.each([
    [0, 'editable'],
    [MAX_EDIT_BYTES - 1, 'editable'],
    [MAX_EDIT_BYTES, 'editable'],
    [MAX_EDIT_BYTES + 1, 'view-only'],
    [600 * MB, 'view-only'],
    [MAX_VIEW_BYTES - 1, 'view-only'],
    [MAX_VIEW_BYTES, 'view-only'],
    [MAX_VIEW_BYTES + 1, 'too-large'],
    [2 * 1024 * MB, 'too-large'],
  ] as const)('%d bytes is %s', (bytes, expected) => {
    expect(classifySize(bytes)).toBe(expected);
  });
});

describe('every message is built from the constants', () => {
  it('the limit words', () => {
    expect(EDIT_LIMIT_TEXT).toBe('500 MB');
    expect(VIEW_LIMIT_TEXT).toBe('1 GB');
    expect(limitLabel(MAX_EDIT_BYTES)).toBe('500 MB');
    expect(limitLabel(MAX_VIEW_BYTES)).toBe('1 GB');
    expect(sizeLabel(420 * MB)).toBe('420 MB');
    expect(sizeLabel(1.2 * 1024 * MB)).toBe('1.2 GB');
    expect(sizeLabel(12 * 1024)).toBe('12 KB');
  });
  it('the view-only notice and reason say why: over 500 MB, view only', () => {
    expect(VIEW_ONLY_NOTICE).toContain('over 500 MB');
    expect(VIEW_ONLY_NOTICE).toMatch(/viewing only/);
    expect(VIEW_ONLY_NOTICE).toMatch(/read and search it/);
    expect(VIEW_ONLY_NOTICE).toMatch(/cannot edit or save it/);
    expect(VIEW_ONLY_REASON).toContain('over 500 MB');
    expect(VIEW_ONLY_REASON).toMatch(/viewed but not edited/);
  });
  it('a file over 1 GB is refused with a message that names the limit', () => {
    expect(TOO_LARGE_TO_OPEN).toContain('1 GB');
    expect(ERROR_MESSAGES.TooLarge).toBe(TOO_LARGE_TO_OPEN);
  });
  it('a failed save names the reason, says the file is unchanged and the edits are open, and a next step', () => {
    for (const text of [SAVE_OUT_OF_MEMORY, SAVE_ENGINE_FAILED, TOO_LARGE_TO_SAVE]) {
      expect(text).toMatch(/file on disk is unchanged/);
      expect(text).toMatch(/edits are still open/);
    }
    expect(SAVE_OUT_OF_MEMORY).toMatch(/did not have enough memory/);
    expect(SAVE_OUT_OF_MEMORY).toMatch(/Close other tabs and try again/);
    expect(TOO_LARGE_TO_SAVE).toContain('500 MB');
    expect(TOO_LARGE_TO_EXTRACT).toContain('500 MB');
  });
  it('Combine and Split name the same limit', () => {
    expect(COMBINE_TOO_LARGE).toContain('500 MB');
    expect(COMBINE_TOTAL_TOO_LARGE_MESSAGE).toBe(COMBINE_TOO_LARGE);
    expect(SPLIT_REFUSALS.TotalTooLarge).toContain('500 MB');
  });
});

describe('adding a source: the estimate is the document saved size plus the source size', () => {
  it('the estimate is the sum', () => {
    expect(estimatedSizeAfterAdd(300 * MB, 0, 150 * MB)).toBe(450 * MB);
  });
  it('a source over the limit on its own is refused, whatever the document', () => {
    expect(addBlockedMessage(0, MAX_EDIT_BYTES + 1)).toBe(SOURCE_TOO_LARGE);
    expect(addBlockedMessage(undefined, MAX_EDIT_BYTES + 1)).toBe(SOURCE_TOO_LARGE);
    expect(addBlockedMessage(undefined, MAX_EDIT_BYTES)).toBeNull();
  });
  it('just under and just over the limit, by the estimate', () => {
    expect(addBlockedMessage(300 * MB, 200 * MB)).toBeNull();
    expect(addBlockedMessage(300 * MB, 200 * MB + 1)).toMatch(/over the 500 MB limit/);
    expect(addBlockedMessage(MAX_EDIT_BYTES, 0)).toBeNull();
    expect(addBlockedMessage(MAX_EDIT_BYTES, 1)).not.toBeNull();
  });
  it('the message names the sizes and says nothing was changed', () => {
    const text = addBlockedMessage(400 * MB, 150 * MB)!;
    expect(text).toContain('400 MB');
    expect(text).toContain('150 MB');
    expect(text).toContain('500 MB');
    expect(text).toMatch(/Nothing was changed/);
  });
  it('the sources already attached count: 400 MB + 90 MB added + 90 MB is refused ("about 490 MB now"), 400 + 90 + 10 is not', () => {
    expect(estimatedSizeAfterAdd(400 * MB, 90 * MB, 90 * MB)).toBe(580 * MB);
    expect(addBlockedMessage(400 * MB, 90 * MB, 90 * MB)).toBe('That PDF is too large to add to this document: together they would be over the 500 MB limit (the document is about 490 MB and the PDF is 90 MB). Nothing was changed.');
    expect(addBlockedMessage(400 * MB, 10 * MB, 90 * MB)).toBeNull();
    expect(addBlockedMessage(400 * MB, 10 * MB + 1, 90 * MB)).not.toBeNull();
  });
  it('with no saved size known, the sources already added and the new one are counted alone', () => {
    expect(addBlockedMessage(undefined, 300 * MB, 300 * MB)).toMatch(/over the 500 MB limit/);
    expect(addBlockedMessage(undefined, 100 * MB, 300 * MB)).toBeNull();
  });
  it('an unknown document size checks the source alone', () => {
    expect(addBlockedMessage(undefined, 499 * MB)).toBeNull();
  });
});
