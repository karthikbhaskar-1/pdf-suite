// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
// pdf.js creates a DOMMatrix at module load. Parsing never uses it, so a placeholder is enough here.
vi.hoisted(() => {
  if (!('DOMMatrix' in globalThis)) {
    (globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrixStub {};
  }
});

import { readDesktopFile } from '../../platform/desktop/bridge';
import { pdfjsEngine } from './pdfjsEngine';

vi.mock('../../platform/desktop/bridge', () => ({ readDesktopFile: vi.fn() }));

const path = { kind: 'path' as const, path: 'C:/files/sample.pdf', name: 'sample.pdf' };
const readMock = vi.mocked(readDesktopFile);

/** Opens the same bytes once by path and once by bytes, and returns the error kind of each. */
async function kindsFor(bytes: Uint8Array): Promise<{ byPath: string | undefined; byBytes: string | undefined }> {
  readMock.mockResolvedValueOnce(bytes);
  const byPath = await pdfjsEngine.open(path, {}).then(
    () => undefined,
    (e: { kind?: string }) => e.kind,
  );
  const byBytes = await pdfjsEngine.open({ kind: 'bytes', name: 'sample.pdf', bytes }, {}).then(
    () => undefined,
    (e: { kind?: string }) => e.kind,
  );
  return { byPath, byBytes };
}

describe('pdfjsEngine classification is the same for path and byte sources', () => {
  it('reports a 0-byte file as Empty by path, like by bytes', async () => {
    expect(await kindsFor(new Uint8Array(0))).toEqual({ byPath: 'Empty', byBytes: 'Empty' });
  });

  it('reports a PNG renamed to .pdf as NotPdf by path, like by bytes', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0x20)]);
    expect(await kindsFor(png)).toEqual({ byPath: 'NotPdf', byBytes: 'NotPdf' });
  });

  it('does not reject bytes with the PDF signature before pdf.js reads them', async () => {
    const truncated = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n');
    const { byPath } = await kindsFor(truncated);
    expect(byPath).toBe('Corrupt');
  });
});
