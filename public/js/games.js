// Client-side minigame implementations. Contract:
//   GameClients[key].start(root, ctx) -> { collect?: () => payload | null }
// ctx: { data, duration, deadline, submit(payload), rng }
//   - data: server-built round data (identical for every player, seeded)
//   - submit: call once with the payload; the shell locks the UI after
//   - collect: shell calls it at the deadline to auto-submit partial progress
// All randomness in game content comes from the server data or the seeded
// rng — Math.random() only ever drives decoration, never scoring or physics.

import { seededRng } from '/shared/rng.js';
import { createPressCounter } from '/shared/presscounter.js';

// ---- tiny DOM helpers ------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids) {
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Vertical space left for a game below `root`'s top edge, so everything fits
// in the viewport without scrolling. `reserve` = room kept for the game's own
// notes/buttons around the play area.
function availHeight(root, reserve = 0) {
  const top = root.getBoundingClientRect().top || 0;
  return Math.max(160, Math.floor(window.innerHeight - top - reserve - 16));
}

function makeCanvas(root, height = 360, reserve = 90) {
  const c = h('canvas', { class: 'game' });
  root.append(c);
  const w = Math.min(root.clientWidth || 680, 680);
  const hgt = Math.min(height, availHeight(root, reserve));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = w * dpr;
  c.height = hgt * dpr;
  // Explicit CSS size (not width:100%) so pointer coordinates always match
  // the logical drawing coordinates.
  c.style.width = `${w}px`;
  c.style.maxWidth = '100%';
  c.style.height = `${hgt}px`;
  c.style.margin = '0 auto';
  const ctx2d = c.getContext('2d');
  ctx2d.scale(dpr, dpr);
  return { canvas: c, ctx: ctx2d, w, hgt };
}

function canvasPos(canvas, ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const GameClients = {};

// ---- 1. RGB Color Match ----------------------------------------------------

GameClients.rgb = {
  intro: 'Mix the sliders to match the target color, then lock it in.',
  start(root, ctx) {
    const t = ctx.data.target;
    const cur = { r: 128, g: 128, b: 128 };
    const target = h('div', { class: 'swatch', style: { background: `rgb(${t.r},${t.g},${t.b})` } });
    const preview = h('div', { class: 'swatch' });
    const sliders = {};
    const paint = () => { preview.style.background = `rgb(${cur.r},${cur.g},${cur.b})`; };
    const sliderRow = (chan, color) => {
      const s = h('input', {
        type: 'range', min: 0, max: 255, value: cur[chan],
        oninput: (e) => { cur[chan] = Number(e.target.value); paint(); },
        style: { accentColor: color },
      });
      sliders[chan] = s;
      return h('div', {}, h('label', { class: 'muted' }, chan.toUpperCase()), s);
    };
    paint();
    root.append(
      h('p', {}, 'Target:'), target,
      h('p', {}, 'Yours:'), preview,
      sliderRow('r', '#ff5470'), sliderRow('g', '#3dff9e'), sliderRow('b', '#00e5ff'),
      h('div', { style: { marginTop: '12px' } },
        h('button', { class: 'big', onclick: () => ctx.submit({ ...cur }) }, 'Lock it in'))
    );
    return { collect: () => ({ ...cur }) };
  },
};

// ---- 2. Odd One Out --------------------------------------------------------

GameClients.oddoneout = {
  intro: 'One tile is a different shade. Tap it. Wrong tap = 1s freeze.',
  start(root, ctx) {
    const rng = seededRng(ctx.data.seed);
    let cleared = 0;
    let level = 0;
    let frozen = false;
    const score = h('div', { class: 'mash-count' }, '0');
    const gridEl = h('div', { class: 'oddgrid' });
    root.append(score, gridEl);
    // Square grid sized to fit the viewport below the score — never scroll.
    const side = Math.min(root.clientWidth || 680, 480, availHeight(root, 100));
    gridEl.style.width = `${side}px`;
    gridEl.style.margin = '0 auto';

    function next() {
      level++;
      const size = Math.min(2 + Math.ceil(level / 2), 8);
      const delta = Math.max(5, Math.round(42 * Math.pow(0.86, level)));
      const hue = Math.floor(rng() * 360);
      const light = 45 + Math.floor(rng() * 20);
      const oddIdx = Math.floor(rng() * size * size);
      gridEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
      gridEl.replaceChildren();
      for (let i = 0; i < size * size; i++) {
        const l = i === oddIdx ? light + delta / 2.5 : light;
        gridEl.append(h('button', {
          class: 'tile',
          style: { background: `hsl(${hue} 65% ${l}%)` },
          onclick: () => {
            if (frozen) return;
            if (i === oddIdx) {
              cleared++;
              score.textContent = String(cleared);
              next();
            } else {
              frozen = true;
              gridEl.style.opacity = '0.3';
              setTimeout(() => { frozen = false; gridEl.style.opacity = '1'; }, 1000);
            }
          },
        }));
      }
    }
    next();
    return { collect: () => ({ cleared }) };
  },
};

// ---- 3. Bisect the Line ----------------------------------------------------

GameClients.bisect = {
  intro: 'Tap the line at exactly the percentage asked. No feedback between tries.',
  start(root, ctx) {
    const targets = ctx.data.targets;
    const guesses = [];
    const prompt = h('h2', { class: 'center' });
    const note = h('p', { class: 'trial-note center' });
    const { canvas, ctx: g, w } = makeCanvas(root, 140);
    root.prepend(prompt);
    root.append(note);
    const pad = 24;

    function draw() {
      g.clearRect(0, 0, w, 140);
      g.shadowColor = '#00e5ff';
      g.shadowBlur = 12;
      g.strokeStyle = '#00e5ff';
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(pad, 70); g.lineTo(w - pad, 70); g.stroke();
      for (const x of [pad, w - pad]) {
        g.beginPath(); g.moveTo(x, 50); g.lineTo(x, 90); g.stroke();
      }
      g.shadowBlur = 0;
      g.fillStyle = '#3d5a6b';
      g.font = '14px system-ui';
      g.fillText('0%', pad - 8, 110);
      g.fillText('100%', w - pad - 18, 110);
    }
    function show() {
      if (guesses.length >= targets.length) return ctx.submit({ guesses });
      prompt.textContent = `Tap at ${targets[guesses.length]}%`;
      note.textContent = `${guesses.length + 1} of ${targets.length}`;
      draw();
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (guesses.length >= targets.length) return;
      const { x } = canvasPos(canvas, e);
      guesses.push(clamp(((x - pad) / (w - 2 * pad)) * 100, 0, 100));
      show();
    });
    show();
    return { collect: () => (guesses.length ? { guesses } : null) };
  },
};

