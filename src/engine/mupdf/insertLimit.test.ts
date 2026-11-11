// 1.5.5 C7: the sheet and the engine read one constant (protocol.ts); editCore re-exports it, so they cannot differ.
import { expect, it } from 'vitest';
import { MAX_INSERT_COUNT as FROM_ENGINE } from './editCore';
import { MAX_INSERT_COUNT as FROM_PROTOCOL } from './protocol';

it('the engine and the sheets use the same pages-per-insert limit', () => {
  expect(FROM_ENGINE).toBe(FROM_PROTOCOL);
  expect(FROM_ENGINE).toBe(1000);
});
