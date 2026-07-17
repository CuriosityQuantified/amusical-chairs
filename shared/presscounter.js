// Space Mash press counting. See spec §14.
//
// The trap: `keydown` fires repeatedly while a key is held (OS key repeat,
// ~30/s). `event.repeat` is unreliable across browser/OS combinations, so it
// is used only as a cheap first filter — the airtight defense is requiring a
// keyup between counted keydowns.
//
// Anti-macro: rolling cap of `capPerSec` presses within any 1s window.
// Presses beyond the cap are not counted and the counter is flagged.

export function createPressCounter({ capPerSec = 20, now } = {}) {
  const clock = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let count = 0;
  let keyIsDown = false;
  let flagged = false;
  const recent = [];

  function press() {
    const t = clock();
    while (recent.length && t - recent[0] > 1000) recent.shift();
    // Only counted presses occupy the window, so sustained over-cap input is
    // clamped to capPerSec/s rather than locking the counter up entirely.
    if (recent.length >= capPerSec) {
      flagged = true;
      return false;
    }
    recent.push(t);
    count++;
    return true;
  }

  return {
    // repeat: the event's `repeat` flag — used as a first filter only.
    keydown(repeat = false) {
      if (repeat) return false;      // cheap filter (unreliable alone)
      if (keyIsDown) return false;   // key-repeat or held key — the real gate
      keyIsDown = true;
      return press();
    },
    keyup() {
      keyIsDown = false;
    },
    // Touch/mouse path: wire to `pointerdown`, never `click` (mobile click
    // delay would halve phone scores).
    pointerdown() {
      return press();
    },
    get count() {
      return count;
    },
    get flagged() {
      return flagged;
    },
  };
}