// ---- 5. Trace the Shape ----------------------------------------------------

GameClients.trace = {
  intro: 'Trace the outline with your finger or cursor. Cover the whole shape.',
  start(root, ctx) {
    const { canvas, ctx: g, w, hgt } = makeCanvas(root, 360);
    const path = shapePath(ctx.data.shape, w, hgt);
    const diag = Math.hypot(w, hgt);
    const strokes = [];
    let drawing = false;

    function drawBase() {
      g.clearRect(0, 0, w, hgt);
      g.shadowColor = '#ff2d95';
      g.shadowBlur = 16;
      g.strokeStyle = 'rgba(255,45,149,0.85)';
      g.lineWidth = 8;
      g.lineJoin = g.lineCap = 'round';
      g.beginPath();
      path.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
      g.shadowColor = '#3dff9e';
      g.shadowBlur = 10;
      g.strokeStyle = '#3dff9e';
      g.lineWidth = 3;
      g.beginPath();
      let started = false;
      for (const p of strokes) {
        if (p === null) { started = false; continue; }
        if (!started) { g.moveTo(p.x, p.y); started = true; }
        else g.lineTo(p.x, p.y);
      }
      g.stroke();
    }
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      strokes.push(null, canvasPos(canvas, e));
      drawBase();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      strokes.push(canvasPos(canvas, e));
      drawBase();
    });
    canvas.addEventListener('pointerup', () => { drawing = false; });
    drawBase();

    function result() {
      const pts = strokes.filter(Boolean);
      if (pts.length < 5) return null;
      // Mean distance from each drawn point to the path, normalized by the
      // shape's bounding-box diagonal so screen size doesn't matter.
      const xs = path.map((p) => p.x);
      const ys = path.map((p) => p.y);
      const bbDiag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      let sum = 0;
      for (const p of pts) sum += nearestDist(p, path);
      const deviation = sum / pts.length / bbDiag;
      const covThresh = diag * 0.04;
      let covered = 0;
      for (const q of path) if (nearestDist(q, pts) <= covThresh) covered++;
      return { deviation, coverage: covered / path.length };
    }
    root.append(h('button', {
      class: 'big', style: { marginTop: '10px' },
      onclick: () => { const r = result(); if (r) ctx.submit(r); },
    }, 'Done tracing'));
    return { collect: result };
  },
};

