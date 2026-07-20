// Room-level integration for the score-attack format: every enabled game is
// played exactly once by everyone, scores are normalized 0–1000 per game and
// accumulate. The finale is the musical-chairs BONUS tournament: (players−1)
// reaction rounds, slowest out each round, 3× points by final placement
// (1st = 3000 … last = 0). Highest cumulative total wins the session.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { ROSTER } from '../server/games.js';

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

// Enable only the given keys.
function onlyGames(...keys) {
  const enabled = {};
  for (const g of ROSTER) enabled[g.key] = keys.includes(g.key);
  return enabled;
}

const FAST = {
  practice: false, gameDuration: 800, musicMs: 60, tutorialMs: 0,
  redemptionPrepMs: 60, redemptionLeadMs: 120,
  postGreenTimeout: 800, hardTimeout: 1500, closeGraceMs: 200,
};

test('score attack: every game once, totals accumulate, chairs finale, highest total wins', async () => {
  const room = new Room(stubIo(), 'TEST', {
    ...FAST,
    enabled: onlyGames('spacemash', 'stopclock'),
  });
  try {
    const ids = ['p1', 'p2', 'p3'];
    ids.forEach((id, i) => addPlayer(room, id, `Player${i + 1}`));
    assert.equal(room.start().ok, true);
    assert.equal(room.queue.length, 2, 'both enabled games queued once each');

    const playedKeys = [];
    const submitFor = (key, id, quality) => {
      // quality: 0 = best, larger = worse
      if (key === 'spacemash') room.handleSubmit(id, { count: 100 - quality * 20, flagged: false });
      else room.handleSubmit(id, { best: 100 + quality * 150 });
    };

    // ---- game 1: p3 never submits ----
    await waitFor(() => room.phase === 'minigame', 3000, 'first minigame');
    playedKeys.push(room.round.games[0].key);
    submitFor(playedKeys[0], 'p1', 0);
    submitFor(playedKeys[0], 'p2', 1);
    await waitFor(() => room.phase === 'scores', 3000, 'first scores');

    const board1 = room.lastScores;
    const row = (board, id) => board.find((r) => r.id === id);
    assert.equal(row(board1, 'p1').points, 1000, 'best submitter gets 1000');
    assert.equal(row(board1, 'p3').points, 0, 'non-submitter scores 0');
    assert.ok(room.players.has('p3'), 'non-submitter is never removed');
    assert.equal(row(board1, 'p1').rank, 1);

    // ---- game 2: everyone submits, p3 is best ----
    room.hostNext();
    await waitFor(() => room.phase === 'minigame', 3000, 'second minigame');
    playedKeys.push(room.round.games[0].key);
    submitFor(playedKeys[1], 'p1', 2);
    submitFor(playedKeys[1], 'p2', 1);
    submitFor(playedKeys[1], 'p3', 0);
    await waitFor(() => room.phase === 'scores', 3000, 'second scores');

    assert.deepEqual([...playedKeys].sort(), ['spacemash', 'stopclock'],
      'each enabled game played exactly once');
    const board2 = room.lastScores;
    assert.equal(row(board2, 'p3').points, 1000, 'p3 wins game 2');
    for (const id of ids) {
      assert.equal(row(board2, id).total,
        row(board1, id).total + row(board2, id).points,
        `${id} total accumulates across games`);
    }

    // ---- musical chairs finale: 3 players → 2 elimination rounds ----
    const totalsBefore = new Map([...room.totals].map(([id, t]) => [id, Math.round(t)]));
    room.hostNext();
    await waitFor(() => room.phase === 'redemption', 3000, 'chairs round 1');
    assert.equal(room.redemption.participants.length, 3, 'everyone starts the finale');
    assert.equal(room.redemption.mode, 'chairs');
    assert.equal(room.chairs.totalRounds, 2, 'rounds = players − 1');
    assert.equal(room.chairs.round, 1);

    // Round 1: p3 is slowest → eliminated, 2 chairs at stake.
    await waitFor(() => room.redemption && room.redemption.tGreen, 3000, 'go 1');
    room.handleRedemptionReport('p1', { status: 'ok', rawMs: 200, earlyPresses: 0 });
    room.handleRedemptionReport('p2', { status: 'ok', rawMs: 300, earlyPresses: 0 });
    room.handleRedemptionReport('p3', { status: 'ok', rawMs: 400, earlyPresses: 0 });
    await waitFor(() => room.phase === 'chairs_result', 3000, 'round 1 result');
    assert.deepEqual(room.chairs.eliminated, ['p3'], 'slowest player is out first');
    assert.deepEqual([...room.chairs.active].sort(), ['p1', 'p2'], 'survivors keep chairs');

    // Round 2 (final): p2 slowest → p1 takes the last chair.
    room.hostNext();
    await waitFor(() => room.phase === 'redemption' && room.chairs.round === 2, 3000, 'chairs round 2');
    assert.equal(room.redemption.participants.length, 2, 'eliminated players sit out');
    await waitFor(() => room.redemption && room.redemption.tGreen, 3000, 'go 2');
    room.handleRedemptionReport('p1', { status: 'ok', rawMs: 210, earlyPresses: 0 });
    room.handleRedemptionReport('p2', { status: 'ok', rawMs: 320, earlyPresses: 0 });
    await waitFor(() => room.phase === 'chairs_result', 3000, 'final round result');

    // Bonus scoring: 3× by placement — 1st 3000, 2nd 1500, 3rd 0.
    room.hostNext();
    await waitFor(() => room.phase === 'winner', 3000, 'winner');
    const standings = room.finalStandings;
    assert.equal(standings.length, 3, 'all players in final standings');
    for (let i = 1; i < standings.length; i++) {
      assert.ok(standings[i - 1].total >= standings[i].total, 'standings sorted by total');
    }
    assert.equal(room.winnerId, standings[0].id);
    const totalOf = (id) => standings.find((s) => s.id === id).total;
    assert.equal(totalOf('p1'), totalsBefore.get('p1') + 3000, 'tournament winner banks 3000 (3×)');
    assert.equal(totalOf('p2'), totalsBefore.get('p2') + 1500, '2nd of 3 banks 1500');
    assert.equal(totalOf('p3'), totalsBefore.get('p3') + 0, 'first out banks 0');
  } finally {
    room.destroy();
  }
});

