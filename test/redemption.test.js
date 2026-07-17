// Redemption anti-spam (spec §5.1): reset-on-early-press means a masher
// never sees green and takes the hard timeout — asserted here under a fake
// clock, plus server-side scoring of reports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedemptionRun, scoreRedemptionReport } from '../shared/redemption-core.js';
import { fakeClock } from './fakeclock.js';

function run(clock, overrides = {}) {
  let result = null;
  let greens = 0;
  const machine = createRedemptionRun({
    initialDelay: 3000,
    minDelay: 2000,
    maxDelay: 6000,
    postGreenTimeout: 10000,
    hardTimeout: 25000,
    rng: () => 0.5, // deterministic reset delay: 2000 + 0.5*4000 = 4000ms
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onState: (s) => { if (s === 'green') greens++; },
    onFinish: (r) => { result = r; },
    ...overrides,
  });
  return { machine, result: () => result, greens: () => greens };
}

test('honest player: green at schedule, clean reaction time', () => {
  const clock = fakeClock();
  const r = run(clock);
  clock.advance(3000); // green fires
  clock.advance(280);
  r.machine.press();
  assert.deepEqual(r.result(), { status: 'ok', rawMs: 280, earlyPresses: 0 });
  assert.equal(r.greens(), 1);
});

test('single anticipatory press: silent reset, then fair finish', () => {
  const clock = fakeClock();
  const r = run(clock);
  clock.advance(2900);      // 100ms before green...
  r.machine.press();        // ...jumps the gun
  assert.equal(r.result(), null, 'no feedback, no finish — the light stays red');
  clock.advance(1000);      // old green time (t=3000) passes: nothing happens
  assert.equal(r.greens(), 0, 'original green must have been rescheduled');
  clock.advance(3000);      // reset delay was 4000ms from the press → green at t=6900
  assert.equal(r.greens(), 1);
  clock.advance(250);
  r.machine.press();
  const res = r.result();
  assert.equal(res.status, 'ok');
  assert.equal(res.rawMs, 250);
  assert.equal(res.earlyPresses, 1);
});

test('MASHER LOSES: continuous mashing never sees green, takes hard timeout', () => {
  const clock = fakeClock();
  const r = run(clock);
  // Mash at 40 presses/second for the whole round.
  while (clock.now() < 26000 && !r.result()) {
    clock.advance(25);
    if (!r.result()) r.machine.press();
  }
  const res = r.result();
  assert.equal(res.status, 'hardTimeout', 'masher must hit the hard timeout');
  assert.equal(r.greens(), 0, 'masher must never see green');
  assert.ok(res.earlyPresses > 500, `masher accumulated ${res.earlyPresses} early presses`);
  // And the server gives that report last place:
  const scored = scoreRedemptionReport(res, { earlyPressPenalty: 0.1 });
  assert.equal(scored.finalMs, 999999);
});

test('freezing after green: post-green timeout', () => {
  const clock = fakeClock();
  const r = run(clock);
  clock.advance(3000 + 10000);
  assert.equal(r.result().status, 'postGreenTimeout');
  assert.equal(scoreRedemptionReport(r.result()).finalMs, 10000);
});

test('press after finish is ignored', () => {
  const clock = fakeClock();
  const r = run(clock);
  clock.advance(3300);
  r.machine.press();
  const first = r.result();
  r.machine.press();
  assert.deepEqual(r.result(), first);
});

test('server scoring: 10% penalty per early press on top of raw time', () => {
  const s = scoreRedemptionReport({ status: 'ok', rawMs: 280, earlyPresses: 1 }, { earlyPressPenalty: 0.1 });
  assert.ok(Math.abs(s.finalMs - 308) < 1e-9);
  const s4 = scoreRedemptionReport({ status: 'ok', rawMs: 312, earlyPresses: 4 }, { earlyPressPenalty: 0.1 });
  assert.ok(Math.abs(s4.finalMs - 312 * 1.4) < 1e-9);
});

test('server scoring: sub-100ms reports are flagged as impossible, not crashed', () => {
  const s = scoreRedemptionReport({ status: 'ok', rawMs: 12, earlyPresses: 0 });
  assert.equal(s.flagged, true);
  assert.equal(s.finalMs, 999999);
});

test('honest ~280ms beats a masher and a one-time flincher beats a spammer', () => {
  const honest = scoreRedemptionReport({ status: 'ok', rawMs: 280, earlyPresses: 0 });
  const flinch = scoreRedemptionReport({ status: 'ok', rawMs: 250, earlyPresses: 1 });
  const masher = scoreRedemptionReport({ status: 'hardTimeout', rawMs: null, earlyPresses: 900 });
  assert.ok(honest.finalMs < masher.finalMs);
  assert.ok(flinch.finalMs < masher.finalMs);
});
