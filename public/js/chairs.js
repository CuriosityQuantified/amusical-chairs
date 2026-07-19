// Mini musical-chairs scene: one avatar token per player circling a ring of
// chairs. Pure decoration — chair count reflects the seats actually at stake.
// The rAF loop self-stops when the canvas leaves the DOM, so callers can
// simply replace their screen content without leaking animations.

export function startChairs(container, { names = [], chairs = 1, size = 320 } = {}) {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  container.append(canvas);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);

  const n = Math.max(1, names.length);
  const chairCount = Math.max(1, chairs);
  const cx = size / 2;
  const cy = size / 2;
  const rChairs = size * 0.16;
  const rWalk = size * 0.36;
  const NEON = ['#00e5ff', '#ff2d95', '#ffd23d', '#3dff9e', '#a06bff', '#ff5470'];
  const colorFor = (i) => NEON[i % NEON.length];

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

    // chairs in the middle
    g.font = `${Math.round(size * 0.085)}px system-ui`;
    for (let c = 0; c < chairCount; c++) {
      const a = (c / chairCount) * Math.PI * 2 - Math.PI / 2;
      const r = chairCount === 1 ? 0 : rChairs;
      g.fillText('🪑', cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }

    // avatars circling counter-clockwise, bobbing as they "walk"
    for (let i = 0; i < n; i++) {
      const a = -t * 0.9 + (i / n) * Math.PI * 2;
      const bob = Math.sin(t * 6 + i * 1.7) * 3;
      const x = cx + Math.cos(a) * (rWalk + bob);
      const y = cy + Math.sin(a) * (rWalk + bob);
      g.beginPath();
      g.arc(x, y, 13, 0, Math.PI * 2);
      g.fillStyle = colorFor(i);
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.stroke();
      g.fillStyle = '#fff';
      g.font = '700 13px system-ui';
      g.fillText((String(names[i] || '?')[0] || '?').toUpperCase(), x, y + 0.5);
      g.fillStyle = 'rgba(217,250,255,0.85)';
      g.font = '10px system-ui';
      g.fillText(String(names[i] || '').slice(0, 9), x, y + 24);
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
