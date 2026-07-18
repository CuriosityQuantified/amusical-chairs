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
  'Our team synergy peaked the day the vending machine started working.',
  'I put my keys somewhere safe and now they are gone forever, obviously.',
  'The office plant has seen things no fern should ever have to witness.',
  'Reply all is a button that has ended more careers than we can count.',
  'My password is strong, unique, and written on a sticky note right here.',
  'The mute button works perfectly except when you actually need it most.',
  'The fastest way to find a typo is to hit send and wait three seconds.',
  'Our roadmap is less of a map and more of a vibe with quarterly labels.',
  'Nothing motivates a team like a deadline that was due yesterday.',
  'I have a filing system for my desktop: chaos, sorted alphabetically.',
  'The intern fixed in an hour what we argued about for eleven meetings.',
  'A watched progress bar never loads, but an ignored one fails silently.',
  'My calendar has back to back meetings about reducing meeting overload.',
  'The printer senses fear and jams accordingly during important demos.',
  'We renamed the folder final, then final two, then final for real now.',
  'Someone microwaved fish again and the whole floor is now in mourning.',
  'My browser has ninety tabs open and each one is a broken promise.',
  'The standup ran long because nobody could agree on what short means.',
  'Autocorrect has never once corrected a word into something better.',
  'The snack drawer is a shared resource governed by unspoken treaties.',
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
  'Have you ever blamed the wifi to escape a meeting that was going fine?',
  'Do you put ketchup on eggs?',
  'Have you ever eaten clearly-labeled food from the office fridge?',
  'Do you clap when the plane lands?',
  'Have you ever googled how to spell a word you use every day?',
  'Do you double-dip chips at parties?',
  'Have you ever waved back at someone who was not waving at you?',
  'Do you actually read the terms and conditions?',
  'Have you ever faked knowing a name for more than a month?',
  'Do you sleep with socks on?',
  'Have you ever cried at a commercial?',
  'Do you check your phone within one minute of waking up?',
  'Have you ever rehearsed an argument in the shower you never had?',
  'Do you own more than five houseplants?',
  'Have you ever liked your own post?',
  'Do you eat cereal for dinner?',
  'Have you ever practiced your coffee order before reaching the counter?',
  'Have you ever pushed a door that clearly said pull?',
  'Do you apologize to furniture when you bump into it?',
  'Have you ever faked a phone call to escape a conversation?',
  'Do you have a junk drawer you are slightly afraid to open?',
  'Have you ever re-gifted a present?',
  'Do you save the pizza crusts for last?',
  'Have you ever texted someone sitting in the same room?',
  'Do you have more than 1,000 unread emails?',
  'Do you believe in ghosts?',
  'Have you ever googled yourself?',
  'Do you hoard sauce packets in a drawer?',
  'Have you ever fake-laughed at the boss’s joke?',
  'Do you know every word of at least one 2000s pop song?',
  'Have you ever worn the same shirt on video calls two days in a row?',
  'Do you narrate your pet’s inner thoughts out loud?',
  'Have you ever missed a flight?',
  'Do you screenshot things you will never look at again?',
  'Have you ever joined a meeting from a bathroom?',
  'Do you think pineapple belongs on pizza?',
  'Have you ever said “you too” to a waiter who said “enjoy your meal”?',
  'Do you still count on your fingers?',
  'Have you ever pretended to take notes to look busy?',
  'Do you dance when nobody is watching?',
  'Have you ever locked yourself out of your own home?',
  'Do you keep cables for devices you no longer own?',
  'Have you ever cried during an animated movie as an adult?',
  'Do you talk to your plants?',
  'Have you ever eaten dessert before dinner as an adult?',
  'Do you replay conversations from years ago and cringe?',
  'Have you ever been on TV?',
  'Do you sleep with more than two pillows?',
  'Have you ever won a raffle?',
  'Do you use dark mode on everything?',
  'Have you ever briefly forgotten your own age?',
  'Do you keep your phone permanently on silent?',
  'Have you ever gone back home just to check the door was locked?',
  'Do you confidently sing lyrics that turn out to be wrong?',
  'Have you ever laughed so hard at work that you cried?',
  'Do you have an emergency snack within arm’s reach right now?',
  'Have you ever sent a voice message of pure silence by accident?',
  'Do you keep a box of old birthday cards?',
  'Have you ever said goodbye and then walked in the same direction?',
  'Do you re-check the fridge hoping new food has appeared?',
  'Have you ever fallen off a chair in public?',
  'Do you set alarms for weird times like 7:03?',
  'Have you ever called a teacher “mom” or a boss “dad”?',
  'Do you keep the box your phone came in?',
  'Have you ever watched an entire season in one day?',
  'Do you take the stairs only when someone is watching?',
  'Have you ever clapped alone at the end of a presentation?',
  'Do you own a kitchen gadget you have used exactly once?',
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
        clientData: {
          shape: pick(rng, [
            'spiral', 'star', 'wave', 'zigzag', 'infinity',
            'heart', 'circle', 'triangle', 'square', 'diamond',
            'hourglass', 'hexagon', 'bolt', 'arrow', 'cross',
          ]),
          seed: `trace-${Math.floor(rng() * 1e9)}`,
        },
        secret: {},
      };
    case 'dots': {
      const counts = [randInt(rng, 22, 40), randInt(rng, 90, 150), randInt(rng, 300, 500)];
      return { clientData: { counts, seed: `dots-${Math.floor(rng() * 1e9)}` }, secret: { counts } };
    }
    case 'stopclock': {
      // Random target 6.0–10.0s (half-second steps) so nobody can pre-train
      // a single interval.
      const targetMs = randInt(rng, 12, 20) * 500;
      return { clientData: { targetMs, visibleMs: 3000, attempts: 2 }, secret: {} };
    }
    case 'gridflash': {
      // 6–9 lit cells per round — pattern size varies between sessions.
      const patterns = [0, 1].map(() =>
        shuffle(rng, [...Array(25).keys()]).slice(0, randInt(rng, 6, 9)).sort((a, b) => a - b));
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
    case 'slingshot': {
      // Jitter the host's base distance ±25% so range-finding stays a skill.
      const distance = clamp(Math.round(config.slingshotDistance * (0.75 + rng() * 0.5)), 30, 150);
      return {
        clientData: { distance, shots: 5, rings: [2, 5, 10, 20] },
        secret: {},
      };
    }
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
