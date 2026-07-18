// Server-side minigame definitions: roster metadata, per-round content
// generation (seeded, identical for every player), and metric computation.
// Metrics returned as `null` mean "treat as non-submission" (§4.6: P90 clamp,
// normalized 0, NOT auto-elimination).

import { randInt, shuffle, pick } from '../shared/rng.js';
import { rgbToLab, ciede2000 } from '../shared/ciede2000.js';

const SENTENCES = [
  'The quick brown fox jumps over the lazy dog while the band plays on.',
  'Never trust an elevator that smells faintly of fresh paint and regret.',
  'Somewhere in this building a printer is jamming for no reason at all.',
  'A committee is a group that keeps minutes and loses hours every week.',
  'The wifi is strongest in the one room nobody ever wants to sit in.',
  'Please do not feed the seagulls; they have unionized and want snacks.',
  'My keyboard has a key that only works when I am not looking at it.',
  'The meeting could have been an email, and the email could have waited.',
  'Half of debugging is staring; the other half is apologizing to the code.',
  'If you can read this sentence quickly, your coffee is finally working.',
];

const ROOM_QUESTIONS = [
  'Have you ever fallen asleep in a meeting?',
  'Do you sing in the shower?',
  'Have you ever pretended your camera was broken to skip video?',
  'Do you eat pizza with a fork?',
  'Have you ever sent a message to the wrong chat?',
  'Do you make your bed every day?',
  'Have you ever laughed at a meme during a serious meeting?',
  'Do you still know your childhood phone number?',
  'Have you ever worn pajama pants on a video call?',
  'Do you talk to yourself out loud while working?',
  'Do you snooze your alarm more than twice?',
  'Have you ever returned a gift for the money?',
];

export const ROSTER = [
  { key: 'rgb', name: 'RGB Color Match', category: 'perceptual', type: 'error' },
  { key: 'oddoneout', name: 'Odd One Out', category: 'perceptual', type: 'score' },
  { key: 'bisect', name: 'Bisect the Line', category: 'perceptual', type: 'error' },
  { key: 'trace', name: 'Trace the Shape', category: 'perceptual', type: 'error' },
  { key: 'dots', name: 'Dots in the Jar', category: 'numerical', type: 'error' },
  { key: 'stopclock', name: 'Stop the Clock', category: 'timing', type: 'error' },
  { key: 'gridflash', name: 'Grid Flash', category: 'memory', type: 'error' },
  { key: 'readroom', name: 'Read the Room', category: 'social', type: 'error' },
  { key: 'typing', name: 'Typing Sprint', category: 'motor', type: 'score', keyboardOnly: true },
  { key: 'spacemash', name: 'Space Mash', category: 'motor', type: 'score' },
  { key: 'slingshot', name: 'Slingshot', category: 'motor', type: 'error' },
];

