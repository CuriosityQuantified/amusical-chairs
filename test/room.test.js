// Room-level integration for the score-attack format: every enabled game is
// played exactly once by everyone, scores are normalized 0–1000 per game and
// accumulate, the musical-chairs reaction round is the scored finale, and the
// highest total wins. Nobody is ever eliminated.

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
  practice: false, gameDuration: 800, musicMs: 60,
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

    // ---- musical chairs finale: all three participate, scored ----
    room.hostNext();
    await waitFor(() => room.phase === 'redemption', 3000, 'chairs finale');
    assert.equal(room.redemption.participants.length, 3, 'everyone plays the finale');
    assert.equal(room.redemption.mode, 'scored');

    await waitFor(() => room.redemption && room.redemption.tGreen, 3000, 'go');
    room.handleRedemptionReport('p1', { status: 'ok', rawMs: 200, earlyPresses: 0 });
    room.handleRedemptionReport('p2', { status: 'ok', rawMs: 300, earlyPresses: 0 });
    room.handleRedemptionReport('p3', { status: 'ok', rawMs: 400, earlyPresses: 0 });

    await waitFor(() => room.phase === 'winner', 3000, 'winner');
    const standings = room.finalStandings;
    assert.equal(standings.length, 3, 'all players in final standings — nobody eliminated');
    for (let i = 1; i < standings.length; i++) {
      assert.ok(standings[i - 1].total >= standings[i].total, 'standings sorted by total');
    }
    assert.equal(room.winnerId, standings[0].id);
    // p1: 1000 + something + 1000 (fastest reaction) — must beat p3 who sat
    // out game 1 (0 pts) and was slowest in the finale.
    assert.ok(standings.findIndex((s) => s.id === 'p1') <
              standings.findIndex((s) => s.id === 'p3'));
  } finally {
    room.destroy();
  }
});

test('finale with no clean presses: chairs scores 0 for all, prior totals decide', async () => {
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
    await waitFor(() => room.redemption && room.redemption.tGreen, 3000, 'go');
    room.handleRedemptionReport('a', { status: 'hardTimeout', rawMs: null, earlyPresses: 40 });
    room.handleRedemptionReport('b', { status: 'postGreenTimeout', rawMs: null, earlyPresses: 0 });
    await waitFor(() => room.phase === 'winner', 3000, 'winner');
    assert.equal(room.winnerId, 'a', 'game-1 leader wins when the finale scores nobody');
    assert.equal(room.finalStandings.length, 2);
  } finally {
    room.destroy();
  }
});
