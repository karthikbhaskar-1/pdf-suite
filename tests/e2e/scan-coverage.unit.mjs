// Unit test of the pure coverage logic of the thumbnail scan. Run: node --test tests/e2e/scan-coverage.unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverage } from './scan-coverage.mjs';

const uniform = (n, h = 100, gap = 10, start = 0) => Array.from({ length: n }, (_, i) => ({ top: start + i * (h + gap), height: h }));

test('a list shorter than the viewport is covered when its rows reach the end of the content', () => {
  const rows = uniform(3);
  assert.equal(coverage(rows, { from: 0, to: 330, scrollHeight: 330 }).covered, true);
});

test('a short list with its last row missing is not covered', () => {
  const rows = uniform(2);
  const r = coverage(rows, { from: 0, to: 330, scrollHeight: 330 });
  assert.equal(r.covered, false);
  assert.deepEqual(r.missing, [[210, 330]]);
});

test('a short list with its first row missing is not covered', () => {
  const rows = uniform(3).slice(1);
  assert.equal(coverage(rows, { from: 0, to: 330, scrollHeight: 330 }).covered, false);
});

test('mixed row heights are covered from their real positions', () => {
  const heights = [80, 220, 140, 300, 90, 160];
  let top = 0;
  const rows = heights.map((h) => {
    const row = { top, height: h };
    top += h + 8;
    return row;
  });
  assert.equal(coverage(rows, { from: 100, to: 700, scrollHeight: top }).covered, true);
  // Drop a tall row from the middle: a hole opens inside the range.
  const holed = rows.filter((_, i) => i !== 3);
  const r = coverage(holed, { from: 100, to: 700, scrollHeight: top });
  assert.equal(r.covered, false);
  assert.equal(r.missing.length, 1);
});

test('rows that stop short of the bottom of the range are not covered', () => {
  const rows = uniform(5);
  assert.equal(coverage(rows, { from: 0, to: 800, scrollHeight: 5000 }).covered, false);
  assert.equal(coverage(rows, { from: 0, to: 500, scrollHeight: 5000 }).covered, true);
});

test('a mid-list range needs a row at its top', () => {
  const rows = uniform(4, 100, 10, 1000);
  assert.equal(coverage(rows, { from: 900, to: 1300, scrollHeight: 5000 }).covered, false);
  assert.equal(coverage(rows, { from: 1000, to: 1300, scrollHeight: 5000 }).covered, true);
});

test('padding at the start and end of the list is allowed', () => {
  const rows = uniform(3, 100, 10, 12);
  assert.equal(coverage(rows, { from: 0, to: 342, scrollHeight: 342 }).covered, true);
});

test('no rows drawn means not covered, an empty list is covered', () => {
  assert.equal(coverage([], { from: 0, to: 500, scrollHeight: 500 }).covered, false);
  assert.equal(coverage([], { from: 0, to: 0, scrollHeight: 0 }).covered, true);
});
