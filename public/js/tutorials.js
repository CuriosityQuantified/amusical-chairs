// Animated "how to play" demos shown before each game. Each tutorial is a
// short looping film strip of steps: green ✓ steps show what to DO, red ✗
// steps show what to AVOID. Pure decoration — nothing here is scored, so
// plain math (no seeded rng) is fine.

const C = {
  ink: '#d9faff', muted: '#7fb8cc', accent: '#ff2d95', cyan: '#00e5ff',
  good: '#3dff9e', bad: '#ff5470', warn: '#ffd23d',
  panel: '#0a141c', line: '#16303f',
};

const lerp = (a, b, p) => a + (b - a) * p;
const clamp01 = (p) => Math.max(0, Math.min(1, p));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2);
// Eased progress of `p` within the sub-window [a, b].
const seg = (p, a, b) => ease(clamp01((p - a) / (b - a)));

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function box(g, x, y, w, h, fill, stroke) {
  rr(g, x, y, w, h, 8);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2; g.stroke(); }
}

function text(g, str, x, y, { size = 13, color = C.muted, align = 'center', bold = false } = {}) {
  g.fillStyle = color;
  g.font = `${bold ? '700 ' : ''}${size}px system-ui, sans-serif`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(str, x, y);
}

function cursor(g, x, y, pressed = false) {
  if (pressed) {
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y - 2, 14, 0, Math.PI * 2);
    g.stroke();
  }
  text(g, '👆', x, y + 15, { size: 26 });
}

function timerBar(g, x, y, w, frac, color = C.accent) {
  box(g, x, y, w, 8, C.line);
  box(g, x, y, Math.max(6, w * clamp01(frac)), 8, color);
}

// Big ✓ / ✗ stamp shown near the end of every step.
function stamp(g, w, ok, p) {
  if (p < 0.72) return;
  g.globalAlpha = seg(p, 0.72, 0.85);
  text(g, ok ? '✓' : '✗', w - 30, 30, { size: 42, color: ok ? C.good : C.bad, bold: true });
  g.globalAlpha = 1;
}

// Deterministic scatter (golden-ratio) so the dot demo is stable frame to frame.
const SCATTER = [...Array(30)].map((_, i) => ({
  x: (i * 0.6180339887) % 1,
  y: (i * 0.3819660113 + 0.15) % 1,
}));

// 5-point star polyline used by the trace demo.
function starPts(cx, cy, R) {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const th = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : R * 0.45;
    pts.push({ x: cx + rad * Math.cos(th), y: cy + rad * Math.sin(th) });
  }
  return pts;
}

function drawPolyline(g, pts, upTo, color, width) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineJoin = g.lineCap = 'round';
  g.beginPath();
  const n = Math.max(2, Math.floor(pts.length * clamp01(upTo)));
  for (let i = 0; i < n; i++) (i ? g.lineTo(pts[i].x, pts[i].y) : g.moveTo(pts[i].x, pts[i].y));
  g.stroke();
}

// ---- per-game tutorials ------------------------------------------------------

