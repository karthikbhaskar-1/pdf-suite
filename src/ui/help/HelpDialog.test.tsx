import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { APP_VERSION } from '../../core/appInfo';
import { COPYRIGHT_HOLDER, LICENSE_NAME, NO_WARRANTY_NOTICE, REPOSITORY_URL } from '../../core/repoInfo';
import { useUiStore } from '../../core/stores/uiStore';
import { HelpDialog } from './HelpDialog';

afterEach(() => {
  cleanup();
  useUiStore.setState({ helpDialog: null });
});

describe('About dialog', () => {
  it('shows the version, the license name and the source code link', () => {
    useUiStore.setState({ helpDialog: 'about' });
    const { container } = render(<HelpDialog />);
    const text = container.textContent ?? '';
    expect(text).toContain(`version ${APP_VERSION}`);
    expect(text).toContain(`Copyright (c) ${COPYRIGHT_HOLDER}`);
    expect(text).toContain('This program comes with ABSOLUTELY NO WARRANTY.');
    expect(text).toContain(NO_WARRANTY_NOTICE);
    expect(text).toContain(`License: ${LICENSE_NAME}`);
    expect(text).toContain(`Source code: ${REPOSITORY_URL}`);
  });

  it('points at the project repository', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/karthikbhaskar-1/pdf-suite');
  });
});

describe('Help panels take focus (1.5.5 C3)', () => {
  it('focus goes to Close on open, the body is a labelled region, Esc closes only the panel, focus returns', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    useUiStore.setState({ helpDialog: 'shortcuts' });
    const { container } = render(<HelpDialog />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    const body = container.querySelector('.help-body') as HTMLElement;
    expect(body.getAttribute('role')).toBe('region');
    expect(body.getAttribute('aria-label')).toBeTruthy();
    expect(body.tabIndex).toBe(0);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(useUiStore.getState().helpDialog).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
