// @vitest-environment node
// The rule for a document that is not shown (1.5.4): visible, time, running operation, unsaved edits, reopenable.
import { describe, expect, it } from 'vitest';
import { BACKGROUND_IDLE_MS, residencyFor, type ResidencyFacts } from './residencyRule';

const idle: ResidencyFacts = { visible: false, idleMs: BACKGROUND_IDLE_MS + 1, runningOperation: false, unsavedEdits: false, reopenable: true };
const facts = (patch: Partial<ResidencyFacts>): ResidencyFacts => ({ ...idle, ...patch });

describe('residencyFor', () => {
  it('ends the engine of a clean document that was not shown for more than 60 s', () => {
    expect(BACKGROUND_IDLE_MS).toBe(60_000);
    expect(residencyFor(idle)).toBe('worker');
  });

  it('keeps a document that is shown, whatever else is true', () => {
    expect(residencyFor(facts({ visible: true }))).toBe('keep');
    expect(residencyFor(facts({ visible: true, idleMs: 10 * 60_000 }))).toBe('keep');
  });

  it('keeps a document until MORE than 60 s have passed (exactly 60 s is not enough)', () => {
    expect(residencyFor(facts({ idleMs: 0 }))).toBe('keep');
    expect(residencyFor(facts({ idleMs: BACKGROUND_IDLE_MS - 1 }))).toBe('keep');
    expect(residencyFor(facts({ idleMs: BACKGROUND_IDLE_MS }))).toBe('keep');
    expect(residencyFor(facts({ idleMs: BACKGROUND_IDLE_MS + 1 }))).toBe('worker');
  });

  it('keeps everything of a document with a running operation', () => {
    expect(residencyFor(facts({ runningOperation: true }))).toBe('keep');
    expect(residencyFor(facts({ runningOperation: true, unsavedEdits: true }))).toBe('keep');
  });

  it('releases only the bitmaps of a document with unsaved edits: its worker holds the edit journal and the undo history', () => {
    expect(residencyFor(facts({ unsavedEdits: true }))).toBe('bitmaps');
  });

  it('releases only the bitmaps of a document that cannot be reopened as it is', () => {
    expect(residencyFor(facts({ reopenable: false }))).toBe('bitmaps');
  });

  it('takes the idle time as a parameter', () => {
    expect(residencyFor(facts({ idleMs: 2_000 }), 1_000)).toBe('worker');
    expect(residencyFor(facts({ idleMs: 2_000 }), 5_000)).toBe('keep');
  });
});