function nearestDist(p, pts) {
  let best = Infinity;
  for (const q of pts) {
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// Interpolate a closed polygon (corners in normalized [-1,1] coords) into a
// dense polyline centered at (cx, cy) with scale s.
function polygonPath(corners, cx, cy, s) {
  const pts = [];
  const closed = [...corners, corners[0]];
  // ~200 samples total regardless of corner count, so the deviation metric
  // is equally fine-grained on a triangle and a 12-corner cross.
  const per = Math.max(8, Math.ceil(200 / corners.length));
  for (let i = 0; i < closed.length - 1; i++) {
    for (let k = 0; k < per; k++) {
      const t = k / per;
      pts.push({
        x: cx + s * (closed[i][0] + (closed[i + 1][0] - closed[i][0]) * t),
        y: cy + s * (closed[i][1] + (closed[i + 1][1] - closed[i][1]) * t),
      });
    }
  }
  pts.push({ x: cx + s * corners[0][0], y: cy + s * corners[0][1] });
  return pts;
}

// Normalized corner lists ([-1,1] box, y down) for the polygon shapes.
const SHAPE_CORNERS = {
  triangle: [[0, -1], [1, 0.8], [-1, 0.8]],
  square: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
  diamond: [[0, -1], [1, 0], [0, 1], [-1, 0]],
  hourglass: [[-0.8, -1], [0.8, -1], [-0.8, 1], [0.8, 1]],
  hexagon: [...Array(6)].map((_, i) => {
    const th = -Math.PI / 2 + (i * Math.PI) / 3;
    return [Math.cos(th), Math.sin(th)];
  }),
  bolt: [[0.35, -1], [-0.35, 0.05], [0.05, 0.05], [-0.35, 1], [0.35, -0.05], [-0.05, -0.05]],
  arrow: [[-1, -0.35], [0.2, -0.35], [0.2, -0.75], [1, 0], [0.2, 0.75], [0.2, 0.35], [-1, 0.35]],
  cross: [
    [-0.33, -1], [0.33, -1], [0.33, -0.33], [1, -0.33], [1, 0.33], [0.33, 0.33],
    [0.33, 1], [-0.33, 1], [-0.33, 0.33], [-1, 0.33], [-1, -0.33], [-0.33, -0.33],
  ],
};

function shapePath(shape, w, hgt) {
  const cx = w / 2;
  const cy = hgt / 2;
  const pts = [];
  if (SHAPE_CORNERS[shape]) {
    return polygonPath(SHAPE_CORNERS[shape], cx, cy, Math.min(w, hgt) / 2 - 30);
  }
  if (shape === 'heart') {
    // Classic parametric heart, then uniformly scaled + centered to fit.
    const raw = [];
    for (let i = 0; i <= 260; i++) {
      const t = (i / 260) * Math.PI * 2;
      raw.push({
        x: 16 * Math.sin(t) ** 3,
        y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
      });
    }
    const xs = raw.map((p) => p.x);
    const ys = raw.map((p) => p.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const s = Math.min((w - 60) / bw, (hgt - 60) / bh);
    const mx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const my = (Math.max(...ys) + Math.min(...ys)) / 2;
    return raw.map((p) => ({ x: cx + (p.x - mx) * s, y: cy + (p.y - my) * s }));
  }
  if (shape === 'circle') {
    const R = Math.min(w, hgt) / 2 - 30;
    for (let i = 0; i <= 240; i++) {
      const th = -Math.PI / 2 + (i / 240) * Math.PI * 2;
      pts.push({ x: cx + R * Math.cos(th), y: cy + R * Math.sin(th) });
    }
    return pts;
  }
  if (shape === 'spiral') {
    for (let i = 0; i <= 260; i++) {
      const th = (i / 260) * 3.5 * Math.PI;
      const r = 12 + th * (Math.min(w, hgt) / 2 - 30) / (3.5 * Math.PI);
      pts.push({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) });
    }
  } else if (shape === 'star') {
    const R = Math.min(w, hgt) / 2 - 25;
    const r = R * 0.45;
    const corners = [];
    for (let i = 0; i <= 10; i++) {
      const th = -Math.PI / 2 + (i * Math.PI) / 5;
      const rad = i % 2 === 0 ? R : r;
      corners.push({ x: cx + rad * Math.cos(th), y: cy + rad * Math.sin(th) });
    }
    for (let i = 0; i < corners.length - 1; i++) {
      for (let s = 0; s < 24; s++) {
        const t = s / 24;
        pts.push({
          x: corners[i].x + (corners[i + 1].x - corners[i].x) * t,
          y: corners[i].y + (corners[i + 1].y - corners[i].y) * t,
        });
      }
    }
  } else if (shape === 'zigzag') {
    const peaks = 5;
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * peaks;
      const x = 30 + (i / 240) * (w - 60);
      const tri = 2 * Math.abs(t - Math.floor(t + 0.5)); // triangle wave 0..1
      pts.push({ x, y: cy + (tri - 0.5) * (hgt - 90) });
    }
  } else if (shape === 'infinity') {
    // Lemniscate of Bernoulli, scaled to the canvas.
    const a = Math.min(w, hgt * 1.6) / 2 - 30;
    for (let i = 0; i <= 260; i++) {
      const th = (i / 260) * Math.PI * 2;
      const d = 1 + Math.sin(th) * Math.sin(th);
      pts.push({ x: cx + (a * Math.cos(th)) / d, y: cy + (a * 0.9 * Math.sin(th) * Math.cos(th)) / d });
    }
  } else {
    for (let i = 0; i <= 240; i++) {
      const x = 30 + (i / 240) * (w - 60);
      pts.push({ x, y: cy + Math.sin((i / 240) * Math.PI * 3) * (hgt / 2 - 50) });
    }
  }
  return pts;
}

// ---- 6. Dots in the Jar ----------------------------------------------------

GameClients.dots = {
  intro: 'Dots flash for 4 seconds. Estimate how many. Three jars.',
  start(root, ctx) {
    const rng = seededRng(ctx.data.seed);
    const counts = ctx.data.counts;
    const guesses = [];
    const note = h('p', { class: 'trial-note center' });
    const { canvas, ctx: g, w, hgt } = makeCanvas(root, 300);
    const input = h('input', { type: 'number', placeholder: 'How many dots?', min: 0, inputmode: 'numeric' });
    const btn = h('button', { class: 'big', onclick: confirm, disabled: true }, 'Guess');
    root.append(note, input, h('div', { style: { marginTop: '8px' } }, btn));

    // Pre-generate all dot positions from the shared seed so every player
    // sees the identical jars.
    const layouts = counts.map((n) => [...Array(n)].map(() => ({ x: 15 + rng() * (w - 30), y: 15 + rng() * (hgt - 30) })));

    function show() {
      if (guesses.length >= counts.length) return ctx.submit({ guesses });
      note.textContent = `Jar ${guesses.length + 1} of ${counts.length} — memorize!`;
      btn.disabled = true;
      input.value = '';
      const pts = layouts[guesses.length];
      g.clearRect(0, 0, w, hgt);
      g.shadowColor = '#ffd23d';
      g.shadowBlur = 8;
      g.fillStyle = '#ffd23d';
      for (const p of pts) {
        g.beginPath();
        g.arc(p.x, p.y, 4, 0, Math.PI * 2);
        g.fill();
      }
      g.shadowBlur = 0;
      setTimeout(() => {
        g.clearRect(0, 0, w, hgt);
        g.fillStyle = '#7fb8cc';
        g.font = '22px system-ui';
        g.fillText('How many did you see?', w / 2 - 110, hgt / 2);
        note.textContent = `Jar ${guesses.length + 1} of ${counts.length} — your estimate?`;
        btn.disabled = false;
        input.focus();
      }, 4000);
    }
    function confirm() {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0) return;
      guesses.push(v);
      show();
    }
    show();
    return { collect: () => (guesses.length ? { guesses } : null) };
  },
};

