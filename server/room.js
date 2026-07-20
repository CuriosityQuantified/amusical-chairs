// Room = one game session. All state is in-memory and ephemeral by design —
// no database, no persistence.
//
// Format: every player plays every enabled minigame once, then the
// musical-chairs reaction round as the scored finale. No elimination — each
// game is normalized 0–1000 across the players who played it and added to a
// running total; highest total wins. Everyone sees their score after every
// game.

import crypto from 'node:crypto';
import { seededRng, shuffle } from '../shared/rng.js';
import { normalizeError, normalizeScore } from '../shared/normalize.js';
import { scoreRedemptionReport } from '../shared/redemption-core.js';
import {
  ROSTER,
  ROSTER_BY_KEY,
  NEEDS_AGGREGATION,
  buildGameData,
  computeMetric,
  aggregateGame,
  formatRaw,
} from './games.js';

// Ambiguity-free room-code alphabet: no I or O (and digits are excluded).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRoomCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return code;
}

const DEFAULTS = {
  gameDuration: 45000,
  tutorialMs: 9000,        // animated how-to screen before each game; 0 = off
  practice: true,
  minDelay: 2000,
  maxDelay: 6000,
  earlyPressPenalty: 0.1,
  postGreenTimeout: 10000,
  hardTimeout: 25000,
  slingshotDistance: 60,
  // pacing knobs (the low clamps exist so the bot harness can run a full
  // game in seconds)
  musicMs: null,           // null = seeded 4–7s
  redemptionPrepMs: 2500,  // client re-sync window before green is scheduled
  redemptionLeadMs: 3000,  // T_green broadcast this far ahead
  closeGraceMs: 1500,      // late-submission grace after a game's deadline
};

function sanitizeConfig(raw = {}) {
  const c = { ...DEFAULTS };
  const numIn = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  c.gameDuration = numIn(raw.gameDuration, 500, 120000, DEFAULTS.gameDuration);
  c.tutorialMs = numIn(raw.tutorialMs, 0, 30000, DEFAULTS.tutorialMs);
  c.practice = raw.practice != null ? !!raw.practice : DEFAULTS.practice;
  c.minDelay = numIn(raw.minDelay, 500, 10000, DEFAULTS.minDelay);
  c.maxDelay = numIn(raw.maxDelay, c.minDelay, 15000, Math.max(c.minDelay, DEFAULTS.maxDelay));
  c.earlyPressPenalty = numIn(raw.earlyPressPenalty, 0, 0.5, DEFAULTS.earlyPressPenalty);
  c.postGreenTimeout = numIn(raw.postGreenTimeout, 1000, 30000, DEFAULTS.postGreenTimeout);
  c.hardTimeout = numIn(raw.hardTimeout, 1000, 60000, DEFAULTS.hardTimeout);
  c.slingshotDistance = numIn(raw.slingshotDistance, 30, 150, DEFAULTS.slingshotDistance);
  c.musicMs = raw.musicMs != null ? numIn(raw.musicMs, 50, 15000, null) : null;
  c.redemptionPrepMs = numIn(raw.redemptionPrepMs, 50, 10000, DEFAULTS.redemptionPrepMs);
  c.redemptionLeadMs = numIn(raw.redemptionLeadMs, 100, 10000, DEFAULTS.redemptionLeadMs);
  c.closeGraceMs = numIn(raw.closeGraceMs, 0, 5000, DEFAULTS.closeGraceMs);
  c.enabled = {};
  for (const g of ROSTER) {
    c.enabled[g.key] = raw.enabled && raw.enabled[g.key] != null ? !!raw.enabled[g.key] : true;
  }
  return c;
}

