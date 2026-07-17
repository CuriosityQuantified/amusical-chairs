// Deterministic fake clock + timer scheduler for testing the redemption
// state machine without real time.

export function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, delay) {
      const id = nextId++;
      timers.set(id, { at: t + Math.max(0, delay), fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    // Advance time, firing due timers in order.
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let earliest = null;
        for (const [id, tm] of timers) {
          if (tm.at <= end && (!earliest || tm.at < earliest.at)) earliest = { id, ...tm };
        }
        if (!earliest) break;
        timers.delete(earliest.id);
        t = earliest.at;
        earliest.fn();
      }
      t = end;
    },
  };
}
