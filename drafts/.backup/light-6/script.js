'use strict';
/* ============================================================
   WILLOWMERE credential — rigid-body badge on a verlet cord
   ------------------------------------------------------------
   physics : the strap is a verlet particle chain pinned to a
             wall peg. its last particle is welded to the clip
             ring on the card. the card is a free 2-DOF rigid
             body (x, y, θ, ω) — position + rotation + momentum.
             strap↔card coupling is a one-sided pin constraint
             (the strap can pull, never push) solved with
             positional dynamics + proper generalized inverse
             mass, so a lifted card makes the strap fold and a
             released card keeps its momentum.
   input   : drag anywhere on the card → spring force applied
             AT the grab point (off-center grabs = real torque).
             drag the strap → pinned particle follows the mouse.
   ============================================================ */

/* ----------------------------- helpers ----------------------------- */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const perp = (x, y) => ({ x: -y, y: x });

/* ----------------------------- DOM refs ---------------------------- */
const cardEl   = document.getElementById('card');
const shadowEl = document.getElementById('cardShadow');
const strapCv  = document.getElementById('strap');
const ctx      = strapCv.getContext('2d');

let vw = window.innerWidth, vh = window.innerHeight;

/* ------------------- generated print: barcode ---------------------- */
(function drawBarcode() {
  const c = document.getElementById('barcode'), x = c.getContext('2d');
  const r = mulberry(20241187);
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = '#16181d';
  let px = 4;
  while (px < c.width - 6) {
    const w = 1 + ((r() * 3) | 0);
    if (r() < 0.74) x.fillRect(px, 1, w, 30);
    px += w + 1 + (r() < 0.4 ? 1 : 0);
  }
  // guard bars
  x.fillRect(2, 1, 1, 33); x.fillRect(c.width - 3, 1, 1, 33);
})();

/* --------------------- generated print: QR ------------------------- */
(function drawQR() {
  const c = document.getElementById('qr'), x = c.getContext('2d');
  const r = mulberry(5119733), n = 21, m = 3, off = 1.5;
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#14161a';
  const finderZone = (i, j) => (i < 8 && j < 8) || (i > 12 && j < 8) || (i < 8 && j > 12);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      if (!finderZone(i, j) && r() < 0.44) x.fillRect(off + i * m, off + j * m, m, m);
  const finder = (cx, cy) => {
    x.fillStyle = '#14161a'; x.fillRect(off + cx * m, off + cy * m, 7 * m, 7 * m);
    x.fillStyle = '#ffffff'; x.fillRect(off + (cx + 1) * m, off + (cy + 1) * m, 5 * m, 5 * m);
    x.fillStyle = '#14161a'; x.fillRect(off + (cx + 2) * m, off + (cy + 2) * m, 3 * m, 3 * m);
  };
  finder(0, 0); finder(14, 0); finder(0, 14);
})();

/* ============================ PHYSICS ============================== */
const W = 320, H = 460;              // card size (px) — staff credential
const ATT = { x: 0, y: -H / 2 - 27 }; // clip-ring attach point, card space
const MASS = 10;
const INER = MASS * (W * W + H * H) / 12;
const IM = 1 / MASS, II = 1 / INER;
const G = 2500;                       // gravity px/s²
const N = 15, SEG = 16;               // strap particles / rest length
const ANCHOR = { x: 0, y: 62 };       // peg point (x set in resize)

const rope = [];
for (let i = 0; i < N; i++) {
  rope.push({ x: 0, y: ANCHOR.y + i * SEG, px: 0, py: ANCHOR.y + i * SEG });
}
const card = {
  x: 0, y: ANCHOR.y + (N - 1) * SEG + 27 + H / 2,
  vx: 26, vy: 0,
  th: 0.10, w: 0
};

const mouse = { x: 0, y: 0 };
let grab = null;        // {lx, ly} card-space grab point
let strapGrab = -1;     // index of pinned strap particle
let simT = 0;

