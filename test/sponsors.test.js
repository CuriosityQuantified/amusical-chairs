// Sponsored rounds: guardrails (≤ SPONSOR_CAP per session, always labeled,
// Odd One Out never sponsored) and content swaps (brand color / logo shape /
// sentences / questions) that leave mechanics and difficulty untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { seededRng } from '../shared/rng.js';
import { buildGameData, ROSTER } from '../server/games.js';
import {
  SPONSORABLE,
  SPONSOR_CAP,
  DEMO_SPONSOR_PACK,
  assignSponsors,
  sponsorClientInfo,
} from '../server/sponsors.js';
import { Room } from '../server/room.js';

const allKeys = ROSTER.map((g) => g.key);

test('assignSponsors caps at SPONSOR_CAP and only sponsors sponsorable games', () => {
  const a = assignSponsors(seededRng('t1'), allKeys);
  assert.ok(a.size > 0 && a.size <= SPONSOR_CAP, `got ${a.size} assignments`);
  for (const key of a.keys()) {
    assert.ok(SPONSORABLE.has(key), `${key} must be sponsorable`);
    assert.notEqual(key, 'oddoneout', 'Odd One Out is never sponsored');
  }
  const brandKeys = [...a.values()].map((b) => b.key);
  assert.equal(new Set(brandKeys).size, brandKeys.length, 'each sponsored game gets a distinct brand');
});

test('assignSponsors is deterministic for the same seed, varies across seeds', () => {
  const dump = (m) => JSON.stringify([...m.entries()].map(([k, b]) => [k, b.key]).sort());
  assert.equal(
    dump(assignSponsors(seededRng('same'), allKeys)),
    dump(assignSponsors(seededRng('same'), allKeys)),
  );
  const seen = new Set(
    ['a', 'b', 'c', 'd', 'e'].map((s) => dump(assignSponsors(seededRng(s), allKeys))));
  assert.ok(seen.size > 1, 'different seeds produce different assignments');
});

test('assignSponsors with no sponsorable games in queue assigns nothing', () => {
  const a = assignSponsors(seededRng('t2'), ['oddoneout', 'bisect', 'stopclock']);
  assert.equal(a.size, 0);
});

test('sponsored content swaps: brand color, logo shape, sentences, questions, labels', () => {
  const brand = DEMO_SPONSOR_PACK.brands[0];
  const ctx = () => ({ rng: seededRng('content'), config: { slingshotDistance: 60 }, used: {}, sponsor: brand });

  const rgb = buildGameData('rgb', ctx());
  assert.deepEqual(rgb.secret.target, brand.color, 'rgb target is the brand color');
  assert.equal(rgb.clientData.sponsor.name, brand.name);

  const trace = buildGameData('trace', ctx());
  assert.equal(trace.clientData.shape, brand.traceShape, 'trace draws the brand logo shape');

  const typing = buildGameData('typing', ctx());
  assert.ok(brand.sentences.includes(typing.secret.sentence), 'typing sentence comes from the brand');
  assert.equal(typing.clientData.sentence, typing.secret.sentence);

  const readroom = buildGameData('readroom', ctx());
  assert.ok(brand.questions.includes(readroom.clientData.question), 'readroom question comes from the brand');

  // Skinned-only games keep their mechanics data intact and just gain the label.
  for (const key of ['gridflash', 'dots', 'spacemash', 'slingshot']) {
    const { clientData } = buildGameData(key, ctx());
    assert.equal(clientData.sponsor.name, brand.name, `${key} carries the sponsor label`);
    assert.equal(clientData.sponsor.css, sponsorClientInfo(brand).css);
  }
  const plain = buildGameData('gridflash', { ...ctx(), sponsor: null });
  assert.equal(plain.clientData.sponsor, undefined, 'unsponsored rounds carry no sponsor field');
});

test('sponsored difficulty is unchanged: same seed → same patterns/counts/targets', () => {
  const brand = DEMO_SPONSOR_PACK.brands[1];
  const build = (key, sponsor) =>
    buildGameData(key, { rng: seededRng('fair'), config: { slingshotDistance: 60 }, used: {}, sponsor });
  assert.deepEqual(build('gridflash', brand).secret.patterns, build('gridflash', null).secret.patterns);
  assert.deepEqual(build('dots', brand).secret.counts, build('dots', null).secret.counts);
  assert.equal(build('slingshot', brand).clientData.distance, build('slingshot', null).clientData.distance);
});