const TUTORIALS = {
  rgb: [
    { ok: true, dur: 4200, label: 'Drag the sliders until your color matches the target',
      draw(g, w, h, p) {
        const m = seg(p, 0.08, 0.72);
        const chans = [[110, 206], [160, 96], [190, 64]];
        const mix = chans.map(([a, b]) => Math.round(lerp(a, b, m)));
        box(g, 24, 22, w / 2 - 40, 44, 'rgb(206,96,64)');
        box(g, w / 2 + 16, 22, w / 2 - 40, 44, `rgb(${mix[0]},${mix[1]},${mix[2]})`);
        text(g, 'TARGET', 24 + (w / 2 - 40) / 2, 78);
        text(g, 'YOURS', w / 2 + 16 + (w / 2 - 40) / 2, 78);
        ['#ff5470', '#3dff9e', '#00e5ff'].forEach((col, i) => {
          const y = 110 + i * 28;
          box(g, 34, y - 3, w - 68, 6, C.line);
          const kx = 34 + (w - 68) * lerp(chans[i][0], chans[i][1], m) / 255;
          g.fillStyle = col;
          g.beginPath(); g.arc(kx, y, 8, 0, Math.PI * 2); g.fill();
          if (i === 0) cursor(g, kx, y + 6, p > 0.08 && p < 0.75);
        });
      } },
    { ok: false, dur: 3200, label: 'Do not fiddle forever — lock it in before time runs out',
      draw(g, w, h, p) {
        box(g, 24, 30, w / 2 - 40, 50, 'rgb(206,96,64)');
        box(g, w / 2 + 16, 30, w / 2 - 40, 50, 'rgb(120,120,120)');
        text(g, 'TARGET', 24 + (w / 2 - 40) / 2, 94);
        text(g, 'YOURS', w / 2 + 16 + (w / 2 - 40) / 2, 94);
        timerBar(g, 34, 130, w - 68, 1 - p, p > 0.55 ? C.bad : C.accent);
        text(g, p > 0.72 ? 'never submitted → 0 points' : 'time is ticking…',
          w / 2, 165, { size: 15, color: p > 0.72 ? C.bad : C.muted, bold: p > 0.72 });
      } },
  ],

  oddoneout: [
    { ok: true, dur: 3800, label: 'One tile is a different shade — find it and tap it',
      draw(g, w, h, p) {
        const size = 44, gap = 8, cols = 3;
        const gx = w / 2 - (cols * size + (cols - 1) * gap) / 2;
        const gy = 34;
        const odd = 5;
        for (let i = 0; i < 9; i++) {
          const x = gx + (i % 3) * (size + gap);
          const y = gy + Math.floor(i / 3) * (size + gap);
          const hit = i === odd && p > 0.62;
          box(g, x, y, size, size, `hsl(258 55% ${i === odd ? 62 : 48}%)`, hit ? C.good : null);
        }
        const tx = gx + (odd % 3) * (size + gap) + size / 2;
        const ty = gy + Math.floor(odd / 3) * (size + gap) + size / 2;
        const m = seg(p, 0.1, 0.6);
        cursor(g, lerp(w / 2 - 90, tx, m), lerp(h - 24, ty, m), p > 0.6 && p < 0.75);
        if (p > 0.65) text(g, '+1', tx + 34, ty - 20, { size: 20, color: C.good, bold: true });
      } },
    { ok: false, dur: 3200, label: 'A wrong tap freezes you for a second — look first',
      draw(g, w, h, p) {
        const size = 44, gap = 8;
        const gx = w / 2 - (3 * size + 2 * gap) / 2;
        const gy = 34;
        const frozen = p > 0.5;
        g.globalAlpha = frozen ? 0.35 : 1;
        for (let i = 0; i < 9; i++) {
          const x = gx + (i % 3) * (size + gap);
          const y = gy + Math.floor(i / 3) * (size + gap);
          box(g, x, y, size, size, `hsl(258 55% ${i === 5 ? 62 : 48}%)`, i === 1 && frozen ? C.bad : null);
        }
        g.globalAlpha = 1;
        const tx = gx + size + gap + size / 2;
        const ty = gy + size / 2;
        const m = seg(p, 0.08, 0.45);
        cursor(g, lerp(w / 2 - 80, tx, m), lerp(h - 24, ty, m), p > 0.45 && p < 0.6);
        if (frozen) text(g, '⏳ frozen 1s', w / 2, h - 20, { size: 17, color: C.bad, bold: true });
      } },
  ],

  bisect: [
    { ok: true, dur: 3800, label: 'Tap the line exactly where the percent asks',
      draw(g, w, h, p) {
        text(g, 'Tap at 30%', w / 2, 34, { size: 20, color: C.ink, bold: true });
        const pad = 40, y = 110;
        g.strokeStyle = C.cyan; g.lineWidth = 4;
        g.beginPath(); g.moveTo(pad, y); g.lineTo(w - pad, y); g.stroke();
        for (const x of [pad, w - pad]) { g.beginPath(); g.moveTo(x, y - 14); g.lineTo(x, y + 14); g.stroke(); }
        text(g, '0%', pad, y + 32); text(g, '100%', w - pad, y + 32);
        const target = pad + (w - 2 * pad) * 0.3;
        const m = seg(p, 0.1, 0.6);
        cursor(g, lerp(w - 70, target, m), y + 8, p > 0.6 && p < 0.75);
        if (p > 0.62) {
          g.fillStyle = C.good;
          g.beginPath(); g.arc(target, y, 7, 0, Math.PI * 2); g.fill();
          text(g, 'spot on', target, y - 26, { size: 15, color: C.good, bold: true });
        }
      } },
    { ok: false, dur: 3200, label: 'Do not slap a wild guess — picture the whole line first',
      draw(g, w, h, p) {
        text(g, 'Tap at 30%', w / 2, 34, { size: 20, color: C.ink, bold: true });
        const pad = 40, y = 110;
        g.strokeStyle = C.cyan; g.lineWidth = 4;
        g.beginPath(); g.moveTo(pad, y); g.lineTo(w - pad, y); g.stroke();
        const target = pad + (w - 2 * pad) * 0.3;
        const guess = pad + (w - 2 * pad) * 0.62;
        cursor(g, guess, y + 8, p > 0.25 && p < 0.4);
        if (p > 0.3) {
          g.fillStyle = C.bad;
          g.beginPath(); g.arc(guess, y, 7, 0, Math.PI * 2); g.fill();
          g.fillStyle = C.good;
          g.beginPath(); g.arc(target, y, 5, 0, Math.PI * 2); g.fill();
          g.strokeStyle = C.bad; g.lineWidth = 2; g.setLineDash([5, 4]);
          g.beginPath(); g.moveTo(target, y - 22); g.lineTo(guess, y - 22); g.stroke();
          g.setLineDash([]);
          text(g, '32 pts off', (target + guess) / 2, y - 38, { size: 15, color: C.bad, bold: true });
        }
      } },
  ],

  trace: [
    { ok: true, dur: 4200, label: 'Follow the outline closely — cover the whole shape',
      draw(g, w, h, p) {
        const pts = starPts(w / 2, h / 2 + 6, 74);
        drawPolyline(g, pts, 1, 'rgba(255,45,149,0.85)', 7);
        const m = seg(p, 0.05, 0.85);
        drawPolyline(g, pts, m, C.good, 3);
        const idx = Math.min(pts.length - 1, Math.floor(pts.length * m));
        cursor(g, pts[idx].x, pts[idx].y, p > 0.05 && p < 0.85);
      } },
    { ok: false, dur: 3400, label: 'Sloppy scribbles and skipped corners cost points',
      draw(g, w, h, p) {
        const pts = starPts(w / 2, h / 2 + 6, 74);
        drawPolyline(g, pts, 1, 'rgba(255,45,149,0.85)', 7);
        const m = seg(p, 0.05, 0.8);
        const n = Math.max(2, Math.floor(80 * m));
        g.strokeStyle = C.bad; g.lineWidth = 3; g.lineJoin = g.lineCap = 'round';
        g.beginPath();
        let lx = 0, ly = 0;
        for (let i = 0; i < n; i++) {
          const th = (i / 80) * Math.PI * 2 - Math.PI / 2;
          lx = w / 2 + Math.cos(th) * (46 + 18 * Math.sin(i * 0.9));
          ly = h / 2 + 6 + Math.sin(th) * (46 + 18 * Math.cos(i * 1.3));
          (i ? g.lineTo(lx, ly) : g.moveTo(lx, ly));
        }
        g.stroke();
        cursor(g, lx, ly, p > 0.05 && p < 0.8);
      } },
  ],

  dots: [
    { ok: true, dur: 4200, label: 'Dots flash briefly — take a snapshot and estimate',
      draw(g, w, h, p) {
        const showing = p < 0.45;
        if (showing) {
          g.fillStyle = C.warn;
          for (const d of SCATTER) {
            g.beginPath();
            g.arc(40 + d.x * (w - 80), 30 + d.y * (h - 90), 4, 0, Math.PI * 2);
            g.fill();
          }
          timerBar(g, 40, h - 34, w - 80, 1 - p / 0.45);
        } else {
          text(g, 'How many did you see?', w / 2, 60, { size: 17, color: C.ink });
          const typed = '≈ 30'.slice(0, 1 + Math.floor(seg(p, 0.5, 0.75) * 4));
          box(g, w / 2 - 70, 90, 140, 40, C.panel, C.line);
          text(g, typed, w / 2, 110, { size: 22, color: C.good, bold: true });
        }
      } },
    { ok: false, dur: 3400, label: 'Do not count one by one — they vanish before you finish',
      draw(g, w, h, p) {
        const gone = p > 0.55;
        if (!gone) {
          g.fillStyle = C.warn;
          for (const d of SCATTER) {
            g.beginPath();
            g.arc(40 + d.x * (w - 80), 30 + d.y * (h - 90), 4, 0, Math.PI * 2);
            g.fill();
          }
          const i = Math.floor(seg(p, 0, 0.55) * 4);
          const d = SCATTER[i];
          cursor(g, 40 + d.x * (w - 80), 30 + d.y * (h - 90) + 8, false);
          text(g, `${i + 1}…`, w / 2, h - 26, { size: 18, color: C.ink });
          timerBar(g, 40, h - 12, w - 80, 1 - p / 0.55, C.bad);
        } else {
          text(g, 'Gone! You counted 4 of 30.', w / 2, h / 2, { size: 18, color: C.bad, bold: true });
        }
      } },
  ],

  stopclock: [
    { ok: true, dur: 4200, label: 'The clock hides after 3s — keep counting in your head',
      draw(g, w, h, p) {
        // Demo timeline: 0–0.3 visible count, 0.3–0.7 hidden, press at 0.7.
        const target = 10;
        const t = p * (target + 1.5);
        const visible = t <= 3;
        text(g, 'Stop at 10.000s', w / 2, 30, { size: 16, color: C.ink });
        text(g, visible ? t.toFixed(2) : '· · ·', w / 2, 90, { size: 44, color: visible ? C.ink : C.muted, bold: true });
        const pressAt = p > 0.86;
        box(g, w / 2 - 70, 130, 140, 44, pressAt ? C.good : C.accent);
        text(g, pressAt ? '9.97s!' : 'STOP', w / 2, 152, { size: 18, color: '#fff', bold: true });
        cursor(g, w / 2 + 20, 168, pressAt);
      } },
    { ok: false, dur: 3200, label: 'Do not guess wildly once it hides — keep the rhythm',
      draw(g, w, h, p) {
        text(g, 'Stop at 10.000s', w / 2, 30, { size: 16, color: C.ink });
        text(g, '· · ·', w / 2, 90, { size: 44, color: C.muted, bold: true });
        const pressed = p > 0.6;
        box(g, w / 2 - 70, 130, 140, 44, pressed ? C.bad : C.accent);
        text(g, pressed ? '14.82s' : 'STOP', w / 2, 152, { size: 18, color: '#fff', bold: true });
        cursor(g, w / 2 + 20, 168, pressed && p < 0.72);
        if (pressed) text(g, '4.8s off — lost count', w / 2, h - 12, { size: 15, color: C.bad, bold: true });
      } },
  ],

  gridflash: [
    { ok: true, dur: 4400, label: 'Memorize the lit cells, then rebuild the exact pattern',
      draw(g, w, h, p) {
        const size = 26, gap = 5;
        const gx = w / 2 - (5 * size + 4 * gap) / 2;
        const gy = 26;
        const pattern = [2, 6, 8, 11, 13, 17, 21];
        const showing = p < 0.38;
        const picked = Math.floor(seg(p, 0.45, 0.9) * pattern.length);
        for (let i = 0; i < 25; i++) {
          const x = gx + (i % 5) * (size + gap);
          const y = gy + Math.floor(i / 5) * (size + gap);
          const inPat = pattern.includes(i);
          const isPicked = !showing && inPat && pattern.indexOf(i) < picked;
          box(g, x, y, size, size, showing && inPat ? C.cyan : isPicked ? C.accent : C.panel, C.line);
        }
        text(g, showing ? 'memorize!' : 'now tap what was lit', w / 2, h - 16, { size: 15 });
        if (!showing && picked < pattern.length) {
          const i = pattern[picked];
          cursor(g, gx + (i % 5) * (size + gap) + size / 2, gy + Math.floor(i / 5) * (size + gap) + size / 2, true);
        }
      } },
    { ok: false, dur: 3200, label: 'Wrong cells count against you — as much as missed ones',
      draw(g, w, h, p) {
        const size = 26, gap = 5;
        const gx = w / 2 - (5 * size + 4 * gap) / 2;
        const gy = 26;
        const pattern = [2, 6, 8, 11, 13];
        const wrong = [4, 20, 24];
        const on = p > 0.35;
        for (let i = 0; i < 25; i++) {
          const x = gx + (i % 5) * (size + gap);
          const y = gy + Math.floor(i / 5) * (size + gap);
          const fill = on && wrong.includes(i) ? C.bad : on && pattern.includes(i) && i < 9 ? C.good : C.panel;
          box(g, x, y, size, size, fill, C.line);
        }
        if (on) text(g, '3 wrong + 3 missed = 6 off', w / 2, h - 16, { size: 15, color: C.bad, bold: true });
        cursor(g, gx + 4 * (size + gap) + size / 2, gy + size / 2, p > 0.3 && p < 0.45);
      } },
  ],

  readroom: [
    { ok: true, dur: 4400, label: 'Answer honestly, then predict what percent said YES',
      draw(g, w, h, p) {
        text(g, 'Do you sing in the shower?', w / 2, 28, { size: 16, color: C.ink, bold: true });
        if (p < 0.45) {
          box(g, w / 2 - 110, 60, 100, 42, p > 0.3 ? C.good : C.accent);
          text(g, 'YES', w / 2 - 60, 81, { size: 17, color: '#fff', bold: true });
          box(g, w / 2 + 10, 60, 100, 42, '#0f2430');
          text(g, 'NO', w / 2 + 60, 81, { size: 17, color: '#fff', bold: true });
          const m = seg(p, 0.05, 0.3);
          cursor(g, lerp(w / 2, w / 2 - 60, m), lerp(h - 30, 88, m), p > 0.3 && p < 0.42);
        } else {
          text(g, 'What % of the room said YES?', w / 2, 66, { size: 14 });
          const m = seg(p, 0.5, 0.85);
          const val = Math.round(lerp(50, 64, m));
          box(g, 60, 108, w - 120, 6, C.line);
          const kx = 60 + (w - 120) * val / 100;
          g.fillStyle = C.accent;
          g.beginPath(); g.arc(kx, 111, 9, 0, Math.PI * 2); g.fill();
          text(g, `${val}%`, w / 2, 150, { size: 26, color: C.ink, bold: true });
          cursor(g, kx, 122, p > 0.5 && p < 0.85);
        }
      } },
    { ok: false, dur: 3400, label: 'Predict the room, not yourself — the crowd decides',
      draw(g, w, h, p) {
        text(g, 'You said YES…', w / 2, 34, { size: 15 });
        const m = seg(p, 0.1, 0.4);
        const val = Math.round(lerp(50, 100, m));
        box(g, 60, 76, w - 120, 6, C.line);
        const kx = 60 + (w - 120) * val / 100;
        g.fillStyle = val > 90 ? C.bad : C.accent;
        g.beginPath(); g.arc(kx, 79, 9, 0, Math.PI * 2); g.fill();
        text(g, `${val}%`, w / 2, 116, { size: 26, color: val > 90 ? C.bad : C.ink, bold: true });
        cursor(g, kx, 90, p > 0.1 && p < 0.4);
        if (p > 0.55) text(g, 'the room only said 38% — 62 pts off', w / 2, 160, { size: 15, color: C.bad, bold: true });
      } },
  ],

  typing: [
    { ok: true, dur: 4200, label: 'Type the sentence exactly — accuracy earns the speed',
      draw(g, w, h, p) {
        const s = 'The quick brown fox jumps…';
        box(g, 26, 40, w - 52, 44, C.panel, C.line);
        text(g, s, w / 2, 62, { size: 15, color: C.ink });
        const n = Math.floor(seg(p, 0.05, 0.9) * s.length);
        box(g, 26, 110, w - 52, 44, C.panel, C.good);
        text(g, s.slice(0, n) + (Math.floor(p * 20) % 2 ? '|' : ''), w / 2, 132, { size: 15, color: C.good });
      } },
    { ok: false, dur: 3400, label: 'Every wrong character costs more than slow typing does',
      draw(g, w, h, p) {
        const s = 'The quick brown fox jumps…';
        const bad = 'Teh qiuck borwn fxo jmups…';
        box(g, 26, 40, w - 52, 44, C.panel, C.line);
        text(g, s, w / 2, 62, { size: 15, color: C.ink });
        const n = Math.floor(seg(p, 0.05, 0.8) * bad.length);
        box(g, 26, 110, w - 52, 44, C.panel, C.bad);
        text(g, bad.slice(0, n), w / 2, 132, { size: 15, color: C.bad });
        if (p > 0.85) text(g, 'fast but wrong = low score', w / 2, h - 16, { size: 15, color: C.bad, bold: true });
      } },
  ],

  spacemash: [
    { ok: true, dur: 3800, label: 'Tap or press SPACE as fast as you can — full release counts',
      draw(g, w, h, p) {
        const count = Math.floor(seg(p, 0.05, 0.95) * 34);
        const pressed = Math.floor(p * 26) % 2 === 0 && p > 0.05 && p < 0.95;
        text(g, String(count), w / 2, 52, { size: 46, color: C.ink, bold: true });
        box(g, w / 2 - 100, 96, 200, 62, pressed ? C.good : C.accent);
        text(g, 'MASH!', w / 2, 127, { size: 22, color: '#fff', bold: true });
        cursor(g, w / 2 + 24, 140 + (pressed ? 4 : 0), pressed);
      } },
    { ok: false, dur: 3400, label: 'Holding the button does nothing — release between presses',
      draw(g, w, h, p) {
        text(g, '1', w / 2, 52, { size: 46, color: C.bad, bold: true });
        box(g, w / 2 - 100, 96, 200, 62, '#0f2430');
        text(g, 'HELD DOWN…', w / 2, 127, { size: 20, color: C.muted, bold: true });
        cursor(g, w / 2 + 24, 144, true);
        if (p > 0.5) text(g, 'still 1 — holding scores nothing', w / 2, h - 14, { size: 15, color: C.bad, bold: true });
      } },
  ],

  slingshot: [
    { ok: true, dur: 4400, label: 'Pull back for power, aim, release — closest to the bullseye',
      draw(g, w, h, p) {
        const groundY = h - 40;
        g.strokeStyle = C.line; g.lineWidth = 2;
        g.beginPath(); g.moveTo(10, groundY); g.lineTo(w - 10, groundY); g.stroke();
        // target rings on the right
        const tx = w - 70;
        ['#ff2d95', '#ffd23d', '#00e5ff'].forEach((col, i) => {
          g.fillStyle = col;
          g.beginPath(); g.ellipse(tx, groundY, 44 - i * 14, 10 - i * 3, 0, 0, Math.PI * 2); g.fill();
        });
        g.fillStyle = '#fff';
        g.beginPath(); g.ellipse(tx, groundY, 4, 2, 0, 0, Math.PI * 2); g.fill();
        // slingshot fork
        const sx = 54;
        g.strokeStyle = '#d8a339'; g.lineWidth = 5;
        g.beginPath(); g.moveTo(sx, groundY); g.lineTo(sx, groundY - 40);
        g.moveTo(sx, groundY - 40); g.lineTo(sx - 12, groundY - 58);
        g.moveTo(sx, groundY - 40); g.lineTo(sx + 12, groundY - 58);
        g.stroke();
        const pull = seg(p, 0.05, 0.4);
        const flight = seg(p, 0.45, 0.85);
        if (p < 0.45) {
          const px = sx - pull * 30, py = groundY - 48 + pull * 18;
          g.strokeStyle = '#ffd23d'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(sx - 12, groundY - 58); g.lineTo(px, py);
          g.moveTo(sx + 12, groundY - 58); g.lineTo(px, py); g.stroke();
          g.fillStyle = C.warn;
          g.beginPath(); g.arc(px, py, 6, 0, Math.PI * 2); g.fill();
          cursor(g, px, py + 10, p > 0.08);
          text(g, `power ${Math.round(pull * 62)}%`, w / 2, 26, { size: 14 });
        } else {
          const bx = lerp(sx, tx, flight);
          const by = groundY - 48 - Math.sin(flight * Math.PI) * 66 + flight * 40;
          g.fillStyle = C.ink;
          g.beginPath(); g.arc(bx, Math.min(by, groundY - 6), 6, 0, Math.PI * 2); g.fill();
          if (flight >= 1) text(g, '1.8 ft from the bullseye', w / 2, 26, { size: 15, color: C.good, bold: true });
        }
      } },
    { ok: false, dur: 3600, label: 'Full power overshoots — ease off and judge the distance',
      draw(g, w, h, p) {
        const groundY = h - 40;
        g.strokeStyle = C.line; g.lineWidth = 2;
        g.beginPath(); g.moveTo(10, groundY); g.lineTo(w - 10, groundY); g.stroke();
        const tx = w - 110;
        ['#ff2d95', '#ffd23d', '#00e5ff'].forEach((col, i) => {
          g.fillStyle = col;
          g.beginPath(); g.ellipse(tx, groundY, 40 - i * 13, 9 - i * 3, 0, 0, Math.PI * 2); g.fill();
        });
        const sx = 54;
        g.strokeStyle = '#d8a339'; g.lineWidth = 5;
        g.beginPath(); g.moveTo(sx, groundY); g.lineTo(sx, groundY - 40); g.stroke();
        const pull = seg(p, 0.05, 0.3);
        const flight = seg(p, 0.35, 0.85);
        if (p < 0.35) {
          const px = sx - pull * 46, py = groundY - 46 + pull * 26;
          g.fillStyle = C.warn;
          g.beginPath(); g.arc(px, py, 6, 0, Math.PI * 2); g.fill();
          cursor(g, px, py + 10, p > 0.08);
          text(g, `power ${Math.round(pull * 100)}%!`, w / 2, 26, { size: 14, color: C.bad });
        } else {
          const bx = lerp(sx, w + 40, flight);
          const by = groundY - 46 - Math.sin(flight * Math.PI * 0.8) * 90;
          g.fillStyle = C.ink;
          g.beginPath(); g.arc(bx, by, 6, 0, Math.PI * 2); g.fill();
          if (flight > 0.9) text(g, 'sailed 60 ft past the target', w / 2, 26, { size: 15, color: C.bad, bold: true });
        }
      } },
  ],

  chairs: [
    { ok: true, dur: 4200, label: 'BONUS 3× — tap on GREEN fast: slowest each round loses their chair',
      draw(g, w, h, p) {
        const green = p > 0.55;
        g.fillStyle = green ? C.good : '#58121f';
        g.beginPath(); g.arc(w / 2, h / 2 - 8, 62, 0, Math.PI * 2); g.fill();
        g.strokeStyle = C.line; g.lineWidth = 6; g.stroke();
        text(g, green ? 'GO!' : 'WAIT…', w / 2, h / 2 - 8, { size: 22, color: green ? '#042a18' : C.ink, bold: true });
        cursor(g, w / 2 + 80, h / 2 + 40, green && p > 0.6 && p < 0.75);
        if (p > 0.65) text(g, '212 ms', w / 2, h - 18, { size: 18, color: C.good, bold: true });
      } },
    { ok: false, dur: 3800, label: 'Never press on red — a penalty makes you the slowest, and OUT',
      draw(g, w, h, p) {
        g.fillStyle = '#58121f';
        g.beginPath(); g.arc(w / 2, h / 2 - 8, 62, 0, Math.PI * 2); g.fill();
        g.strokeStyle = p > 0.35 ? C.bad : C.line; g.lineWidth = 6; g.stroke();
        text(g, 'WAIT…', w / 2, h / 2 - 8, { size: 22, color: C.ink, bold: true });
        cursor(g, w / 2 + 80, h / 2 + 40, p > 0.3 && p < 0.45);
        if (p > 0.4) text(g, '+10% penalty — green is rescheduled', w / 2, h - 34, { size: 14, color: C.bad, bold: true });
        if (p > 0.65) text(g, 'keep mashing and you never see green', w / 2, h - 14, { size: 14, color: C.bad });
      } },
  ],
};

