// Host screen: room creation, lobby + QR, config panel, phase displays,
// animated reveals, redemption drama, voting tallies, winner.

import { syncClock } from '/js/sync.js';

const socket = io();
const $ = (id) => document.getElementById(id);

const state = {
  code: null,
  hostKey: null,
  offset: 0,
  players: [],
  config: null,
  phase: 'lobby',
  audio: null,
};

const GAME_NAMES = {}; // filled from config toggles payload

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}

// ---- create / rejoin -------------------------------------------------------

$('create-btn').addEventListener('click', createRoom);

const saved = JSON.parse(sessionStorage.getItem('mc_host') || 'null');

socket.on('connect', async () => {
  const s = await syncClock(socket, 6);
  state.offset = s.offset;
  if (state.code && state.hostKey) {
    socket.emit('host:rejoin', { code: state.code, hostKey: state.hostKey }, () => {});
  } else if (saved && !state.code) {
    socket.emit('host:rejoin', saved, (res) => {
      if (res && res.ok) {
        state.code = res.code;
        state.hostKey = saved.hostKey;
        state.config = res.config;
        enterLobbyUi(res);
      }
    });
  }
});

function createRoom() {
  socket.emit('host:create', { origin: location.origin, config: {} }, (res) => {
    if (res.error) { $('create-error').textContent = res.error; return; }
    state.code = res.code;
    state.hostKey = res.hostKey;
    state.config = res.config;
    sessionStorage.setItem('mc_host', JSON.stringify({ code: res.code, hostKey: res.hostKey }));
    enterLobbyUi(res);
  });
}

function enterLobbyUi(res) {
  $('screen-create').classList.add('hidden');
  $('screen-lobby').classList.remove('hidden');
  $('room-code').textContent = state.code;
  $('run-code').textContent = state.code;
  if (res.qr) $('qr').src = res.qr;
  else $('qr').classList.add('hidden');
  $('join-url').textContent = res.joinUrl ? res.joinUrl.replace(/^https?:\/\//, '') : `${location.host}/?code=${state.code}`;
  buildConfigPanel();
  renderLadderInto($('lobby-ladder'), [state.players.length || 0], 0);
}

// ---- config panel ----------------------------------------------------------

function buildConfigPanel() {
  const c = state.config;
  $('cfg-m').value = c.m;
  $('cfg-m-val').textContent = c.m;
  $('cfg-dur').value = Math.round(c.gameDuration / 1000);
  $('cfg-dur-val').textContent = Math.round(c.gameDuration / 1000);
  $('cfg-pen').value = Math.round(c.earlyPressPenalty * 100);
  $('cfg-pen-val').textContent = Math.round(c.earlyPressPenalty * 100);
  $('cfg-sling').value = c.slingshotDistance;
  $('cfg-sling-val').textContent = c.slingshotDistance;
  $('cfg-practice').checked = c.practice;

  const toggles = $('game-toggles');
  toggles.replaceChildren();
  for (const [key, on] of Object.entries(c.enabled)) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = on;
    cb.addEventListener('change', () => pushConfig({ enabled: { [key]: cb.checked } }));
    toggles.append(el('label', {}, cb, key));
  }

  $('cfg-m').oninput = (e) => { $('cfg-m-val').textContent = e.target.value; pushConfig({ m: Number(e.target.value) }); };
  $('cfg-dur').oninput = (e) => { $('cfg-dur-val').textContent = e.target.value; pushConfig({ gameDuration: Number(e.target.value) * 1000 }); };
  $('cfg-pen').oninput = (e) => { $('cfg-pen-val').textContent = e.target.value; pushConfig({ earlyPressPenalty: Number(e.target.value) / 100 }); };
  $('cfg-sling').oninput = (e) => { $('cfg-sling-val').textContent = e.target.value; pushConfig({ slingshotDistance: Number(e.target.value) }); };
  $('cfg-practice').onchange = (e) => pushConfig({ practice: e.target.checked });
}

function pushConfig(patch) {
  socket.emit('host:config', patch, (res) => {
    if (res && res.error) console.warn(res.error);
  });
}

socket.on('room:config', (c) => { state.config = c; });

// ---- lobby joins -----------------------------------------------------------

socket.on('room:players', ({ players }) => {
  state.players = players;
  $('player-count').textContent = players.length;
  const list = $('joinlist');
  list.replaceChildren();
  for (const p of players) {
    const dotCls = !p.connected ? 'off' : (p.sync?.quality || 'ok');
    list.append(el('span', { class: `chip${p.eliminated ? ' eliminated' : ''}` },
      el('span', { class: `dot ${dotCls}` }), p.name));
  }
  if (state.phase === 'lobby') {
    const n = players.length;
    renderLadderInto($('lobby-ladder'), n >= 4 ? predictLadder(n) : [n], 0);
  }
});

