// Player app shell: join/reconnect, clock sync, minigame lifecycle, the
// musical-chairs finale (bonus elimination tournament: slowest out each
// round, 3× points by placement), and per-game score reveals.

import { syncClock } from '/js/sync.js';
import { GameClients } from '/js/games.js';
import { startChairs, startChairsSeated } from '/js/chairs.js';
import { startTutorialAnim } from '/js/tutorials.js';
import { createRedemptionRun } from '/shared/redemption-core.js';

const socket = io();
const $ = (id) => document.getElementById(id);

const state = {
  code: null,
  playerId: null,
  name: null,
  offset: 0,
  game: null,          // { key, submitted }
  redemption: null,
  solo: false,
  roster: [],          // [{key, name, category}] — for the solo menu
  players: [],         // latest room roster w/ totals — feeds the live leaderboard
};

// ---- join flow -------------------------------------------------------------

const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('join-code').value = urlCode.toUpperCase();
$('join-name').value = localStorage.getItem('mc_name') || '';

$('join-btn').addEventListener('click', join);
$('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('solo-btn').addEventListener('click', soloStart);

function join() {
  const code = $('join-code').value.trim().toUpperCase();
  const name = $('join-name').value.trim();
  if (code.length !== 4) return showJoinError('Enter the 4-letter room code.');
  if (!name) return showJoinError('Enter your name.');
  localStorage.setItem('mc_name', name);
  const storedPid = localStorage.getItem(`mc_pid_${code}`);
  socket.emit('player:join', { code, name, playerId: storedPid }, (res) => enterRoom(res, code));
}

function soloStart() {
  const name = $('join-name').value.trim() || 'Solo';
  localStorage.setItem('mc_name', name);
  socket.emit('solo:create', { name }, (res) => enterRoom(res, res.snapshot?.code));
}

async function enterRoom(res, code) {
  if (res.error) return showJoinError(res.error);
  state.code = code;
  state.playerId = res.playerId;
  state.name = res.name;
  localStorage.setItem(`mc_pid_${code}`, res.playerId);
  $('screen-join').classList.add('hidden');
  $('screen-play').classList.remove('hidden');
  $('me-name').textContent = res.name;
  $('room-label').textContent = res.snapshot?.solo ? 'solo practice' : `room ${code}`;
  applySnapshot(res.snapshot);
  await doSync();
}

function showJoinError(msg) { $('join-error').textContent = msg; }

async function doSync() {
  const s = await syncClock(socket);
  state.offset = s.offset;
  socket.emit('sync:report', s);
}

socket.on('connect', () => {
  // Transparent reconnect: rejoin with the stored playerId.
  if (state.code && state.playerId) {
    socket.emit('player:join', { code: state.code, name: state.name, playerId: state.playerId }, (res) => {
      if (res && res.ok) {
        applySnapshot(res.snapshot);
        doSync();
      }
    });
  }
});

function applySnapshot(snap) {
  if (!snap) return;
  state.solo = !!snap.solo;
  if (snap.config?.roster) state.roster = snap.config.roster;
  if (snap.players) { state.players = snap.players; renderLiveboard(); }
  if (snap.game) {
    startMinigame(snap.game);
  } else if (snap.phase === 'tutorial' && snap.tutorial) {
    renderTutorial(snap.tutorial);
  } else if (snap.phase === 'scores' && snap.scores) {
    renderScores({ leaderboard: snap.scores });
  } else if (snap.phase === 'winner' && snap.finalStandings) {
    renderWinner({ standings: snap.finalStandings, winnerId: snap.winnerId, winnerName: snap.finalStandings[0]?.name });
  } else if (snap.phase === 'lobby') {
    if (state.solo) renderSoloMenu();
    else renderWaiting('You’re in! Waiting for the host to start…');
  } else {
    renderWaiting('Reconnected — waiting for the next phase…');
  }
}

// ---- solo practice menu ------------------------------------------------------

function renderSoloMenu() {
  clearAll();
  banner('SOLO PRACTICE', '');
  content().append(
    el('h2', {}, 'Pick a game to play'),
    el('p', { class: 'muted' }, 'Unscored practice — results show your raw metric.')
  );
  for (const g of state.roster) {
    content().append(el('button', {
      class: 'vote-option',
      onclick: () => socket.emit('solo:play', { key: g.key }, (res) => {
        if (res && res.error) alert(res.error);
      }),
    }, `▶ ${g.name}`));
  }
  content().append(el('button', {
    class: 'vote-option',
    onclick: () => socket.emit('solo:redemption', {}, (res) => {
      if (res && res.error) alert(res.error);
    }),
  }, '🚨 Musical chairs — reaction round'));
}

function soloBackButton() {
  return el('button', {
    class: 'big',
    style: 'margin-top:14px',
    onclick: () => socket.emit('solo:menu', {}, () => {}),
  }, 'Back to menu');
}

// ---- rendering helpers -----------------------------------------------------

const content = () => $('content');
const gameRoot = () => $('game-root');

let activeTut = null;

function clearAll() {
  activeTut?.stop();
  activeTut = null;
  content().replaceChildren();
  content().classList.remove('hidden');
  gameRoot().replaceChildren();
  $('banner').replaceChildren();
  hideCountdown();
  stopGameTimer();
}

// ---- live leaderboard (always on screen once ≥2 players have joined) --------

function renderLiveboard() {
  const lb = $('liveboard');
  if (!lb) return;
  const players = state.players || [];
  if (state.solo || players.length < 2) { lb.classList.add('hidden'); return; }
  lb.classList.remove('hidden');
  const sorted = [...players].sort((a, b) => b.total - a.total);
  lb.replaceChildren(el('span', { class: 'lb-title' }, '🏆'));
  sorted.forEach((p, i) => {
    lb.append(el('span', { class: 'lb-chip' + (p.id === state.playerId ? ' me' : '') },
      `${i + 1}. ${p.name} · ${p.total}`));
  });
  // Keep your own chip in view without yanking the strip around.
  const mine = lb.querySelector('.lb-chip.me');
  if (mine && mine.offsetLeft > lb.clientWidth) lb.scrollLeft = mine.offsetLeft - lb.clientWidth / 2;
}

function renderWaiting(msg, sub = '') {
  clearAll();
  content().append(el('h2', {}, msg));
  if (sub) content().append(el('p', { class: 'muted' }, sub));
}

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

function banner(text, cls = '') {
  $('banner').replaceChildren(el('div', { class: `status-banner ${cls}` }, text));
}

// ---- countdown bar ---------------------------------------------------------

let countdownRaf = null;
function showCountdown(deadlineLocal, duration) {
  $('countdown').classList.remove('hidden');
  const bar = $('countdown-bar');
  const tick = () => {
    const left = Math.max(0, deadlineLocal - performance.now());
    bar.style.width = `${(left / duration) * 100}%`;
    if (left > 0) countdownRaf = requestAnimationFrame(tick);
  };
  tick();
}
function hideCountdown() {
  $('countdown').classList.add('hidden');
  if (countdownRaf) cancelAnimationFrame(countdownRaf);
}

// ---- minigame lifecycle ----------------------------------------------------

let autoTimer = null;
function stopGameTimer() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  state.game = null;
}