// ---- room integration -------------------------------------------------------

const stubIo = () => ({ to: () => ({ emit: () => {} }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function addPlayer(room, id, name) {
  room.players.set(id, {
    id, name, socketId: `sock-${id}`, connected: true,
    disconnectedAt: null, sync: null, joinedAt: Date.now(),
  });
}
const FAST = {
  practice: false, gameDuration: 800, musicMs: 60, tutorialMs: 0,
  redemptionPrepMs: 60, redemptionLeadMs: 120,
  postGreenTimeout: 800, hardTimeout: 1500, closeGraceMs: 200,
};

test('room start assigns at most SPONSOR_CAP sponsors and labels game payloads', async () => {
  const room = new Room(stubIo(), 'SPON', { ...FAST });
  try {
    addPlayer(room, 'p1', 'One');
    addPlayer(room, 'p2', 'Two');
    assert.equal(room.start().ok, true);
    assert.ok(room.sponsorAssignments.size > 0, 'a full roster session gets sponsored rounds');
    assert.ok(room.sponsorAssignments.size <= SPONSOR_CAP, 'hard cap holds');
    for (const key of room.sponsorAssignments.keys()) assert.ok(SPONSORABLE.has(key));

    // Walk the whole queue: every sponsored game's payload carries the label,
    // every unsponsored game's payload doesn't.
    let sponsoredSeen = 0;
    for (let i = 0; i < room.queue.length; i++) {
      await waitFor(() => room.phase === 'minigame', 3000, `game ${i}`);
      const g = room.round.games[0];
      const payload = room.gamePayload(g);
      if (room.sponsorAssignments.has(g.key)) {
        sponsoredSeen++;
        assert.equal(payload.sponsor.name, room.sponsorAssignments.get(g.key).name,
          `${g.key} payload is labeled with its brand`);
        assert.equal(g.clientData.sponsor.name, payload.sponsor.name);
      } else {
        assert.equal(payload.sponsor, null, `${g.key} is not labeled`);
      }
      room.hostNext(); // close game
      await waitFor(() => room.phase === 'scores', 3000, `scores ${i}`);
      room.hostNext(); // advance
    }
    assert.equal(sponsoredSeen, room.sponsorAssignments.size, 'every assigned sponsor was played');
  } finally {
    room.destroy();
  }
});

test('sponsors toggle off → zero sponsored rounds', async () => {
  const room = new Room(stubIo(), 'NOAD', { ...FAST, sponsors: false });
  try {
    addPlayer(room, 'p1', 'One');
    addPlayer(room, 'p2', 'Two');
    assert.equal(room.start().ok, true);
    assert.equal(room.sponsorAssignments.size, 0);
    await waitFor(() => room.phase === 'minigame', 3000, 'first game');
    assert.equal(room.gamePayload(room.round.games[0]).sponsor, null);
    assert.equal(room.publicConfig().sponsors, false);
  } finally {
    room.destroy();
  }
});

test('sponsored round scores exactly like a plain one (normalization untouched)', async () => {
  // Force a session containing typing only, sponsored — submit and check the
  // 0–1000 normalization still applies to the brand sentence.
  const enabled = {};
  for (const g of ROSTER) enabled[g.key] = g.key === 'typing';
  const room = new Room(stubIo(), 'FAIR', { ...FAST, enabled });
  try {
    addPlayer(room, 'p1', 'One');
    addPlayer(room, 'p2', 'Two');
    assert.equal(room.start().ok, true);
    await waitFor(() => room.phase === 'minigame', 3000, 'typing game');
    const g = room.round.games[0];
    assert.ok(room.sponsorAssignments.has('typing'), 'the lone sponsorable game gets sponsored');
    const sentence = g.secret.sentence;
    assert.ok(room.sponsorAssignments.get('typing').sentences.includes(sentence));
    room.handleSubmit('p1', { typed: sentence, elapsedMs: 10000 });
    room.handleSubmit('p2', { typed: sentence.slice(0, 10), elapsedMs: 10000 });
    await waitFor(() => room.phase === 'scores', 3000, 'scores');
    const rows = room.lastScores;
    assert.equal(rows.find((r) => r.id === 'p1').points, 1000, 'faster typist normalizes to 1000');
    assert.equal(rows.find((r) => r.id === 'p2').points, 0, 'slower typist normalizes to 0');
  } finally {
    room.destroy();
  }
});