// Client-side ladder prediction mirrors shared/ladder.js (kept tiny here).
function predictLadder(n) {
  const steps = [n];
  let cur = n;
  while (cur > 3) {
    const safe = Math.ceil(cur / 2);
    const bottom = Math.floor(cur / 2);
    cur = safe + (bottom >= 3 ? 1 : 0);
    steps.push(cur);
  }
  return steps;
}

function renderLadderInto(elm, steps, currentIdx) {
  elm.replaceChildren();
  steps.forEach((s, i) => {
    if (i) elm.append(el('span', { class: 'arrow' }, '→'));
    elm.append(el('span', { class: `step${i === currentIdx ? ' current' : ''}` }, String(s)));
  });
  elm.append(el('span', { class: 'arrow' }, '→'), el('span', { class: 'step' }, '🏆'));
}

// ---- start / next ----------------------------------------------------------

$('start-btn').addEventListener('click', () => {
  unlockAudio();
  socket.emit('host:start', {}, (res) => {
    if (res && res.error) alert(res.error);
  });
});
$('next-btn').addEventListener('click', () => socket.emit('host:next', {}, () => {}));

// ---- phases ----------------------------------------------------------------

const content = () => $('host-content');

socket.on('phase', (p) => {
  state.phase = p.name;
  if (p.name !== 'lobby') {
    $('screen-lobby').classList.add('hidden');
    $('screen-run').classList.remove('hidden');
  }
  if (p.ladder) {
    const steps = p.ladder.predicted && p.ladder.predicted.length > 1 ? p.ladder.predicted : predictLadder(p.ladder.alive);
    renderLadderInto($('run-ladder'), steps, 0);
  }
  switch (p.name) {
    case 'lobby':
      $('screen-run').classList.add('hidden');
      $('screen-lobby').classList.remove('hidden');
      break;
    case 'music': renderMusic(p); break;
    case 'minigame': renderMinigame(p); break;
    case 'practice_done':
      content().replaceChildren(
        el('h1', {}, '🧪 Practice complete'),
        el('p', { class: 'muted' }, `${p.submitted} of ${p.total} submitted something. If someone was lost, fix it now.`),
        el('p', {}, 'Press Next ▸ to start Round 1 for real.'));
      break;
    case 'cut': renderCut(p); break;
    case 'redemption': renderRedemption(p); break;
    case 'reveal': renderReveal(p); break;
    case 'voting': renderVoting(p); break;
    case 'winner': renderWinner(p); break;
  }
});

// ---- music (visual + audio on the host screen only) ------------------------

