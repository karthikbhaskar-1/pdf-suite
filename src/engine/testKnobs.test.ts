import { describe, expect, it } from 'vitest';
import { KNOB_DEFAULTS, knobWindowArguments, knobs, knobsFromArgv, resolveKnobs, testScreenScale } from './testKnobs';

describe('test knobs', () => {
  it('keeps the shipped values with no knob', () => {
    expect(knobs).toEqual(KNOB_DEFAULTS);
    expect(resolveKnobs(undefined, true)).toEqual(KNOB_DEFAULTS);
    expect(KNOB_DEFAULTS.bitmapBudgetBytes).toBe(48 * 1024 * 1024);
    expect(KNOB_DEFAULTS.concurrency).toBe(2);
    expect(KNOB_DEFAULTS.fastViewportsPerSecond).toBe(1.5);
    expect(KNOB_DEFAULTS.settleMs).toBe(120);
    expect(KNOB_DEFAULTS.lowScaleFactor).toBe(0.5);
    expect(KNOB_DEFAULTS.lowMaxPixels).toBe(2_000_000);
    expect(KNOB_DEFAULTS.dragPauseMs).toBe(80);
    expect(KNOB_DEFAULTS.layerSettleMs).toBe(150);
    expect(KNOB_DEFAULTS.overscan).toBe(2);
    expect(KNOB_DEFAULTS.thumbOverscanPx).toBe(320);
  });

  it('applies values in test mode and ignores bad entries', () => {
    const out = resolveKnobs({ concurrency: 1, settleMs: 200, overscan: 'x', lowScaleFactor: -1, nope: 5 }, true);
    expect(out.concurrency).toBe(1);
    expect(out.settleMs).toBe(200);
    expect(out.overscan).toBe(2);
    expect(out.lowScaleFactor).toBe(0.5);
  });

  it('rounds integer knobs and falls back to the default outside the sane range', () => {
    expect(resolveKnobs({ concurrency: 1.6, overscan: 3.4 }, true)).toMatchObject({ concurrency: 2, overscan: 3 });
    expect(resolveKnobs({ concurrency: 0 }, true).concurrency).toBe(2);
    expect(resolveKnobs({ concurrency: 9 }, true).concurrency).toBe(2);
    expect(resolveKnobs({ concurrency: 8 }, true).concurrency).toBe(8);
    expect(resolveKnobs({ overscan: 0 }, true).overscan).toBe(0);
    expect(resolveKnobs({ overscan: 7 }, true).overscan).toBe(2);
    expect(resolveKnobs({ lowScaleFactor: 0.05 }, true).lowScaleFactor).toBe(0.5);
    expect(resolveKnobs({ lowScaleFactor: 1.2 }, true).lowScaleFactor).toBe(0.5);
    expect(resolveKnobs({ bitmapBudgetBytes: 4 * 1024 * 1024 }, true).bitmapBudgetBytes).toBe(48 * 1024 * 1024);
    expect(resolveKnobs({ bitmapBudgetBytes: 600 * 1024 * 1024 }, true).bitmapBudgetBytes).toBe(48 * 1024 * 1024);
    expect(resolveKnobs({ bitmapBudgetBytes: 96 * 1024 * 1024 }, true).bitmapBudgetBytes).toBe(96 * 1024 * 1024);
    expect(resolveKnobs({ settleMs: 0, dragPauseMs: 2000 }, true)).toMatchObject({ settleMs: 0, dragPauseMs: 2000 });
    expect(resolveKnobs({ settleMs: 2001, layerSettleMs: -1 }, true)).toMatchObject({ settleMs: 120, layerSettleMs: 150 });
    expect(testScreenScale({ PDFSUITE_E2E: '1', PDFSUITE_TEST_KNOBS: '{"screenScale":0.4}' })).toBeNull();
    expect(testScreenScale({ PDFSUITE_E2E: '1', PDFSUITE_TEST_KNOBS: '{"screenScale":5}' })).toBeNull();
    expect(testScreenScale({ PDFSUITE_E2E: '1', PDFSUITE_TEST_KNOBS: '{"screenScale":4}' })).toBe(4);
  });

  it('ignores values outside test mode', () => {
    expect(resolveKnobs({ concurrency: 1, bitmapBudgetBytes: 1 }, false)).toEqual(KNOB_DEFAULTS);
  });

  it('main process: window argument and screen scale only in test mode', () => {
    const json = JSON.stringify({ concurrency: 1, screenScale: 1.5 });
    expect(knobWindowArguments({ PDFSUITE_TEST_KNOBS: json })).toEqual([]);
    expect(testScreenScale({ PDFSUITE_TEST_KNOBS: json })).toBeNull();
    expect(knobWindowArguments({ PDFSUITE_E2E: '1' })).toEqual([]);
    expect(testScreenScale({ PDFSUITE_E2E: '1', PDFSUITE_TEST_KNOBS: 'not json' })).toBeNull();
    expect(testScreenScale({ PDFSUITE_E2E: '1', PDFSUITE_TEST_KNOBS: json })).toBe(1.5);
    const args = knobWindowArguments({ PDFSUITE_E2E: '1', PDFSUITE_TEST_KNOBS: json });
    expect(knobsFromArgv(['--pdfsuite-test-mode', ...args])).toEqual({ concurrency: 1, screenScale: 1.5 });
    expect(knobsFromArgv(args)).toBeNull();
  });
});
