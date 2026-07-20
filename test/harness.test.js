// 20-bot end-to-end harness. Every bug in this system is a 20-player
// concurrency bug: bots join, play every minigame with plausible random
// submissions, include silent non-submitters, a mid-round disconnect +
// reconnect, and a masher in the musical-chairs finale — and the game must
// play every enabled game exactly once, run the full 19-round chairs
// elimination tournament, and reach a winner by highest total.

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createServer } from '../server/app.js';
import { ROSTER } from '../server/games.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Await a promise with a deadline whose timer is cleaned up on resolution —
// a bare Promise.race(sleep) would keep the test process alive for the full
// timeout even after a pass.
async function withDeadline(promise, ms, msg) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Fast pacing so a full 20-player game runs in seconds. Game mechanics are
// untouched — only phase timings shrink.
const TEST_CONFIG = {
  gameDuration: 900,
  practice: false,
  musicMs: 60,
  tutorialMs: 50,
  redemptionPrepMs: 80,
  redemptionLeadMs: 200,
  postGreenTimeout: 800,
  hardTimeout: 1500,
  closeGraceMs: 300,
};

function botPayload(key, data, rnd) {
  switch (key) {
    case 'rgb': return { r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256) };
    case 'oddoneout': return { cleared: 2 + Math.floor(rnd() * 20) };
    case 'bisect': return { guesses: data.targets.map((t) => Math.max(0, Math.min(100, t + (rnd() * 20 - 10)))) };
    case 'trace': return { deviation: 0.01 + rnd() * 0.08, coverage: 0.92 + rnd() * 0.08 };
    case 'dots': return { guesses: data.counts.map((c) => Math.max(1, Math.round(c * (0.5 + rnd())))) };
    case 'stopclock': return { best: rnd() * 1500 };
    case 'gridflash': return { picks: data.patterns.map(() => [...Array(8)].map(() => Math.floor(rnd() * 25))) };
    case 'readroom': return { answer: rnd() < 0.5, prediction: Math.floor(rnd() * 101) };
    case 'typing': return { typed: data.sentence.slice(0, 5 + Math.floor(rnd() * data.sentence.length)), elapsedMs: 15000 + rnd() * 20000 };
    case 'spacemash': return { count: 40 + Math.floor(rnd() * 70), flagged: false };
    case 'slingshot': return { best: rnd() * 40 };
    default: return {};
  }
}

class Bot {
  constructor(url, name, behavior) {
    this.url = url;
    this.name = name;
    this.behavior = behavior; // 'normal' | 'nosubmit' | 'masher' | 'flaky'
    this.playerId = null;
    this.reconnected = false;
    this.scoreCards = [];     // every you:score payload received
    this.socket = null;
  }

  async join(code) {
    this.code = code;
    this.socket = connect(this.url, { transports: ['websocket'], forceNew: true });
    this.wire(this.socket);
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`${this.name} join timeout`)), 5000);
      this.socket.emit('player:join', { code, name: this.name, playerId: this.playerId }, (res) => {
        clearTimeout(to);
        if (res.error) return reject(new Error(res.error));
        this.playerId = res.playerId;
        resolve();
      });
    });
  }

  wire(s) {
    s.on('phase', async (p) => {
      if (p.name === 'minigame') {
        if (this.behavior === 'nosubmit' || this.behavior === 'masher') return;
        if (this.behavior === 'flaky' && !this.reconnected) {
          // Drop mid-game, come back with the stored playerId.
          this.reconnected = true;
          s.disconnect();
          await sleep(250);
          await this.join(this.code);
          return;
        }
        await sleep(10 + Math.random() * 120);
        s.emit('player:submit', { payload: botPayload(p.key, p.clientData, Math.random) });
      }
    });
    s.on('you:score', (card) => { this.scoreCards.push(card); });
    s.on('redemption:go', async (p) => {
      if (!p.participants.includes(this.playerId)) return;
      if (this.behavior === 'masher') {
        // A masher's client-side machine never shows green (proven in
        // redemption.test.js under a fake clock); its report is the hard
        // timeout with a pile of early presses.
        await sleep(30);
        this.socket.emit('redemption:report', { status: 'hardTimeout', rawMs: null, earlyPresses: 812 });
      } else {
        await sleep(30 + Math.random() * 100);
        this.socket.emit('redemption:report', {
          status: 'ok',
          rawMs: 180 + Math.random() * 350,
          earlyPresses: Math.random() < 0.25 ? 1 : 0,
        });
      }
    });
  }

  close() { try { this.socket?.disconnect(); } catch { /* done */ } }
}