// ---- 8. Stop the Clock -----------------------------------------------------

GameClients.stopclock = {
  intro: 'Stop the timer at exactly the target time shown. It disappears after 3 seconds. Two tries, best counts.',
  start(root, ctx) {
    const { targetMs, visibleMs, attempts } = ctx.data;
    const errors = [];
    const display = h('div', { class: 'mash-count' }, '0.000');
    const note = h('p', { class: 'trial-note center' }, `Attempt 1 of ${attempts} — stop at ${(targetMs / 1000).toFixed(3)}s`);
    const btn = h('button', { class: 'big' }, 'START');
    root.append(display, note, btn);
    let startTs = null;
    let raf = null;

    function tick() {
      const el = performance.now() - startTs;
      display.textContent = el <= visibleMs ? (el / 1000).toFixed(3) : '· · ·';
      raf = requestAnimationFrame(tick);
    }
    btn.addEventListener('click', () => {
      if (startTs == null) {
        startTs = performance.now();
        btn.textContent = 'STOP';
        tick();
      } else {
        const el = performance.now() - startTs;
        cancelAnimationFrame(raf);
        startTs = null;
        errors.push(Math.abs(el - targetMs));
        display.textContent = (el / 1000).toFixed(3);
        if (errors.length >= attempts) {
          ctx.submit({ best: Math.min(...errors) });
        } else {
          note.textContent = `That was ${(el / 1000).toFixed(3)}s. Attempt ${errors.length + 1} of ${attempts}.`;
          btn.textContent = 'START';
        }
      }
    });
    return { collect: () => (errors.length ? { best: Math.min(...errors) } : null) };
  },
};

