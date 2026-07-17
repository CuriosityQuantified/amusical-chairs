// Unique Answer clustering. See spec §6.3 game 10.
// Normalize: lowercase, trim, collapse whitespace, strip punctuation and
// leading articles, naive singularize — then group by Levenshtein distance <= 2.

const ARTICLES = new Set(['a', 'an', 'the', 'some', 'my']);

export function normalizeAnswer(s) {
  let t = String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = t.split(' ').filter((w) => w && !ARTICLES.has(w));
  const singular = words.map((w) => {
    if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  });
  return singular.join(' ');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// entries: [{ id, answer }]
// Returns array of clusters: { members: [id], answers: [raw], label }
export function clusterAnswers(entries) {
  const items = entries.map((e) => ({ ...e, norm: normalizeAnswer(e.answer) }));
  // Union-find over pairs with distance <= 2 on normalized forms.
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].norm === items[j].norm || levenshtein(items[i].norm, items[j].norm) <= 2) {
        union(i, j);
      }
    }
  }
  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()].map((members) => ({
    members: members.map((m) => m.id),
    answers: members.map((m) => m.answer),
    label: mostCommon(members.map((m) => m.norm)) || members[0].answer,
    size: members.length,
  }));
}

function mostCommon(arr) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const v of arr) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}