const rot = (lx, ly, th) => {
  const c = Math.cos(th), s = Math.sin(th);
  return { x: lx * c - ly * s, y: lx * s + ly * c };
};

/* one fixed substep */
function substep(h) {
  simT += h;

  /* ---- card: forces ---- */
  card.vy += G * h;

  // faint air currents — perpetual micro-sway
  if (!grab) {
    card.vx += (Math.sin(simT * 0.9) * 9 + Math.sin(simT * 0.37 + 2.1) * 12) * h;
    card.w  += Math.sin(simT * 0.53 + 0.7) * 0.05 * h;
  }

  // mouse spring applied at the grab point → linear + torque
  if (grab) {
    const r = rot(grab.lx, grab.ly, card.th);
    const px = card.x + r.x, py = card.y + r.y;
    const vpx = card.vx - card.w * r.y;      // velocity of the grab point
    const vpy = card.vy + card.w * r.x;
    const ax = (mouse.x - px) * 110 - vpx * 16;
    const ay = (mouse.y - py) * 110 - vpy * 16;
    card.vx += ax * h;
    card.vy += ay * h;
    card.w += (r.x * ay - r.y * ax) * MASS * II * h;
    card.w *= Math.exp(-0.5 * h);            // palm friction while held
  }

  // air drag
  const dl = Math.exp(-0.12 * h), da = Math.exp(-0.55 * h);
  card.vx *= dl; card.vy *= dl; card.w *= da;

  // soft viewport bounds
  const mgn = 12;
  if (card.x - W / 2 < mgn)      card.vx += (mgn - (card.x - W / 2)) * 40 * h;
  if (card.x + W / 2 > vw - mgn) card.vx -= (card.x + W / 2 - (vw - mgn)) * 40 * h;
  if (card.y + H / 2 > vh - 8)   card.vy -= (card.y + H / 2 - (vh - 8)) * 60 * h;
  if (card.y - H / 2 < 2)        card.vy += (2 - (card.y - H / 2)) * 60 * h;

  /* ---- card: predict ---- */
  const ox = card.x, oy = card.y, ot = card.th;
  card.x += card.vx * h;
  card.y += card.vy * h;
  card.th += card.w * h;

  /* ---- strap: verlet integrate ---- */
  for (let i = 1; i < N - 1; i++) {
    const p = rope[i];
    const nx = p.x + (p.x - p.px) * 0.985;
    const ny = p.y + (p.y - p.py) * 0.985 + G * h * h;
    p.px = p.x; p.py = p.y;
    p.x = nx; p.y = ny;
  }
  if (strapGrab > 0) {
    const p = rope[strapGrab];
    p.x = p.px = mouse.x; p.y = p.py = mouse.y;
  }

  /* ---- constraint solve ---- */
  for (let it = 0; it < 8; it++) {
    rope[0].x = ANCHOR.x; rope[0].y = ANCHOR.y;

    // strap segments between free particles
    for (let i = 1; i < N - 1; i++) {
      const a = rope[i - 1], b = rope[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const corr = (d - SEG) / d;
      if (i - 1 === 0) {                       // a is the pin
        b.x -= dx * corr; b.y -= dy * corr;
      } else {
        a.x += dx * corr * 0.5; a.y += dy * corr * 0.5;
        b.x -= dx * corr * 0.5; b.y -= dy * corr * 0.5;
      }
    }

    // last segment ↔ card attach point (one-sided: strap pulls only)
    const q = rope[N - 2];
    const rA = rot(ATT.x, ATT.y, card.th);
    const ax = card.x + rA.x, ay = card.y + rA.y;
    const dx = ax - q.x, dy = ay - q.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (d > SEG) {
      const ux = dx / d, uy = dy / d, err = d - SEG;
      const cr = rA.x * uy - rA.y * ux;              // moment arm
      const wc = IM + cr * cr * II;                  // generalized inv-mass
      const wr = 1;                                  // rope particle inv-mass
      const K = wc + wr;
      q.x += ux * err * (wr / K);
      q.y += uy * err * (wr / K);
      card.x  -= ux * err * (IM / K);
      card.y  -= uy * err * (IM / K);
      card.th -= err * cr * II / K;                  // rotational share
    }

    // strap end welded to the clip ring
    const rE = rot(ATT.x, ATT.y, card.th);
    rope[N - 1].x = card.x + rE.x;
    rope[N - 1].y = card.y + rE.y;
  }

  /* ---- recover velocities from projected positions ---- */
  card.vx = (card.x - ox) / h;
  card.vy = (card.y - oy) / h;
  card.w  = (card.th - ot) / h;

  const sp = Math.hypot(card.vx, card.vy);
  if (sp > 4200) { card.vx *= 4200 / sp; card.vy *= 4200 / sp; }
  card.w = clamp(card.w, -24, 24);

  // give the welded end particle the ring's true velocity
  const rE = rot(ATT.x, ATT.y, card.th);
  rope[N - 1].px = rope[N - 1].x - (card.vx - card.w * rE.y) * h;
  rope[N - 1].py = rope[N - 1].y - (card.vy + card.w * rE.x) * h;
}

/* ============================ RENDER =============================== */
/* braided-leather pattern tile for the cord */
let strapPat = null;
function makeStrapPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const x = c.getContext('2d');
  x.fillStyle = '#6b4c2d'; x.fillRect(0, 0, 8, 8);
  x.strokeStyle = 'rgba(255,226,182,0.12)'; x.lineWidth = 1;
  for (let i = -8; i < 8; i += 3) {                            // rising strands
    x.beginPath(); x.moveTo(i, 8); x.lineTo(i + 8, 0); x.stroke();
  }
  x.strokeStyle = 'rgba(24,12,4,0.20)';
  for (let i = -6; i < 8; i += 3) {                            // falling strands
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 8, 8); x.stroke();
  }
  strapPat = ctx.createPattern(c, 'repeat');
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStrap(lift) {
  ctx.clearRect(0, 0, vw, vh);
  const pts = rope;

  // per-particle frame: direction, normal, half-width (slightly thins
  // when the card twists — the cord reads as twisting near the ring)
  const L = [], R = [], HW = [];
  const tw = Math.sin(card.th * 0.9);
  for (let i = 0; i < N; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    const near = Math.pow(i / (N - 1), 1.6);
    const hw = 4.2 * (1 - 0.30 * Math.abs(tw) * near);
    HW.push(hw);
    L.push({ x: pts[i].x - dy * hw, y: pts[i].y + dx * hw });
    R.push({ x: pts[i].x + dy * hw, y: pts[i].y - dx * hw });
    pts[i]._nx = -dy; pts[i]._ny = dx;
    pts[i]._dx = dx; pts[i]._dy = dy;
  }

  const ribbon = () => {
    ctx.beginPath();
    ctx.moveTo(L[0].x, L[0].y);
    for (let i = 1; i < N - 1; i++)
      ctx.quadraticCurveTo(L[i].x, L[i].y, (L[i].x + L[i + 1].x) / 2, (L[i].y + L[i + 1].y) / 2);
    ctx.lineTo(L[N - 1].x, L[N - 1].y);
    for (let i = N - 1; i > 0; i--)
      ctx.quadraticCurveTo(R[i].x, R[i].y, (R[i].x + R[i - 1].x) / 2, (R[i].y + R[i - 1].y) / 2);
    ctx.closePath();
  };
  const polyline = (arr) => {
    ctx.beginPath();
    ctx.moveTo(arr[0].x, arr[0].y);
    for (let i = 1; i < N - 1; i++)
      ctx.quadraticCurveTo(arr[i].x, arr[i].y, (arr[i].x + arr[i + 1].x) / 2, (arr[i].y + arr[i + 1].y) / 2);
    ctx.lineTo(arr[N - 1].x, arr[N - 1].y);
  };

  // cord's own shadow on the wall
  ctx.save();
  ctx.translate(9 + lift * 0.05, 15 + lift * 0.07);
  if ('filter' in ctx) ctx.filter = `blur(${(5 + lift * 0.04).toFixed(1)}px)`;
  ribbon();
  ctx.fillStyle = 'rgba(44,36,24,0.22)';
  ctx.fill();
  ctx.restore();

  // leather body
  ribbon();
  ctx.fillStyle = strapPat;
  ctx.fill();
  ribbon();
  ctx.strokeStyle = 'rgba(28,16,6,0.38)'; ctx.lineWidth = 0.9; ctx.stroke();

  // cylindrical shading: fixed-offset specular + underside shade
  const HL = [], SH = [];
  for (let i = 0; i < N; i++) {
    HL.push({ x: pts[i].x - 0.9, y: pts[i].y - 1.3 });
    SH.push({ x: pts[i].x + 0.9, y: pts[i].y + 1.4 });
  }
  polyline(HL);
  ctx.strokeStyle = 'rgba(255,232,196,0.26)'; ctx.lineWidth = 1.3; ctx.stroke();
  polyline(SH);
  ctx.strokeStyle = 'rgba(20,10,4,0.30)'; ctx.lineWidth = 1.4; ctx.stroke();

  // braided chevron wraps along the cord
  ctx.lineWidth = 1.05;
  for (let i = 1; i < N - 1; i++) {
    const p = pts[i], hw = HW[i] - 0.7;
    const dx = p._dx, dy = p._dy, nx = p._nx, ny = p._ny;
    ctx.beginPath();
    ctx.moveTo(p.x - dx * 1.7 + nx * hw, p.y - dy * 1.7 + ny * hw);
    ctx.lineTo(p.x + dx * 2.1, p.y + dy * 2.1);
    ctx.lineTo(p.x - dx * 1.7 - nx * hw, p.y - dy * 1.7 - ny * hw);
    ctx.strokeStyle = i % 2 ? 'rgba(42,24,10,0.45)' : 'rgba(255,222,178,0.30)';
    ctx.stroke();
  }

  // small brass bead slid down near the top
  {
    const a = pts[2], b = pts[3];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const g = ctx.createRadialGradient(mx - 1.6, my - 2.1, 0.6, mx, my, 6.4);
    g.addColorStop(0, '#f4e2ae'); g.addColorStop(.4, '#c8a45e');
    g.addColorStop(.78, '#8a6a34'); g.addColorStop(1, '#5a401e');
    ctx.beginPath(); ctx.arc(mx, my, 5.4, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(46,30,8,0.55)'; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.beginPath(); ctx.arc(mx, my, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,18,6,0.55)'; ctx.fill();
    ctx.beginPath(); ctx.arc(mx - 1.7, my - 2.2, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,246,214,0.65)'; ctx.fill();
  }

  // leather-wrap knot where the cord meets the split ring
  {
    const a = pts[N - 2], b = pts[N - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, -6, 0, 6);
    g.addColorStop(0, '#6a4c2c'); g.addColorStop(.5, '#452f1a'); g.addColorStop(1, '#2c1d0e');
    roundRect(-8.5, -5.6, 17, 11.2, 3.2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(20,10,4,0.55)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-4.5, -5.6); ctx.lineTo(-4.5, 5.6);
    ctx.moveTo(-0.8, -5.6); ctx.lineTo(-0.8, 5.6);
    ctx.moveTo(3, -5.6); ctx.lineTo(3, 5.6);
    ctx.strokeStyle = 'rgba(18,9,3,0.45)'; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-8.5, -4.6); ctx.lineTo(8.5, -4.6);
    ctx.strokeStyle = 'rgba(255,222,178,0.22)'; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.restore();
  }
}

