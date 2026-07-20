// Host screen: room creation, lobby + QR, config panel, phase displays,
// per-game leaderboards, the musical-chairs finale, winner.
// Format: every player plays every enabled game once, then Musical Chairs;
// highest cumulative score wins. No elimination.

import { syncClock } from '/js/sync.js';
import { startChairs } from '/js/chairs.js';
import { startTutorialAnim } from '/js/tutorials.js';

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
  renderLobbySummary();
}

function enabledCount() {
  return state.config ? Object.values(state.config.enabled).filter(Boolean).length : 0;
}

function renderLobbySummary() {
  $('lobby-ladder').replaceChildren(
    el('span', { class: 'step' },
      `${enabledCount()} games + musical chairs · highest total score wins`)
  );
}

// ---- config panel ----------------------------------------------------------

function buildConfigPanel() {
  const c = state.config;
  $('cfg-dur').value = Math.round(c.gameDuration / 1000);
  $('cfg-dur-val').textContent = Math.round(c.gameDuration / 1000);
  $('cfg-practice').checked = c.practice;

  const nameOf = (key) => (c.roster || []).find((g) => g.key === key)?.name || key;
  const toggles = $('game-toggles');
  toggles.replaceChildren();
  for (const [key, on] of Object.entries(c.enabled)) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = on;
    cb.addEventListener('change', () => pushConfig({ enabled: { [key]: cb.checked } }));
    toggles.append(el('label', {}, cb, nameOf(key)));
  }

  const tests = $('test-buttons');
  tests.replaceChildren();
  for (const g of c.roster || []) {
    tests.append(el('button', {
      class: 'secondary',
      onclick: () => socket.emit('host:test', { key: g.key }, (res) => {
        if (res && res.error) alert(res.error);
      }),
    }, `▶ ${g.name}`));
  }

  $('cfg-dur').oninput = (e) => { $('cfg-dur-val').textContent = e.target.value; pushConfig({ gameDuration: Number(e.target.value) * 1000 }); };
  $('cfg-practice').onchange = (e) => pushConfig({ practice: e.target.checked });
}

function pushConfig(patch) {
  socket.emit('host:config', patch, (res) => {
    if (res && res.error) console.warn(res.error);
  });
}

socket.on('room:config', (c) => {
  state.config = c;
  renderLobbySummary();
});

// ---- lobby joins -----------------------------------------------------------

socket.on('room:players', ({ players }) => {
  state.players = players;
  $('player-count').textContent = players.length;
  const list = $('joinlist');
  list.replaceChildren();
  for (const p of players) {
    const dotCls = !p.connected ? 'off' : (p.sync?.quality || 'ok');
    list.append(el('span', { class: 'chip' },
      el('span', { class: `dot ${dotCls}` }), p.name));
  }
  renderHostLiveboard();
});

// Always-on leaderboard strip across the top of the running screen.
function renderHostLiveboard() {
  const lb = $('host-liveboard');
  if (!lb) return;
  const sorted = [...state.players].sort((a, b) => b.total - a.total);
  lb.replaceChildren(el('span', { class: 'lb-title' }, '🏆'));
  sorted.forEach((p, i) => {
    lb.append(el('span', { class: 'lb-chip' + (i === 0 && p.total > 0 ? ' me' : '') },
      `${i + 1}. ${p.name} · ${p.total}`));
  });
}