export const ROSTER_BY_KEY = new Map(ROSTER.map((g) => [g.key, g]));
export const NEEDS_AGGREGATION = new Set(['readroom']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Pick an index into a content list, avoiding repeats within a session.
function pickContent(rng, listLen, usedSet) {
  let candidates = [];
  for (let i = 0; i < listLen; i++) if (!usedSet.has(i)) candidates.push(i);
  if (!candidates.length) candidates = [...Array(listLen).keys()];
  const idx = candidates[Math.floor(rng() * candidates.length)];
  usedSet.add(idx);
  return idx;
}

// Build the per-round data for a game. `clientData` is broadcast to players;
// `secret` stays server-side (answers).
// ctx: { rng, config, used } — `used` maps content-list name -> Set of indices.
export function buildGameData(key, ctx) {
  const { rng, config, used } = ctx;
  const usedSet = (name) => {
    if (!used[name]) used[name] = new Set();
    return used[name];
  };
  switch (key) {
    case 'rgb': {
      // Mid-saturation / mid-lightness targets — near-black and near-white
      // compress the perceptual scale.
      const target = { r: randInt(rng, 50, 205), g: randInt(rng, 50, 205), b: randInt(rng, 50, 205) };
      return { clientData: { target }, secret: { target } };
    }
    case 'oddoneout':
      return { clientData: { seed: `odd-${Math.floor(rng() * 1e9)}` }, secret: {} };
    case 'bisect': {
      const targets = [];
      while (targets.length < 5) {
        const t = randInt(rng, 7, 93);
        if (!targets.some((x) => Math.abs(x - t) < 4)) targets.push(t);
      }
      return { clientData: { targets }, secret: { targets } };
    }
    case 'trace':
      return {
        clientData: { shape: pick(rng, ['spiral', 'star', 'wave']), seed: `trace-${Math.floor(rng() * 1e9)}` },
        secret: {},
      };
    case 'dots': {
      const counts = [randInt(rng, 22, 40), randInt(rng, 90, 150), randInt(rng, 300, 500)];
      return { clientData: { counts, seed: `dots-${Math.floor(rng() * 1e9)}` }, secret: { counts } };
    }
    case 'stopclock':
      return { clientData: { targetMs: 10000, visibleMs: 3000, attempts: 2 }, secret: {} };
    case 'gridflash': {
      const patterns = [0, 1].map(() => shuffle(rng, [...Array(25).keys()]).slice(0, 8).sort((a, b) => a - b));
      return { clientData: { patterns, showMs: 4000 }, secret: { patterns } };
    }
    case 'readroom': {
      const idx = pickContent(rng, ROOM_QUESTIONS.length, usedSet('readroom'));
      return { clientData: { question: ROOM_QUESTIONS[idx] }, secret: {} };
    }
    case 'typing': {
      const idx = pickContent(rng, SENTENCES.length, usedSet('typing'));
      return { clientData: { sentence: SENTENCES[idx] }, secret: { sentence: SENTENCES[idx] } };
    }
    case 'spacemash':
      return { clientData: { activeMs: 10000, capPerSec: 20 }, secret: {} };
    case 'slingshot':
      return {
        clientData: { distance: config.slingshotDistance, shots: 5, rings: [2, 5, 10, 20] },
        secret: {},
      };
    default:
      throw new Error(`unknown game key ${key}`);
  }
}

// Compute the raw metric for one player's submission. Returns null for
// "counts as non-submission". Payloads are untrusted — validate and clamp.
export function computeMetric(key, payload, secret, clientData, config) {
  if (!payload || typeof payload !== 'object') return null;
  switch (key) {
    case 'rgb': {
      const r = num(payload.r);
      const g = num(payload.g);
      const b = num(payload.b);
      if (r == null || g == null || b == null) return null;
      const guess = { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) };
      return ciede2000(rgbToLab(secret.target), rgbToLab(guess));
    }
    case 'oddoneout': {
      const c = num(payload.cleared);
      if (c == null) return null;
      return clamp(Math.floor(c), 0, 300);
    }
    case 'bisect': {
      if (!Array.isArray(payload.guesses)) return null;
      const targets = secret.targets;
      let any = false;
      let sum = 0;
      for (let i = 0; i < targets.length; i++) {
        const g = num(payload.guesses[i]);
        if (g == null) {
          sum += 50; // missed sub-trial: worst plausible deviation
        } else {
          any = true;
          sum += Math.abs(clamp(g, 0, 100) - targets[i]);
        }
      }
      return any ? sum : null;
    }
    case 'trace': {
      const dev = num(payload.deviation);
      const cov = num(payload.coverage);
      // Spec: require >= 90% path coverage or the attempt scores P90.
      if (dev == null || cov == null || cov < 0.9) return null;
      return clamp(dev, 0, 2);
    }
    case 'dots': {
      if (!Array.isArray(payload.guesses)) return null;
      const truths = secret.counts;
      let any = false;
      let sum = 0;
      for (let i = 0; i < truths.length; i++) {
        const g = num(payload.guesses[i]);
        if (g == null || g < 0) {
          sum += 1; // missing trial = 100% relative error
        } else {
          any = true;
          // Relative error so the big-magnitude trial doesn't dominate (§6.3).
          sum += clamp(Math.abs(g - truths[i]) / truths[i], 0, 5);
        }
      }
      return any ? sum : null;
    }
    case 'stopclock': {
      const best = num(payload.best);
      if (best == null || best < 0) return null;
      return clamp(best, 0, 60000);
    }
    case 'gridflash': {
      if (!Array.isArray(payload.picks)) return null;
      let total = 0;
      for (let r = 0; r < secret.patterns.length; r++) {
        const pattern = new Set(secret.patterns[r]);
        const raw = Array.isArray(payload.picks[r]) ? payload.picks[r] : [];
        const picks = new Set(
          raw.filter((c) => Number.isInteger(c) && c >= 0 && c < 25).slice(0, 25)
        );
        let diff = 0;
        for (const c of pattern) if (!picks.has(c)) diff++;
        for (const c of picks) if (!pattern.has(c)) diff++;
        total += diff;
      }
      return total;
    }
    case 'typing': {
      const typed = typeof payload.typed === 'string' ? payload.typed.slice(0, 500) : null;
      if (typed == null || !typed.length) return null;
      const s = secret.sentence;
      let correct = 0;
      let errors = 0;
      for (let i = 0; i < typed.length; i++) {
        if (i < s.length && typed[i] === s[i]) correct++;
        else errors++;
      }
      const elapsed = clamp(num(payload.elapsedMs) ?? config.gameDuration, 3000, Math.max(3000, config.gameDuration));
      const cpm = correct / (elapsed / 60000);
      return Math.max(0, cpm - 5 * errors);
    }
    case 'spacemash': {
      const c = num(payload.count);
      if (c == null) return null;
      const cap = Math.ceil((clientData.capPerSec * clientData.activeMs) / 1000);
      return clamp(Math.floor(c), 0, cap);
    }
    case 'slingshot': {
      const best = num(payload.best);
      if (best == null || best < 0) return null;
      return clamp(best, 0, 500);
    }
    default:
      return null;
  }
}