function unlockAudio() {
  if (!state.audio) {
    try { state.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
  }
  if (state.audio && state.audio.state === 'suspended') state.audio.resume();
}

let musicStop = null;
function playMusic(durationMs) {
  if (!state.audio) return;
  const ctx = state.audio;
  const notes = [0, 4, 7, 12, 7, 4, 0, -5];
  const gain = ctx.createGain();
  gain.gain.value = 0.08;
  gain.connect(ctx.destination);
  let i = 0;
  const iv = setInterval(() => {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 330 * Math.pow(2, notes[i % notes.length] / 12);
    o.connect(gain);
    o.start();
    o.stop(ctx.currentTime + 0.14);
    i++;
  }, 170);
  musicStop = () => { clearInterval(iv); gain.disconnect(); };
  setTimeout(() => musicStop && musicStop(), durationMs);
}

function renderMusic(p) {
  const viz = el('div', { class: 'music-viz' });
  for (let i = 0; i < 10; i++) {
    viz.append(el('div', { class: 'bar', style: `animation-delay:-${i * 0.07}s` }));
  }
  content().replaceChildren(
    el('h1', {}, p.final ? '🏆 THE FINAL' : `Round ${p.round}`),
    el('h2', {}, '🎵 The music is playing…'),
    viz,
    el('p', { class: 'muted', style: 'font-size:20px' }, `When it stops: ${(p.gameNames || []).join('  +  ')}`)
  );
  playMusic(p.duration);
  setTimeout(() => {
    viz.classList.add('stopped');
    const h = content().querySelector('h2');
    if (h) h.textContent = '🛑 THE MUSIC STOPPED!';
  }, Math.max(0, p.duration - 150));
}

// ---- minigame progress (count only, never live scores — spec §8.1) ---------

function renderMinigame(p) {
  content().replaceChildren(
    el('h1', {}, (p.practice ? '🧪 PRACTICE: ' : '') + p.gameName),
    el('p', { class: 'muted', style: 'font-size:20px' }, `Game ${p.gameIndex + 1} of ${p.gameCount} · ${Math.round(p.duration / 1000)}s`),
    el('div', { class: 'progress-count', id: 'prog' }, '0'),
    el('p', { class: 'muted', style: 'font-size:22px' }, 'submitted'),
    el('div', { class: 'countdown' }, el('div', { id: 'host-bar' }))
  );
  const localDeadline = p.deadline - state.offset;
  const tick = () => {
    const left = Math.max(0, localDeadline - Date.now());
    const bar = $('host-bar');
    if (!bar) return;
    bar.style.width = `${(left / p.duration) * 100}%`;
    if (left > 0 && state.phase === 'minigame') requestAnimationFrame(tick);
  };
  tick();
}

socket.on('host:progress', ({ submitted, total }) => {
  const prog = $('prog');
  if (prog) prog.textContent = `${submitted} of ${total}`;
});

// ---- cut + redemption drama --------------------------------------------------

function boardTable(rows, { safeIds = [], animate = false } = {}) {
  const table = el('table', { class: 'board' });
  table.append(el('tr', {},
    el('th', {}, '#'), el('th', {}, 'Player'),
    ...(rows[0]?.games || []).map((g) => el('th', {}, g.name)),
    el('th', {}, 'Total'), el('th', {}, '')));
  rows.forEach((r, i) => {
    const cls = [];
    if (animate) cls.push('reveal-row');
    if (r.status === 'eliminated') cls.push('eliminated');
    if (r.status === 'saved') cls.push('saved');
    if (safeIds.length && i === safeIds.length - 1) cls.push('cutline');
    const tr = el('tr', { class: cls.join(' ') },
      el('td', {}, String(r.rank)),
      el('td', {}, r.name),
      ...r.games.map((g) => el('td', { class: 'num' }, `${g.raw} · ${g.norm}`)),
      el('td', { class: 'num' }, String(r.total)),
      el('td', {}, r.status === 'saved' ? '🛟 saved' : r.status === 'eliminated' ? '❌ out' : ''));
    table.append(tr);
  });
  if (animate) {
    // Bottom-up staggered reveal.
    const trs = [...table.querySelectorAll('tr.reveal-row')];
    trs.reverse().forEach((tr, i) => setTimeout(() => tr.classList.add('shown'), 250 + i * 220));
  }
  return table;
}

function extrasBlock(extras) {
  const wrap = el('div', {});
  if (!extras) return wrap;
  if (extras.unique?.clusters?.length) {
    wrap.append(el('h3', {}, 'The answers:'));
    const div = el('div', { class: 'answer-clusters' });
    for (const c of extras.unique.clusters) {
      div.append(el('p', {}, `${c.label} ×${c.size} — ${c.answers.join(', ')}`));
    }
    wrap.append(div);
  }
  if (extras.readroom?.actualPct != null) {
    wrap.append(el('h3', {}, `The room's real answer: ${extras.readroom.actualPct}% said yes`));
  }
  return wrap;
}

function renderCut(p) {
  const safeNames = p.leaderboard.filter((r) => p.safeIds.includes(r.id)).map((r) => r.name);
  const riskNames = p.leaderboard.filter((r) => p.riskIds.includes(r.id)).map((r) => r.name);
  content().replaceChildren(
    el('h1', {}, `Round ${p.round} — the cut`),
    boardTable(p.leaderboard, { safeIds: p.safeIds }),
    el('h2', { style: 'color:var(--good)' }, `Safe: ${safeNames.join(', ') || '—'}`),
    el('h2', { style: 'color:var(--bad)' },
      p.willRedeem ? `Fighting for redemption: ${riskNames.join(', ')}` : `Eliminated: ${riskNames.join(', ')}`),
    p.tieAtCut ? el('p', { class: 'muted' }, 'Tie at the cut line — everyone tied goes to redemption.') : '',
    extrasBlock(p.extras)
  );
}

function renderRedemption(p) {
  content().replaceChildren(
    el('h1', {}, p.mode === 'final-tiebreak' ? '⚡ SUDDEN DEATH' : '🚨 REDEMPTION'),
    el('p', { style: 'font-size:22px' },
      `${p.participantNames.join(' · ')} — ${p.saveCount} will be saved.`),
    el('div', { class: 'light', id: 'host-light' }, 'WAIT…'),
    el('p', { class: 'muted', id: 'red-progress' }, 'Eyes on your own screens. Press the instant it turns green.')
  );
}

socket.on('redemption:go', (p) => {
  // Ambiance only — each participant's light is authoritative on their own
  // device (their early presses reschedule their own green).
  const light = $('host-light');
  if (!light) return;
  const wait = Math.max(0, (p.tGreen - state.offset) - Date.now());
  setTimeout(() => {
    const l = $('host-light');
    if (l) { l.classList.add('green'); l.textContent = 'GO!'; }
  }, wait);
});

socket.on('redemption:progress', ({ reported, total }) => {
  const rp = $('red-progress');
  if (rp) rp.textContent = `${reported} of ${total} have pressed…`;
});

// ---- reveal ------------------------------------------------------------------

function fmtRedRow(r) {
  if (r.status === 'ok') {
    const pen = r.earlyPresses
      ? ` (+${r.earlyPresses} early press${r.earlyPresses > 1 ? 'es' : ''} → ${r.finalMs} ms)`
      : '';
    return `${r.name}: ${Math.round(r.rawMs)} ms${pen}${r.flagged ? ' ⚠' : ''}`;
  }
  if (r.status === 'postGreenTimeout') return `${r.name}: froze on green (10s)`;
  if (r.status === 'tooFast') return `${r.name}: impossibly fast ⚠ (disqualified)`;
  return `${r.name}: never saw green 💀 (${r.earlyPresses} early presses)`;
}

function renderReveal(p) {
  const parts = [
    el('h1', {}, `Round ${p.round} — results`),
    boardTable(p.leaderboard, { animate: true }),
  ];
  if (p.redemption) {
    const box = el('div', { style: 'margin-top:14px' }, el('h2', {}, '🚨 Redemption results'));
    for (const r of p.redemption.results) {
      box.append(el('p', { style: r.saved ? 'color:var(--good);font-weight:700;font-size:20px' : '' },
        (r.saved ? '🛟 ' : '') + fmtRedRow(r)));
    }
    parts.push(box);
  }
  if (p.eliminatedNames?.length) {
    parts.push(el('h2', { style: 'color:var(--bad)' }, `Out: ${p.eliminatedNames.join(', ')}`));
  }
  parts.push(extrasBlock(p.extras));
  parts.push(el('p', { class: 'muted' },
    p.nextIsFinal ? 'Next up: THE FINAL. Press Next ▸' : 'Press Next ▸ for minigame voting.'));
  content().replaceChildren(...parts);
}

// ---- voting ------------------------------------------------------------------

function renderVoting(p) {
  const rows = p.options.map((o, i) => el('h2', { id: `vopt-${i}` },
    `${o.games.map((g) => g.name).join(' + ')} — 0 votes`));
  content().replaceChildren(
    el('h1', {}, p.nextIsFinal ? '🗳 The eliminated choose the FINAL game' : '🗳 The eliminated choose the next games'),
    el('p', { class: 'muted' }, `${p.eligible} ghost${p.eligible === 1 ? '' : 's'} voting…`),
    ...rows
  );
}

socket.on('vote:update', ({ counts }) => {
  counts.forEach((c, i) => {
    const o = $(`vopt-${i}`);
    if (o) o.textContent = o.textContent.replace(/ — \d+ votes?$/, ` — ${c} vote${c === 1 ? '' : 's'}`);
  });
});

socket.on('vote:result', ({ chosen }) => {
  if (!chosen) return;
  content().append(el('h2', { style: 'color:var(--good)' },
    `Chosen: ${chosen.games.map((g) => g.name).join(' + ')}`));
});

// ---- winner ------------------------------------------------------------------

function renderWinner(p) {
  const list = el('ol', { style: 'font-size:22px; text-align:left; max-width:420px; margin:20px auto' });
  for (const s of (p.standings || []).slice(0, 10)) list.append(el('li', {}, s.name));
  content().replaceChildren(
    el('h2', {}, '👑 Your new office champion'),
    el('div', { class: 'winner-name' }, p.winnerName || '—'),
    p.tiebreak ? el('p', { class: 'muted' }, 'Decided by sudden-death reaction!') : '',
    p.finalLeaderboard?.length ? boardTable(p.finalLeaderboard) : '',
    list,
    el('p', { class: 'muted' }, 'Press Next ▸ for a rematch lobby.')
  );
  confetti();
}

function confetti() {
  const c = el('canvas', { style: 'position:fixed;inset:0;pointer-events:none;z-index:99' });
  document.body.append(c);
  c.width = innerWidth; c.height = innerHeight;
  const g = c.getContext('2d');
  const parts = [...Array(180)].map(() => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height,
    v: 2 + Math.random() * 4, r: 3 + Math.random() * 5,
    col: ['#7c5cff', '#22d3a5', '#ffc555', '#ff5470'][Math.floor(Math.random() * 4)],
    w: Math.random() * 2 - 1,
  }));
  let frames = 0;
  const tick = () => {
    g.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.y += p.v; p.x += p.w;
      if (p.y > c.height) p.y = -10;
      g.fillStyle = p.col;
      g.fillRect(p.x, p.y, p.r, p.r * 1.6);
    }
    if (++frames < 60 * 12 && state.phase === 'winner') requestAnimationFrame(tick);
    else c.remove();
  };
  tick();
}
