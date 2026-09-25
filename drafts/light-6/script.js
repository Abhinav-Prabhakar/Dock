'use strict';
/* ============================================================
   MERIDIAN booking credential — rigid-body badge on a verlet cord
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
  const r = mulberry(24810314);
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

/* ------------- generated print: mini container stack ------------- */
/* 24 corrugated units in an 8×3 vessel-bay grid, palette inks only  */
(function buildStack() {
  const g = document.getElementById('ctnStack');
  if (!g) return;
  const r = mulberry(248114);
  const inks = ['#3a5a44', '#b96f4b', '#a8843e', '#ddd5bd', '#45423a'];
  const w = 6.6, h = 5.4, gx = 1.1, gy = 1.3;   // glyph + gutter
  let s = '';
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 8; i++) {
      const x = i * (w + gx), y = j * (h + gy);
      s += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w}" height="${h}"` +
           ` fill="${inks[(r() * inks.length) | 0]}"` +
           ` stroke="rgba(28,22,12,.30)" stroke-width=".4"/>`;
      s += `<path d="M${(x + w / 2).toFixed(2)} ${(y + .7).toFixed(2)}v${(h - 1.4).toFixed(2)}"` +
           ` stroke="rgba(20,14,6,.20)" stroke-width=".5" fill="none"/>`;
    }
  g.innerHTML = s;
})();

/* ============================ PHYSICS ============================== */
const W = 332, H = 468;              // card size (px) — booking credential
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

  // wall hook + hint ride the peg — the mount is CSS-anchored at 50%,
  // so it only needs the anchor's offset from center
  const ax = ANCHOR.x - vw / 2;
  mountEl.style.transform = `translateX(${ax.toFixed(1)}px)`;
  hintEl.style.transform = `translateX(calc(-50% + ${ax.toFixed(1)}px))`;
}

