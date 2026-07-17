// 20-bot end-to-end harness (spec §11). Every bug in this system is a
// 20-player concurrency bug: bots join, play every minigame with plausible
// random submissions, include non-submitters, a mid-round disconnect +
// reconnect, and a masher in redemption — and the game must reach a winner
// with a strictly decreasing ladder. Asserts the masher loses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createServer } from '../server/app.js';

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
  m: 2,
  gameDuration: 1000,
  practice: false,
  musicMs: 60,
  cutRevealMs: 80,
  voteMs: 350,
  redemptionPrepMs: 80,
  redemptionLeadMs: 200,
  postGreenTimeout: 800,
  hardTimeout: 1500,
  closeGraceMs: 400,
};

function botPayload(key, data, rnd) {
  switch (key) {
    case 'rgb': return { r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256) };
    case 'oddoneout': return { cleared: 2 + Math.floor(rnd() * 20) };
    case 'bisect': return { guesses: data.targets.map((t) => Math.max(0, Math.min(100, t + (rnd() * 20 - 10)))) };
    case 'pie': return { guesses: data.targets.map((t) => Math.max(0, Math.min(100, t + (rnd() * 24 - 12)))) };
    case 'trace': return { deviation: 0.01 + rnd() * 0.08, coverage: 0.92 + rnd() * 0.08 };
    case 'dots': return { guesses: data.counts.map((c) => Math.max(1, Math.round(c * (0.5 + rnd())))) };
    case 'price': return { guesses: data.items.map(() => Math.round(10 + rnd() * 5000)) };
    case 'stopclock': return { best: rnd() * 1500 };
    case 'gridflash': return { picks: data.patterns.map(() => [...Array(8)].map(() => Math.floor(rnd() * 25))) };
    case 'unique': return { answer: ['eggs', 'bacon', 'toast', 'cereal', 'pancakes', 'waffles', `thing${Math.floor(rnd() * 50)}`][Math.floor(rnd() * 7)] };
    case 'readroom': return { answer: rnd() < 0.5, prediction: Math.floor(rnd() * 101) };
    case 'clickacc': return { distances: data.targets.map(() => rnd() * 0.25) };
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
    this.eliminated = false;
    this.everSaved = false;
    this.reconnected = false;
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
      if (p.name === 'minigame' && !this.eliminated) {
        if (this.behavior === 'nosubmit' || this.behavior === 'masher') return;
        if (this.behavior === 'flaky' && !this.reconnected) {
          // Drop mid-game, come back with the stored playerId (spec §8).
          this.reconnected = true;
          s.disconnect();
          await sleep(250);
          await this.join(this.code);
          return;
        }
        await sleep(10 + Math.random() * 120);
        s.emit('player:submit', { payload: botPayload(p.key, p.clientData, Math.random) });
      }
      if (p.name === 'voting' && this.eliminated) {
        await sleep(10 + Math.random() * 80);
        const opt = p.options[Math.floor(Math.random() * p.options.length)];
        if (opt) s.emit('player:vote', { optionId: opt.id });
      }
    });
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
    s.on('you:eliminated', () => { this.eliminated = true; });
  }

  close() { try { this.socket?.disconnect(); } catch { /* done */ } }
}

test('20 bots: full game to a winner, decreasing ladder, masher loses', async () => {
  const { httpServer, io, rooms } = createServer();
  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;

  const host = connect(url, { transports: ['websocket'], forceNew: true });
  const bots = [];
  const aliveCounts = [];
  const redemptionSavedIds = [];
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
        if (p.name === 'music') aliveCounts.push(p.ladder.alive);
        if (p.name === 'reveal') {
          if (p.redemption) redemptionSavedIds.push(...p.redemption.savedIds);
          setTimeout(() => host.emit('host:next', {}, () => {}), 30);
        }
        if (p.name === 'winner') { winnerPayload = p; resolve(p); }
      });
    });

    // ---- 20 bots join: 17 normal, 2 silent non-submitters, 1 masher ----
    for (let i = 0; i < 20; i++) {
      const behavior = i === 19 ? 'masher' : i >= 17 ? 'nosubmit' : i === 5 ? 'flaky' : 'normal';
      bots.push(new Bot(url, `Bot${String(i).padStart(2, '0')}`, behavior));
    }
    await Promise.all(bots.map((b) => b.join(created.code)));

    const startRes = await new Promise((resolve) => host.emit('host:start', {}, resolve));
    assert.equal(startRes.ok, true);

    await withDeadline(winnerReached, 90000, 'game never reached a winner');

    // ---- assertions ----
    assert.ok(winnerPayload.winnerName, 'a winner is declared');
    assert.equal(aliveCounts[0], 20, 'round 1 starts with all 20');
    for (let i = 1; i < aliveCounts.length; i++) {
      assert.ok(aliveCounts[i] < aliveCounts[i - 1],
        `ladder must strictly decrease: ${aliveCounts.join(' → ')}`);
    }

    const masher = bots[19];
    assert.equal(masher.eliminated, true, 'the masher must be eliminated');
    assert.ok(!redemptionSavedIds.includes(masher.playerId),
      'the masher must never be the one saved in redemption');
    assert.notEqual(winnerPayload.winnerId, masher.playerId, 'masher must not win');

    // Non-submitters were never crashed out of the data model.
    const standingNames = winnerPayload.standings.map((s) => s.name);
    for (const b of bots) assert.ok(standingNames.includes(b.name), `${b.name} in final standings`);

    // The flaky bot reconnected successfully with its identity intact.
    assert.equal(bots[5].reconnected, true);
    assert.ok(standingNames.includes(bots[5].name));
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

test('3-player game goes straight to the final', async () => {
  const { httpServer, io, rooms } = createServer();
  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;
  const host = connect(url, { transports: ['websocket'], forceNew: true });
  const bots = [0, 1, 2].map((i) => new Bot(url, `Trio${i}`, 'normal'));
  try {
    const created = await new Promise((resolve, reject) => {
      host.emit('host:create', { origin: url, config: { ...TEST_CONFIG, m: 1 } }, (res) =>
        res.error ? reject(new Error(res.error)) : resolve(res));
    });
    const winner = new Promise((resolve) => {
      host.on('phase', (p) => {
        if (p.name === 'reveal') setTimeout(() => host.emit('host:next', {}, () => {}), 30);
        if (p.name === 'winner') resolve(p);
      });
    });
    await Promise.all(bots.map((b) => b.join(created.code)));
    await new Promise((resolve) => host.emit('host:start', {}, resolve));
    const w = await withDeadline(winner, 30000, 'no winner');
    assert.ok(w.winnerName);
    assert.equal(w.standings.length, 3);
  } finally {
    for (const b of bots) b.close();
    host.disconnect();
    for (const room of rooms.values()) room.destroy();
    io.close();
    httpServer.close();
  }
});