// ---- animated how-to tutorial before each game ------------------------------

function renderTutorial(p) {
  clearAll();
  banner(p.chairs ? '🪑 GET READY' : p.gameNumber ? `GAME ${p.gameNumber}` : 'GET READY');
  content().append(
    el('h2', { class: 'center' }, `How to play: ${p.gameName}`),
    el('p', { class: 'muted center' }, state.solo
      ? 'Watch the demo, then press Play.'
      : 'Watch the demo — the host starts the game.')
  );
  activeTut = startTutorialAnim(content(), p.key);
  if (state.solo) {
    content().append(el('button', {
      class: 'big',
      style: 'margin-top:12px',
      onclick: () => socket.emit('solo:skip', {}, () => {}),
    }, 'Play ▸'));
  }
}

function startMinigame(payload) {
  clearAll();
  const client = GameClients[payload.key];
  if (!client) return renderWaiting(`Unknown game ${payload.key}`);
  content().append(
    el('h2', {}, (payload.practice ? '🧪 PRACTICE — ' : payload.test ? '🔧 TEST — ' : '') + payload.gameName),
    el('p', { class: 'muted' }, client.intro || '')
  );
  // Convert the server deadline to local time via the sync offset, then run
  // the countdown off performance.now().
  const localDeadline = payload.deadline - state.offset;
  const perfDeadline = performance.now() + (localDeadline - Date.now());
  showCountdown(perfDeadline, payload.duration);

  let submitted = false;
  const submit = (data) => {
    if (submitted) return;
    submitted = true;
    socket.emit('player:submit', { payload: data });
    hideCountdown();
    gameRoot().replaceChildren();
    content().replaceChildren(
      el('h2', {}, '✓ Submitted'),
      el('p', { class: 'muted' }, 'Waiting for everyone else…'),
      el('p', { class: 'muted', id: 'spec-progress' }, '')
    );
  };
  const handle = client.start(gameRoot(), {
    data: payload.clientData,
    duration: payload.duration,
    deadline: perfDeadline,
    submit,
    rng: null,
  });
  state.game = { key: payload.key, submitted: () => submitted };
  // Auto-collect partial progress just before the server closes the game.
  const msLeft = Math.max(0, localDeadline - Date.now() - 250);
  autoTimer = setTimeout(() => {
    if (!submitted && handle && typeof handle.collect === 'function') {
      const data = handle.collect();
      if (data) submit(data);
    }
  }, msLeft);
}