// The practice round reuses the stopclock tutorial; typing sprint intro etc.
// come from the game clients themselves.

// ---- runner -----------------------------------------------------------------

// Mounts a looping tutorial into `root`. Returns { stop } — call stop() when
// the phase changes (it cancels the rAF loop and removes the element).
export function startTutorialAnim(root, key) {
  const spec = TUTORIALS[key];
  if (!spec) return { stop() {} };

  const wrap = document.createElement('div');
  wrap.className = 'tut';
  const badge = document.createElement('div');
  badge.className = 'tut-badge';
  const canvas = document.createElement('canvas');
  canvas.className = 'tut-canvas';
  wrap.append(badge, canvas);
  root.append(wrap);

  const w = Math.min(root.clientWidth || 420, 440);
  const hgt = 210;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hgt}px`;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);

  const total = spec.reduce((s, st) => s + st.dur, 0);
  const start = performance.now();
  let stopped = false;
  let raf = null;
  let lastStep = -1;

  function frame(now) {
    if (stopped || !canvas.isConnected) return;
    let t = (now - start) % total;
    let i = 0;
    while (t > spec[i].dur) { t -= spec[i].dur; i++; }
    const st = spec[i];
    if (i !== lastStep) {
      lastStep = i;
      badge.textContent = `${st.ok ? '✓ DO:' : '✗ AVOID:'} ${st.label}`;
      badge.classList.toggle('do', st.ok);
      badge.classList.toggle('avoid', !st.ok);
    }
    const p = t / st.dur;
    g.clearRect(0, 0, w, hgt);
    rr(g, 0, 0, w, hgt, 12);
    g.fillStyle = '#060b12';
    g.fill();
    st.draw(g, w, hgt, p);
    stamp(g, w, st.ok, p);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      wrap.remove();
    },
  };
}
