import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoupeIcon, SearchIcon } from './icons';

describe('the Loupe icon (1.5.5 D3)', () => {
  it('has no circle (that is Search\'s glass), and Search keeps one', () => {
    expect(render(<LoupeIcon />).container.querySelector('circle')).toBeNull();
    expect(render(<SearchIcon />).container.querySelector('circle')).not.toBeNull();
  });
});
