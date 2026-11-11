import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { panels } from '../../core/layout/panelRegistry';
import { DOCK_DEFAULT_WIDTH, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, useUiStore } from '../../core/stores/uiStore';
import { DockArea } from './Dock';

beforeAll(() => {
  panels.register({ id: 'dock-test', title: 'Dock test', icon: null, component: () => <p>body</p> } as never);
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ openPanel: { left: null, right: null }, dockWidth: { left: DOCK_DEFAULT_WIDTH, right: DOCK_DEFAULT_WIDTH } });
});

function open(side: 'left' | 'right') {
  useUiStore.setState({ openPanel: { left: null, right: null, [side]: 'dock-test' } } as never);
  render(<DockArea side={side} />);
  return screen.getByRole('separator', { name: 'Resize panel' });
}

describe('dock resizer keyboard', () => {
  it('is a tab stop with value, min and max', () => {
    const sep = open('left');
    expect(sep.getAttribute('tabindex')).toBe('0');
    expect(sep.getAttribute('aria-valuenow')).toBe(String(DOCK_DEFAULT_WIDTH));
    expect(sep.getAttribute('aria-valuemin')).toBe(String(DOCK_MIN_WIDTH));
    expect(sep.getAttribute('aria-valuemax')).toBe(String(DOCK_MAX_WIDTH));
  });

  it('Left and Right move the edge by 16 px, following the edge on either side', () => {
    const sep = open('left');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(useUiStore.getState().dockWidth.left).toBe(DOCK_DEFAULT_WIDTH + 16);
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(useUiStore.getState().dockWidth.left).toBe(DOCK_DEFAULT_WIDTH - 16);
    expect(sep.getAttribute('aria-valuenow')).toBe(String(DOCK_DEFAULT_WIDTH - 16));
  });

  it('on a right dock, Left widens', () => {
    const sep = open('right');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(useUiStore.getState().dockWidth.right).toBe(DOCK_DEFAULT_WIDTH + 16);
  });

  it('Home and End go to the minimum and maximum', () => {
    const sep = open('left');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(useUiStore.getState().dockWidth.left).toBe(DOCK_MAX_WIDTH);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(useUiStore.getState().dockWidth.left).toBe(DOCK_MIN_WIDTH);
  });
});