// ---- per-game score reveal -------------------------------------------------

function renderScores(p) {
  clearAll();
  const me = (p.leaderboard || []).find((r) => r.id === state.playerId);
  if (!me) return renderWaiting('Scores are in.', 'Watch the host screen.');
  banner(`#${me.rank} of ${p.leaderboard.length}`, me.rank === 1 ? 'safe' : '');
  content().append(
    el('h2', {}, `${p.gameName || 'Game'}: +${me.points} pts`),
    el('p', { class: 'muted' }, `Your result: ${me.raw}`),
    el('h2', {}, `Total: ${me.total} pts — #${me.rank} of ${p.leaderboard.length}`),
    el('p', { class: 'muted' },
      p.nextIsChairs ? 'Next up: MUSICAL CHAIRS — the finale!' : 'Next game starts soon…')
  );
}

// ---- socket events ---------------------------------------------------------

socket.on('room:players', ({ players }) => {
  state.players = players || [];
  renderLiveboard();
});

socket.on('phase', (p) => {
  switch (p.name) {
    case 'lobby':
      if (state.solo) renderSoloMenu();
      else renderWaiting('New game! Waiting for the host to start…');
      break;
    case 'music':
      clearAll();
      banner(p.chairs ? '🪑 MUSICAL CHAIRS' : `GAME ${p.gameNumber || ''}${p.progress ? ` of ${p.progress.totalGames}` : ''}`);
      content().append(
        el('h2', { class: 'center' }, '🎵 Music is playing…'),
        el('p', { class: 'muted center' },
          p.chairs
            ? 'BONUS ROUND — 3× points! Slowest reaction each round is OUT. Survive to the last chair!'
            : 'When it stops: ' + (p.gameNames || []).join(' + '))
      );
      break;
    case 'tutorial':
      renderTutorial(p);
      break;
    case 'minigame':
      startMinigame(p);
      break;
    case 'practice_done':
      renderWaiting('Practice over!', 'Host will start the games when everyone is ready.');
      break;
    case 'test_done': {
      const mine = (p.results || []).find((r) => r.id === state.playerId);
      clearAll();
      content().append(
        el('h2', {}, mine ? `🔧 ${p.gameName}: ${mine.raw}` : '🔧 Test over — no submission recorded.'),
        el('p', { class: 'muted' }, 'Unscored practice run.')
      );
      if (state.solo) content().append(soloBackButton());
      else content().append(el('p', { class: 'muted' }, 'Waiting for the host…'));
      break;
    }
    case 'redemption_test_done': {
      const mine = (p.results || []).find((r) => r.id === state.playerId);
      clearAll();
      const line = !mine ? 'No reaction recorded.'
        : mine.status === 'ok'
          ? `Your reaction: ${Math.round(mine.rawMs)} ms` +
            (mine.earlyPresses ? ` (+${mine.earlyPresses} early press${mine.earlyPresses > 1 ? 'es' : ''} → ${mine.finalMs} ms)` : '')
          : mine.status === 'postGreenTimeout' ? 'Too slow — the light was green!'
          : mine.status === 'tooFast' ? 'Impossibly fast — disqualified.'
          : 'You never saw green (kept pressing early).';
      content().append(el('h2', {}, `🚨 ${line}`), el('p', { class: 'muted' }, 'Unscored practice run.'));
      if (state.solo) content().append(soloBackButton());
      break;
    }
    case 'scores':
      renderScores(p);
      break;
    case 'redemption':
      // Survivors play; eliminated players spectate.
      if (p.participants.includes(state.playerId)) prepareRedemption(p);
      else if (p.round) renderWaiting(`🪑 Round ${p.round} of ${p.totalRounds} in progress…`,
        'You’re out of chairs — watch the host screen.');
      else renderWaiting('Musical chairs in progress…', 'Watch the host screen.');
      break;
    case 'chairs_result':
      renderChairsResult(p);
      break;
    case 'winner':
      renderWinner(p);
      break;
  }
});

