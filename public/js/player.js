// Player app shell: join/reconnect, clock sync, minigame lifecycle,
// redemption participation, voting, results.

import { syncClock } from '/js/sync.js';
import { GameClients } from '/js/games.js';
import { createRedemptionRun } from '/shared/redemption-core.js';

const socket = io();
const $ = (id) => document.getElementById(id);

const state = {
  code: null,
  playerId: null,
  name: null,
  eliminated: false,
  offset: 0,
  game: null,          // { handle, deadline, key, submitted, timer }
  redemption: null,
  votedOption: null,
};

// ---- join flow -------------------------------------------------------------

const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('join-code').value = urlCode.toUpperCase();
$('join-name').value = localStorage.getItem('mc_name') || '';

$('join-btn').addEventListener('click', join);
$('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join() {
  const code = $('join-code').value.trim().toUpperCase();
  const name = $('join-name').value.trim();
  if (code.length !== 4) return showJoinError('Enter the 4-letter room code.');
  if (!name) return showJoinError('Enter your name.');
  localStorage.setItem('mc_name', name);
  const storedPid = localStorage.getItem(`mc_pid_${code}`);
  socket.emit('player:join', { code, name, playerId: storedPid }, async (res) => {
    if (res.error) return showJoinError(res.error);
    state.code = code;
    state.playerId = res.playerId;
    state.name = res.name;
    localStorage.setItem(`mc_pid_${code}`, res.playerId);
    $('screen-join').classList.add('hidden');
    $('screen-play').classList.remove('hidden');
    $('me-name').textContent = res.name;
    $('room-label').textContent = `room ${code}`;
    applySnapshot(res.snapshot);
    await doSync();
  });
}

function showJoinError(msg) { $('join-error').textContent = msg; }

async function doSync() {
  const s = await syncClock(socket);
  state.offset = s.offset;
  socket.emit('sync:report', s);
}