test('2-player finale: one round, placement bonus (3000 / 0) can flip the lead', async () => {
  const room = new Room(stubIo(), 'TESB', {
    ...FAST,
    enabled: onlyGames('stopclock'),
  });
  try {
    addPlayer(room, 'a', 'Anna');
    addPlayer(room, 'b', 'Ben');
    room.start();
    await waitFor(() => room.phase === 'minigame', 3000, 'minigame');
    room.handleSubmit('a', { best: 100 });
    room.handleSubmit('b', { best: 900 });
    await waitFor(() => room.phase === 'scores', 3000, 'scores');
    room.hostNext();
    await waitFor(() => room.phase === 'redemption', 3000, 'finale');
    assert.equal(room.chairs.totalRounds, 1, '2 players → a single round');
    await waitFor(() => room.redemption && room.redemption.tGreen, 3000, 'go');
    // Anna mashes into the hard timeout (999999); Ben merely freezes on
    // green (10000) — Ben is less slow, takes the only chair, and the 3×
    // placement bonus overturns Anna's minigame lead.
    room.handleRedemptionReport('a', { status: 'hardTimeout', rawMs: null, earlyPresses: 40 });
    room.handleRedemptionReport('b', { status: 'postGreenTimeout', rawMs: null, earlyPresses: 0 });
    await waitFor(() => room.phase === 'chairs_result', 3000, 'result');
    assert.equal(room.chairs.eliminated[0], 'a');
    room.hostNext();
    await waitFor(() => room.phase === 'winner', 3000, 'winner');
    assert.equal(room.winnerId, 'b', 'last chair pays 3000 — bonus round flips the lead');
    assert.equal(room.finalStandings.length, 2);
    assert.equal(room.finalStandings[0].total, 3000, 'Ben: 0 from games + 3000 bonus');
    assert.equal(room.finalStandings[1].total, 1000, 'Anna: 1000 from games + 0 bonus');
  } finally {
    room.destroy();
  }
});
