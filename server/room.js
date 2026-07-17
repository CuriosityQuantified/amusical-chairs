// Room = one game session. All state is in-memory and ephemeral by design —
// no database, no persistence (spec §1, §8).

import crypto from 'node:crypto';
import { seededRng, shuffle } from '../shared/rng.js';
import { resolveRound, ladderFor, splitAtCut } from '../shared/ladder.js';
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
  m: 2,                    // minigames per round; hard-capped at 3 (spec §7)
  gameDuration: 45000,
  practice: true,
  minDelay: 2000,
  maxDelay: 6000,
  earlyPressPenalty: 0.1,
  postGreenTimeout: 10000,
  hardTimeout: 25000,
  slingshotDistance: 60,
  // pacing knobs (host UI never exposes these below sane values; the low
  // clamps exist so the bot harness can run a full game in seconds)
  musicMs: null,           // null = seeded 4–7s
  cutRevealMs: 8000,
  voteMs: 12000,
  redemptionPrepMs: 2500,  // client re-sync window before green is scheduled
  redemptionLeadMs: 3000,  // T_green broadcast this far ahead (spec: 2–3s)
  closeGraceMs: 1500,      // late-submission grace after a game's deadline
};

function sanitizeConfig(raw = {}) {
  const c = { ...DEFAULTS };
  const numIn = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  c.m = numIn(raw.m, 1, 3, DEFAULTS.m);
  c.gameDuration = numIn(raw.gameDuration, 500, 120000, DEFAULTS.gameDuration);
  c.practice = raw.practice != null ? !!raw.practice : DEFAULTS.practice;
  c.minDelay = numIn(raw.minDelay, 500, 10000, DEFAULTS.minDelay);
  c.maxDelay = numIn(raw.maxDelay, c.minDelay, 15000, Math.max(c.minDelay, DEFAULTS.maxDelay));
  c.earlyPressPenalty = numIn(raw.earlyPressPenalty, 0, 0.5, DEFAULTS.earlyPressPenalty);
  c.postGreenTimeout = numIn(raw.postGreenTimeout, 1000, 30000, DEFAULTS.postGreenTimeout);
  c.hardTimeout = numIn(raw.hardTimeout, 1000, 60000, DEFAULTS.hardTimeout);
  c.slingshotDistance = numIn(raw.slingshotDistance, 30, 150, DEFAULTS.slingshotDistance);
  c.musicMs = raw.musicMs != null ? numIn(raw.musicMs, 50, 15000, null) : null;
  c.cutRevealMs = numIn(raw.cutRevealMs, 50, 20000, DEFAULTS.cutRevealMs);
  c.voteMs = numIn(raw.voteMs, 200, 30000, DEFAULTS.voteMs);
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
    this.roundNumber = 0;
    this.usedGames = new Set();
    this.usedCategories = new Set();
    this.usedContent = {};
    this.round = null;
    this.eliminationOrder = []; // first eliminated first
    this.pendingSet = null;     // voted set of game keys for the next round
    this.redemption = null;
    this.vote = null;
    this.winnerId = null;
    this.finalStandings = null;
    this.timers = new Map();
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
    this.emitAll('phase', { name, ...data, ladder: this.ladderInfo() });
  }

  alive() { return [...this.players.values()].filter((p) => !p.eliminated); }
  eliminated() { return [...this.players.values()].filter((p) => p.eliminated); }

  ladderInfo() {
    const n = this.alive().length || this.players.size;
    return { alive: n, predicted: n >= 2 ? ladderFor(n) : [n], round: this.roundNumber };
  }

  playerSummaries() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      eliminated: p.eliminated,
      sync: p.sync || null,
    }));
  }

  broadcastPlayers() {
    this.emitAll('room:players', { players: this.playerSummaries() });
  }

  // ---- join / reconnect ---------------------------------------------------

  join(socket, { name, playerId }) {
    if (playerId && this.players.has(playerId)) {
      // Reconnect: rebind socket, 30s+ grace means nobody was eliminated for
      // a wifi hiccup (spec §8) — they simply may have missed submissions.
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
      eliminated: false,
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
        // are kept (P90 clamp on missed submissions, never auto-eliminated).
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
    // Per-player clock-sync confidence for the host screen (spec §5.2).
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
      players: this.playerSummaries(),
      ladder: this.ladderInfo(),
      config: this.publicConfig(),
      you: p ? { id: p.id, name: p.name, eliminated: p.eliminated } : null,
      winnerId: this.winnerId,
      finalStandings: this.finalStandings,
    };
    if ((this.phase === 'minigame' || this.phase === 'practice') && this.round) {
      const g = this.round.games[this.round.gameIndex];
      if (g && p && !p.eliminated && !g.submissions.has(p.id)) {
        snap.game = this.gamePayload(g);
      }
    }
    if (this.phase === 'voting' && this.vote) {
      snap.voting = { options: this.vote.options, endsAt: this.vote.endsAt };
    }
    return snap;
  }

  publicConfig() {
    const { m, gameDuration, practice, minDelay, maxDelay, earlyPressPenalty, slingshotDistance, enabled } = this.config;
    return { m, gameDuration, practice, minDelay, maxDelay, earlyPressPenalty, slingshotDistance, enabled };
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
    if (this.players.size < 3) return { error: 'Need at least 3 players.' };
    if (this.config.practice) this.startPractice();
    else this.startRound();
    return { ok: true };
  }

  // Practice: one un-scored Stop the Clock so broken devices surface before
  // round 1 (spec §9), not during it.
  startPractice() {
    const rng = seededRng(`${this.code}:practice`);
    const { clientData, secret } = buildGameData('stopclock', { rng, config: this.config, used: this.usedContent });
    this.round = {
      number: 0,
      practice: true,
      games: [{
        key: 'stopclock', ...ROSTER_BY_KEY.get('stopclock'),
        clientData, secret, submissions: new Map(), metrics: new Map(), token: crypto.randomUUID(),
      }],
      gameIndex: 0,
    };
    const g = this.round.games[0];
    const duration = Math.min(this.config.gameDuration, 30000);
    g.deadline = Date.now() + duration;
    this.setPhase('minigame', { ...this.gamePayload(g, duration), practice: true });
    this.emitHost('host:progress', { submitted: 0, total: this.alive().length });
    this.setTimer('game', () => this.closeGame(g.token), duration + this.config.closeGraceMs);
  }

  gamePayload(g, duration) {
    const dur = duration ?? this.config.gameDuration;
    return {
      round: this.round.number,
      gameIndex: this.round.gameIndex,
      gameCount: this.round.games.length,
      key: g.key,
      gameName: g.name,
      gameType: g.type,
      category: g.category,
      clientData: g.clientData,
      duration: dur,
      deadline: g.deadline ?? Date.now() + dur,
      practice: !!this.round.practice,
    };
  }

  startRound() {
    const alive = this.alive();
    const resolve = resolveRound(alive.length);
    if (resolve.type === 'FINAL') return this.startFinal();
    this.roundNumber++;
    const keys = this.takeGameSet(this.config.m);
    const rng = seededRng(`${this.code}:r${this.roundNumber}`);
    this.round = {
      number: this.roundNumber,
      practice: false,
      final: false,
      resolve,
      games: keys.map((key) => {
        const meta = ROSTER_BY_KEY.get(key);
        const { clientData, secret } = buildGameData(key, {
          rng: seededRng(`${this.code}:r${this.roundNumber}:${key}`),
          config: this.config,
          used: this.usedContent,
        });
        return { ...meta, clientData, secret, submissions: new Map(), metrics: new Map(), token: crypto.randomUUID() };
      }),
      gameIndex: -1,
      extras: {},
    };
    const musicMs = this.config.musicMs ?? 4000 + Math.floor(rng() * 3000);
    this.setPhase('music', {
      duration: musicMs,
      round: this.roundNumber,
      gameNames: this.round.games.map((g) => g.name),
      atStake: resolve,
    });
    this.setTimer('music', () => this.startGame(0), musicMs);
  }

  startFinal() {
    this.roundNumber++;
    const keys = this.takeGameSet(1);
    const meta = ROSTER_BY_KEY.get(keys[0]);
    const { clientData, secret } = buildGameData(keys[0], {
      rng: seededRng(`${this.code}:final:${keys[0]}`),
      config: this.config,
      used: this.usedContent,
    });
    this.round = {
      number: this.roundNumber,
      practice: false,
      final: true,
      games: [{ ...meta, clientData, secret, submissions: new Map(), metrics: new Map(), token: crypto.randomUUID() }],
      gameIndex: -1,
      extras: {},
    };
    const rng = seededRng(`${this.code}:finalmusic`);
    const musicMs = this.config.musicMs ?? 4000 + Math.floor(rng() * 3000);
    this.setPhase('music', {
      duration: musicMs,
      round: this.roundNumber,
      final: true,
      finalists: this.alive().map((p) => p.name),
      gameNames: [meta.name],
    });
    this.setTimer('music', () => this.startGame(0), musicMs);
  }

  // Selection rule (spec §6.1): never repeat a game in a session, never two
  // games of one category in a round, prefer unused categories. Repeats are
  // allowed only if the roster is genuinely exhausted.
  drawSet(m, rng) {
    let pool = ROSTER.filter((g) => this.config.enabled[g.key] && !this.usedGames.has(g.key));
    const cats = new Set(pool.map((g) => g.category));
    if (cats.size < Math.min(m, 1) || pool.length < m) {
      pool = ROSTER.filter((g) => this.config.enabled[g.key]);
      if (!pool.length) pool = [...ROSTER];
    }
    const byCat = new Map();
    for (const g of pool) {
      if (!byCat.has(g.category)) byCat.set(g.category, []);
      byCat.get(g.category).push(g);
    }
    const unusedCats = shuffle(rng, [...byCat.keys()].filter((c) => !this.usedCategories.has(c)));
    const usedCats = shuffle(rng, [...byCat.keys()].filter((c) => this.usedCategories.has(c)));
    const order = [...unusedCats, ...usedCats];
    const picked = [];
    for (const cat of order) {
      if (picked.length >= m) break;
      const options = byCat.get(cat);
      picked.push(options[Math.floor(rng() * options.length)].key);
    }
    return picked;
  }

  takeGameSet(m) {
    let keys;
    if (this.pendingSet && this.pendingSet.length) {
      keys = this.pendingSet.slice(0, m);
      this.pendingSet = null;
    } else {
      keys = this.drawSet(m, seededRng(`${this.code}:draw:${this.roundNumber}:${this.usedGames.size}`));
    }
    if (!keys.length) keys = [ROSTER[0].key];
    for (const k of keys) {
      this.usedGames.add(k);
      this.usedCategories.add(ROSTER_BY_KEY.get(k).category);
    }
    return keys;
  }

  startGame(idx) {
    const g = this.round.games[idx];
    if (!g) return this.scoreRound();
    this.round.gameIndex = idx;
    g.deadline = Date.now() + this.config.gameDuration;
    this.setPhase('minigame', this.gamePayload(g));
    this.emitHost('host:progress', { submitted: 0, total: this.alive().length });
    this.setTimer('game', () => this.closeGame(g.token), this.config.gameDuration + this.config.closeGraceMs);
  }

  handleSubmit(playerId, payload) {
    if (this.phase !== 'minigame') return;
    const p = this.players.get(playerId);
    if (!p || p.eliminated) return;
    const g = this.round.games[this.round.gameIndex];
    if (!g || g.submissions.has(playerId)) return;
    g.submissions.set(playerId, payload ?? {});
    if (!NEEDS_AGGREGATION.has(g.key)) {
      const metric = computeMetric(g.key, payload, g.secret, g.clientData, this.config);
      if (metric != null) g.metrics.set(playerId, metric);
    }
    const aliveCount = this.alive().length;
    const submitted = [...g.submissions.keys()].filter((id) => {
      const pl = this.players.get(id);
      return pl && !pl.eliminated;
    }).length;
    // Progress count only — never live scores (spec §8.1).
    this.emitAll('host:progress', { submitted, total: aliveCount });
    this.emitPlayer(playerId, 'submit:ack', { gameIndex: this.round.gameIndex });
    if (submitted >= aliveCount) this.closeGame(g.token);
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
      this.round.extras[g.key] = extra;
    }
    if (this.round.practice) {
      this.setPhase('practice_done', { submitted: g.submissions.size, total: this.alive().length });
      return;
    }
    const next = this.round.gameIndex + 1;
    if (next < this.round.games.length) this.startGame(next);
    else this.scoreRound();
  }

  // Normalization per spec §4: each game independently, within the round,
  // across only the players who played it, 0–1000. Non-submitters get 0.
  computeRoundScores() {
    const alive = this.alive();
    for (const g of this.round.games) {
      const submitters = alive.filter((p) => g.metrics.has(p.id));
      const values = submitters.map((p) => g.metrics.get(p.id));
      const normalized = values.length
        ? (g.type === 'error' ? normalizeError(values) : normalizeScore(values))
        : [];
      g.normalized = new Map();
      submitters.forEach((p, i) => g.normalized.set(p.id, normalized[i]));
      for (const p of alive) if (!g.normalized.has(p.id)) g.normalized.set(p.id, 0);
    }
    const ranking = alive
      .map((p) => ({
        id: p.id,
        total: this.round.games.reduce((s, g) => s + g.normalized.get(p.id), 0),
      }))
      .sort((a, b) => b.total - a.total);
    this.round.ranking = ranking;
    return ranking;
  }

  leaderboardRows(ranking) {
    return ranking.map((r, i) => {
      const p = this.players.get(r.id);
      return {
        rank: i + 1,
        id: r.id,
        name: p ? p.name : '?',
        total: Math.round(r.total),
        games: this.round.games.map((g) => ({
          key: g.key,
          name: g.name,
          norm: Math.round(g.normalized.get(r.id) ?? 0),
          raw: formatRaw(g.key, g.metrics.get(r.id) ?? null, g.submissions.get(r.id)),
        })),
      };
    });
  }

  scoreRound() {
    if (this.round.final) return this.scoreFinal();
    const ranking = this.computeRoundScores();
    const resolve = this.round.resolve;
    const split = splitAtCut(ranking, resolve.safeCount);
    this.round.split = split;
    const nameOf = (id) => this.players.get(id)?.name || '?';

    if (resolve.redemption) {
      // Bottom half (plus anyone tied at the cut, §4.5) go to redemption;
      // exactly one is saved.
      this.round.pendingEliminations = [];
      this.showCutThen(split, () => this.startRedemption(split.risk, 1, 'round'));
    } else if (split.tieAtCut) {
      // No redemption this round (bottom < 3), but a tie spans the cut line.
      // Never a coin flip: the tied players contest the remaining safe seats
      // with a reaction tiebreak; everyone strictly below is out regardless.
      const seats = resolve.safeCount - split.safe.length;
      this.round.pendingEliminations = split.below;
      this.showCutThen(split, () => this.startRedemption(split.tied, seats, 'cut-tiebreak'));
    } else {
      this.round.pendingEliminations = split.risk;
      this.round.redemptionResult = null;
      this.showCutThen(split, () => this.finishRoundReveal([]));
    }
  }

  showCutThen(split, next) {
    const rows = this.leaderboardRows(this.round.ranking);
    this.setPhase('cut', {
      round: this.round.number,
      leaderboard: rows,
      safeIds: split.safe,
      riskIds: split.risk,
      tieAtCut: split.tieAtCut,
      willRedeem: this.round.resolve?.redemption || split.tieAtCut,
      extras: this.round.extras,
    });
    for (const id of split.safe) this.emitPlayer(id, 'you:cut', { status: 'safe' });
    for (const id of split.risk) this.emitPlayer(id, 'you:cut', { status: 'risk' });
    this.setTimer('cut', next, this.config.cutRevealMs);
  }

  // ---- redemption ---------------------------------------------------------

  startRedemption(participantIds, saveCount, mode) {
    const c = this.config;
    this.redemption = {
      participants: participantIds,
      saveCount: Math.max(1, Math.min(saveCount, Math.max(1, participantIds.length - 1))),
      mode,
      reports: new Map(),
      tGreen: null,
      startedAt: Date.now(),
    };
    const names = participantIds.map((id) => this.players.get(id)?.name || '?');
    this.setPhase('redemption', {
      participants: participantIds,
      participantNames: names,
      saveCount: this.redemption.saveCount,
      mode,
      prepMs: c.redemptionPrepMs,
    });
    // Give clients a resync window (spec §5.2: re-sync before each redemption
    // round), then broadcast the absolute server-time T_green 2–3s ahead.
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
    // Server-side sanity (spec §5.2 step 6): a clean (no-early-press) report
    // should arrive roughly rtt after T_green + reportedTime. Flag, don't crash.
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
    const saved = results.slice(0, red.saveCount).map((r) => r.id);
    const eliminatedNow = results.slice(red.saveCount).map((r) => r.id);
    const redemptionResult = {
      mode: red.mode,
      saveCount: red.saveCount,
      savedIds: saved,
      results: results.map((r) => ({
        id: r.id, name: r.name, status: r.status, rawMs: r.rawMs,
        earlyPresses: r.earlyPresses, finalMs: Math.round(r.finalMs),
        flagged: r.flagged, saved: saved.includes(r.id),
      })),
    };
    if (red.mode === 'final-tiebreak') {
      this.round.redemptionResult = redemptionResult;
      return this.declareWinner(saved[0], redemptionResult);
    }
    this.round.redemptionResult = redemptionResult;
    this.finishRoundReveal(eliminatedNow);
  }

  // ---- reveal / voting ----------------------------------------------------

  finishRoundReveal(redemptionEliminated) {
    const toEliminate = [...(this.round.pendingEliminations || []), ...redemptionEliminated];
    for (const id of toEliminate) {
      const p = this.players.get(id);
      if (p && !p.eliminated) {
        p.eliminated = true;
        this.eliminationOrder.push(id);
        this.emitPlayer(id, 'you:eliminated', {
          round: this.round.number,
          place: this.players.size - this.eliminationOrder.length + 1,
        });
      }
    }
    const rows = this.leaderboardRows(this.round.ranking).map((row) => ({
      ...row,
      status: toEliminate.includes(row.id)
        ? 'eliminated'
        : this.round.redemptionResult?.savedIds?.includes(row.id)
          ? 'saved'
          : 'safe',
    }));
    this.setPhase('reveal', {
      round: this.round.number,
      leaderboard: rows,
      redemption: this.round.redemptionResult,
      eliminatedNames: toEliminate.map((id) => this.players.get(id)?.name || '?'),
      aliveCount: this.alive().length,
      nextIsFinal: resolveRound(this.alive().length).type === 'FINAL',
      extras: this.round.extras,
    });
    this.broadcastPlayers();
    // Host advances from reveal (host:next) → voting.
  }

  // Eliminated players pick the next round's minigame set (spec §8.3).
  startVoting() {
    const alive = this.alive();
    if (alive.length <= 1) return this.declareWinner(alive[0]?.id || null, null);
    const nextM = resolveRound(alive.length).type === 'FINAL' ? 1 : this.config.m;
    const rng = seededRng(`${this.code}:vote:${this.roundNumber}`);
    const options = [];
    const seen = new Set();
    for (let attempt = 0; attempt < 10 && options.length < 3; attempt++) {
      const keys = this.drawSet(nextM, seededRng(`${this.code}:vote:${this.roundNumber}:${attempt}`));
      if (!keys.length) continue;
      const sig = keys.slice().sort().join('+');
      if (seen.has(sig)) continue;
      seen.add(sig);
      options.push({
        id: options.length,
        games: keys.map((k) => ({ key: k, name: ROSTER_BY_KEY.get(k).name, category: ROSTER_BY_KEY.get(k).category })),
      });
    }
    const voters = this.eliminated().filter((p) => p.connected);
    this.vote = {
      options,
      votes: new Map(),
      voterIds: new Set(voters.map((p) => p.id)),
      endsAt: Date.now() + this.config.voteMs,
    };
    this.setPhase('voting', {
      options,
      duration: this.config.voteMs,
      endsAt: this.vote.endsAt,
      eligible: voters.length,
      nextIsFinal: nextM === 1,
    });
    // With nobody eliminated yet (or nobody connected), don't stall the room.
    const wait = voters.length ? this.config.voteMs : Math.min(this.config.voteMs, 2000);
    this.setTimer('vote', () => this.tallyVote(), wait);
  }

  handleVote(playerId, optionId) {
    if (this.phase !== 'voting' || !this.vote) return;
    if (!this.vote.voterIds.has(playerId)) return;
    const opt = this.vote.options.find((o) => o.id === optionId);
    if (!opt) return;
    this.vote.votes.set(playerId, optionId);
    const counts = this.voteCounts();
    this.emitAll('vote:update', { counts, voted: this.vote.votes.size, eligible: this.vote.voterIds.size });
    if (this.vote.votes.size >= this.vote.voterIds.size) this.tallyVote();
  }

  voteCounts() {
    const counts = this.vote.options.map(() => 0);
    for (const v of this.vote.votes.values()) counts[v]++;
    return counts;
  }

  tallyVote() {
    if (!this.vote) return;
    this.clearTimer('vote');
    const counts = this.voteCounts();
    let winner = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[winner]) winner = i;
    const chosen = this.vote.options[winner] || this.vote.options[0];
    this.pendingSet = chosen ? chosen.games.map((g) => g.key) : null;
    const votedNames = [...this.vote.votes.keys()].map((id) => this.players.get(id)?.name);
    this.vote = null;
    this.emitAll('vote:result', { chosen, counts, votedNames });
    this.setTimer('nextround', () => this.startRound(), 1200);
  }

  // ---- final --------------------------------------------------------------

  scoreFinal() {
    const ranking = this.computeRoundScores();
    this.round.ranking = ranking;
    const top = ranking[0];
    const tiedTop = ranking.filter((r) => r.total === top.total);
    if (tiedTop.length > 1) {
      // Sudden death: fastest reaction among the tied leaders wins.
      const rows = this.leaderboardRows(ranking);
      this.setPhase('cut', {
        round: this.round.number,
        final: true,
        leaderboard: rows,
        safeIds: [],
        riskIds: tiedTop.map((r) => r.id),
        tieAtCut: true,
        willRedeem: true,
        extras: this.round.extras,
      });
      this.setTimer('cut', () => this.startRedemption(tiedTop.map((r) => r.id), 1, 'final-tiebreak'),
        this.config.cutRevealMs);
      return;
    }
    this.declareWinner(top.id, null);
  }

  declareWinner(winnerId, tiebreak) {
    this.winnerId = winnerId;
    // Standings: winner, then remaining finalists by final-round rank, then
    // the eliminated in reverse elimination order.
    const standings = [];
    if (winnerId) standings.push(winnerId);
    if (this.round?.ranking) {
      for (const r of this.round.ranking) if (!standings.includes(r.id)) standings.push(r.id);
    }
    for (const p of this.alive()) if (!standings.includes(p.id)) standings.push(p.id);
    for (let i = this.eliminationOrder.length - 1; i >= 0; i--) {
      if (!standings.includes(this.eliminationOrder[i])) standings.push(this.eliminationOrder[i]);
    }
    this.finalStandings = standings.map((id, i) => ({
      place: i + 1,
      id,
      name: this.players.get(id)?.name || '?',
    }));
    const finalRows = this.round?.ranking ? this.leaderboardRows(this.round.ranking) : [];
    this.setPhase('winner', {
      winnerId,
      winnerName: this.players.get(winnerId)?.name || '?',
      standings: this.finalStandings,
      finalLeaderboard: finalRows,
      tiebreak,
      extras: this.round?.extras || {},
    });
  }

  // Rematch: same lobby, fresh session state.
  reset() {
    this.clearTimer('game'); this.clearTimer('music'); this.clearTimer('cut');
    this.clearTimer('vote'); this.clearTimer('redemption'); this.clearTimer('nextround');
    this.phase = 'lobby';
    this.roundNumber = 0;
    this.usedGames = new Set();
    this.usedCategories = new Set();
    this.usedContent = {};
    this.round = null;
    this.eliminationOrder = [];
    this.pendingSet = null;
    this.redemption = null;
    this.vote = null;
    this.winnerId = null;
    this.finalStandings = null;
    for (const p of this.players.values()) p.eliminated = false;
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    this.setPhase('lobby', {});
    this.broadcastPlayers();
  }

  // Host "next" — the single advance control. Also acts as a skip for any
  // phase that could stall (dead client mid-game, etc).
  hostNext() {
    switch (this.phase) {
      case 'lobby': return this.start();
      case 'practice_done': this.startRound(); return { ok: true };
      case 'minigame': {
        const g = this.round?.games[this.round.gameIndex];
        if (g) this.closeGame(g.token);
        return { ok: true };
      }
      case 'music':
        this.clearTimer('music');
        this.startGame(0);
        return { ok: true };
      case 'cut':
        return { ok: true }; // cut auto-advances; ignore
      case 'redemption':
        this.finishRedemption();
        return { ok: true };
      case 'reveal':
        this.startVoting();
        return { ok: true };
      case 'voting':
        this.tallyVote();
        return { ok: true };
      case 'winner':
        this.reset();
        return { ok: true };
      default:
        return { ok: true };
    }
  }
}
