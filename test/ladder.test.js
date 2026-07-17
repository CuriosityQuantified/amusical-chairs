// The single most important test in the project (spec §3.3): the elimination
// ladder must strictly decrease and terminate for every starting count.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRound, ladderFor, splitAtCut } from '../shared/ladder.js';

test('ladder strictly decreases and terminates for n = 3..40', () => {
  for (let start = 3; start <= 40; start++) {
    let n = start;
    let rounds = 0;
    for (;;) {
      const r = resolveRound(n);
      if (r.type === 'FINAL') break;
      assert.ok(r.survivors < n, `n=${n} must strictly decrease (got ${r.survivors})`);
      assert.ok(r.survivors >= 2, `n=${n} must not collapse below 2`);
      n = r.survivors;
      rounds++;
      assert.ok(rounds <= 20, `start=${start} did not terminate`);
    }
    assert.ok(n <= 3, `start=${start} must end at <= 3 players (got ${n})`);
  }
});

test('verified ladders from the spec table', () => {
  assert.deepEqual(ladderFor(30), [30, 16, 9, 6, 4, 2]);
  assert.deepEqual(ladderFor(25), [25, 14, 8, 5, 3]);
  assert.deepEqual(ladderFor(20), [20, 11, 7, 5, 3]);
  assert.deepEqual(ladderFor(15), [15, 9, 6, 4, 2]);
  assert.deepEqual(ladderFor(10), [10, 6, 4, 2]);
  assert.deepEqual(ladderFor(6), [6, 4, 2]);
});

test('redemption guard: no redemption when bottom half < 3', () => {
  // Without the guard, survivors(3) = 3 and survivors(4) = 3 forever.
  assert.equal(resolveRound(4).redemption, false);
  assert.equal(resolveRound(5).redemption, false);
  assert.equal(resolveRound(6).redemption, true);
  assert.equal(resolveRound(3).type, 'FINAL');
});

test('splitAtCut: clean cut', () => {
  const ranking = [
    { id: 'a', total: 900 },
    { id: 'b', total: 800 },
    { id: 'c', total: 700 },
    { id: 'd', total: 600 },
  ];
  const s = splitAtCut(ranking, 2);
  assert.deepEqual(s.safe, ['a', 'b']);
  assert.deepEqual(s.risk, ['c', 'd']);
  assert.equal(s.tieAtCut, false);
});

test('splitAtCut: tie spanning the cut sends ALL tied players to risk (§4.5)', () => {
  const ranking = [
    { id: 'a', total: 900 },
    { id: 'b', total: 700 },
    { id: 'c', total: 700 },
    { id: 'd', total: 700 },
    { id: 'e', total: 300 },
    { id: 'f', total: 100 },
  ];
  // safeCount = 3: b, c, d all tied at the boundary score.
  const s = splitAtCut(ranking, 3);
  assert.deepEqual(s.safe, ['a']);
  assert.deepEqual(s.tied.sort(), ['b', 'c', 'd']);
  assert.deepEqual(s.below.sort(), ['e', 'f']);
  assert.equal(s.tieAtCut, true);
  assert.equal(s.risk.length, 5);
});

test('splitAtCut: everyone above the cut is unaffected by ties below it', () => {
  const ranking = [
    { id: 'a', total: 900 },
    { id: 'b', total: 800 },
    { id: 'c', total: 500 },
    { id: 'd', total: 500 },
  ];
  const s = splitAtCut(ranking, 2);
  assert.deepEqual(s.safe, ['a', 'b']);
  assert.equal(s.tieAtCut, false);
});