socket.on('host:progress', ({ submitted, total }) => {
  const elP = document.getElementById('spec-progress');
  if (elP) elP.textContent = `${submitted} of ${total} submitted`;
});

// Personal score after each attempt (also fires for the chairs finale just
// before the winner screen).
socket.on('you:score', (s) => {
  // The scores phase already renders the full card for minigames; this covers
  // the chairs finale where the next phase is the winner screen.
  if (s.gameName === 'Musical Chairs') {
    renderWaiting(`🪑 Musical Chairs: ${s.raw} → +${s.points} pts`, `Total: ${s.total} pts`);
  }
});

// ---- musical chairs (reaction) ---------------------------------------------

// Round result: survivors see themselves take a chair; the slowest player
// walks off. The final placements pay 3× bonus points.
function renderChairsResult(p) {
  clearAll();
  const out = p.eliminated?.id === state.playerId;
  const ord = (n) => `${n}${['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'}`;
  banner(out ? `💥 OUT — ${ord(p.eliminated.place)} PLACE` : '🪑 SAFE!', out ? '' : 'safe');
  content().append(
    el('h2', { class: 'center' }, out
      ? `Slowest this round — you finish ${ord(p.eliminated.place)} in Musical Chairs.`
      : p.final
        ? '👑 You took the last chair!'
        : `You grabbed a chair — round ${p.round} of ${p.totalRounds} survived.`)
  );
  const arena = el('div', { style: 'display:flex;justify-content:center' });
  content().append(arena);
  startChairsSeated(arena, {
    seated: (p.survivors || []).map((s) => s.name),
    out: p.eliminated?.name || null,
    size: Math.min(280, Math.floor(window.innerHeight * 0.38)),
  });
  content().append(el('p', { class: 'muted center' }, p.final
    ? 'Bonus points: 3× by placement — results coming up…'
    : out
      ? 'Your placement still banks 3× bonus points at the end.'
      : 'Next round starts soon — one fewer chair!'));
}