export class Room {
  constructor(io, code, config, onEmpty = () => {}) {
    this.io = io;
    this.code = code;
    this.config = sanitizeConfig(config);
    this.onEmpty = onEmpty;
    this.hostKey = crypto.randomUUID();
    this.hostSocketId = null;
    this.players = new Map(); // id -> player
    this.phase = 'lobby';
    this.queue = [];          // game keys, each played exactly once
    this.queueIndex = 0;
    this.totals = new Map();  // playerId -> cumulative points
    this.round = null;        // current single-game round (also practice/test)
    this.lastScores = null;   // leaderboard rows from the last scored game
    this.redemption = null;
    this.afterMusic = null;   // what the music phase leads into
    this.tutorial = null;     // current tutorial info (for reconnect snapshots)
    this.afterTutorial = null;
    this.winnerId = null;
    this.finalStandings = null;
    this.timers = new Map();
    this.solo = false;        // solo practice room: the lone player drives it
    this.testCounter = 0;
    this.destroyed = false;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  // ---- plumbing -----------------------------------------------------------

  setTimer(name, fn, ms) {
    if (this.destroyed) return;
    this.clearTimer(name);
    const t = setTimeout(() => {
      this.timers.delete(name);
      try { fn(); } catch (err) { console.error(`room ${this.code} timer ${name}:`, err); }
    }, ms);
    // Unref'd timers never hold the process open (the listening server does
    // that in production); they still fire on schedule while it runs.
    t.unref?.();
    this.timers.set(name, t);
  }

  clearTimer(name) {
    const t = this.timers.get(name);
    if (t) { clearTimeout(t); this.timers.delete(name); }
  }

  destroy() {
    this.destroyed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  emitAll(event, data) { this.io.to(`room:${this.code}`).emit(event, data); }
  emitHost(event, data) { this.io.to(`host:${this.code}`).emit(event, data); }
  emitPlayer(playerId, event, data) {
    const p = this.players.get(playerId);
    if (p && p.socketId) this.io.to(p.socketId).emit(event, data);
  }

  setPhase(name, data = {}) {
    this.phase = name;
    this.lastActivity = Date.now();
    this.emitAll('phase', { name, ...data, progress: this.progressInfo() });
  }

  alive() { return [...this.players.values()]; }

  // Total events = every queued game + the musical-chairs finale.
  progressInfo() {
    const total = (this.queue.length || 0) + 1;
    return {
      players: this.players.size,
      game: Math.min(this.queueIndex + 1, total),
      totalGames: total,
    };
  }

  playerSummaries() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      total: Math.round(this.totals.get(p.id) || 0),
      sync: p.sync || null,
    }));
  }

  broadcastPlayers() {
    this.emitAll('room:players', { players: this.playerSummaries() });
  }

  // ---- join / reconnect ---------------------------------------------------

  join(socket, { name, playerId }) {
    if (playerId && this.players.has(playerId)) {
      // Reconnect: rebind socket — nobody loses their identity or score for
      // a wifi hiccup; they simply may have missed submissions.
      const p = this.players.get(playerId);
      p.socketId = socket.id;
      p.connected = true;
      p.disconnectedAt = null;
      this.clearTimer(`kick:${p.id}`);
      socket.join(`room:${this.code}`);
      socket.data.roomCode = this.code;
      socket.data.playerId = p.id;
      this.broadcastPlayers();
      return { ok: true, playerId: p.id, name: p.name, snapshot: this.snapshot(p.id) };
    }
    if (this.phase !== 'lobby') return { error: 'Game already started — ask the host for a rematch.' };
    if (this.players.size >= 30) return { error: 'Room is full (30 players max).' };
    let cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';
    const names = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    let finalName = cleanName;
    let i = 2;
    while (names.has(finalName.toLowerCase())) finalName = `${cleanName} ${i++}`;
    const p = {
      id: crypto.randomUUID(),
      name: finalName,
      socketId: socket.id,
      connected: true,
      disconnectedAt: null,
      sync: null,
      joinedAt: Date.now(),
    };
    this.players.set(p.id, p);
    socket.join(`room:${this.code}`);
    socket.data.roomCode = this.code;
    socket.data.playerId = p.id;
    this.broadcastPlayers();
    return { ok: true, playerId: p.id, name: p.name, snapshot: this.snapshot(p.id) };
  }

  handleDisconnect(socket) {
    const pid = socket.data.playerId;
    if (socket.id === this.hostSocketId) this.hostSocketId = null;
    if (pid && this.players.has(pid)) {
      const p = this.players.get(pid);
      if (p.socketId === socket.id) {
        p.connected = false;
        p.disconnectedAt = Date.now();
        // In the lobby a vanished player is removed after 60s; mid-game they
        // are kept (missed submissions score 0, identity survives).
        if (this.phase === 'lobby') {
          this.setTimer(`kick:${pid}`, () => {
            if (this.phase === 'lobby' && this.players.get(pid) && !this.players.get(pid).connected) {
              this.players.delete(pid);
              this.broadcastPlayers();
            }
          }, 60000);
        }
        this.broadcastPlayers();
      }
    }
    const anyConnected =
      this.hostSocketId || [...this.players.values()].some((p) => p.connected);
    if (!anyConnected) {
      this.setTimer('empty', () => this.onEmpty(this), 15 * 60 * 1000);
    }
  }

  recordSync(playerId, sync) {
    const p = this.players.get(playerId);
    if (!p || !sync) return;
    p.sync = {
      offset: Number(sync.offset) || 0,
      minRtt: Math.max(0, Number(sync.minRtt) || 0),
      jitter: Math.max(0, Number(sync.jitter) || 0),
    };
    // Per-player clock-sync confidence for the host screen.
    p.sync.quality =
      p.sync.minRtt < 150 && p.sync.jitter < 60 ? 'good'
      : p.sync.minRtt < 400 && p.sync.jitter < 200 ? 'ok'
      : 'poor';
    this.broadcastPlayers();
  }

  snapshot(playerId) {
    const p = playerId ? this.players.get(playerId) : null;
    const snap = {
      code: this.code,
      phase: this.phase,
      solo: this.solo,
      players: this.playerSummaries(),
      progress: this.progressInfo(),
      config: this.publicConfig(),
      you: p ? { id: p.id, name: p.name, total: Math.round(this.totals.get(p.id) || 0) } : null,
      winnerId: this.winnerId,
      finalStandings: this.finalStandings,
    };
    if ((this.phase === 'minigame' || this.phase === 'practice') && this.round) {
      const g = this.round.games[this.round.gameIndex];
      if (g && p && !g.submissions.has(p.id)) {
        snap.game = this.gamePayload(g);
      }
    }
    if (this.phase === 'scores' && this.lastScores) {
      snap.scores = this.lastScores;
    }
    if (this.phase === 'tutorial' && this.tutorial) {
      snap.tutorial = { ...this.tutorial };
    }
    return snap;
  }

  publicConfig() {
    const { gameDuration, practice, minDelay, maxDelay, enabled } = this.config;
    const roster = ROSTER.map(({ key, name, category }) => ({ key, name, category }));
    return { gameDuration, practice, minDelay, maxDelay, enabled, roster };
  }

  updateConfig(raw) {
    if (this.phase !== 'lobby') return { error: 'Config can only change in the lobby.' };
    this.config = sanitizeConfig({ ...this.config, ...raw, enabled: { ...this.config.enabled, ...(raw.enabled || {}) } });
    this.emitAll('room:config', this.publicConfig());
    return { ok: true };
  }

  // ---- game flow ----------------------------------------------------------

  start() {
    if (this.phase !== 'lobby') return { error: 'Already started.' };
    if (this.players.size < 2) return { error: 'Need at least 2 players.' };
    const enabledKeys = ROSTER.filter((g) => this.config.enabled[g.key]).map((g) => g.key);
    if (!enabledKeys.length) return { error: 'Enable at least one game.' };
    this.queue = shuffle(seededRng(`${this.code}:queue`), enabledKeys);
    this.queueIndex = 0;
    this.totals = new Map([...this.players.keys()].map((id) => [id, 0]));
    if (this.config.practice) this.startPractice();
    else this.nextGame();
    return { ok: true };
  }

  // Practice: one un-scored Stop the Clock so broken devices surface before
  // the real games, not during them.
  startPractice() {
    const rng = seededRng(`${this.code}:practice`);
    const { clientData, secret } = buildGameData('stopclock', { rng, config: this.config, used: {} });
    this.round = {
      practice: true,
      games: [{
        key: 'stopclock', ...ROSTER_BY_KEY.get('stopclock'),
        clientData, secret, submissions: new Map(), metrics: new Map(), token: crypto.randomUUID(),
      }],
      gameIndex: 0,
    };
    this.startTutorial(
      { key: 'stopclock', gameName: 'Stop the Clock', practice: true },
      () => this.startGame(0)
    );
  }

  // Solo test: run any single game from the lobby, unscored, any player count
  // (host playtesting). Uses a throwaway content pool — the real session's
  // no-repeat pool is unaffected.
  startTest(key) {
    if (this.phase !== 'lobby') return { error: 'Games can only be tested from the lobby.' };
    const meta = ROSTER_BY_KEY.get(key);
    if (!meta) return { error: `Unknown game "${key}".` };
    if (this.players.size < 1) return { error: 'Need at least 1 player joined to test.' };
    this.testCounter += 1;
    const { clientData, secret } = buildGameData(key, {
      rng: seededRng(`${this.code}:test:${key}:${this.testCounter}`),
      config: this.config,
      used: {},
    });
    this.round = {
      practice: false,
      test: true,
      games: [{
        ...meta, clientData, secret, submissions: new Map(), metrics: new Map(), token: crypto.randomUUID(),
      }],
      gameIndex: 0,
      extras: {},
    };
    this.startTutorial({ key, gameName: meta.name, test: true }, () => this.startGame(0));
    return { ok: true };
  }

  // The "musical chairs" moment itself, solo: a full reaction round with
  // everyone present as participants. Unscored, nothing at stake.
  startRedemptionTest() {
    if (this.phase !== 'lobby') return { error: 'Finish the current game first.' };
    if (this.players.size < 1) return { error: 'Need at least 1 player joined to test.' };
    this.round = null;
    this.startTutorial(
      { key: 'chairs', gameName: 'Musical Chairs', test: true },
      () => this.startRedemption([...this.players.keys()], 'test')
    );
    return { ok: true };
  }

  backToLobby() {
    this.clearTimer('game');
    this.clearTimer('redemption');
    this.clearTimer('tutorial');
    this.round = null;
    this.redemption = null;
    this.tutorial = null;
    this.afterTutorial = null;
    this.setPhase('lobby', {});
    this.broadcastPlayers();
    return { ok: true };
  }

  gamePayload(g, duration) {
    const dur = duration ?? this.config.gameDuration;
    return {
      gameNumber: this.queueIndex + 1,
      key: g.key,
      gameName: g.name,
      gameType: g.type,
      category: g.category,
      clientData: g.clientData,
      duration: dur,
      deadline: g.deadline ?? Date.now() + dur,
      practice: !!this.round.practice,
      test: !!this.round.test,
    };
  }

  // Music plays (avatars circle the chairs on the host screen), then the
  // next event starts. The host can skip the music with Next.
  playMusicThen(data, fn) {
    const rng = seededRng(`${this.code}:music:${this.queueIndex}`);
    const musicMs = this.config.musicMs ?? 4000 + Math.floor(rng() * 3000);
    this.afterMusic = fn;
    this.setPhase('music', { duration: musicMs, ...data });
    this.setTimer('music', fn, musicMs);
  }

  nextGame() {
    if (this.queueIndex >= this.queue.length) return this.startChairsFinale();
    const key = this.queue[this.queueIndex];
    const meta = ROSTER_BY_KEY.get(key);
    const { clientData, secret } = buildGameData(key, {
      rng: seededRng(`${this.code}:g${this.queueIndex}:${key}`),
      config: this.config,
      used: this.usedContent || (this.usedContent = {}),
    });
    this.round = {
      practice: false,
      games: [{ ...meta, clientData, secret, submissions: new Map(), metrics: new Map(), token: crypto.randomUUID() }],
      gameIndex: 0,
      extras: {},
    };
    this.playMusicThen(
      { gameNames: [meta.name], gameNumber: this.queueIndex + 1 },
      () => this.startTutorial(
        { key, gameName: meta.name, gameNumber: this.queueIndex + 1 },
        () => this.startGame(0)
      )
    );
  }

  // Animated how-to screen (what to do / what to avoid) shown before every
  // game. Never advances on its own: the host's Next — or the solo player's
  // Play — starts the game. tutorialMs = 0 still disables tutorials entirely.
  startTutorial(info, fn) {
    if (!this.config.tutorialMs) return fn();
    this.afterTutorial = fn;
    this.tutorial = { ...info };
    this.setPhase('tutorial', { ...this.tutorial });
  }

  endTutorial() {
    this.clearTimer('tutorial');
    const fn = this.afterTutorial;
    this.afterTutorial = null;
    this.tutorial = null;
    fn?.();
  }

  skipTutorial() {
    if (this.phase !== 'tutorial') return { error: 'No tutorial to skip.' };
    this.endTutorial();
    return { ok: true };
  }

  startGame(idx) {
    const g = this.round.games[idx];
    if (!g) return;
    this.round.gameIndex = idx;
    const duration = this.round.practice
      ? Math.min(this.config.gameDuration, 30000)
      : this.config.gameDuration;
    g.deadline = Date.now() + duration;
    this.setPhase('minigame', this.gamePayload(g, duration));
    this.emitHost('host:progress', { submitted: 0, total: this.players.size });
    this.setTimer('game', () => this.closeGame(g.token), duration + this.config.closeGraceMs);
  }

  handleSubmit(playerId, payload) {
    if (this.phase !== 'minigame') return;
    const p = this.players.get(playerId);
    if (!p) return;
    const g = this.round.games[this.round.gameIndex];
    if (!g || g.submissions.has(playerId)) return;
    g.submissions.set(playerId, payload ?? {});
    if (!NEEDS_AGGREGATION.has(g.key)) {
      const metric = computeMetric(g.key, payload, g.secret, g.clientData, this.config);
      if (metric != null) g.metrics.set(playerId, metric);
    }
    const total = this.players.size;
    const submitted = g.submissions.size;
    // Progress count only — never live scores.
    this.emitAll('host:progress', { submitted, total });
    this.emitPlayer(playerId, 'submit:ack', { gameIndex: this.round.gameIndex });
    if (submitted >= total) this.closeGame(g.token);
  }

  closeGame(token) {
    const g = this.round?.games[this.round.gameIndex];
    if (!g || g.token !== token || g.closed) return;
    g.closed = true;
    this.clearTimer('game');
    if (NEEDS_AGGREGATION.has(g.key)) {
      const entries = [...g.submissions.entries()].map(([playerId, payload]) => ({ playerId, payload }));
      const { metrics, extra } = aggregateGame(g.key, entries);
      g.metrics = metrics;
      if (this.round.extras) this.round.extras[g.key] = extra;
    }
    if (this.round.test) {
      // Raw metric per player, no normalization — solo results would all
      // normalize to the same score anyway.
      const results = [...this.players.values()]
        .filter((p) => g.submissions.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.name,
          raw: formatRaw(g.key, g.metrics.get(p.id) ?? null, g.submissions.get(p.id)),
          metric: g.metrics.get(p.id) ?? null,
        }));
      this.setPhase('test_done', {
        key: g.key,
        gameName: g.name,
        results,
        total: this.players.size,
        extras: this.round.extras,
      });
      return;
    }
    if (this.round.practice) {
      this.setPhase('practice_done', { submitted: g.submissions.size, total: this.players.size });
      return;
    }
    this.scoreGame(g);
  }

  // Normalize this game 0–1000 across the players who played it, add to the
  // running totals, and show everyone where they stand. Non-submitters get 0.
  scoreGame(g) {
    const players = [...this.players.values()];
    const submitters = players.filter((p) => g.metrics.has(p.id));
    const values = submitters.map((p) => g.metrics.get(p.id));
    const normalized = values.length
      ? (g.type === 'error' ? normalizeError(values) : normalizeScore(values))
      : [];
    const points = new Map();
    submitters.forEach((p, i) => points.set(p.id, normalized[i]));
    for (const p of players) {
      if (!points.has(p.id)) points.set(p.id, 0);
      this.totals.set(p.id, (this.totals.get(p.id) || 0) + points.get(p.id));
    }
    const rows = players
      .map((p) => ({
        id: p.id,
        name: p.name,
        raw: formatRaw(g.key, g.metrics.get(p.id) ?? null, g.submissions.get(p.id)),
        points: Math.round(points.get(p.id)),
        total: Math.round(this.totals.get(p.id)),
      }))
      .sort((a, b) => b.total - a.total)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    this.lastScores = rows;
    this.queueIndex++;
    this.setPhase('scores', {
      key: g.key,
      gameName: g.name,
      gameNumber: this.queueIndex,       // the game just finished
      leaderboard: rows,
      nextIsChairs: this.queueIndex >= this.queue.length,
      extras: this.round.extras,
    });
    for (const r of rows) {
      this.emitPlayer(r.id, 'you:score', {
        gameName: g.name, raw: r.raw, points: r.points, total: r.total,
        rank: r.rank, of: rows.length,
      });
    }
    this.broadcastPlayers();
    // Host advances from scores (host:next) → next game / chairs finale.
  }

  // ---- musical chairs finale ----------------------------------------------

  startChairsFinale() {
    this.round = null;
    this.playMusicThen(
      { gameNames: ['Musical Chairs'], gameNumber: this.queue.length + 1, chairs: true },
      () => this.startTutorial(
        { key: 'chairs', gameName: 'Musical Chairs', chairs: true },
        () => this.startRedemption([...this.players.keys()], 'scored')
      )
    );
  }

  startRedemption(participantIds, mode) {
    const c = this.config;
    this.redemption = {
      participants: participantIds,
      mode,
      reports: new Map(),
      tGreen: null,
      startedAt: Date.now(),
    };
    const names = participantIds.map((id) => this.players.get(id)?.name || '?');
    this.setPhase('redemption', {
      participants: participantIds,
      participantNames: names,
      mode,
      scored: mode === 'scored',
      prepMs: c.redemptionPrepMs,
    });
    // Give clients a resync window, then broadcast the absolute server-time
    // T_green a couple of seconds ahead.
    this.setTimer('redemption', () => {
      if (!this.redemption) return;
      const tGreen = Date.now() + c.redemptionLeadMs;
      this.redemption.tGreen = tGreen;
      this.emitAll('redemption:go', {
        tGreen,
        participants: participantIds,
        minDelay: c.minDelay,
        maxDelay: c.maxDelay,
        postGreenTimeout: c.postGreenTimeout,
        hardTimeout: c.hardTimeout,
      });
      this.setTimer('redemption', () => this.finishRedemption(),
        c.redemptionLeadMs + c.hardTimeout + 5000);
    }, c.redemptionPrepMs);
  }

  handleRedemptionReport(playerId, report) {
    const red = this.redemption;
    if (!red || !red.tGreen) return;
    if (!red.participants.includes(playerId) || red.reports.has(playerId)) return;
    const scored = scoreRedemptionReport(report, { earlyPressPenalty: this.config.earlyPressPenalty });
    // Server-side sanity: a clean (no-early-press) report should arrive
    // roughly rtt after T_green + reportedTime. Flag, don't crash.
    const p = this.players.get(playerId);
    if (scored.status === 'ok' && scored.earlyPresses === 0) {
      const rtt = p?.sync?.minRtt ?? 200;
      const expected = red.tGreen + scored.rawMs + rtt + 1500;
      if (Date.now() > expected + 1000) scored.flagged = true;
    }
    red.reports.set(playerId, scored);
    this.emitAll('redemption:progress', { reported: red.reports.size, total: red.participants.length });
    if (red.reports.size >= red.participants.length) this.finishRedemption();
  }

  finishRedemption() {
    const red = this.redemption;
    if (!red) return;
    this.redemption = null;
    this.clearTimer('redemption');
    const results = red.participants.map((id, i) => {
      const scored = red.reports.get(id) ||
        { finalMs: 999999, rawMs: null, earlyPresses: 0, status: 'noReport', flagged: false };
      return { id, name: this.players.get(id)?.name || '?', order: i, ...scored };
    });
    results.sort((a, b) => a.finalMs - b.finalMs || a.order - b.order);

    if (red.mode === 'test') {
      // Solo/test run: show reaction results, nothing at stake.
      this.setPhase('redemption_test_done', {
        results: results.map((r) => ({
          id: r.id, name: r.name, status: r.status, rawMs: r.rawMs,
          earlyPresses: r.earlyPresses, finalMs: Math.round(r.finalMs), flagged: r.flagged,
        })),
      });
      return;
    }

    // Scored finale: penalized reaction time is an error metric — normalize
    // 0–1000 across everyone who got a clean press; the rest score 0.
    const ok = results.filter((r) => r.status === 'ok');
    const normalized = ok.length ? normalizeError(ok.map((r) => r.finalMs)) : [];
    const points = new Map();
    ok.forEach((r, i) => points.set(r.id, normalized[i]));
    for (const r of results) {
      if (!points.has(r.id)) points.set(r.id, 0);
      this.totals.set(r.id, (this.totals.get(r.id) || 0) + points.get(r.id));
    }
    const chairsBoard = results.map((r) => ({
      id: r.id, name: r.name, status: r.status,
      rawMs: r.rawMs != null ? Math.round(r.rawMs) : null,
      finalMs: Math.round(r.finalMs),
      earlyPresses: r.earlyPresses, flagged: r.flagged,
      points: Math.round(points.get(r.id)),
      total: Math.round(this.totals.get(r.id) || 0),
    }));
    const byTotal = [...chairsBoard].sort((a, b) => b.total - a.total);
    for (const r of chairsBoard) {
      this.emitPlayer(r.id, 'you:score', {
        gameName: 'Musical Chairs',
        raw: r.status === 'ok' ? `${r.rawMs} ms` : r.status,
        points: r.points, total: r.total,
        rank: byTotal.findIndex((x) => x.id === r.id) + 1, of: chairsBoard.length,
      });
    }
    this.declareWinner(chairsBoard);
  }

  // ---- winner --------------------------------------------------------------

  declareWinner(chairsBoard = null) {
    const standings = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, total: Math.round(this.totals.get(p.id) || 0) }))
      .sort((a, b) => b.total - a.total)
      .map((s, i) => ({ place: i + 1, ...s }));
    this.winnerId = standings[0]?.id || null;
    this.finalStandings = standings;
    this.setPhase('winner', {
      winnerId: this.winnerId,
      winnerName: standings[0]?.name || '?',
      standings,
      chairsBoard,
    });
    this.broadcastPlayers();
  }

  // Rematch: same lobby, fresh session state.
  reset() {
    this.clearTimer('game'); this.clearTimer('music'); this.clearTimer('redemption'); this.clearTimer('tutorial');
    this.tutorial = null;
    this.afterTutorial = null;
    this.phase = 'lobby';
    this.queue = [];
    this.queueIndex = 0;
    this.totals = new Map();
    this.usedContent = {};
    this.round = null;
    this.lastScores = null;
    this.redemption = null;
    this.afterMusic = null;
    this.winnerId = null;
    this.finalStandings = null;
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    this.setPhase('lobby', {});
    this.broadcastPlayers();
  }

  // Host "next" — the single advance control. Also acts as a skip for any
  // phase that could stall (dead client mid-game, etc).
  hostNext() {
    switch (this.phase) {
      case 'lobby': return this.start();
      case 'test_done':
      case 'redemption_test_done':
        return this.backToLobby();
      case 'practice_done': this.nextGame(); return { ok: true };
      case 'minigame': {
        const g = this.round?.games[this.round.gameIndex];
        if (g) this.closeGame(g.token);
        return { ok: true };
      }
      case 'music': {
        this.clearTimer('music');
        const fn = this.afterMusic;
        this.afterMusic = null;
        fn?.();
        return { ok: true };
      }
      case 'tutorial':
        this.endTutorial();
        return { ok: true };
      case 'scores':
        this.nextGame();
        return { ok: true };
      case 'redemption':
        this.finishRedemption();
        return { ok: true };
      case 'winner':
        this.reset();
        return { ok: true };
      default:
        return { ok: true };
    }
  }
}
