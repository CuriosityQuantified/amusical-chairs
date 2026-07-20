// Mini musical-chairs scenes: avatar tokens and a ring of chairs.
// startChairs — avatars circling the chairs while the music plays / light is
// red; chair count reflects the seats actually at stake (players − 1).
// startChairsSeated — the round result: every surviving avatar walks into a
// chair while the eliminated (slowest) player walks off and fades out.
// The rAF loops self-stop when the canvas leaves the DOM, so callers can
// simply replace their screen content without leaking animations.

const NEON = ['#00e5ff', '#ff2d95', '#ffd23d', '#3dff9e', '#a06bff', '#ff5470'];
const colorFor = (i) => NEON[i % NEON.length];

// Chair ring geometry that still reads with 20+ chairs on screen: the ring
// grows and the chair glyph shrinks as the count goes up.
function chairLayout(chairCount, size) {
  const r = chairCount === 1 ? 0 : size * Math.min(0.27, 0.12 + chairCount * 0.014);
  const font = Math.round(size * Math.max(0.05, 0.085 - chairCount * 0.0012));
  return { r, font };
}

function makeCanvas(container, size) {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  container.append(canvas);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  return { canvas, g };
}

function drawChairRing(g, cx, cy, chairCount, size) {
  const { r, font } = chairLayout(chairCount, size);
  g.font = `${font}px system-ui`;
  for (let c = 0; c < chairCount; c++) {
    const a = (c / chairCount) * Math.PI * 2 - Math.PI / 2;
    g.fillText('🪑', cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}

function drawAvatar(g, x, y, i, name, { alpha = 1, radius = 13 } = {}) {
  g.globalAlpha = alpha;
  g.beginPath();
  g.arc(x, y, radius, 0, Math.PI * 2);
  g.fillStyle = colorFor(i);
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.stroke();
  g.fillStyle = '#fff';
  g.font = `700 ${Math.round(radius)}px system-ui`;
  g.fillText((String(name || '?')[0] || '?').toUpperCase(), x, y + 0.5);
  g.fillStyle = 'rgba(217,250,255,0.85)';
  g.font = '10px system-ui';
  g.fillText(String(name || '').slice(0, 9), x, y + radius + 11);
  g.globalAlpha = 1;
}

export function startChairs(container, { names = [], chairs = 1, size = 320 } = {}) {
  const { canvas, g } = makeCanvas(container, size);

  const n = Math.max(1, names.length);
  const chairCount = Math.max(1, chairs);
  const cx = size / 2;
  const cy = size / 2;
  const rWalk = size * 0.36;

  let running = true;
  let raf = null;
  const t0 = performance.now();

  function draw(now) {
    if (!running || !canvas.isConnected) return;
    const t = (now - t0) / 1000;
    g.clearRect(0, 0, size, size);

    // walking track
    g.beginPath();
    g.arc(cx, cy, rWalk, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(0,229,255,0.18)';
    g.setLineDash([4, 8]);
    g.lineWidth = 2;
    g.stroke();
    g.setLineDash([]);

    g.textAlign = 'center';
    g.textBaseline = 'middle';

    drawChairRing(g, cx, cy, chairCount, size);

    // avatars circling counter-clockwise, bobbing as they "walk"
    for (let i = 0; i < n; i++) {
      const a = -t * 0.9 + (i / n) * Math.PI * 2;
      const bob = Math.sin(t * 6 + i * 1.7) * 3;
      const x = cx + Math.cos(a) * (rWalk + bob);
      const y = cy + Math.sin(a) * (rWalk + bob);
      drawAvatar(g, x, y, i, names[i]);
    }
    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);

  return {
    canvas,
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    },
    remove() {
      this.stop();
      canvas.remove();
    },
  };
}

// Round result: `seated` players walk from the ring into their chairs (one
// avatar per chair), `out` walks off the bottom and fades — they lost the
// scramble. Loops the settle pose after the walk-in completes.
export function startChairsSeated(container, { seated = [], out = null, size = 320 } = {}) {
  const { canvas, g } = makeCanvas(container, size);

  const cx = size / 2;
  const cy = size / 2;
  const rWalk = size * 0.36;
  const chairCount = Math.max(1, seated.length);
  const { r: rChairs } = chairLayout(chairCount, size);
  const WALK_MS = 1100;

  let running = true;
  let raf = null;
  const t0 = performance.now();
  const ease = (p) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

  function draw(now) {
    if (!running || !canvas.isConnected) return;
    const p = ease((now - t0) / WALK_MS);
    const t = (now - t0) / 1000;
    g.clearRect(0, 0, size, size);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    drawChairRing(g, cx, cy, chairCount, size);

    // survivors: ring position → their chair
    seated.forEach((name, i) => {
      const a = (i / chairCount) * Math.PI * 2 - Math.PI / 2;
      const sx = cx + Math.cos(a) * rWalk;
      const sy = cy + Math.sin(a) * rWalk;
      const txr = chairCount === 1 ? 0 : rChairs;
      const tx = cx + Math.cos(a) * txr;
      const ty = cy + Math.sin(a) * txr - size * 0.02; // perch on the chair
      const bounce = p >= 1 ? Math.sin(t * 5 + i) * 1.5 : 0;
      drawAvatar(g, sx + (tx - sx) * p, sy + (ty - sy) * p + bounce, i, name, { radius: 12 });
    });

    // the slowest player: walks off the bottom edge and fades out
    if (out) {
      const sx = cx;
      const sy = cy + rWalk;
      const x = sx;
      const y = sy + p * size * 0.18;
      drawAvatar(g, x, y, seated.length, out, { alpha: Math.max(0.3, 1 - p * 0.7) });
      if (p > 0.5) {
        g.fillStyle = '#ff5470';
        g.font = `700 ${Math.round(size * 0.045)}px system-ui`;
        g.fillText('OUT', x + 34, y);
      }
    }
    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);

  return {
    canvas,
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    },
    remove() {
      this.stop();
      canvas.remove();
    },
  };
}
