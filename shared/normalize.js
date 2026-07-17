// Score normalization. See spec §4.
// Each minigame is normalized independently, within the round, across only
// the players who played it, to 0–1000. Do NOT rank-sum — rank sums produce
// frequent exact ties; normalize on the continuous underlying value.

export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// Error-type games: lower is better. The P90 clamp stops one catastrophic
// outlier from compressing everyone else into the top 5% of the scale.
export function normalizeError(errors) {
  const min = Math.min(...errors);
  const p90 = percentile(errors, 90);
  const span = p90 - min;
  return errors.map((e) => {
    if (span <= 0) return 1000; // everyone identical
    const clamped = Math.min(e, p90);
    return 1000 * (1 - (clamped - min) / span);
  });
}

// Score-type games: higher is better. P10 clamp mirrors the above.
export function normalizeScore(values) {
  const max = Math.max(...values);
  const p10 = percentile(values, 10);
  const span = max - p10;
  return values.map((v) => {
    if (span <= 0) return 1000;
    const clamped = Math.max(v, p10);
    return (1000 * (clamped - p10)) / span;
  });
}
