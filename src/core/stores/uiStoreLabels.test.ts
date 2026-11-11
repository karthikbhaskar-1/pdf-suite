import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A localStorage stand-in, so the store can be loaded again the way a restart loads it. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

async function loadStore() {
  vi.resetModules();
  return (await import('./uiStore')).useUiStore;
}

describe('Show Labels is remembered between sessions (1.2.2)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect((await loadStore()).getState().toolbarLabels).toBe(false);
  });

  it('is saved when it is turned on, and read again at the next start', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    (await loadStore()).getState().setToolbarLabels(true);
    expect(storage.data.get('pdfsuite.toolbarLabels')).toBe('true');
    // A restart: a fresh store reads what was saved.
    expect((await loadStore()).getState().toolbarLabels).toBe(true);
  });

  it('is saved when it is turned off again', async () => {
    const storage = memoryStorage({ 'pdfsuite.toolbarLabels': 'true' });
    vi.stubGlobal('localStorage', storage);
    const store = await loadStore();
    expect(store.getState().toolbarLabels).toBe(true);
    store.getState().setToolbarLabels(false);
    expect((await loadStore()).getState().toolbarLabels).toBe(false);
  });

  it('is independent of the toolbar being shown', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'pdfsuite.toolbarVisible': 'false' }));
    const store = await loadStore();
    expect(store.getState().toolbarVisible).toBe(false);
    expect(store.getState().toolbarLabels).toBe(false);
  });

  it('works without storage: off, and it can still be changed for the session', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const store = await loadStore();
    expect(store.getState().toolbarLabels).toBe(false);
    store.getState().setToolbarLabels(true);
    expect(store.getState().toolbarLabels).toBe(true);
  });
});