function prepareRedemption(p) {
  clearAll();
  content().classList.add('hidden');
  const tz = $('tapzone');
  tz.classList.remove('hidden', 'green');
  $('tapzone-text').textContent = p.round
    ? `ROUND ${p.round} of ${p.totalRounds} — WAIT FOR GREEN`
    : 'WAIT FOR GREEN';
  $('tapzone-sub').textContent = p.round
    ? 'Slowest player loses their chair! Tap the instant it turns green. Too early = trouble.'
    : 'Tap or press any key the instant it turns green. Too early = trouble.';
  // Everyone circles the chairs while waiting for the light.
  const names = p.participantNames || [];
  const anim = startChairs(tz, {
    names,
    chairs: p.chairCount ?? Math.max(1, names.length - 1),
    size: Math.min(300, Math.floor(window.innerHeight * 0.4)),
  });
  tz.insertBefore(anim.canvas, $('tapzone-text'));
  state.redemption = { armed: false, anim };
  // Re-sync the clock in the background before green is scheduled. This must
  // not gate state.redemption: on a slow link the 10-sample sync can outlast
  // the server's prep window, and the redemption:go arriving mid-sync would
  // be dropped — the light would stay red forever. A stale offset from the
  // previous sync is a far better fallback than never seeing green.
  doSync();
}

socket.on('redemption:go', (p) => {
  if (!p.participants.includes(state.playerId)) return;
  if (!state.redemption) return;
  const tz = $('tapzone');
  // Convert server T_green to local, schedule against performance.now(),
  // and time from the rendered green frame (rAF timestamp) to keydown.
  const localTGreen = p.tGreen - state.offset;
  const initialDelay = localTGreen - Date.now();

  const run = createRedemptionRun({
    initialDelay,
    minDelay: p.minDelay,
    maxDelay: p.maxDelay,
    postGreenTimeout: p.postGreenTimeout,
    hardTimeout: p.hardTimeout,
    rng: Math.random, // resets are per-player by design; no shared seed needed
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    requestPaint: (cb) => requestAnimationFrame((ts) => {
      // Green = the music stopped: chairs vanish, just hit it.
      state.redemption?.anim?.remove();
      tz.classList.add('green');
      $('tapzone-text').textContent = 'GO!';
      $('tapzone-sub').textContent = '';
      cb(ts);
    }),
    onState: () => {},
    onFinish: (result) => {
      cleanup();
      socket.emit('redemption:report', result);
      tz.classList.add('hidden');
      content().classList.remove('hidden');
      clearAllButBanner();
      if (result.status === 'ok') {
        renderWaiting(`Your time: ${Math.round(result.rawMs)} ms`, 'Waiting for the others…');
      } else if (result.status === 'postGreenTimeout') {
        renderWaiting('Too slow — the light was green!', 'Waiting for the others…');
      } else {
        renderWaiting('Time expired.', 'Waiting for the others…');
      }
    },
  });

  const press = (e) => { e.preventDefault(); run.press(); };
  const keyPress = (e) => {
    if (e.repeat) return;
    press(e);
  };
  tz.addEventListener('pointerdown', press);
  document.addEventListener('keydown', keyPress);
  function cleanup() {
    tz.removeEventListener('pointerdown', press);
    document.removeEventListener('keydown', keyPress);
    tz.classList.remove('green');
    state.redemption?.anim?.remove();
  }
  state.redemption.run = run;
});

function clearAllButBanner() {
  content().replaceChildren();
  gameRoot().replaceChildren();
  hideCountdown();
}

// ---- winner ------------------------------------------------------------------

function renderWinner(p) {
  clearAll();
  const iWon = p.winnerId ? p.winnerId === state.playerId : p.standings?.[0]?.id === state.playerId;
  banner(iWon ? '👑 YOU WIN!' : '🏁 GAME OVER', iWon ? 'safe' : '');
  const myChairs = (p.chairsBoard || []).find((r) => r.id === state.playerId);
  const list = el('ol', {});
  for (const s of p.standings || []) {
    list.append(el('li', s.id === state.playerId ? { style: 'font-weight:700' } : {},
      `${s.name} — ${s.total} pts`));
  }
  content().append(el('h2', {}, `Winner: ${p.winnerName || '—'}`));
  if (myChairs) {
    content().append(el('p', { class: 'muted' },
      `Musical Chairs: #${myChairs.place} of ${p.chairsBoard.length} → +${myChairs.points} bonus pts (3×)`));
  }
  content().append(list);
}
