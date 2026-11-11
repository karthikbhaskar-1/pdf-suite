import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/services', () => ({ keymap: { shortcutFor: () => undefined }, fileService: { listRecent: async () => [] } }));

import { commands } from '../../core/commands/registry';
import { ToolbarButton } from './toolbarControls';

afterEach(cleanup);

describe('Delete and Rotate tooltips (1.5.5 D5)', () => {
  it('a target line is the tooltip\'s second line and the button\'s accessible description', () => {
    vi.spyOn(commands, 'isEnabled').mockReturnValue(true);
    render(<ToolbarButton commandId="pages.delete" label="Delete" name="Delete pages" icon={null} targetLine="Acts on the 3 selected pages." />);
    const button = screen.getByRole('button', { name: 'Delete pages' });
    expect(button.getAttribute('data-tooltip')).toBe('Delete pages\nActs on the 3 selected pages.');
    const id = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)!.textContent).toBe('Acts on the 3 selected pages.');
  });

  it('with no target line the tooltip is one line and there is no description', () => {
    vi.spyOn(commands, 'isEnabled').mockReturnValue(true);
    render(<ToolbarButton commandId="pages.delete" label="Delete" name="Delete pages" icon={null} />);
    const button = screen.getByRole('button', { name: 'Delete pages' });
    expect(button.getAttribute('data-tooltip')).toBe('Delete pages');
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });
});
