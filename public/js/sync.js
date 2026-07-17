// NTP-style clock offset estimation over the socket (spec §5.2).
// ~10 samples; offset = median offset of the 3 samples with lowest RTT.
// serverTime ≈ Date.now() + offset.

export async function syncClock(socket, samples = 10) {
  const results = [];
  for (let i = 0; i < samples; i++) {
    const sample = await pingOnce(socket);
    if (sample) results.push(sample);
    await sleep(25 + Math.random() * 35);
  }
  if (!results.length) return { offset: 0, minRtt: 9999, jitter: 9999 };
  results.sort((a, b) => a.rtt - b.rtt);
  const best = results.slice(0, Math.min(3, results.length));
  const offsets = best.map((r) => r.offset).sort((a, b) => a - b);
  const offset = offsets[Math.floor(offsets.length / 2)];
  const rtts = results.map((r) => r.rtt);
  return {
    offset,
    minRtt: rtts[0],
    jitter: Math.max(...best.map((r) => r.rtt)) - rtts[0],
  };
}

function pingOnce(socket) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve(null), 2000);
    socket.emit('sync:ping', t0, ({ t1 } = {}) => {
      clearTimeout(timer);
      const t2 = Date.now();
      if (typeof t1 !== 'number') return resolve(null);
      resolve({ rtt: t2 - t0, offset: t1 - (t0 + t2) / 2 });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
