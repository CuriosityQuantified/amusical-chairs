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

function makeCanvas(root, height = 360) {
  const c = h('canvas', { class: 'game' });
  root.append(c);
  const w = Math.min(root.clientWidth || 680, 680);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = w * dpr;
  c.height = height * dpr;
  c.style.height = `${height}px`;
  const ctx2d = c.getContext('2d');
  ctx2d.scale(dpr, dpr);
  return { canvas: c, ctx: ctx2d, w, hgt: height };
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
      sliderRow('r', '#ff5470'), sliderRow('g', '#22d3a5'), sliderRow('b', '#5c9dff'),
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
      g.strokeStyle = '#eef0ff';
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(pad, 70); g.lineTo(w - pad, 70); g.stroke();
      for (const x of [pad, w - pad]) {
        g.beginPath(); g.moveTo(x, 50); g.lineTo(x, 90); g.stroke();
      }
      g.fillStyle = '#9aa1c7';
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

// ---- 4. Pie Estimate -------------------------------------------------------

GameClients.pie = {
  intro: 'What percent of the pie is purple? Slide and confirm. Five pies.',
  start(root, ctx) {
    const targets = ctx.data.targets;
    const guesses = [];
    const note = h('p', { class: 'trial-note center' });
    const { canvas, ctx: g, w } = makeCanvas(root, 260);
    const val = h('div', { class: 'center', style: { fontSize: '28px', fontWeight: '700' } }, '50%');
    const slider = h('input', {
      type: 'range', min: 0, max: 100, value: 50,
      oninput: () => { val.textContent = `${slider.value}%`; },
    });
    const btn = h('button', { class: 'big', onclick: confirm }, 'Confirm');
    root.append(val, slider, btn, note);

    function drawPie(pct) {
      g.clearRect(0, 0, w, 260);
      const cx = w / 2;
      const cy = 130;
      const r = 110;
      // Random-ish start rotation per trial (seeded via target) so the wedge
      // can't be read off the 12 o'clock position every time.
      const rot = (targets[guesses.length] * 37) % 360 * Math.PI / 180;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, r, rot, rot + (pct / 100) * Math.PI * 2);
      g.closePath();
      g.fillStyle = '#7c5cff';
      g.fill();
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, r, rot + (pct / 100) * Math.PI * 2, rot + Math.PI * 2);
      g.closePath();
      g.fillStyle = '#22d3a5';
      g.fill();
    }
    function show() {
      if (guesses.length >= targets.length) return ctx.submit({ guesses });
      note.textContent = `Pie ${guesses.length + 1} of ${targets.length} — percent that is purple?`;
      slider.value = 50;
      val.textContent = '50%';
      drawPie(targets[guesses.length]);
    }
    function confirm() {
      if (guesses.length >= targets.length) return;
      guesses.push(Number(slider.value));
      show();
    }
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
      g.strokeStyle = '#3a4178';
      g.lineWidth = 8;
      g.lineJoin = g.lineCap = 'round';
      g.beginPath();
      path.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
      g.strokeStyle = '#22d3a5';
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

function shapePath(shape, w, hgt) {
  const cx = w / 2;
  const cy = hgt / 2;
  const pts = [];
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
      g.fillStyle = '#ffc555';
      for (const p of pts) {
        g.beginPath();
        g.arc(p.x, p.y, 4, 0, Math.PI * 2);
        g.fill();
      }
      setTimeout(() => {
        g.clearRect(0, 0, w, hgt);
        g.fillStyle = '#9aa1c7';
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

// ---- 7. Guess the Price ----------------------------------------------------

GameClients.price = {
  intro: 'Guess the real retail price. Three items. Closest relative error wins.',
  start(root, ctx) {
    const items = ctx.data.items;
    const guesses = [];
    const box = h('div', { class: 'center' });
    const input = h('input', { type: 'number', placeholder: 'Price in USD', min: 0, inputmode: 'decimal' });
    const btn = h('button', { class: 'big', onclick: confirm }, 'Guess');
    root.append(box, input, h('div', { style: { marginTop: '8px' } }, btn));

    function show() {
      if (guesses.length >= items.length) return ctx.submit({ guesses });
      const it = items[guesses.length];
      box.replaceChildren(
        h('div', { class: 'price-item' },
          h('div', { class: 'emoji' }, it.emoji),
          h('h2', {}, it.name),
          h('p', { class: 'muted' }, it.blurb),
          h('p', { class: 'trial-note' }, `Item ${guesses.length + 1} of ${items.length}`))
      );
      input.value = '';
      input.focus();
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
  intro: 'Stop the timer at exactly 10.000s. It disappears after 3 seconds. Two tries, best counts.',
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
  intro: 'Eight cells light up for 4 seconds. Rebuild the pattern from memory. Two rounds.',
  start(root, ctx) {
    const { patterns, showMs } = ctx.data;
    const picks = [];
    let current = new Set();
    let showing = true;
    const note = h('p', { class: 'trial-note center' });
    const grid = h('div', { class: 'grid5' });
    const btn = h('button', { class: 'big', onclick: confirm, disabled: true }, 'Done');
    root.append(note, grid, h('div', { style: { marginTop: '8px' } }, btn));
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

// ---- 10. Unique Answer -----------------------------------------------------

GameClients.unique = {
  intro: 'Give an answer nobody else gives. Matching answers split the points.',
  start(root, ctx) {
    const input = h('input', { type: 'text', placeholder: 'Your answer…', maxlength: 40, autocomplete: 'off' });
    root.append(
      h('h2', { class: 'center' }, ctx.data.prompt),
      h('p', { class: 'muted center' }, 'Score = 1000 ÷ number of players with the same answer. Be unique — but valid!'),
      input,
      h('div', { style: { marginTop: '10px' } },
        h('button', { class: 'big', onclick: () => { if (input.value.trim()) ctx.submit({ answer: input.value }); } }, 'Submit'))
    );
    input.focus();
    return { collect: () => (input.value.trim() ? { answer: input.value } : null) };
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

// ---- 12. Click Accuracy ----------------------------------------------------

GameClients.clickacc = {
  intro: 'Ten targets. Tap as close to each center as you can. Accuracy, not speed.',
  start(root, ctx) {
    const targets = ctx.data.targets;
    const distances = [];
    const note = h('p', { class: 'trial-note center' });
    const { canvas, ctx: g, w, hgt } = makeCanvas(root, 380);
    const diag = Math.hypot(w, hgt);
    root.append(note);

    function draw() {
      if (distances.length >= targets.length) return ctx.submit({ distances });
      note.textContent = `Target ${distances.length + 1} of ${targets.length}`;
      const t = targets[distances.length];
      g.clearRect(0, 0, w, hgt);
      const cx = t.x * w;
      const cy = t.y * hgt;
      for (const [r, col] of [[26, '#ff5470'], [17, '#eef0ff'], [8, '#ff5470'], [2, '#eef0ff']]) {
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.fillStyle = col;
        g.fill();
      }
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (distances.length >= targets.length) return;
      const t = targets[distances.length];
      const p = canvasPos(canvas, e);
      // Normalized by the play-area diagonal — a 27" monitor and a phone
      // play the same game (spec §6.3 game 12).
      distances.push(Math.hypot(p.x - t.x * w, p.y - t.y * hgt) / diag);
      draw();
    });
    draw();
    return { collect: () => (distances.length ? { distances } : null) };
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
      h('p', { style: { fontSize: '20px', lineHeight: '1.5', background: 'var(--bg2)', padding: '12px', borderRadius: '10px' } }, sentence),
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
        btn.style.background = 'var(--good)';
        setTimeout(() => {
          phase = 'done';
          btn.textContent = 'TIME!';
          btn.style.background = '';
          document.removeEventListener('keydown', onKeydown);
          document.removeEventListener('keyup', onKeyup);
          ctx.submit({ count: counter.count, flagged: counter.flagged });
        }, activeMs);
      }
    }, 800);
    return { collect: () => ({ count: counter.count, flagged: counter.flagged }) };
  },
};

// ---- 15. Slingshot ---------------------------------------------------------

GameClients.slingshot = {
  intro: 'Drag back, aim, release. 45° launch — power and left/right are yours. Watch the wind: it changes every shot. Best of 5 counts.',
  start(root, ctx) {
    const { winds, distance: D, shots: SHOTS, rings } = ctx.data;
    const { canvas, ctx: g, w, hgt } = makeCanvas(root, 420);
    const note = h('p', { class: 'trial-note center' });
    root.append(note);

    // Deterministic physics (spec §6.3 game 15): 45° elevation fixed, so a
    // 2-DoF drag maps cleanly to (power, lateral aim). No randomness here —
    // winds come pre-seeded from the server, identical for every player.
    const GRAV = 32.2;             // ft/s²
    const MIN_POWER = 18;
    const MAX_POWER = 75;
    const MAX_DRAG = hgt * 0.38;   // px
    const anchor = { x: w / 2, y: hgt - 40 };
    const landings = [];           // {lat, fwd, dist}
    let shot = 0;
    let best = null;
    let dragging = false;
    let dragPt = null;
    let animating = false;

    function landingFor(pull, wind) {
      const mag = Math.min(Math.hypot(pull.x, pull.y), MAX_DRAG);
      const v0 = MIN_POWER + (MAX_POWER - MIN_POWER) * (mag / MAX_DRAG);
      const theta = Math.atan2(-pull.x, pull.y); // pull down-left → aim up-right
      const flightTime = (2 * v0 * Math.SQRT1_2) / GRAV;
      const range = (v0 * v0) / GRAV;
      const fwd = range * Math.cos(theta);
      const lat = range * Math.sin(theta) + wind * flightTime;
      return { fwd, lat, dist: Math.hypot(lat, fwd - D), flightTime };
    }

    // pseudo-3D ground projection
    const NEAR = 35;
    const py = (d) => hgt - 40 - (hgt - 110) * (d / (d + NEAR));
    const scale = (d) => NEAR / (d + NEAR);
    const px = (lat, d) => w / 2 + lat * 9 * scale(d);

    function draw() {
      g.clearRect(0, 0, w, hgt);
      // ground + horizon
      g.fillStyle = '#141830';
      g.fillRect(0, 0, w, py(1e6));
      g.fillStyle = '#1a2140';
      g.fillRect(0, py(1e6), w, hgt);
      // target rings (far to near)
      const cols = ['#58121f', '#8a1e33', '#c23b52', '#ff5470'];
      [...rings].sort((a, b) => b - a).forEach((r, i) => {
        g.beginPath();
        g.ellipse(px(0, D), py(D), r * 9 * scale(D), r * 3.6 * scale(D), 0, 0, Math.PI * 2);
        g.fillStyle = cols[i % cols.length];
        g.fill();
      });
      g.beginPath();
      g.ellipse(px(0, D), py(D), 2.2, 1.4, 0, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      // ghost markers for previous shots
      landings.forEach((L, i) => {
        g.beginPath();
        g.arc(px(L.lat, L.fwd), py(Math.max(L.fwd, 0.1)), 5 * Math.max(scale(L.fwd), 0.25) + 2, 0, Math.PI * 2);
        g.fillStyle = i === landings.length - 1 ? '#ffc555' : 'rgba(255,197,85,0.45)';
        g.fill();
      });
      // wind arrow
      if (shot < SHOTS) {
        const wind = winds[shot];
        g.font = '16px system-ui';
        g.fillStyle = '#eef0ff';
        const arrow = wind >= 0 ? '→' : '←';
        g.fillText(`wind ${arrow} ${Math.abs(wind).toFixed(1)} ft/s`, 14, 24);
        g.strokeStyle = '#5c9dff';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(w / 2 - wind * 4, 40);
        g.lineTo(w / 2 + wind * 4, 40);
        g.stroke();
        g.beginPath();
        const tip = w / 2 + wind * 4;
        g.moveTo(tip, 40);
        g.lineTo(tip - Math.sign(wind || 1) * 8, 34);
        g.moveTo(tip, 40);
        g.lineTo(tip - Math.sign(wind || 1) * 8, 46);
        g.stroke();
      }
      // slingshot + rubber band
      g.strokeStyle = '#8a6b3f';
      g.lineWidth = 7;
      g.beginPath();
      g.moveTo(anchor.x - 16, anchor.y + 26);
      g.lineTo(anchor.x - 12, anchor.y);
      g.moveTo(anchor.x + 16, anchor.y + 26);
      g.lineTo(anchor.x + 12, anchor.y);
      g.stroke();
      if (dragging && dragPt) {
        g.strokeStyle = '#d8b073';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(anchor.x - 12, anchor.y);
        g.lineTo(dragPt.x, dragPt.y);
        g.lineTo(anchor.x + 12, anchor.y);
        g.stroke();
        g.beginPath();
        g.arc(dragPt.x, dragPt.y, 8, 0, Math.PI * 2);
        g.fillStyle = '#eef0ff';
        g.fill();
        // aim preview line (direction only — power is the drag length)
        const pull = { x: dragPt.x - anchor.x, y: dragPt.y - anchor.y };
        if (pull.y > 6) {
          const L = landingFor(pull, 0);
          g.strokeStyle = 'rgba(238,240,255,0.25)';
          g.setLineDash([5, 6]);
          g.beginPath();
          g.moveTo(anchor.x, anchor.y);
          g.lineTo(px(L.lat, L.fwd), py(Math.max(L.fwd, 0.1)));
          g.stroke();
          g.setLineDash([]);
        }
      }
      note.textContent = shot < SHOTS
        ? `Shot ${shot + 1} of ${SHOTS} — target ${D} ft away${best != null ? ` · best: ${best.toFixed(1)} ft` : ''}`
        : `Done — best: ${best != null ? best.toFixed(1) : '—'} ft`;
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (shot >= SHOTS || animating) return;
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      dragPt = canvasPos(canvas, e);
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dragPt = canvasPos(canvas, e);
      draw();
    });
    canvas.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const pull = { x: dragPt.x - anchor.x, y: dragPt.y - anchor.y };
      if (pull.y < 12) { draw(); return; } // too small to be a real draw
      const wind = winds[shot];
      const L = landingFor(pull, wind);
      shot++;
      animating = true;
      const t0 = performance.now();
      const dur = 650;
      const anim = () => {
        const t = Math.min(1, (performance.now() - t0) / dur);
        draw();
        const d = L.fwd * t;
        const lat = L.lat * t;
        const arc = Math.sin(t * Math.PI) * 60 * scale(d);
        g.beginPath();
        g.arc(px(lat, Math.max(d, 0.1)), py(Math.max(d, 0.1)) - arc, 6 * Math.max(scale(d), 0.3) + 2, 0, Math.PI * 2);
        g.fillStyle = '#eef0ff';
        g.fill();
        if (t < 1) requestAnimationFrame(anim);
        else {
          landings.push(L);
          best = best == null ? L.dist : Math.min(best, L.dist);
          animating = false;
          if (shot >= SHOTS) ctx.submit({ best });
          draw();
        }
      };
      anim();
    });
    draw();
    return { collect: () => (best != null ? { best } : null) };
  },
};