test('20 bots: every game once, per-game scores, chairs finale, winner by total', async () => {
  const { httpServer, io, rooms } = createServer();
  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;

  const host = connect(url, { transports: ['websocket'], forceNew: true });
  const bots = [];
  const minigameKeys = [];
  const scoreboards = [];
  let chairsSeen = 0;
  let winnerPayload = null;

  try {
    // ---- host creates the room ----
    const created = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('create timeout')), 5000);
      host.emit('host:create', { origin: url, config: TEST_CONFIG }, (res) => {
        clearTimeout(to);
        res.error ? reject(new Error(res.error)) : resolve(res);
      });
    });
    assert.match(created.code, /^[A-HJ-NP-Z]{4}$/, 'room code is 4 ambiguity-free letters');

    const winnerReached = new Promise((resolve) => {
      host.on('phase', (p) => {
        if (p.name === 'minigame') minigameKeys.push(p.key);
        if (p.name === 'scores') {
          scoreboards.push(p.leaderboard);
          setTimeout(() => host.emit('host:next', {}, () => {}), 30);
        }
        // Tutorials no longer auto-advance — the host starts each game.
        // Chairs round results also wait for the host's Next.
        if (p.name === 'tutorial' || p.name === 'chairs_result') {
          setTimeout(() => host.emit('host:next', {}, () => {}), 30);
        }
        if (p.name === 'redemption') chairsSeen++;
        if (p.name === 'winner') { winnerPayload = p; resolve(p); }
      });
    });

    // ---- 20 bots join: 16 normal, 1 flaky, 2 silent non-submitters, 1 masher ----
    for (let i = 0; i < 20; i++) {
      const behavior = i === 19 ? 'masher' : i >= 17 ? 'nosubmit' : i === 5 ? 'flaky' : 'normal';
      bots.push(new Bot(url, `Bot${String(i).padStart(2, '0')}`, behavior));
    }
    await Promise.all(bots.map((b) => b.join(created.code)));

    const startRes = await new Promise((resolve) => host.emit('host:start', {}, resolve));
    assert.equal(startRes.ok, true);

    await withDeadline(winnerReached, 90000, 'game never reached a winner');
    // The host's winner event doesn't guarantee every bot has drained its own
    // socket queue (the finale you:score) yet.
    await sleep(500);

    // ---- assertions ----
    const enabledCount = ROSTER.length;
    assert.equal(minigameKeys.length, enabledCount, 'every enabled game played');
    assert.equal(new Set(minigameKeys).size, enabledCount, 'no game repeats');
    assert.equal(chairsSeen, bots.length - 1,
      'chairs tournament runs players − 1 elimination rounds');

    // Per-game scoreboards: full roster of 20 on every one, totals monotone.
    assert.equal(scoreboards.length, enabledCount, 'a scoreboard after every game');
    for (const board of scoreboards) {
      assert.equal(board.length, 20, 'nobody is ever dropped from the scoreboard');
      for (let i = 1; i < board.length; i++) {
        assert.ok(board[i - 1].total >= board[i].total, 'scoreboard sorted by total');
      }
    }

    // Every submitting bot saw a personal score card after every game + finale.
    for (const b of bots) {
      if (b.behavior === 'normal') {
        assert.equal(b.scoreCards.length, enabledCount + 1,
          `${b.name} saw a score after every game and the finale`);
        for (const card of b.scoreCards) {
          assert.ok(Number.isFinite(card.points) && Number.isFinite(card.total),
            'score cards carry points and running total');
        }
      }
    }

    // Winner is the highest total; standings are complete and sorted.
    assert.ok(winnerPayload.winnerName, 'a winner is declared');
    const standings = winnerPayload.standings;
    assert.equal(standings.length, 20, 'all 20 in final standings — no elimination');
    for (let i = 1; i < standings.length; i++) {
      assert.ok(standings[i - 1].total >= standings[i].total, 'standings sorted by total');
    }
    assert.equal(winnerPayload.winnerId, standings[0].id);

    const masher = bots[19];
    const masherRow = standings.find((s) => s.id === masher.playerId);
    assert.equal(masherRow.total, 0,
      'masher never scored: no submissions, first out of chairs → 0 bonus');
    assert.notEqual(winnerPayload.winnerId, masher.playerId, 'masher must not win');

    const standingNames = standings.map((s) => s.name);
    for (const b of bots) assert.ok(standingNames.includes(b.name), `${b.name} in final standings`);

    // The flaky bot reconnected successfully with its identity intact.
    assert.equal(bots[5].reconnected, true);
  } finally {
    for (const b of bots) b.close();
    host.disconnect();
    // Rooms hold live timers (including a 15-minute empty-room TTL) that
    // would keep the test process's event loop alive.
    for (const room of rooms.values()) room.destroy();
    io.close();
    httpServer.close();
  }
});

test('2-player game runs to a winner', async () => {
  const { httpServer, io, rooms } = createServer();
  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;
  const host = connect(url, { transports: ['websocket'], forceNew: true });
  const bots = [0, 1].map((i) => new Bot(url, `Duo${i}`, 'normal'));
  try {
    const created = await new Promise((resolve, reject) => {
      host.emit('host:create', { origin: url, config: TEST_CONFIG }, (res) =>
        res.error ? reject(new Error(res.error)) : resolve(res));
    });
    const winner = new Promise((resolve) => {
      host.on('phase', (p) => {
        if (p.name === 'scores' || p.name === 'tutorial' || p.name === 'chairs_result') {
          setTimeout(() => host.emit('host:next', {}, () => {}), 30);
        }
        if (p.name === 'winner') resolve(p);
      });
    });
    await Promise.all(bots.map((b) => b.join(created.code)));
    await new Promise((resolve) => host.emit('host:start', {}, resolve));
    const w = await withDeadline(winner, 60000, 'no winner');
    assert.ok(w.winnerName);
    assert.equal(w.standings.length, 2);
    assert.ok(w.standings[0].total >= w.standings[1].total);
  } finally {
    for (const b of bots) b.close();
    host.disconnect();
    for (const room of rooms.values()) room.destroy();
    io.close();
    httpServer.close();
  }
});