/* ============================ INPUT ================================ */
function toCardLocal(mx, my) {
  const dx = mx - card.x, dy = my - card.y;
  const c = Math.cos(-card.th), s = Math.sin(-card.th);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

let tap = null;                    // {x, y, t, onCard} — tap-to-reopen detection
window.addEventListener('pointerdown', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  const l = toCardLocal(e.clientX, e.clientY);
  if (Math.abs(l.x) < W / 2 + 10 && l.y > -H / 2 - 52 && l.y < H / 2 + 10) {
    grab = { lx: clamp(l.x, -W / 2, W / 2), ly: clamp(l.y, -H / 2 - 42, H / 2) };
    tap  = { x: e.clientX, y: e.clientY, t: performance.now() };
  } else if (deckEl && deckEl.contains(e.target)) {
    return;                        // panel presses belong to the panel
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
const release = (e) => {
  grab = null; strapGrab = -1;
  document.body.classList.remove('grabbing');
  /* a quick still tap on the badge while collapsed reopens the panel */
  if (tap && e && !split &&
      performance.now() - tap.t < 350 &&
      Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 7)
    setSplit(true);
  tap = null;
};
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);

/* ==================== SPLIT VIEW — DETAILS PANEL DECK ==================== */
/* ~1.7s after load the peg itself glides left; the badge physically
   swings over and settles while Column 1 slides in from the right.
   Clicking CONTINUE moves Column 1 left and slides in Column 2 from the side! */
const mountEl = document.querySelector('.mount');
const hintEl  = document.querySelector('.hint');
const deckEl  = document.getElementById('panel');
const col1El  = document.getElementById('col1');
const col2El  = document.getElementById('col2');
const typesEl = document.getElementById('types');
const addBtn  = document.getElementById('addType');

let step  = 1;                     // 1 = Cargo (col1), 2 = Scheduling & Route (col1 + col2 side-by-side)
let split = false;                 // split engaged?
let anchAnim = null;               // {t0, from, dur} — anchor glide
let col2Revealed = false;
const SHEET_VW = 640;              // below this the panel is a bottom sheet

function getColWidth() {
  if (col1El) {
    const rect = col1El.getBoundingClientRect();
    if (rect.width > 0) return rect.width;
  }
  return Math.min(440, Math.max(330, vw * 0.32));
}

function anchorGoal() {
  if (!split || vw <= SHEET_VW) return vw / 2;
  const colW = getColWidth();
  const nCols = step === 2 ? 2 : 1;
  const remaining = vw - nCols * colW;
  const minPeg = W / 2 + 16;
  if (remaining <= minPeg * 2) {
    return minPeg;
  }
  return Math.max(minPeg, Math.min(remaining - minPeg, remaining / 2));
}
const easeIO = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;

/* move the pin, never the card — the rope drags the badge across */
function stepAnchor(now) {
  if (!anchAnim) return;
  const k = clamp((now - anchAnim.t0) / anchAnim.dur, 0, 1);
  ANCHOR.x = anchAnim.from + (anchorGoal() - anchAnim.from) * easeIO(k);
  if (k >= 1) { ANCHOR.x = anchorGoal(); anchAnim = null; }
}

/* staggered reveal — a list of .rvl elements fades up in order. */
function rvlShow(items, base = 480, step = 250) {
  [...items].forEach((el, i) =>
    setTimeout(() => el.classList.add('on'), base + i * step));
}

/* step navigation — column 1 pushes left, column 2 slides in from the side */
function setStep(s) {
  if (s === step || (s !== 1 && s !== 2)) return;
  step = s;
  anchAnim = { t0: performance.now(), from: ANCHOR.x, dur: 750 };
  if (step === 2) {
    deckEl.classList.remove('step-1');
    deckEl.classList.add('step-2');
    col1El.querySelectorAll('.btnrow .btn').forEach(btn => btn.setAttribute('tabindex', '-1'));
    if (!col2Revealed) {
      col2Revealed = true;
      rvlShow(col2El.querySelectorAll('.p-inner > .rvl'), 200, 140);
      rvlShow(col2El.querySelectorAll('.pg-scroll .rvl'), 340, 160);
      rvlShow(col2El.querySelectorAll('.btnrow.rvl'), 600, 140);
    } else {
      col2El.querySelectorAll('.rvl').forEach(el => el.classList.add('on'));
    }
  } else {
    deckEl.classList.remove('step-2');
    deckEl.classList.add('step-1');
    col1El.querySelectorAll('.btnrow .btn').forEach(btn => btn.removeAttribute('tabindex'));
  }
}

/* collapse/restore the whole split — the badge swings home or steps aside */
function setSplit(on) {
  if (on === split) return;
  split = on;
  anchAnim = { t0: performance.now(), from: ANCHOR.x, dur: 900 };
  if (on) {
    step = 1;
    deckEl.classList.add('on', 'step-1');
    deckEl.classList.remove('step-2');
    col1El.querySelectorAll('.btnrow .btn').forEach(btn => btn.removeAttribute('tabindex'));
    rvlShow(col1El.querySelectorAll('.p-inner > .rvl'), 320, 150);
    rvlShow(col1El.querySelectorAll('.pg-scroll .rvl'), 480, 160);
    rvlShow(col1El.querySelectorAll('.btnrow.rvl'), 650, 150);
  } else {
    deckEl.classList.remove('on', 'step-1', 'step-2');
    deckEl.querySelectorAll('.rvl.on').forEach(el => el.classList.remove('on'));
    col1El.querySelectorAll('.btnrow .btn').forEach(btn => btn.removeAttribute('tabindex'));
    col2Revealed = false;
  }
}

/* --------- container art — side-view 20-ft GP, painted via --cc -------- */
/* corrugated wall, corner castings + posts, black top/bottom rails,
   door end with four locking rods + hinges, stencil marks, weathering */
function containerArt(seed) {
  const r = mulberry(seed);
  let s = '<svg viewBox="0 0 132 56">';

  /* paint slab — wall, door end and posts share the body color */
  s += '<rect x="5.5" y="4.6" width="121" height="43.4" class="cc-body"/>';

  /* corrugation: trapezoid profile read as a light edge + dark crease */
  for (let x = 10.9; x < 102; x += 4.35) {
    s += `<rect x="${x.toFixed(2)}" y="9.6" width="1.05" height="31.8" class="cc-hi"/>` +
         `<rect x="${(x + 2.1).toFixed(2)}" y="9.6" width="1.55" height="31.8" class="cc-lo"/>`;
  }

  /* door end — flat twin-leaf panel at the right end */
  s += '<rect x="104.5" y="9.2" width="18.2" height="32.8" class="cc-door"/>';
  s += '<rect x="104.5" y="9.2" width=".8" height="32.8" fill="rgba(15,10,5,.18)"/>';   // gasket shadow
  s += '<rect x="113.3" y="9.2" width=".75" height="32.8" fill="rgba(15,10,5,.24)"/>';  // leaf seam
  s += '<rect x="114.05" y="9.2" width=".4" height="32.8" fill="rgba(255,255,255,.12)"/>';
  for (const bx of [107.5, 111.1, 116.4, 120.0]) {                                      // 4 locking rods
    s += `<rect x="${bx}" y="9.4" width="1.45" height="32.2" class="cc-hw"/>` +
         `<rect x="${bx - .4}" y="9.4" width="2.25" height="2.5" class="cc-hw2"/>` +    // top cam
         `<rect x="${bx - .4}" y="39.2" width="2.25" height="2.5" class="cc-hw2"/>` +   // bottom cam
         `<rect x="${bx - .85}" y="24.9" width="3.15" height="1.7" rx=".7" class="cc-hw2"/>`; // handle
  }
  for (const hy of [11.6, 21.2, 30.8])                                                  // hinge knuckles
    s += `<rect x="121.9" y="${hy}" width="1.9" height="3.4" class="cc-hw2"/>`;
  /* CSC safety plate riveted to the left door leaf */
  s += '<rect x="105.7" y="12.4" width="2.7" height="3.5" rx=".3" fill="rgba(238,234,218,.85)" stroke="rgba(15,10,5,.4)" stroke-width=".3"/>';

  /* stencil markings on the corrugated wall */
  s += '<text x="12.4" y="16.6" font-size="3.7" letter-spacing=".7" class="cc-mark">MLSU 2481 034</text>' +
       '<text x="12.4" y="20.8" font-size="2.8" letter-spacing=".4" class="cc-mark2">MAX GROSS 30 480 KG · 22G1</text>' +
       '<text x="99.6" y="16.6" font-size="3.0" text-anchor="end" letter-spacing=".4" class="cc-mark2">20′ GP</text>';

  /* weathering — scuffs, scratches, rust weep off the top rail, dents */
  for (let i = 0; i < 6; i++) {
    const sx = 11 + r() * 88, sy = 12.5 + r() * 24, sl = 2 + r() * 9;
    s += `<rect x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${sl.toFixed(1)}" height=".65"` +
         ` fill="${r() < .5 ? 'rgba(255,255,255,.13)' : 'rgba(15,10,5,.09)'}"/>`;
  }
  for (let i = 0; i < 4; i++) {
    const sx = 12 + r() * 86;
    s += `<rect x="${sx.toFixed(1)}" y="9.4" width=".8" height="${(2.5 + r() * 7).toFixed(1)}" fill="rgba(122,60,26,.15)"/>`;
  }
  for (let i = 0; i < 2; i++) {
    s += `<ellipse cx="${(14 + r() * 80).toFixed(1)}" cy="${(14 + r() * 22).toFixed(1)}" rx="${(1.6 + r() * 2.4).toFixed(1)}" ry=".9" fill="rgba(15,10,5,.08)"/>`;
  }

  /* light + grime grading across the whole side */
  s += '<rect x="5.5" y="9.2" width="121" height="2.1" fill="rgba(15,10,5,.12)"/>';    // under top rail
  s += '<rect x="5.5" y="38.6" width="121" height="3.4" fill="rgba(18,11,5,.13)"/>';   // bottom grime

  /* corner posts */
  s += '<rect x="5.5" y="8" width="3.8" height="40" class="cc-dark"/>' +
       '<rect x="122.7" y="8" width="3.8" height="40" class="cc-dark"/>' +
       '<rect x="9.3" y="8" width=".7" height="40" fill="rgba(15,10,5,.18)"/>' +
       '<rect x="122" y="8" width=".7" height="40" fill="rgba(15,10,5,.18)"/>';

  /* top + bottom side rails — black steel, with fork pockets below */
  s += '<rect x="1" y="4.6" width="130" height="4.4" class="cc-hw"/>' +
       '<rect x="1" y="4.6" width="130" height=".9" fill="rgba(255,255,255,.20)"/>' +
       '<rect x="1" y="42" width="130" height="6" class="cc-hw"/>' +
       '<rect x="1" y="42" width="130" height=".8" fill="rgba(255,255,255,.16)"/>' +
       '<rect x="36" y="44.4" width="10" height="2.4" rx=".6" fill="rgba(8,6,4,.55)"/>' +
       '<rect x="86" y="44.4" width="10" height="2.4" rx=".6" fill="rgba(8,6,4,.55)"/>';

  /* corner castings — protrude past the rails, slotted ISO holes */
  for (const [cx, cy] of [[1, 1], [124, 1], [1, 48], [124, 48]]) {
    s += `<rect x="${cx}" y="${cy}" width="7" height="7" rx=".8" class="cc-hw"/>` +
         `<rect x="${cx + 1.7}" y="${cy + 2.5}" width="3.6" height="2" rx="1" fill="rgba(12,9,6,.5)"/>` +
         `<rect x="${cx + .7}" y="${cy + .7}" width="5.6" height="5.6" rx=".6" fill="none" stroke="rgba(255,255,255,.12)" stroke-width=".5"/>`;
  }

  /* ground shadow only — no box outline */
  s += '<ellipse cx="66" cy="55.2" rx="62" ry="1" fill="rgba(42,33,20,.16)"/>';
  return s + '</svg>';
}

/* ------------------- request-size type blocks ------------------- */
const TYPE_COLORS = [                  // fixed paint order per spec
  { c: '#c96a2a', ink: '#f5e9d2' },    // TYPE 1 — orange
  { c: '#e9e5d7', ink: '#3a352a' },    // white
  { c: '#8f918a', ink: '#f2ecda' },    // grey
  { c: '#2f5b7e', ink: '#efe8d2' },    // blue
  { c: '#a8402f', ink: '#f0e6d0' },    // red
  { c: '#2a2721', ink: '#cfc7ae' },    // black
];
const CHEV_U = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 5 5 1 9 5"/></svg>';
const CHEV_D = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1 5 5 9 1"/></svg>';

function buildType(idx) {
  const col = TYPE_COLORS[idx];
  const el = document.createElement('div');
  el.className = 'ctype rvl';
  el.style.setProperty('--cc', col.c);
  el.style.setProperty('--cc-ink', col.ink);

  let wt = 500, cnt = 3;
  let cells = '';
  for (let i = 0; i < 6; i++)
    cells += `<div class="cell${i < cnt ? ' on' : ''}">` +
             containerArt(idx * 991 + i * 37 + 11) +
             '<span class="plus"></span></div>';

  el.innerHTML =
    `<div class="ct-head">
       <span class="ct-name">TYPE ${idx + 1}</span><i class="ct-chip"></i>
       <button class="ct-cargo" type="button" data-cargo="dry"></button>
       <div class="stepper st-w" title="Gross weight per unit — click or scroll">
         <button class="sbtn" data-d="1" type="button" aria-label="increase weight">${CHEV_U}</button>
         <div class="sval sv-w" tabindex="0" role="spinbutton" aria-valuemin="50" aria-valuemax="30000"
              aria-valuenow="500" title="scroll to adjust">500<span class="u">KG</span></div>
         <button class="sbtn" data-d="-1" type="button" aria-label="decrease weight">${CHEV_D}</button>
       </div>
     </div>
     <div class="ct-body">
       <div class="ct-grid">${cells}</div>
       <div class="stepper st-c" title="Units — click or scroll">
         <button class="sbtn" data-d="1" type="button" aria-label="more units">${CHEV_U}</button>
         <div class="sval sv-c" tabindex="0" role="spinbutton" aria-valuemin="1" aria-valuemax="99"
              aria-valuenow="3" title="scroll to adjust">3</div>
         <button class="sbtn" data-d="-1" type="button" aria-label="fewer units">${CHEV_D}</button>
         <div class="sunit">TEU</div>
       </div>
     </div>`;

  const cellEls = [...el.querySelectorAll('.cell')];
  const wEl = el.querySelector('.sv-w'), cEl = el.querySelector('.sv-c');

  /* dimmed cells light up left-to-right as the count climbs */
  const paint = () => {
    cellEls.forEach((c, i) => c.classList.toggle('on', i < cnt));
    const over = cnt - 6;
    cellEls[5].classList.toggle('over', over > 0);
    if (over > 0) cellEls[5].querySelector('.plus').textContent = '+' + over;
  };
  const setW = v => {
    wt = clamp(v, 50, 30000);
    wEl.innerHTML = wt + '<span class="u">KG</span>';
    wEl.setAttribute('aria-valuenow', wt);
  };
  const setC = v => {
    cnt = clamp(v, 1, 99);
    cEl.textContent = cnt;
    cEl.setAttribute('aria-valuenow', cnt);
    paint();
  };

  el.querySelectorAll('.st-w .sbtn').forEach(b =>
    b.addEventListener('click', () => setW(wt + 50 * (+b.dataset.d))));
  el.querySelectorAll('.st-c .sbtn').forEach(b =>
    b.addEventListener('click', () => setC(cnt + (+b.dataset.d))));
  wEl.addEventListener('wheel', e => { e.preventDefault(); setW(wt + (e.deltaY < 0 ? 50 : -50)); }, { passive: false });
  cEl.addEventListener('wheel', e => { e.preventDefault(); setC(cnt + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  wEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp')   { setW(wt + 50); e.preventDefault(); }
    if (e.key === 'ArrowDown') { setW(wt - 50); e.preventDefault(); }
  });
  cEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp')   { setC(cnt + 1); e.preventDefault(); }
    if (e.key === 'ArrowDown') { setC(cnt - 1); e.preventDefault(); }
  });

  /* cargo-type toggle — DRY → HAZMAT → REEFER, per-block state.
     glyphs are hand-drawn SVG; data-cargo drives color in CSS. */
  const CARGO = [
    { k: 'dry',  t: 'DRY',
      ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="2.7" fill="currentColor"/></svg>' },
    { k: 'haz',  t: 'HAZMAT',
      ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="currentColor">' +
          '<circle cx="6" cy="6" r="1.3"/>' +
          '<path d="M3.65 1.93A4.7 4.7 0 0 1 8.35 1.93L6.95 4.36A1.9 1.9 0 0 0 5.05 4.36Z"/>' +
          '<path d="M10.7 6A4.7 4.7 0 0 1 8.35 10.07L6.95 7.64A1.9 1.9 0 0 0 7.9 6Z"/>' +
          '<path d="M3.65 10.07A4.7 4.7 0 0 1 1.3 6L4.1 6A1.9 1.9 0 0 0 5.05 7.64Z"/></g></svg>' },
    { k: 'reef', t: 'REEFER',
      ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="none" stroke="currentColor"' +
          ' stroke-width="1.1" stroke-linecap="round">' +
          '<path d="M10.16 8.4L1.84 3.6M6 10.8L6 1.2M1.84 8.4L10.16 3.6"/>' +
          '<path d="M8.64 7.52L9.1 8.95M8.64 7.52L10.11 7.21M6 9.05L5 10.16M6 9.05L7 10.16' +
          'M3.36 7.52L1.89 7.21M3.36 7.52L2.9 8.95M3.36 4.47L2.9 3.05M3.36 4.47L1.89 4.79' +
          'M6 2.95L7 1.84M6 2.95L5 1.84M8.64 4.47L10.11 4.79M8.64 4.47L9.1 3.05"/></g></svg>' },
  ];
  const cgBtn = el.querySelector('.ct-cargo');
  let cgIdx = 0;
  const setCargo = i => {
    cgIdx = i;
    const s = CARGO[i];
    cgBtn.dataset.cargo = s.k;
    cgBtn.innerHTML = `<span class="cg-ic">${s.ic}</span>`;
    cgBtn.title = `CARGO TYPE — ${s.t} · CLICK TO CHANGE`;
    cgBtn.setAttribute('aria-label', `cargo type ${s.t.toLowerCase()}, click to change`);
  };
  cgBtn.addEventListener('click', () => setCargo((cgIdx + 1) % CARGO.length));
  setCargo(0);
  paint();
  return el;
}

let nTypes = 0;
function addType() {
  if (nTypes >= TYPE_COLORS.length) return;
  const el = buildType(nTypes++);
  typesEl.appendChild(el);
  if (nTypes > 1)                                    // TYPE 1 rides the load cascade
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  if (nTypes >= TYPE_COLORS.length) {
    addBtn.disabled = true;
    addBtn.textContent = '— ALL SIX TYPES LISTED';
  }
}
addBtn.addEventListener('click', addType);
addType();                                           // TYPE 1 — orange

/* footer buttons — CONTINUE opens column 2 side-by-side; BACK slides column 2 back;
   CANCEL collapses the view (tap badge to reopen) */
deckEl.addEventListener('click', e => {
  const b = e.target.closest('.btn');
  if (!b || b.disabled) return;
  if (b.hasAttribute('data-next')) {
    setStep(2);
  } else if (b.hasAttribute('data-back')) {
    setStep(1);
  } else if (b.hasAttribute('data-cancel')) {
    if (step === 2) {
      setStep(1);
    } else {
      setSplit(false);
    }
  } else if (b.hasAttribute('data-submit')) {
    b.textContent = '✓ BOOKING SUBMITTED';
    b.disabled = true;
    b.style.background = '#2c4234';
    const badgeStatus = document.querySelector('.face .rows .r:last-child b');
    if (badgeStatus) badgeStatus.textContent = 'CONFIRMED';
    const bandText = document.querySelector('.face .band-t');
    if (bandText) bandText.innerHTML = 'BOOKING REQUEST&nbsp;&nbsp;—&nbsp;&nbsp;CONFIRMED';
  }
});

/* swing left, then cascade the questions in */
setTimeout(() => setSplit(true), 1650);

/* ============================ LOOP ================================= */
function resize() {
  vw = window.innerWidth; vh = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  strapCv.width = Math.round(vw * dpr);
  strapCv.height = Math.round(vh * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tx = anchorGoal();
  const dx = tx - ANCHOR.x;
  ANCHOR.x = tx;
  anchAnim = null;                 // resize snaps the peg to its current target
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
  stepAnchor(t);                   // glide the peg before the sim steps
  acc += dt;
  const h = 1 / 180;
  let n = 0;
  while (acc >= h && n < 8) { substep(h); acc -= h; n++; }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ==== SCHEDULING CALENDAR ==== */
/* Flexible departure window — ONE month block at a time (MAR 2025 →
   APR 2026), switched with the ‹ › chevrons riding the month header.
   Circular day cells; Sundays, anything before the 14 MAR earliest
   start, and a seeded ~15% of other days are "not bookable" (hatched,
   skipped). Drag across cells to paint a continuous range: sage
   interior, terracotta endpoints, hairline band between circles; the
   stat line above counts bookable days live. The day table is global,
   so the committed range survives month switches and repainting is a
   pure function of (lo, hi) — no per-month element bookkeeping.       */
(function buildCalendar() {
  const host  = document.getElementById('calGrid');
  const numEl = document.getElementById('calNum');
  const rngEl = document.getElementById('calRng');
  if (!host || !numEl || !rngEl) return;

  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
                  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const MABR   = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const NMON   = 14;                          // MAR 2025 → APR 2026
  const FIRST  = new Date(2025, 2, 14);       // earliest start, per the badge

  /* ---- global day table — one entry per calendar day, no elements ---- */
  const cells = [];                           // { d, ok }
  const moFirst = [];                         // first di of each month + sentinel
  for (let mi = 0; mi < NMON; mi++) {
    moFirst.push(cells.length);
    const base = new Date(2025, 2 + mi, 1);
    const y = base.getFullYear(), m = base.getMonth();
    const dim = new Date(y, m + 1, 0).getDate();
    for (let day = 1; day <= dim; day++) {
      const d = new Date(y, m, day);
      const ok = d.getDay() !== 0 && d >= FIRST &&
                 mulberry(y * 10000 + m * 100 + day + 2481)() >= 0.15;
      cells.push({ d, ok });
    }
  }
  moFirst.push(cells.length);

  /* ---- range state (di indices into cells) ---- */
  let curMo = 0;
  let lo = -1, hi = -1;
  let drag = null;                            // {anchor, cur}
  let count = 0;

  const fmt = d => `${d.getDate()} ${MABR[d.getMonth()]}`;
  function stat() {
    const on = count > 0;
    numEl.textContent = on ? String(count) : '—';
    numEl.dataset.t = numEl.textContent;
    numEl.classList.toggle('cal-nil', !on);
    rngEl.textContent = !on ? 'DRAG TO SELECT'
      : lo === hi ? fmt(cells[lo].d)
      : fmt(cells[lo].d) + ' → ' + fmt(cells[hi].d);
    const nb = col2El && col2El.querySelector('[data-submit], [data-next]');
    if (nb) nb.disabled = !on;                // CONFIRM wakes once a window exists
  }

  /* paint the rendered month's cells purely from (lo, hi) — not-bookable
     gaps stay unpainted, and the tinted connector half-bars (.cal-l/.cal-r)
     join adjacent selected circles, suppressed at week-row edges          */
  function paint() {
    host.querySelectorAll('.cal-d[data-di]').forEach(el => {
      const i = +el.dataset.di, c = cells[i];
      const sel = c.ok && i >= lo && i <= hi;
      const selAt = j => { const k = cells[j]; return !!k && k.ok && j >= lo && j <= hi; };
      const col = (c.d.getDay() + 6) % 7;
      el.classList.toggle('cal-sel', sel);
      el.classList.toggle('cal-end', sel && (i === lo || i === hi));
      el.classList.toggle('cal-l', sel && col > 0 && selAt(i - 1));
      el.classList.toggle('cal-r', sel && col < 6 && selAt(i + 1));
    });
  }

  function applyRange(a, b) {
    lo = Math.min(a, b); hi = Math.max(a, b); count = 0;
    for (let i = lo; i <= hi; i++) if (cells[i].ok) count++;
    paint(); stat();
  }

  /* ---- render one month block: header + pager + weekday row + grid ---- */
  const CH_L = '<svg viewBox="0 0 6 10" aria-hidden="true"><path d="M5 1 1 5 5 9"/></svg>';
  const CH_R = '<svg viewBox="0 0 6 10" aria-hidden="true"><path d="M1 1 5 5 1 9"/></svg>';
  function renderMo(mi, dir) {
    curMo = mi;
    const base = new Date(2025, 2 + mi, 1);
    const y = base.getFullYear(), m = base.getMonth();
    const dim  = new Date(y, m + 1, 0).getDate();
    const lead = (base.getDay() + 6) % 7;     // Monday-first offset
    let h = `<div class="cal-mo${dir ? ' cal-' + dir : ''}">` +
      `<div class="cal-mh"><span class="cal-mt">${MONTHS[m]} ${y}</span>` +
      '<span class="cal-navs">' +
      `<button class="cal-nav" type="button" data-mo="-1" aria-label="previous month"${mi === 0 ? ' disabled' : ''}>${CH_L}</button>` +
      `<button class="cal-nav" type="button" data-mo="1" aria-label="next month"${mi === NMON - 1 ? ' disabled' : ''}>${CH_R}</button>` +
      '</span></div>' +
      '<div class="cal-wk"><i>M</i><i>T</i><i>W</i><i>T</i><i>F</i><i>S</i><i>S</i></div>' +
      '<div class="cal-ds">';
    let di = moFirst[mi];
    for (let k = 0; k < 42; k++) {
      const day = k - lead + 1;
      if (day < 1 || day > dim) { h += '<span class="cal-d cal-x"></span>'; continue; }
      h += `<span class="cal-d${cells[di].ok ? '' : ' cal-na'}" data-di="${di}"><i>${day}</i></span>`;
      di++;
    }
    host.innerHTML = h + '</div></div>';
    paint();
  }

  host.addEventListener('click', e => {       // month pager — chevrons
    const b = e.target.closest('.cal-nav');
    if (!b || b.disabled) return;
    const d = +b.dataset.mo;
    renderMo(curMo + d, d > 0 ? 'nx' : 'pv');
  });

  /* ---- drag-select: press a bookable day, sweep, release.
     No pointer capture — elementFromPoint keeps hover tracking honest
     across fast moves. A fresh press always starts a new range.        */
  host.addEventListener('pointerdown', e => {
    const t = e.target.closest('.cal-d');
    if (!t || t.dataset.di === undefined) return;
    const i = +t.dataset.di;
    if (!cells[i].ok) return;
    drag = { anchor: i, cur: i };
    applyRange(i, i);
    e.preventDefault();
  });
  window.addEventListener('pointermove', e => {
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const t = el && el.closest ? el.closest('.cal-d') : null;
    if (!t || t.dataset.di === undefined) return;
    const i = +t.dataset.di;
    if (!cells[i].ok || i === drag.cur) return;
    drag.cur = i;
    applyRange(drag.anchor, i);
  });
  const lift = () => { drag = null; };
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);

  renderMo(0);
  stat();
})();

/* ==== PORT PAIR + REQUEST PRICE ==== */
/* Two rubber datestamps pressed onto the sheet — sage origin ink,
   terracotta destination ink, each hand-tilted. Tapping a stamp slams
   it down re-inked with the next port in its lane; the little freighter
   re-sails the dashed route, which redraws with a dash-offset flick, and
   the ledger readout under the route (miles + days at sea) follows the
   pair. The price stepper reuses the exact vertical stepper mechanics
   from buildType: chevrons, wheel on the numeral, ArrowUp/ArrowDown,
   role=spinbutton.                                                     */
(function buildPortPair() {
  const route  = document.getElementById('ppRoute');
  const ship   = document.getElementById('ppShip');
  const stepEl = document.getElementById('ppPrice');
  const valEl  = document.getElementById('ppVal');
  const numEl  = document.getElementById('ppNum');
  const distEl = document.getElementById('ppDist');
  if (!route || !ship || !stepEl || !valEl || !numEl) return;

  const SRC = [ { c: 'SIN', n: 'SINGAPORE'   }, { c: 'HKG', n: 'HONG KONG'   },
                { c: 'BUS', n: 'BUSAN'       }, { c: 'SHA', n: 'SHANGHAI'    } ];
  const DST = [ { c: 'OAK', n: 'OAKLAND'     }, { c: 'LAX', n: 'LOS ANGELES' },
                { c: 'SEA', n: 'SEATTLE'     }, { c: 'VAN', n: 'VANCOUVER'   } ];

  /* approximate great-circle distances (NM), origin row → dest column */
  const NM = {
    SIN: { OAK: 7320, LAX: 7640, SEA: 7340, VAN: 7020 },
    HKG: { OAK: 6000, LAX: 6290, SEA: 5950, VAN: 5640 },
    BUS: { OAK: 5030, LAX: 5250, SEA: 4900, VAN: 4580 },
    SHA: { OAK: 5440, LAX: 5690, SEA: 5300, VAN: 4990 },
  };

  const ends = ['A', 'B'].map(k => ({
    g:    document.getElementById('ppCoin' + k),
    code: document.getElementById('ppCode' + k),
    city: document.getElementById('ppName' + k),
    btn:  document.getElementById('ppPort' + k),
    list: k === 'A' ? SRC : DST,
    role: k === 'A' ? 'Origin' : 'Destination',
    i: 0,
  }));

  function apply(e) {
    const p = e.list[e.i];
    e.code.textContent = p.c;
    e.city.textContent = p.n;
    e.btn.setAttribute('aria-label',
      `${e.role} port — ${p.n} ${p.c}. Activate to change.`);
  }

  /* ledger readout follows the current pair */
  function dist() {
    if (!distEl) return;
    const nm = NM[SRC[ends[0].i].c][DST[ends[1].i].c];
    const d  = Math.max(8, Math.round(nm / 450));
    distEl.textContent = `≈ ${nm.toLocaleString('en-US')} NM · ${d} DAYS`;
  }

  /* stamp slam: lift off, swap the ink while high, press back down */
  function slam(e) {
    e.g.classList.remove('pp-slam');
    void e.g.getBoundingClientRect();          // restart the keyframe run
    e.g.classList.add('pp-slam');
    setTimeout(() => apply(e), 150);           // swap mid-slam (~55%)
  }

  /* ---- freighter on the route ---- */
  const L = route.getTotalLength();
  let sailRAF = 0;
  function place(t) {
    const p = route.getPointAtLength(t * L);
    const q = route.getPointAtLength(Math.min(t * L + 1.5, L));
    const a = Math.atan2(q.y - p.y, q.x - p.x) * 57.29578;
    ship.setAttribute('transform',
      `translate(${p.x.toFixed(1)} ${(p.y - 4.6).toFixed(1)}) rotate(${a.toFixed(1)})`);
  }
  function sail() {
    cancelAnimationFrame(sailRAF);
    route.classList.remove('pp-run');
    void route.getBoundingClientRect();
    route.classList.add('pp-run');             // dash redraw flick
    const t0 = performance.now(), dur = 950;
    const step = now => {
      const k = Math.min((now - t0) / dur, 1);
      place(easeIO(k));
      sailRAF = k < 1 ? requestAnimationFrame(step) : 0;
    };
    sailRAF = requestAnimationFrame(step);
  }

  ends.forEach(e => {
    e.btn.addEventListener('click', () => {
      e.i = (e.i + 1) % e.list.length;
      slam(e); sail(); dist();
    });
    apply(e);
  });
  dist();
  place(0.55);                                 // parked mid-voyage

  /* ---- request price — vertical stepper, buildType mechanics ---- */
  let price = 4820;
  const setP = v => {
    price = clamp(Math.round(v / 10) * 10, 0, 999990);
    numEl.textContent = price.toLocaleString('en-US');
    numEl.dataset.t = numEl.textContent;       // misregistration ghost
    valEl.setAttribute('aria-valuenow', price);
  };
  stepEl.querySelectorAll('.sbtn').forEach(b =>
    b.addEventListener('click', () => setP(price + 10 * (+b.dataset.d))));
  valEl.addEventListener('wheel', e => {
    e.preventDefault();
    setP(price + (e.deltaY < 0 ? 10 : -10));
  }, { passive: false });
  valEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp')   { setP(price + 10); e.preventDefault(); }
    if (e.key === 'ArrowDown') { setP(price - 10); e.preventDefault(); }
  });
  setP(4820);
})();
