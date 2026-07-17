// Elimination ladder. See spec §3.
//
// The `>= 3` redemption guard is load-bearing: without it,
// survivors(n) = ceil(n/2) + 1, which is a fixed point at n = 3 (and converges
// to it from n = 4) — the game would never terminate. When the bottom half is
// fewer than 3 people, redemption is skipped and the bottom half is
// eliminated outright.

export function resolveRound(n) {
  if (n <= 3) return { type: 'FINAL' };
  const safeCount = Math.ceil(n / 2);   // top half survive outright
  const bottomCount = Math.floor(n / 2); // bottom half at risk
  const redemption = bottomCount >= 3;
  return {
    type: 'ROUND',
    safeCount,
    bottomCount,
    redemption,
    survivors: safeCount + (redemption ? 1 : 0),
  };
}

// Predicted ladder for n starting players, e.g. 20 -> [20, 11, 7, 5, 3].
// Ends at the count that enters the final (<= 3).
export function ladderFor(n) {
  const steps = [n];
  let cur = n;
  for (;;) {
    const r = resolveRound(cur);
    if (r.type === 'FINAL') break;
    cur = r.survivors;
    steps.push(cur);
  }
  return steps;
}

// Split a ranking at the cut line, sending ties at the boundary to redemption
// (spec §4.5 — never break a cut-line tie with a coin flip).
// ranking: [{ id, total }] sorted descending by total.
// Returns { safe, risk, tied, below, tieAtCut } — all arrays of ids.
// When tieAtCut is true: `safe` holds only players strictly above the cut
// score, `tied` holds everyone exactly at it, `below` everyone under it, and
// risk = tied + below.
export function splitAtCut(ranking, safeCount) {
  const ids = (arr) => arr.map((r) => r.id);
  if (ranking.length <= safeCount) {
    return { safe: ids(ranking), risk: [], tied: [], below: [], tieAtCut: false };
  }
  const cutScore = ranking[safeCount - 1].total;
  const tieAtCut = ranking[safeCount].total === cutScore;
  if (!tieAtCut) {
    return {
      safe: ids(ranking.slice(0, safeCount)),
      risk: ids(ranking.slice(safeCount)),
      tied: [],
      below: ids(ranking.slice(safeCount)),
      tieAtCut,
      cutScore,
    };
  }
  const safe = ranking.filter((r) => r.total > cutScore);
  const tied = ranking.filter((r) => r.total === cutScore);
  const below = ranking.filter((r) => r.total < cutScore);
  return {
    safe: ids(safe),
    risk: ids([...tied, ...below]),
    tied: ids(tied),
    below: ids(below),
    tieAtCut,
    cutScore,
  };
}
