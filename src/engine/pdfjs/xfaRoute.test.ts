// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { chooseXfaRoute, xfaLayerWorks, type XfaCheckedDocument, type XfaLibrary } from './xfaRoute';

/** A pdf.js-like document. `xfa` is what page 1 returns from getXfa; `failGetXfa` makes it throw. */
function fakeDoc(options: { xfa?: unknown; failGetXfa?: boolean } = {}): XfaCheckedDocument & { destroy: () => Promise<void> } {
  const page = {
    getXfa: vi.fn(async () => {
      if (options.failGetXfa) throw new Error('xfa parse failed');
      return 'xfa' in options ? options.xfa : { name: 'div', children: [] };
    }),
    getViewport: () => ({ clone: () => ({}) }),
  };
  return { getPage: async () => page, destroy: vi.fn(async () => undefined) };
}

function fakeLib(fail: boolean): XfaLibrary {
  return {
    XfaLayer: {
      render: vi.fn(() => {
        if (fail) throw new Error('layer failed');
        return { textDivs: [] };
      }),
    },
  };
}

const makeDiv = () => ({}) as HTMLElement;

describe('xfaLayerWorks', () => {
  it('is true when the HTML layer of the first page can be built', async () => {
    expect(await xfaLayerWorks(fakeLib(false), fakeDoc(), makeDiv)).toBe(true);
  });

  it('is false when XfaLayer rendering fails', async () => {
    expect(await xfaLayerWorks(fakeLib(true), fakeDoc(), makeDiv)).toBe(false);
  });

  it('is false when pdf.js cannot read the XFA tree', async () => {
    expect(await xfaLayerWorks(fakeLib(false), fakeDoc({ failGetXfa: true }), makeDiv)).toBe(false);
  });

  it('is true for a page with no XFA content, since the fallback is then the content', async () => {
    const lib = fakeLib(true);
    expect(await xfaLayerWorks(lib, fakeDoc({ xfa: null }), makeDiv)).toBe(true);
    expect(lib.XfaLayer.render).not.toHaveBeenCalled();
  });
});

describe('chooseXfaRoute', () => {
  it('keeps the XFA document when its layer works, and opens nothing else', async () => {
    const xfa = fakeDoc();
    const open = vi.fn(async () => xfa);
    const route = await chooseXfaRoute(open, async () => true);
    expect(route).toEqual({ pdf: xfa, xfa: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(true);
  });

  it('when the layer fails, closes the XFA document and reopens the file without XFA, so the fallback shows', async () => {
    const withXfa = fakeDoc();
    const plain = fakeDoc();
    const open = vi.fn(async (enableXfa: boolean) => (enableXfa ? withXfa : plain));
    const route = await chooseXfaRoute(open, async () => false);
    expect(route).toEqual({ pdf: plain, xfa: false });
    expect(withXfa.destroy).toHaveBeenCalledTimes(1);
    expect(open.mock.calls).toEqual([[true], [false]]);
  });

  it('a failure of the reopen is the error of the open, not a blank page', async () => {
    const open = vi.fn(async (enableXfa: boolean) => {
      if (enableXfa) return fakeDoc();
      throw new Error('cannot open');
    });
    await expect(chooseXfaRoute(open, async () => false)).rejects.toThrow('cannot open');
  });
});