/* per-frame visual update */
function render() {
  const deg = card.th * 57.29578;

  // pseudo-3D: the badge tips toward its velocity, as a real hanging
  // card does — this also drives the laminate sheen
  const ry = clamp(card.vx * 0.005, -14, 14) + 2.0;
  const rx = clamp(-card.vy * 0.0025, -8, 8) + 1.2;

  cardEl.style.transform =
    `translate3d(${(card.x - W / 2).toFixed(2)}px, ${(card.y - H / 2).toFixed(2)}px, 0)` +
    ` rotate(${card.th.toFixed(4)}rad) rotateY(${ry.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg)`;

  // laminate specular sweep + hologram hue, driven by tilt
  const sx = clamp(deg * 1.6 + ry * 9, -170, 170);
  cardEl.style.setProperty('--sx', sx.toFixed(1) + 'px');
  cardEl.style.setProperty('--ho', (deg * 3 + ry * 10).toFixed(1) + 'deg');

  // wall contact shadow — sharp & close when settled, drifting and
  // diffuse when the card is lifted / swinging
  const restY = ANCHOR.y + (N - 1) * SEG + 27 + H / 2;
  const lift = clamp(restY - card.y, -40, 420);
  const speed = Math.hypot(card.vx, card.vy) + Math.abs(card.w) * 140;
  const blur = clamp(7 + lift * 0.045 + speed * 0.004, 7, 30);
  const sox = 14 + lift * 0.10 + deg * 0.5;
  const soy = 20 + lift * 0.16;
  shadowEl.style.transform =
    `translate3d(${(card.x - W / 2 + sox).toFixed(1)}px, ${(card.y - H / 2 + soy).toFixed(1)}px, 0)` +
    ` rotate(${deg.toFixed(2)}deg) scale(${(1 + lift * 0.0006).toFixed(4)})`;
  shadowEl.style.filter = `blur(${blur.toFixed(1)}px)`;
  shadowEl.style.opacity = clamp(0.42 - lift * 0.0004 - speed * 0.00003, 0.12, 0.42).toFixed(3);

  drawStrap(lift);
}

