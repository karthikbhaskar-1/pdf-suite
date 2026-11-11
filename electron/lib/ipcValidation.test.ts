// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  isOpenablePath,
  isPdfPath,
  MAX_PATH_LENGTH,
  noArgs,
  openablePathArg,
  openPathsValue,
  saveArgs,
} from '../../src/platform/desktop/contract';

describe('isOpenablePath (IPC path argument for opening)', () => {
  it('accepts absolute paths of any file type', () => {
    expect(isOpenablePath('C:\\Docs\\me\\notes.txt')).toBe(true);
    expect(isOpenablePath('C:\\Docs\\me\\picture.png')).toBe(true);
    expect(isOpenablePath('C:\\Docs\\me\\a.pdf')).toBe(true);
    expect(isOpenablePath('\\\\server\\share\\noextension')).toBe(true);
  });

  it('rejects relative paths, non-strings, NUL bytes and over-long paths', () => {
    expect(isOpenablePath('notes.txt')).toBe(false);
    expect(isOpenablePath(7)).toBe(false);
    expect(isOpenablePath('C:\\a\0b.txt')).toBe(false);
    expect(isOpenablePath(`C:\\${'a'.repeat(MAX_PATH_LENGTH)}.txt`)).toBe(false);
  });
});

describe('isPdfPath (IPC path argument for writing PDFs)', () => {
  it('accepts absolute Windows and POSIX PDF paths', () => {
    expect(isPdfPath('C:\\Docs\\me\\a.pdf')).toBe(true);
    expect(isPdfPath('\\\\server\\share\\a.pdf')).toBe(true);
    expect(isPdfPath('/home/me/a.PDF')).toBe(true);
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 7, {}, ['C:\\a.pdf'], new Uint8Array(2)]) {
      expect(isPdfPath(value)).toBe(false);
    }
  });

  it('rejects relative paths', () => {
    expect(isPdfPath('a.pdf')).toBe(false);
    expect(isPdfPath('..\\a.pdf')).toBe(false);
  });

  it('rejects non-PDF extensions, including a PDF name in the middle', () => {
    expect(isPdfPath('C:\\a.exe')).toBe(false);
    expect(isPdfPath('C:\\a.pdf.exe')).toBe(false);
    expect(isPdfPath('C:\\a.pdfx')).toBe(false);
  });

  it('rejects empty strings, NUL bytes and over-long paths', () => {
    expect(isPdfPath('')).toBe(false);
    expect(isPdfPath('C:\\a\0b.pdf')).toBe(false);
    expect(isPdfPath(`C:\\${'a'.repeat(MAX_PATH_LENGTH)}.pdf`)).toBe(false);
  });
});

describe('openablePathArg', () => {
  it('returns the path for exactly one valid argument, of any file type', () => {
    expect(openablePathArg(['C:\\a.pdf'])).toBe('C:\\a.pdf');
    expect(openablePathArg(['C:\\a.txt'])).toBe('C:\\a.txt');
  });

  it('rejects zero, two or invalid arguments', () => {
    expect(openablePathArg([])).toBeNull();
    expect(openablePathArg(['C:\\a.pdf', 'C:\\b.pdf'])).toBeNull();
    expect(openablePathArg(['a.pdf'])).toBeNull();
    expect(openablePathArg([{ path: 'C:\\a.pdf' }])).toBeNull();
  });
});

describe('noArgs', () => {
  it('accepts an empty list only', () => {
    expect(noArgs([])).toBe(true);
    expect(noArgs(['extra'])).toBe(false);
  });
});

describe('saveArgs', () => {
  it('accepts a PDF path and an ArrayBuffer', () => {
    const bytes = new ArrayBuffer(4);
    expect(saveArgs(['C:\\a.pdf', bytes])).toEqual({ path: 'C:\\a.pdf', bytes });
  });

  it('rejects a Uint8Array where an ArrayBuffer is required', () => {
    expect(saveArgs(['C:\\a.pdf', new Uint8Array(4)])).toBeNull();
  });

  it('rejects a bad path, a missing argument or extra arguments', () => {
    const bytes = new ArrayBuffer(1);
    expect(saveArgs(['notes.txt', bytes])).toBeNull();
    expect(saveArgs(['C:\\a.pdf'])).toBeNull();
    expect(saveArgs(['C:\\a.pdf', bytes, 'x'])).toBeNull();
  });

  it('rejects payloads over the size limit', () => {
    expect(saveArgs(['C:\\a.pdf', new ArrayBuffer(11)], 10)).toBeNull();
    expect(saveArgs(['C:\\a.pdf', new ArrayBuffer(10)], 10)).not.toBeNull();
  });
});