function renderProgressInto(elm, progress) {
  elm.replaceChildren();
  if (!progress) return;
  elm.append(el('span', { class: 'step current' },
    `Game ${progress.game} of ${progress.totalGames}`));
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

let hostTut = null;

socket.on('phase', (p) => {
  state.phase = p.name;
  hostTut?.stop();
  hostTut = null;
  if (p.name !== 'lobby') {
    $('screen-lobby').classList.add('hidden');
    $('screen-run').classList.remove('hidden');
    renderHostLiveboard();
  }
  if (p.progress) renderProgressInto($('run-ladder'), p.progress);
  switch (p.name) {
    case 'lobby':
      $('screen-run').classList.add('hidden');
      $('screen-lobby').classList.remove('hidden');
      renderLobbySummary();
      break;
    case 'music': renderMusic(p); break;
    case 'tutorial': renderTutorial(p); break;
    case 'minigame': renderMinigame(p); break;
    case 'practice_done':
      content().replaceChildren(
        el('h1', {}, '🧪 Practice complete'),
        el('p', { class: 'muted' }, `${p.submitted} of ${p.total} submitted something. If someone was lost, fix it now.`),
        el('p', {}, 'Press Next ▸ to start the games for real.'));
      break;
    case 'test_done': renderTestDone(p); break;
    case 'scores': renderScores(p); break;
    case 'redemption': renderRedemption(p); break;
    case 'redemption_test_done': renderRedemptionTestDone(p); break;
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
  const arena = el('div', {});
  content().replaceChildren(
    el('h1', {}, p.chairs ? '🪑 MUSICAL CHAIRS — THE FINALE' : `Game ${p.gameNumber || ''} of ${p.progress?.totalGames || ''}`),
    el('h2', {}, '🎵 The music is playing…'),
    viz,
    arena,
    el('p', { class: 'muted', style: 'font-size:20px' },
      p.chairs
        ? 'When it stops: eyes on your own screen — press on green. Fastest reaction scores the most.'
        : `When it stops: ${(p.gameNames || []).join('  +  ')}`)
  );
  const names = state.players.map((pl) => pl.name);
  const anim = startChairs(arena, { names, chairs: Math.max(1, names.length - 1), size: 340 });
  playMusic(p.duration);
  setTimeout(() => {
    viz.classList.add('stopped');
    anim.stop(); // everyone freezes when the music cuts
    const h = content().querySelector('h2');
    if (h) h.textContent = '🛑 THE MUSIC STOPPED!';
  }, Math.max(0, p.duration - 150));
}

// ---- pre-game tutorial ------------------------------------------------------

function renderTutorial(p) {
  const demo = el('div', { style: 'max-width:460px; margin:0 auto' });
  content().replaceChildren(
    el('h1', {}, `${p.chairs ? '🪑 ' : ''}Up next: ${p.gameName}`),
    el('p', { class: 'muted', style: 'font-size:20px' }, 'How to play — watch the demo'),
    demo,
    el('p', { class: 'muted' }, 'Press Next ▸ to start the game.')
  );
  hostTut = startTutorialAnim(demo, p.key);
}

// ---- minigame progress (count only, never live scores) ---------------------

function renderMinigame(p) {
  content().replaceChildren(
    el('h1', {}, (p.practice ? '🧪 PRACTICE: ' : p.test ? '🔧 TEST: ' : '') + p.gameName),
    el('p', { class: 'muted', style: 'font-size:20px' }, `${Math.round(p.duration / 1000)}s`),
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

// ---- per-game scores --------------------------------------------------------

function extrasBlock(extras) {
  const wrap = el('div', {});
  if (!extras) return wrap;
  if (extras.readroom?.actualPct != null) {
    wrap.append(el('h3', {}, `The room's real answer: ${extras.readroom.actualPct}% said yes`));
  }
  return wrap;
}

function scoreTable(rows, { animate = false } = {}) {
  const table = el('table', { class: 'board' });
  table.append(el('tr', {},
    el('th', {}, '#'), el('th', {}, 'Player'),
    el('th', {}, 'Result'), el('th', {}, 'Points'), el('th', {}, 'Total')));
  rows.forEach((r) => {
    const tr = el('tr', { class: animate ? 'reveal-row' : '' },
      el('td', {}, String(r.rank)),
      el('td', {}, r.name),
      el('td', { class: 'num' }, r.raw),
      el('td', { class: 'num' }, `+${r.points}`),
      el('td', { class: 'num' }, String(r.total)));
    table.append(tr);
  });
  if (animate) {
    // Bottom-up staggered reveal.
    const trs = [...table.querySelectorAll('tr.reveal-row')];
    trs.reverse().forEach((tr, i) => setTimeout(() => tr.classList.add('shown'), 250 + i * 180));
  }
  return table;
}

function renderScores(p) {
  content().replaceChildren(
    el('h1', {}, `${p.gameName} — scores`),
    scoreTable(p.leaderboard, { animate: true }),
    extrasBlock(p.extras),
    el('p', { class: 'muted' },
      p.nextIsChairs
        ? 'Next up: 🪑 MUSICAL CHAIRS — the finale. Press Next ▸'
        : 'Press Next ▸ for the next game.')
  );
}

// ---- solo test results -------------------------------------------------------

function renderTestDone(p) {
  const table = el('table', { class: 'board' });
  table.append(el('tr', {}, el('th', {}, 'Player'), el('th', {}, 'Raw result')));
  for (const r of p.results || []) {
    table.append(el('tr', {}, el('td', {}, r.name), el('td', { class: 'num' }, r.raw)));
  }
  content().replaceChildren(
    el('h1', {}, `🔧 Test complete: ${p.gameName}`),
    p.results?.length
      ? table
      : el('p', { class: 'muted' }, 'Nobody submitted anything.'),
    el('p', { class: 'muted' }, `${p.results?.length || 0} of ${p.total} submitted.`),
    extrasBlock(p.extras),
    el('p', {}, 'Press Next ▸ to return to the lobby.')
  );
}

function fmtRedRow(r) {
  if (r.status === 'ok') {
    const pen = r.earlyPresses
      ? ` (+${r.earlyPresses} early press${r.earlyPresses > 1 ? 'es' : ''} → ${r.finalMs} ms)`
      : '';
    return `${r.name}: ${Math.round(r.rawMs)} ms${pen}${r.flagged ? ' ⚠' : ''}`;
  }
  if (r.status === 'postGreenTimeout') return `${r.name}: froze on green`;
  if (r.status === 'tooFast') return `${r.name}: impossibly fast ⚠ (disqualified)`;
  return `${r.name}: never saw green 💀 (${r.earlyPresses} early presses)`;
}

function renderRedemptionTestDone(p) {
  const box = el('div', {}, el('h1', {}, '🔧 Reaction test results'));
  for (const r of p.results || []) box.append(el('p', {}, fmtRedRow(r)));
  box.append(el('p', {}, 'Press Next ▸ to return to the lobby.'));
  content().replaceChildren(box);
}

// ---- musical chairs finale ---------------------------------------------------

let redemptionAnim = null;

function renderRedemption(p) {
  const arena = el('div', {});
  content().replaceChildren(
    el('h1', {}, '🪑 MUSICAL CHAIRS'),
    el('p', { style: 'font-size:22px' },
      p.scored
        ? `${p.participantNames.join(' · ')} — fastest reaction scores the most points.`
        : `${p.participantNames.join(' · ')}`),
    arena,
    el('div', { class: 'light', id: 'host-light' }, 'WAIT…'),
    el('p', { class: 'muted', id: 'red-progress' }, 'Eyes on your own screens. Press the instant it turns green.')
  );
  redemptionAnim = startChairs(arena, {
    names: p.participantNames,
    chairs: Math.max(1, p.participantNames.length - 1),
    size: 280,
  });
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
    redemptionAnim?.stop(); // music stopped — freeze the circle
  }, wait);
});

socket.on('redemption:progress', ({ reported, total }) => {
  const rp = $('red-progress');
  if (rp) rp.textContent = `${reported} of ${total} have pressed…`;
});

// ---- winner ------------------------------------------------------------------

function renderWinner(p) {
  const parts = [
    el('h2', {}, '👑 Your new office champion'),
    el('div', { class: 'winner-name' }, p.winnerName || '—'),
  ];
  if (p.chairsBoard?.length) {
    const box = el('div', { style: 'margin-top:10px' }, el('h2', {}, '🪑 Musical Chairs results'));
    for (const r of p.chairsBoard) {
      box.append(el('p', {}, `${fmtRedRow(r)} → +${r.points} pts`));
    }
    parts.push(box);
  }
  const table = el('table', { class: 'board' });
  table.append(el('tr', {}, el('th', {}, '#'), el('th', {}, 'Player'), el('th', {}, 'Total')));
  for (const s of p.standings || []) {
    table.append(el('tr', {},
      el('td', {}, String(s.place)), el('td', {}, s.name), el('td', { class: 'num' }, String(s.total))));
  }
  parts.push(el('h2', { style: 'margin-top:14px' }, 'Final standings'), table);
  parts.push(el('p', { class: 'muted' }, 'Press Next ▸ for a rematch lobby.'));
  content().replaceChildren(...parts);
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
    col: ['#00e5ff', '#ff2d95', '#ffd23d', '#3dff9e'][Math.floor(Math.random() * 4)],
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