// Social games need every submission before anyone can be scored.
// entries: [{ playerId, payload }]. Returns { metrics: Map, extra }.
export function aggregateGame(key, entries) {
  if (key === 'readroom') {
    const valid = entries.filter((e) => e.payload && typeof e.payload.answer === 'boolean');
    const metrics = new Map();
    if (!valid.length) return { metrics, extra: { actualPct: null } };
    const yes = valid.filter((e) => e.payload.answer).length;
    const actualPct = (100 * yes) / valid.length;
    for (const e of valid) {
      const pred = num(e.payload.prediction);
      if (pred == null) continue; // answered but never predicted → non-submission
      metrics.set(e.playerId, Math.abs(clamp(pred, 0, 100) - actualPct));
    }
    return { metrics, extra: { actualPct: Math.round(actualPct) } };
  }
  throw new Error(`game ${key} does not aggregate`);
}

// Human-readable raw value for the reveal screens.
export function formatRaw(key, metric, payload) {
  if (metric == null) return 'no submission';
  switch (key) {
    case 'rgb': return `ΔE ${metric.toFixed(1)}`;
    case 'oddoneout': return `${metric} tiles`;
    case 'bisect': return `${metric.toFixed(1)} pts off`;
    case 'trace': return `${(metric * 100).toFixed(1)}% dev`;
    case 'dots': return `${(metric * 100).toFixed(0)}% off`;
    case 'stopclock': return `${Math.round(metric)} ms off`;
    case 'gridflash': return `${metric} cells off`;
    case 'readroom': return `${metric.toFixed(0)} pts off`;
    case 'typing': return `${Math.round(metric)} net cpm`;
    case 'spacemash': return `${metric} presses${payload?.flagged ? ' ⚠' : ''}`;
    case 'slingshot': return `${metric.toFixed(1)} ft`;
    default: return String(metric);
  }
}
