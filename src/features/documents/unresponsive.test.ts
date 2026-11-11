// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../../core/stores/editStore';
import { watchUnresponsive } from './unresponsive';

beforeEach(() => useEditStore.setState({ unresponsive: {} }));

describe('watchUnresponsive (1.5.1 W1 wiring)', () => {
  it('a silent worker sets the document\'s "stopped responding" flag, and nothing else happens', () => {
    let report: () => void = () => undefined;
    const terminate = vi.fn();
    const doc = { client: { watchSilence: (handler: () => void) => (report = handler), terminate } };
    watchUnresponsive('path:C:\\a.pdf', doc);
    expect(useEditStore.getState().unresponsive['path:C:\\a.pdf']).toBeUndefined();
    report();
    expect(useEditStore.getState().unresponsive['path:C:\\a.pdf']).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('follows a Save As: the flag is set under the document\'s current id', () => {
    let report: () => void = () => undefined;
    watchUnresponsive('path:C:\\old.pdf', { client: { watchSilence: (h: () => void) => (report = h) } }, (id) => (id === 'path:C:\\old.pdf' ? 'path:C:\\new.pdf' : id));
    report();
    expect(useEditStore.getState().unresponsive['path:C:\\new.pdf']).toBe(true);
    expect(useEditStore.getState().unresponsive['path:C:\\old.pdf']).toBeUndefined();
  });

  it('prefers MupdfDocument.onUnresponsive when that method exists, and skips a document with no worker', () => {
    const onUnresponsive = vi.fn();
    watchUnresponsive('d', { onUnresponsive, client: { watchSilence: vi.fn() } });
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    expect(() => watchUnresponsive('d', {})).not.toThrow();
    expect(() => watchUnresponsive('d', null)).not.toThrow();
  });
});