// ---- 9. Grid Flash ---------------------------------------------------------

GameClients.gridflash = {
  intro: 'Some cells light up for 4 seconds. Rebuild the pattern from memory. Two rounds.',
  start(root, ctx) {
    const { patterns, showMs } = ctx.data;
    const picks = [];
    let current = new Set();
    let showing = true;
    const note = h('p', { class: 'trial-note center' });
    const grid = h('div', { class: 'grid5' });
    const btn = h('button', { class: 'big', onclick: confirm, disabled: true }, 'Done');
    root.append(note, grid, h('div', { style: { marginTop: '8px' } }, btn));
    // Square 5×5 grid sized to fit above the Done button — never scroll.
    const side = Math.min(root.clientWidth || 680, 440, availHeight(root, 140));
    grid.style.width = `${side}px`;
    grid.style.margin = '0 auto';
    const cells = [...Array(25)].map((_, i) => {
      const c = h('div', {
        class: 'cell',
        onclick: () => {
          if (showing) return;
          if (current.has(i)) current.delete(i);
          else current.add(i);
          c.classList.toggle('picked');
        },
      });
      grid.append(c);
      return c;
    });

    function round() {
      const r = picks.length;
      if (r >= patterns.length) return ctx.submit({ picks });
      showing = true;
      btn.disabled = true;
      current = new Set();
      note.textContent = `Round ${r + 1} of ${patterns.length} — memorize!`;
      cells.forEach((c, i) => {
        c.classList.remove('picked');
        c.classList.toggle('lit', patterns[r].includes(i));
      });
      setTimeout(() => {
        cells.forEach((c) => c.classList.remove('lit'));
        showing = false;
        btn.disabled = false;
        note.textContent = `Round ${r + 1} of ${patterns.length} — click the cells that were lit`;
      }, showMs);
    }
    function confirm() {
      picks.push([...current]);
      round();
    }
    round();
    return { collect: () => ({ picks: [...picks, ...(current.size && !showing ? [[...current]] : [])] }) };
  },
};

// ---- 11. Read the Room -----------------------------------------------------

GameClients.readroom = {
  intro: 'Answer honestly, then predict what percent of the room said yes.',
  start(root, ctx) {
    let answer = null;
    const q = h('h2', { class: 'center' }, ctx.data.question);
    const step1 = h('div', { class: 'center' },
      h('button', { style: { marginRight: '10px' }, onclick: () => pick(true) }, 'Yes'),
      h('button', { class: 'secondary', onclick: () => pick(false) }, 'No'));
    const val = h('div', { class: 'center', style: { fontSize: '28px', fontWeight: '700' } }, '50%');
    const slider = h('input', {
      type: 'range', min: 0, max: 100, value: 50,
      oninput: () => { val.textContent = `${slider.value}%`; },
    });
    const step2 = h('div', { class: 'hidden' },
      h('p', { class: 'center muted' }, 'What % of the room answered YES?'),
      val, slider,
      h('div', { style: { marginTop: '10px' } },
        h('button', { class: 'big', onclick: () => ctx.submit({ answer, prediction: Number(slider.value) }) }, 'Submit prediction')));
    root.append(q, step1, step2);
    function pick(v) {
      answer = v;
      step1.classList.add('hidden');
      step2.classList.remove('hidden');
    }
    return { collect: () => (answer == null ? null : { answer, prediction: Number(slider.value) }) };
  },
};

// ---- 13. Typing Sprint -----------------------------------------------------

