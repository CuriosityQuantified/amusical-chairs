// Room-level integration: exact tie at the cut line (§4.5) must send ALL
// tied players to redemption — never a coin flip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';

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
    disconnectedAt: null, eliminated: false, sync: null, joinedAt: Date.now(),
  });
}

test('integer tie at the cut line: all tied players go to redemption', async () => {
  const room = new Room(stubIo(), 'TEST', {
    m: 2, practice: false, gameDuration: 2000,
    musicMs: 50, cutRevealMs: 50, redemptionPrepMs: 50, redemptionLeadMs: 100,
    voteMs: 200, closeGraceMs: 100,
  });
  try {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    ids.forEach((id, i) => addPlayer(room, id, `Player${i + 1}`));
    room.pendingSet = ['spacemash', 'stopclock'];
    room.startRound();
    await waitFor(() => room.phase === 'minigame', 3000, 'first minigame');
    assert.equal(room.round.games[0].key, 'spacemash');

    // Space Mash: integer press counts with a genuine tie (p3 and p4 at 80).
    const counts = { p1: 100, p2: 90, p3: 80, p4: 80, p5: 70, p6: 60 };
    for (const id of ids) room.handleSubmit(id, { count: counts[id], flagged: false });

    await waitFor(() => room.phase === 'minigame' && room.round.gameIndex === 1, 3000, 'second minigame');
    // Stop the Clock: everyone identical → all normalized 1000, so the round
    // ranking is decided purely by Space Mash, preserving the tie.
    for (const id of ids) room.handleSubmit(id, { best: 500 });

    await waitFor(() => room.phase === 'redemption', 3000, 'redemption');
    const split = room.round.split;
    assert.equal(split.tieAtCut, true);
    assert.ok(split.tied.includes('p3') && split.tied.includes('p4'),
      'both tied players must be at risk');
    assert.deepEqual(split.safe.sort(), ['p1', 'p2'], 'only strictly-above-cut players are safe');
    assert.equal(split.risk.length, 4, 'tied pair + genuine bottom two');

    // Reports arrive; p3 is fastest and is the single player saved.
    await waitFor(() => room.redemption && room.redemption.tGreen, 3000, 'redemption go');
    room.handleRedemptionReport('p3', { status: 'ok', rawMs: 210, earlyPresses: 0 });
    room.handleRedemptionReport('p4', { status: 'ok', rawMs: 300, earlyPresses: 0 });
    room.handleRedemptionReport('p5', { status: 'ok', rawMs: 350, earlyPresses: 2 });
    room.handleRedemptionReport('p6', { status: 'ok', rawMs: 400, earlyPresses: 0 });

    await waitFor(() => room.phase === 'reveal', 3000, 'reveal');
    const alive = room.alive().map((p) => p.id).sort();
    assert.deepEqual(alive, ['p1', 'p2', 'p3'], 'safe pair + the saved tied player survive');
    assert.ok(room.players.get('p4').eliminated);
  } finally {
    room.destroy();
  }
});

test('non-submitters get normalized 0 but are NOT auto-eliminated before redemption (§4.6)', async () => {
  const room = new Room(stubIo(), 'TESB', {
    m: 1, practice: false, gameDuration: 400,
    musicMs: 50, cutRevealMs: 50, redemptionPrepMs: 50, redemptionLeadMs: 100,
    voteMs: 200, closeGraceMs: 100,
  });
  try {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    ids.forEach((id, i) => addPlayer(room, id, `P${i}`));
    room.pendingSet = ['stopclock'];
    room.startRound();
    await waitFor(() => room.phase === 'minigame', 3000, 'minigame');
    // 'f' never submits (disconnect/idle). Others submit distinct errors.
    room.handleSubmit('a', { best: 100 });
    room.handleSubmit('b', { best: 200 });
    room.handleSubmit('c', { best: 300 });
    room.handleSubmit('d', { best: 400 });
    room.handleSubmit('e', { best: 500 });

    await waitFor(() => room.phase === 'redemption', 4000, 'redemption');
    const g = room.round.games[0];
    assert.equal(g.normalized.get('f'), 0, 'non-submitter normalized to 0');
    assert.ok(room.round.split.risk.includes('f'), 'non-submitter is at risk, not auto-out');
    assert.equal(room.players.get('f').eliminated, false);

    // The non-submitter wins redemption and survives the round.
    await waitFor(() => room.redemption && room.redemption.tGreen, 3000, 'go');
    room.handleRedemptionReport('f', { status: 'ok', rawMs: 180, earlyPresses: 0 });
    room.handleRedemptionReport('d', { status: 'ok', rawMs: 280, earlyPresses: 0 });
    room.handleRedemptionReport('e', { status: 'ok', rawMs: 320, earlyPresses: 0 });
    await waitFor(() => room.phase === 'reveal', 3000, 'reveal');
    assert.equal(room.players.get('f').eliminated, false, 'saved via redemption');
  } finally {
    room.destroy();
  }
});
