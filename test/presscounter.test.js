// Space Mash press counting (spec §14): a held spacebar must score ~0, and
// sustained super-human rates must clamp and flag.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPressCounter } from '../shared/presscounter.js';

function clock() {
  let t = 0;
  return { now: () => t, tick: (ms) => (t += ms) };
}

test('held spacebar scores exactly 1 despite OS key-repeat storm', () => {
  const c = clock();
  const pc = createPressCounter({ now: c.now });
  // First physical press.
  pc.keydown(false);
  // OS key repeat: ~30/s keydowns with NO keyup, repeat flag unreliable —
  // simulate the worst case where the browser doesn't set e.repeat.
  for (let i = 0; i < 300; i++) {
    c.tick(33);
    pc.keydown(false);
  }
  assert.equal(pc.count, 1, 'holding the key must never beat a masher');
});

test('e.repeat flag is also filtered when the browser does set it', () => {
  const pc = createPressCounter({ now: clock().now });
  pc.keydown(false);
  for (let i = 0; i < 50; i++) pc.keydown(true);
  assert.equal(pc.count, 1);
});

test('honest mashing counts every press with keyups in between', () => {
  const c = clock();
  const pc = createPressCounter({ now: c.now });
  for (let i = 0; i < 80; i++) {
    pc.keydown(false);
    pc.keyup();
    c.tick(110); // ~9/s — typical human rate
  }
  assert.equal(pc.count, 80);
  assert.equal(pc.flagged, false);
});

test('macro at 40/s is clamped to the 20/s rolling cap and flagged', () => {
  const c = clock();
  const pc = createPressCounter({ capPerSec: 20, now: c.now });
  for (let i = 0; i < 400; i++) {
    pc.keydown(false);
    pc.keyup();
    c.tick(25); // 40 presses/sec for 10 seconds
  }
  assert.equal(pc.flagged, true);
  // 10 seconds at a 20/s cap → about 200 counted, never the full 400.
  assert.ok(pc.count <= 210, `count ${pc.count} must respect the cap`);
  assert.ok(pc.count >= 190);
});

test('pointerdown path counts like keydown+keyup', () => {
  const c = clock();
  const pc = createPressCounter({ now: c.now });
  for (let i = 0; i < 30; i++) {
    pc.pointerdown();
    c.tick(120);
  }
  assert.equal(pc.count, 30);
});