GameClients.typing = {
  intro: 'Type the sentence exactly. Net correct characters per minute wins. (Sorry, phones.)',
  start(root, ctx) {
    const sentence = ctx.data.sentence;
    const started = performance.now();
    const input = h('input', {
      type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      placeholder: 'Type here…',
    });
    root.append(
      h('p', { style: { fontSize: '20px', lineHeight: '1.5', background: 'var(--bg2)', padding: '12px', borderRadius: '4px', border: '1px solid var(--line)' } }, sentence),
      input,
      h('div', { style: { marginTop: '10px' } },
        h('button', { class: 'big', onclick: done }, 'Done'))
    );
    input.focus();
    input.addEventListener('input', () => {
      if (input.value === sentence) done();
    });
    function done() {
      ctx.submit({ typed: input.value, elapsedMs: performance.now() - started });
    }
    return { collect: () => (input.value ? { typed: input.value, elapsedMs: performance.now() - started } : null) };
  },
};

// ---- 14. Space Mash --------------------------------------------------------

GameClients.spacemash = {
  intro: 'Mash SPACE or the button as fast as you can for 10 seconds. Holding a key does nothing.',
  start(root, ctx) {
    const { activeMs, capPerSec } = ctx.data;
    const counter = createPressCounter({ capPerSec });
    let phase = 'countdown';
    const countEl = h('div', { class: 'mash-count' }, '3');
    const btn = h('button', { class: 'bigbtn' }, 'GET READY');
    root.append(countEl, btn);

    // Touch path uses pointerdown, never click — mobile click delay would
    // halve a phone player's score (spec §14).
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (phase === 'active') {
        counter.pointerdown();
        countEl.textContent = String(counter.count);
      }
    });
    const onKeydown = (e) => {
      if (e.code !== 'Space') return;
      e.preventDefault(); // stop page scroll
      if (phase !== 'active') return;
      counter.keydown(e.repeat);
      countEl.textContent = String(counter.count);
    };
    const onKeyup = (e) => {
      if (e.code === 'Space') counter.keyup();
    };
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);

    let n = 3;
    const cd = setInterval(() => {
      n--;
      if (n > 0) {
        countEl.textContent = String(n);
      } else {
        clearInterval(cd);
        phase = 'active';
        countEl.textContent = '0';
        btn.textContent = 'MASH!';
        btn.style.background = 'var(--accent)';
        btn.style.color = '#1a0512';
        btn.style.boxShadow = '0 0 24px rgba(255, 45, 149, 0.4)';
        setTimeout(() => {
          phase = 'done';
          btn.textContent = 'TIME!';
          btn.style.background = '';
          btn.style.color = '';
          btn.style.boxShadow = '';
          document.removeEventListener('keydown', onKeydown);
          document.removeEventListener('keyup', onKeyup);
          ctx.submit({ count: counter.count, flagged: counter.flagged });
        }, activeMs);
      }
    }, 800);
    return { collect: () => ({ count: counter.count, flagged: counter.flagged }) };
  },
};
// ---- 12. Slingshot (3D) -----------------------------------------------------
// Real 3D scene (three.js, vendored) with deterministic projectile physics:
// fixed-timestep integration, gravity, bounce and roll. No aim assists — you
// judge power and direction by eye, like a real slingshot. Scoring: resting
// distance from the bullseye (ft).