/* ============================ INPUT ================================ */
function toCardLocal(mx, my) {
  const dx = mx - card.x, dy = my - card.y;
  const c = Math.cos(-card.th), s = Math.sin(-card.th);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

window.addEventListener('pointerdown', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  const l = toCardLocal(e.clientX, e.clientY);
  if (Math.abs(l.x) < W / 2 + 10 && l.y > -H / 2 - 52 && l.y < H / 2 + 10) {
    grab = { lx: clamp(l.x, -W / 2, W / 2), ly: clamp(l.y, -H / 2 - 42, H / 2) };
  } else {
    let best = -1, bd = 42 * 42;
    for (let i = 1; i < N; i++) {
      const dx = rope[i].x - e.clientX, dy = rope[i].y - e.clientY;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best > 0 && best < N - 1) strapGrab = best;
  }
  document.body.classList.add('grabbing');
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
});
const release = () => {
  grab = null; strapGrab = -1;
  document.body.classList.remove('grabbing');
};
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);

/* ============================ LOOP ================================= */
function resize() {
  vw = window.innerWidth; vh = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  strapCv.width = Math.round(vw * dpr);
  strapCv.height = Math.round(vh * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dx = vw / 2 - ANCHOR.x;
  ANCHOR.x = vw / 2;
  // shift the whole sim horizontally so a resize doesn't yank the strap
  for (const p of rope) { p.x += dx; p.px += dx; }
  card.x += dx;
}
window.addEventListener('resize', resize);
resize();
makeStrapPattern();

let last = performance.now(), acc = 0;
function frame(t) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  acc += dt;
  const h = 1 / 180;
  let n = 0;
  while (acc >= h && n < 8) { substep(h); acc -= h; n++; }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
