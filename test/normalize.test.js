import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, normalizeError, normalizeScore } from '../shared/normalize.js';

test('percentile: linear interpolation', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([0, 10], 90), 9);
  assert.equal(percentile([7], 90), 7);
});

test('normalizeError: best gets 1000, values at/beyond P90 get 0', () => {
  const errors = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const out = normalizeError(errors);
  assert.equal(out[0], 1000);
  assert.equal(out[9], 0); // 100 >= p90 (91) → clamped to 0
  for (let i = 1; i < out.length; i++) assert.ok(out[i] <= out[i - 1]);
});

test('normalizeError: P90 clamp stops an outlier compressing the field', () => {
  const errors = [1, 2, 3, 1000];
  const out = normalizeError(errors);
  // Without the clamp, players 1–3 would all land within ~0.2% of each
  // other at the top of the scale. With it, they spread meaningfully.
  assert.equal(out[0], 1000);
  assert.equal(out[3], 0);
  assert.ok(out[0] - out[1] > 1, 'adjacent honest players must be distinguishable');
  assert.ok(out[1] - out[2] > 1);
});

test('normalizeError: identical values all score 1000', () => {
  assert.deepEqual(normalizeError([5, 5, 5]), [1000, 1000, 1000]);
});

test('normalizeScore: mirror behavior with P10 floor clamp', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const out = normalizeScore(values);
  assert.equal(out[9], 1000);
  assert.equal(out[0], 0); // 10 <= p10 (19) → clamped to 0
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1]);
  assert.deepEqual(normalizeScore([7, 7]), [1000, 1000]);
});

test('normalized scores stay within 0..1000', () => {
  for (const vals of [[1, 2], [0, 0, 0], [3, 9, 27, 81], [-5, 0, 5]]) {
    for (const v of normalizeError(vals)) assert.ok(v >= 0 && v <= 1000);
    for (const v of normalizeScore(vals)) assert.ok(v >= 0 && v <= 1000);
  }
});