GameClients.slingshot = {
  intro: 'Drag anywhere to pull the pouch back — like a real slingshot, pull right to fire left. Release to shoot. The ball bounces and rolls; closest resting spot to the bullseye counts. Best of 5.',
  start(root, ctx) {
    const { distance: D, shots: SHOTS, rings } = ctx.data;

    // World units are feet: +z downrange to the target, +x right, +y up.
    const GRAV = 32.2;
    const MIN_POWER = 18;
    const MAX_POWER = 75;
    const ELEV = Math.PI / 4;      // fixed 45° elevation — power and aim are yours
    const RESTITUTION = 0.3;
    const FRICTION = 0.45;         // horizontal speed kept per bounce (grass, not ice)
    const ROLL_DECEL = 22;         // ft/s² while rolling on the ground
    const STOP_SPEED = 1.2;        // ft/s — slower than this on the ground = at rest
    const BALL_R = 0.35;
    const DT = 1 / 120;            // fixed physics step → same result on every device
    const POUCH_HOME = { x: 0, y: 3.0, z: 0 };
    const MAX_DRAG = 110;          // px of pull to full power — short throw = twitchy
    const AIM_PX_PER_RAD = 55;     // px of sideways pull per radian — small wobbles matter
    const MAX_AZ = 0.75;           // rad — max sideways aim

    const note = h('p', { class: 'trial-note center' }, 'Loading 3D scene…');
    root.append(note);

    let shot = 0;
    let best = null;
    let disposed = false;

    // Deterministic flight: integrate the whole path up front with the fixed
    // timestep, then animate along it.
    function simulate(v0, az) {
      const p = { ...POUCH_HOME };
      const v = {
        x: v0 * Math.cos(ELEV) * Math.sin(az),
        y: v0 * Math.sin(ELEV),
        z: v0 * Math.cos(ELEV) * Math.cos(az),
      };
      const pts = [{ ...p }];
      let rolling = false;
      let t = 0;
      while (t < 12) {
        if (!rolling) v.y -= GRAV * DT;
        p.x += v.x * DT;
        p.y += v.y * DT;
        p.z += v.z * DT;
        if (p.y <= BALL_R) {
          p.y = BALL_R;
          const hSpeed = Math.hypot(v.x, v.z);
          if (!rolling && v.y < -3) {
            v.y = -v.y * RESTITUTION;       // bounce
            v.x *= FRICTION;
            v.z *= FRICTION;
          } else {
            rolling = true;                 // too flat to bounce — roll it out
            v.y = 0;
            if (hSpeed <= STOP_SPEED) break;
            const k = Math.max(0, 1 - (ROLL_DECEL * DT) / hSpeed);
            v.x *= k;
            v.z *= k;
          }
        }
        pts.push({ ...p });
        t += DT;
      }
      return { pts, rest: { x: p.x, z: p.z } };
    }

    const launchFrom = (drag) => {
      const pull = Math.min(Math.max(drag.y, 0), MAX_DRAG);
      const power = pull / MAX_DRAG;
      return {
        power,
        v0: MIN_POWER + (MAX_POWER - MIN_POWER) * power,
        // Real slingshot mirror: pull back-right → ball fires screen-LEFT.
        // The camera looks down +z, which renders world +x on the screen's
        // left, so screen-left = world +x → az goes WITH drag.x here while
        // the pouch (world -x) visually follows the drag.
        az: clamp(drag.x / AIM_PX_PER_RAD, -MAX_AZ, MAX_AZ),
      };
    };

    import('/vendor/three.module.js')
      .then((THREE) => { if (!disposed) buildScene(THREE); })
      .catch(() => { note.textContent = 'Could not load the 3D engine — try reloading.'; });

    function buildScene(THREE) {
      // Fill the screen: full container width, and all the vertical room left
      // below the header/intro (kept to a sane aspect so ultrawide monitors
      // don't get a letterbox-thin strip of ground).
      const w = root.clientWidth || 680;
      const hgt = Math.max(240, Math.min(availHeight(root, 40), Math.round(w * 0.62)));
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, hgt);
      renderer.domElement.className = 'game';
      renderer.domElement.style.touchAction = 'none';
      root.insertBefore(renderer.domElement, note);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05070d);
      scene.fog = new THREE.Fog(0x05070d, D * 2, D * 4 + 250);

      const camera = new THREE.PerspectiveCamera(55, w / hgt, 0.1, 2000);
      camera.position.set(0, 9, -16);
      camera.lookAt(0, 1, D * 0.7);

      scene.add(new THREE.HemisphereLight(0xa8e6ff, 0x0a1420, 1.15));
      const sun = new THREE.DirectionalLight(0xffffff, 1.3);
      sun.position.set(-40, 80, -30);
      scene.add(sun);

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(1400, 1400),
        new THREE.MeshLambertMaterial({ color: 0x0a141c })
      );
      ground.rotation.x = -Math.PI / 2;
      scene.add(ground);
      const grid = new THREE.GridHelper(1400, 70, 0x0e3a4a, 0x0a2833);
      grid.position.y = 0.02;
      scene.add(grid);

      // Target: concentric rings flat on the ground, outer first (lowest).
      const ringCols = [0x531034, 0xff2d95, 0xffd23d, 0x00e5ff];
      [...rings].sort((a, b) => b - a).forEach((r, i) => {
        const ring = new THREE.Mesh(
          new THREE.CircleGeometry(r, 56),
          new THREE.MeshBasicMaterial({ color: ringCols[i % ringCols.length] })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, 0.03 + i * 0.012, D);
        scene.add(ring);
      });
      const bull = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      bull.rotation.x = -Math.PI / 2;
      bull.position.set(0, 0.03 + rings.length * 0.012 + 0.01, D);
      scene.add(bull);

      // Slingshot: stem + two angled fork arms.
      const wood = new THREE.MeshLambertMaterial({ color: 0xd8a339 });
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.7, 10), wood);
      stem.position.set(0, 0.85, 0);
      scene.add(stem);
      const forkTips = [];
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.0, 10), wood);
        arm.position.set(side * 0.6, 2.4, 0);
        arm.rotation.z = -side * 0.55;
        scene.add(arm);
        forkTips.push(new THREE.Vector3(side * 1.1, 3.2, 0));
      }

      const bandMat = new THREE.LineBasicMaterial({ color: 0xffd23d });
      const bands = forkTips.map(() => {
        const line = new THREE.Line(new THREE.BufferGeometry(), bandMat);
        scene.add(line);
        return line;
      });
      const pouch = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 16, 12),
        new THREE.MeshLambertMaterial({ color: 0xffd23d })
      );
      scene.add(pouch);

      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_R, 20, 14),
        new THREE.MeshLambertMaterial({ color: 0xeef0ff })
      );
      ball.visible = false;
      scene.add(ball);

      const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffd23d });
      const setBands = (target) => {
        bands.forEach((line, i) => {
          line.geometry.setFromPoints([forkTips[i], target]);
        });
      };
      const pouchFor = (drag) => {
        const { power } = launchFrom(drag);
        // Same screen mapping as the azimuth: world -x renders screen-right.
        return new THREE.Vector3(
          clamp(-drag.x / 45, -2.4, 2.4),
          POUCH_HOME.y - power * 1.1,
          POUCH_HOME.z - power * 4.5
        );
      };

      // ---- input ------------------------------------------------------------
      const canvas = renderer.domElement;
      let dragging = false;
      let dragStart = null;
      let drag = { x: 0, y: 0 };
      let flight = null; // { pts, rest, startedAt }

      const updateAim = () => {
        const { power } = launchFrom(drag);
        const pouchPos = pouchFor(drag);
        pouch.position.copy(pouchPos);
        setBands(pouchPos);
        hud(power > 0.03 ? `power ${(power * 100).toFixed(0)}%` : undefined);
      };

      const resetPouch = () => {
        pouch.position.set(POUCH_HOME.x, POUCH_HOME.y, POUCH_HOME.z);
        setBands(pouch.position);
      };

      canvas.addEventListener('pointerdown', (e) => {
        if (shot >= SHOTS || flight) return;
        dragging = true;
        dragStart = canvasPos(canvas, e);
        drag = { x: 0, y: 0 };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        updateAim();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const p = canvasPos(canvas, e);
        drag = { x: p.x - dragStart.x, y: p.y - dragStart.y };
        updateAim();
      });
      canvas.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        const { v0, az, power } = launchFrom(drag);
        if (power < 0.06) { resetPouch(); hud(); return; } // too soft — treat as cancel
        const sim = simulate(v0, az);
        flight = { ...sim, startedAt: performance.now() };
        ball.visible = true;
        resetPouch();
      });

      // ---- per-frame --------------------------------------------------------
      function hud(extra) {
        if (shot >= SHOTS) {
          note.textContent = `Done — best: ${best != null ? best.toFixed(1) : '—'} ft from the bullseye`;
          return;
        }
        note.textContent =
          `Shot ${shot + 1} of ${SHOTS} · target ${D} ft` +
          (best != null ? ` · best ${best.toFixed(1)} ft` : '') +
          (extra ? ` · ${extra}` : '');
      }

      function settleShot(rest) {
        const dist = Math.hypot(rest.x, rest.z - D);
        best = best == null ? dist : Math.min(best, dist);
        const ghost = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), ghostMat);
        ghost.position.set(rest.x, BALL_R, rest.z);
        scene.add(ghost);
        shot++;
        hud(`landed ${dist.toFixed(1)} ft away`);
        if (shot >= SHOTS) {
          setTimeout(() => { if (!disposed) ctx.submit({ best }); }, 900);
        }
      }

      function frame() {
        if (disposed || !canvas.isConnected) return;
        if (flight) {
          const idx = Math.floor((performance.now() - flight.startedAt) / 1000 / DT);
          if (idx >= flight.pts.length) {
            ball.visible = false;
            const { rest } = flight;
            flight = null;
            settleShot(rest);
          } else {
            const p = flight.pts[idx];
            ball.position.set(p.x, p.y, p.z);
          }
        }
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
      }

      resetPouch();
      hud();
      frame();
    }

    return {
      collect: () => (best != null ? { best } : null),
    };
  },
};