describe('openPathsValue (events sent to the renderer)', () => {
  it('accepts a list of PDF paths', () => {
    expect(openPathsValue(['C:\\a.pdf', '/b/c.pdf'])).toEqual(['C:\\a.pdf', '/b/c.pdf']);
  });

  it('rejects the whole list when any entry is not an absolute path', () => {
    expect(openPathsValue(['C:\\a.pdf', 'C:\\notes.txt'])).toEqual(['C:\\a.pdf', 'C:\\notes.txt']);
    expect(openPathsValue(['C:\\a.pdf', 'relative.txt'])).toBeNull();
    expect(openPathsValue('C:\\a.pdf')).toBeNull();
  });
});

describe('save dialog arguments', () => {
  it('accepts one plain suggested file name', async () => {
    const { saveDialogNameArg } = await import('../../src/platform/desktop/contract');
    expect(saveDialogNameArg(['report.pdf'])).toBe('report.pdf');
  });

  it.each([
    ['no arguments', []],
    ['two arguments', ['a.pdf', 'b.pdf']],
    ['a path separator', ['..\\evil.pdf']],
    ['a forward slash', ['dir/x.pdf']],
    ['a NUL', ['x\0.pdf']],
    ['an empty name', ['']],
    ['a non-string', [42]],
  ])('refuses %s', async (_label, args) => {
    const { saveDialogNameArg } = await import('../../src/platform/desktop/contract');
    expect(saveDialogNameArg(args)).toBeNull();
  });
});

describe('the 1.5.1 additions to the contract validators', () => {
  const KEY = 'a'.repeat(64);

  it('a close answer: the decision, valid keys (capped) and a request id; a bare decision still works', async () => {
    const { closeAnswerArgs, MAX_CLOSE_KEYS } = await import('../../src/platform/desktop/contract');
    expect(closeAnswerArgs(['close'])).toEqual({ decision: 'close', keys: [], requestId: null });
    expect(closeAnswerArgs(['close', [KEY], 3])).toEqual({ decision: 'close', keys: [KEY], requestId: 3 });
    expect(closeAnswerArgs(['cancel', [], 0])).toEqual({ decision: 'cancel', keys: [], requestId: 0 });
    for (const bad of [[], ['maybe'], ['close', 'x'], ['close', ['../x']], ['close', [KEY.toUpperCase()]], ['close', [], -1], ['close', [], 1.5], ['close', [], '3'], ['close', [], 1, 2]]) {
      expect(closeAnswerArgs(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(closeAnswerArgs(['close', Array.from({ length: MAX_CLOSE_KEYS + 1 }, () => KEY)])).toBeNull();
    expect(closeAnswerArgs(['close', Array.from({ length: MAX_CLOSE_KEYS }, () => KEY)])).not.toBeNull();
    // At least 500 dirty documents, each with two keys (the canonical one and an earlier version's), fit in one answer.
    expect(MAX_CLOSE_KEYS).toBeGreaterThanOrEqual(1000);
  });

  it('a save may carry an expected stamp of two finite non-negative numbers, and nothing else', () => {
    const bytes = new ArrayBuffer(4);
    expect(saveArgs(['C:/a.pdf', bytes])).toEqual({ path: 'C:/a.pdf', bytes });
    expect(saveArgs(['C:/a.pdf', bytes, { size: 10, modified: 1700000000000.5 }])).toEqual({ path: 'C:/a.pdf', bytes, expected: { size: 10, modified: 1700000000000.5 } });
    for (const bad of [{}, { size: 1 }, { size: -1, modified: 1 }, { size: 1, modified: NaN }, { size: Infinity, modified: 1 }, { size: '1', modified: 1 }, null, 7, []]) {
      expect(saveArgs(['C:/a.pdf', bytes, bad]), JSON.stringify(bad)).toBeNull();
    }
    expect(saveArgs(['C:/a.pdf', bytes, { size: 1, modified: 1 }, 'extra'])).toBeNull();
  });

  it('a stat takes one path and an optional boolean', async () => {
    const { statArgs } = await import('../../src/platform/desktop/contract');
    expect(statArgs(['C:/a.pdf'])).toEqual({ path: 'C:/a.pdf', withSample: false });
    expect(statArgs(['C:/a.pdf', true])).toEqual({ path: 'C:/a.pdf', withSample: true });
    for (const bad of [[], ['C:/a.pdf', 1], ['relative.pdf'], ['C:/a.pdf', true, 1]]) expect(statArgs(bad), JSON.stringify(bad)).toBeNull();
  });

  it('the recovery limit is tied to the edit limit (500 MB), and the read limit to the view limit (1 GB)', async () => {
    const { MAX_RECOVERY_BYTES, MAX_READ_BYTES, MAX_EDIT_BYTES, MAX_VIEW_BYTES } = await import('../../src/platform/desktop/contract');
    expect(MAX_RECOVERY_BYTES).toBe(MAX_EDIT_BYTES);
    expect(MAX_READ_BYTES).toBe(MAX_VIEW_BYTES);
    expect(MAX_EDIT_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_VIEW_BYTES).toBe(1024 * 1024 * 1024);
  });
});
