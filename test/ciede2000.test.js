// CIEDE2000 verified against reference pairs from Sharma, Wu & Dalal (2005),
// the canonical test dataset for the formula.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ciede2000, rgbToLab, ciede2000Rgb } from '../shared/ciede2000.js';

const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test('Sharma reference pairs', () => {
  const cases = [
    [{ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 }, 2.0425],
    [{ L: 50, a: 3.1571, b: -77.2803 }, { L: 50, a: 0, b: -82.7485 }, 2.8615],
    [{ L: 50, a: 2.8361, b: -74.02 }, { L: 50, a: 0, b: -82.7485 }, 3.4412],
    [{ L: 50, a: 2.5, b: 0 }, { L: 73, a: 25, b: -18 }, 27.1492],
    [{ L: 50, a: 2.5, b: 0 }, { L: 50, a: 3.2592, b: 0.335 }, 1.0],
  ];
  for (const [lab1, lab2, expected] of cases) {
    const got = ciede2000(lab1, lab2);
    assert.ok(close(got, expected), `expected ${expected}, got ${got.toFixed(4)}`);
    const sym = ciede2000(lab2, lab1);
    assert.ok(close(sym, expected), `symmetry: expected ${expected}, got ${sym.toFixed(4)}`);
  }
});

test('rgbToLab: white, black, primary sanity', () => {
  const white = rgbToLab({ r: 255, g: 255, b: 255 });
  assert.ok(close(white.L, 100, 0.1));
  assert.ok(Math.abs(white.a) < 0.01 && Math.abs(white.b) < 0.01);
  const black = rgbToLab({ r: 0, g: 0, b: 0 });
  assert.ok(close(black.L, 0, 0.1));
});

test('perceptual, not Euclidean: identical colors are 0, close colors small', () => {
  assert.equal(ciede2000Rgb({ r: 120, g: 90, b: 200 }, { r: 120, g: 90, b: 200 }), 0);
  const near = ciede2000Rgb({ r: 120, g: 90, b: 200 }, { r: 123, g: 92, b: 197 });
  const far = ciede2000Rgb({ r: 120, g: 90, b: 200 }, { r: 200, g: 180, b: 40 });
  assert.ok(near < 5);
  assert.ok(far > 30);
  assert.ok(near < far);
});
