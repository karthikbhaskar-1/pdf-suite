import { describe, expect, it } from 'vitest';
import { detectRuntime } from './runtime';

describe('detectRuntime', () => {
  it('is web when no desktop bridge is present', () => {
    expect(detectRuntime({})).toBe('web');
  });

  it('is desktop when the preload exposed pdfSuite', () => {
    expect(detectRuntime({ pdfSuite: {} })).toBe('desktop');
  });

  it('is web when pdfSuite is present but empty', () => {
    expect(detectRuntime({ pdfSuite: undefined })).toBe('web');
  });
});