socket.on('connect', () => {
  // Transparent reconnect: rejoin with the stored playerId (spec §8).
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
  if (snap.you) state.eliminated = snap.you.eliminated;
  if (snap.game) {
    startMinigame(snap.game);
  } else if (snap.phase === 'voting' && snap.voting) {
    renderVoting({ options: snap.voting.options });
  } else if (snap.phase === 'winner' && snap.finalStandings) {
    renderWinner({ standings: snap.finalStandings, winnerName: snap.finalStandings[0]?.name });
  } else if (snap.phase === 'lobby') {
    renderWaiting('You’re in! Waiting for the host to start…');
  } else {
    renderWaiting('Reconnected — waiting for the next phase…');
  }
}

// ---- rendering helpers -----------------------------------------------------

const content = () => $('content');
const gameRoot = () => $('game-root');

function clearAll() {
  content().replaceChildren();
  content().classList.remove('hidden');
  gameRoot().replaceChildren();
  $('banner').replaceChildren();
  hideCountdown();
  stopGameTimer();
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

function startMinigame(payload) {
  clearAll();
  if (state.eliminated) {
    banner('SPECTATING', '');
    content().append(
      el('h2', {}, `Round ${payload.round}: ${payload.gameName}`),
      el('p', { class: 'muted' }, 'The survivors are playing. You vote on the next games after this round.'),
      el('p', { class: 'muted', id: 'spec-progress' }, '')
    );
    return;
  }
  const client = GameClients[payload.key];
  if (!client) return renderWaiting(`Unknown game ${payload.key}`);
  content().append(
    el('h2', {}, (payload.practice ? '🧪 PRACTICE — ' : '') + payload.gameName),
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

// ---- socket events ---------------------------------------------------------

socket.on('room:players', () => {});

socket.on('phase', (p) => {
  switch (p.name) {
    case 'lobby':
      state.eliminated = false;
      renderWaiting('New game! Waiting for the host to start…');
      break;
    case 'music':
      clearAll();
      banner(p.final ? '🏆 FINAL' : `ROUND ${p.round}`);
      content().append(
        el('h2', { class: 'center' }, '🎵 Music is playing…'),
        el('p', { class: 'muted center' }, 'When it stops: ' + (p.gameNames || []).join(' + '))
      );
      break;
    case 'minigame':
      startMinigame(p);
      break;
    case 'practice_done':
      renderWaiting('Practice over!', 'Host will start round 1 when everyone is ready.');
      break;
    case 'cut':
      if (!state.eliminated) break; // players get personal you:cut below
      renderWaiting('Scores are in…', 'Watch the host screen for the cut.');
      break;
    case 'redemption':
      if (!p.participants.includes(state.playerId)) {
        clearAll();
        if (state.eliminated) renderWaiting('Redemption in progress…', 'Watch the host screen.');
        else {
          banner('SAFE', 'safe');
          renderWaiting('You have a seat. 🎉', `${p.participantNames.length} players fight for ${p.saveCount} spot${p.saveCount > 1 ? 's' : ''}.`);
        }
      } else {
        prepareRedemption(p);
      }
      break;
    case 'reveal':
      renderReveal(p);
      break;
    case 'voting':
      renderVoting(p);
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

socket.on('you:cut', ({ status }) => {
  clearAll();
  if (status === 'safe') {
    banner('SAFE', 'safe');
    renderWaiting('Top half — you keep your seat this round.');
  } else {
    banner('AT RISK', 'risk');
    renderWaiting('Bottom half. Get ready for redemption…', 'One of you gets saved. Fastest reaction wins.');
  }
}
);

socket.on('you:eliminated', ({ place }) => {
  state.eliminated = true;
  banner('ELIMINATED', 'risk');
});

// ---- redemption ------------------------------------------------------------

async function prepareRedemption(p) {
  clearAll();
  content().classList.add('hidden');
  // Re-sync before every redemption round (spec §5.2).
  await doSync();
  const tz = $('tapzone');
  tz.classList.remove('hidden', 'green');
  $('tapzone-text').textContent = 'WAIT FOR GREEN';
  $('tapzone-sub').textContent = 'Tap or press any key the instant it turns green. Too early = trouble.';
  state.redemption = { armed: false };
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
  }
  state.redemption.run = run;
});

function clearAllButBanner() {
  content().replaceChildren();
  gameRoot().replaceChildren();
  hideCountdown();
}

// ---- reveal / voting / winner ------------------------------------------------

function renderReveal(p) {
  clearAll();
  const me = p.leaderboard.find((r) => r.id === state.playerId);
  if (state.eliminated && p.eliminatedNames && p.leaderboard.some((r) => r.id === state.playerId && r.status === 'eliminated')) {
    banner('ELIMINATED', 'risk');
    content().append(
      el('h2', {}, 'The music stopped without you. 🪑'),
      el('p', { class: 'muted' }, 'You now vote on the games the survivors must play. Choose cruelly.')
    );
  } else if (me) {
    banner(me.status === 'saved' ? 'SAVED!' : 'SAFE', 'safe');
    content().append(
      el('h2', {}, `Round ${p.round}: #${me.rank} — ${me.total} pts`),
      ...me.games.map((gm) => el('p', { class: 'muted' }, `${gm.name}: ${gm.raw} → ${gm.norm}`))
    );
  } else if (state.eliminated) {
    renderWaiting('Round over.', 'Voting starts soon.');
  }
}

function renderVoting(p) {
  clearAll();
  state.votedOption = null;
  if (!state.eliminated) {
    renderWaiting('You’re through! 🎉', 'The eliminated are choosing your next ordeal…');
    return;
  }
  content().append(el('h2', {}, 'Pick the next games:'));
  for (const opt of p.options) {
    const btn = el('button', {
      class: 'vote-option',
      onclick: () => {
        state.votedOption = opt.id;
        socket.emit('player:vote', { optionId: opt.id });
        [...content().querySelectorAll('.vote-option')].forEach((b) => b.classList.remove('chosen'));
        btn.classList.add('chosen');
      },
    }, opt.games.map((g) => g.name).join(' + '));
    content().append(btn);
  }
}

socket.on('vote:result', ({ chosen }) => {
  if (state.eliminated && chosen) {
    renderWaiting('Vote locked in.', `Next: ${chosen.games.map((g) => g.name).join(' + ')}`);
  }
});

function renderWinner(p) {
  clearAll();
  const iWon = p.winnerId ? p.winnerId === state.playerId : p.standings?.[0]?.id === state.playerId;
  banner(iWon ? '👑 YOU WIN!' : '🏁 GAME OVER', iWon ? 'safe' : '');
  const list = el('ol', {});
  for (const s of p.standings || []) {
    list.append(el('li', s.id === state.playerId ? { style: 'font-weight:700' } : {}, `${s.name}`));
  }
  content().append(el('h2', {}, `Winner: ${p.winnerName || '—'}`), list);
}
