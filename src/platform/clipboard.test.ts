import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../core/stores/uiStore';
import { clipboardTextArgs } from './desktop/contract';
import { copyOrReport, copyText } from './clipboard';

const setBridge = (value: unknown) => {
  (window as unknown as { pdfSuite?: unknown }).pdfSuite = value;
};

beforeEach(() => {
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
});

describe('clipboard IPC argument check', () => {
  it('accepts exactly one string of bounded length', () => {
    expect(clipboardTextArgs(['C:\\docs\\a.pdf'])).toBe('C:\\docs\\a.pdf');
    expect(clipboardTextArgs([''])).toBe('');
  });

  it('rejects other argument shapes and oversized text', () => {
    expect(clipboardTextArgs([])).toBeNull();
    expect(clipboardTextArgs(['a', 'b'])).toBeNull();
    expect(clipboardTextArgs([42])).toBeNull();
    expect(clipboardTextArgs([{ text: 'x' }])).toBeNull();
    expect(clipboardTextArgs(['x'.repeat(1_000_001)])).toBeNull();
  });
});

describe('copyText in the desktop app', () => {
  it('writes through the main process and reports success', async () => {
    const writeText = vi.fn(async () => true);
    setBridge({ clipboard: { writeText } });
    expect(await copyText('C:\\docs\\a.pdf')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('C:\\docs\\a.pdf');
  });

  it('reports failure when the main process refuses the write', async () => {
    setBridge({ clipboard: { writeText: vi.fn(async () => false) } });
    expect(await copyText('x')).toBe(false);
  });

  it('reports failure when the bridge call throws', async () => {
    setBridge({ clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    expect(await copyText('x')).toBe(false);
  });
});

describe('copyOrReport', () => {
  it('shows the failure toast when the copy does not happen', async () => {
    setBridge({ clipboard: { writeText: vi.fn(async () => false) } });
    expect(await copyOrReport('C:\\docs\\a.pdf', 'The path could not be copied.')).toBe(false);
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['The path could not be copied.']);
  });

  it('shows no toast when the copy works', async () => {
    setBridge({ clipboard: { writeText: vi.fn(async () => true) } });
    expect(await copyOrReport('C:\\docs\\a.pdf', 'The path could not be copied.')).toBe(true);
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});
