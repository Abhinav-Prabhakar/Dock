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

/* ==================== CUSTOMER GATE ==================== */
/* This is the first-run screen: a customer with no orders lands
   here to file their first booking; once orders exist, the
   customer-facing home is the fleet dashboard. '?new' forces this
   page so returning customers can make additional requests.
   Orders come from the live backend only (shared/api.js) — no
   local cache, no offline mode.                                 */
const DASHBOARD_URL = 'dashboard/';
const forceNew = new URLSearchParams(location.search).has('new');

(async () => {
  if (forceNew) return;
  try {
    const list = await DockAPI.orders();
    if (Array.isArray(list) && list.length) location.replace(DASHBOARD_URL);
  } catch (e) { /* API down: stay on the form; submitting will say so */ }
})();

/* ============ SHARED REQUEST STATE — drives the live card ============ */
/* Every control writes into S; syncCard() re-inks the badge face so the
   hanging credential is always a printed summary of the booking.      */
const S = { origin: 'CNSHA', dest: 'NLRTM', depDay: null,
            flex: 2, segment: 'standard', price: 4820 };
let filed = false;

/* service network — ports, coordinates and servable OD pairs come from
   the backend (DockAPI.network()) when the port pair is built; nothing
   is embedded, so the form only offers lanes the fleet actually serves */
const PORT_G = {};
const PAIRS = {};
const D2R_ = Math.PI / 180;
const nmOf = (a, b) => {
  const A = PORT_G[a], B = PORT_G[b];
  if (!A || !B) return null;
  const la1 = A.lat * D2R_, la2 = B.lat * D2R_;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin(((B.lon - A.lon) * D2R_) / 2) ** 2;
  return Math.round(3440.065 * 2 * Math.asin(Math.sqrt(h)));
};

const $ = id => document.getElementById(id);
const hash = s => { let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0; };

/* current consignment scrape — one {cargo, kg, units} per type block */
function readTypes() {
  return [...document.querySelectorAll('.ctype')].map(t => ({
    cargo: (t.querySelector('.ct-cargo') || {}).dataset?.cargo || 'dry',
    kg:    parseInt((t.querySelector('.sv-w') || {}).textContent, 10) || 0,
    units: parseInt((t.querySelector('.sv-c') || {}).textContent, 10) || 0,
  })).filter(t => t.units > 0);
}

const KIND_NAME = { dry: 'DRY', haz: 'HAZMAT', hazmat: 'HAZMAT',
                    reef: 'REEFER', reefer: 'REEFER' };
const KIND_API  = { dry: 'dry', haz: 'hazmat', hazmat: 'hazmat',
                    reef: 'reefer', reefer: 'reefer' };
const MONTH_AB  = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

/* re-ink the hanging credential — face fields, stats, hub labels,
   barcode + stack re-seed, band state, CONFIRM gate                  */
function syncCard() {
  // until the network loads, the badge shows port codes
  const A = PORT_G[S.origin] || { n: S.origin }, B = PORT_G[S.dest] || { n: S.dest };
  const setT = (id, t) => { const el = $(id); if (!el) return;
    el.textContent = t; if (el.dataset.t !== undefined) el.dataset.t = String(t); };

  setT('cRoute', `${A.n} → ${B.n}`);
  setT('cDept', `FCL · ${S.segment.toUpperCase()} SERVICE`);
  const td = new Date();
  setT('cIssued', `${td.getUTCDate()} ${MONTH_AB[td.getUTCMonth()]} ${td.getUTCFullYear()}`);
  setT('cStatus', filed ? 'FILED' : (S.depDay != null ? 'READY' : 'DRAFT'));

  /* stats — containers, gross tonnes, departure */
  const kinds = readTypes();
  const teu = kinds.reduce((s, k) => s + k.units, 0);
  const wt  = kinds.reduce((s, k) => s + k.kg * k.units, 0) / 1000;
  setT('cTeu', teu || '—');
  const cnt = {};
  kinds.forEach(k => { cnt[k.cargo] = (cnt[k.cargo] || 0) + k.units; });
  const tip = $('cTip');
  if (tip) tip.innerHTML = Object.entries(cnt)
    .map(([k, n]) => `${KIND_NAME[k] || 'DRY'} ×${n}`).join('&nbsp;&nbsp;·&nbsp;&nbsp;') || '—';
  setT('cWt', wt.toFixed(1));
  setT('cDep', S.depDay == null ? '—' : (S.depDay === 0.5 ? '½' : S.depDay));
  const fs = $('cFlexSub');
  if (fs) fs.innerHTML = `±<br>${S.flex}&nbsp;D`;

  /* hub-map labels — booked ends + other servable lanes as alts */
  const setH = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  setH('hpA', S.origin); setH('hpB', S.dest);
  const others = (PAIRS[S.origin] || []).filter(c => c !== S.dest);
  setH('hpMid', others[0] || '—');
  setH('hpM1', others[1] || '—');
  setH('hpM2', others[2] || '—');

  /* generated print re-seeded from the whole spec */
  const seed = hash([S.origin, S.dest, teu, Math.round(wt * 10),
                     S.depDay, S.flex, S.segment, S.price].join('|'));
  drawBarcode(seed);
  drawStack(seed);
  const cap = $('barCap');
  if (cap) {
    const d = String(seed % 100000000).padStart(8, '0');
    cap.textContent = `${d.slice(0, 4)} ${d.slice(4)}`;
  }

  /* status band + CONFIRM gate */
  const bt = document.querySelector('.face .band-t');
  if (bt && !filed) bt.innerHTML =
    `BOOKING REQUEST&nbsp;&nbsp;—&nbsp;&nbsp;${S.depDay != null ? 'READY TO FILE' : 'AWAITING DEPARTURE'}`;
  const sb = col2El && col2El.querySelector('[data-submit]');
  if (sb && !filed) sb.disabled = S.depDay == null;
}

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
/* re-seeded on every spec change by syncCard — the printed code tracks
   the booking payload */
function drawBarcode(seed) {
  const c = document.getElementById('barcode'), x = c.getContext('2d');
  const r = mulberry(seed);
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
}

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
/* 24 corrugated units in an 8×3 vessel-bay grid, palette inks only —
   re-seeded on every spec change by syncCard                         */
function drawStack(seed) {
  const g = document.getElementById('ctnStack');
  if (!g) return;
  const r = mulberry(seed);
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
}

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
  s += '<text x="12.4" y="16.6" font-size="3.3" letter-spacing=".7" class="cc-mark">MLSU 2481 034</text>' +
       '<text x="12.4" y="20.6" font-size="2.4" letter-spacing=".4" class="cc-mark2">MAX GROSS 30 480 KG · 22G1</text>' +
       '<text x="99.6" y="16.6" font-size="2.6" text-anchor="end" letter-spacing=".4" class="cc-mark2">20′ GP</text>';

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
   CANCEL abandons the request and returns to the fleet dashboard */
deckEl.addEventListener('click', e => {
  const b = e.target.closest('.btn');
  if (!b || b.disabled) return;
  if (b.hasAttribute('data-next')) {
    setStep(2);
  } else if (b.hasAttribute('data-back')) {
    setStep(1);
  } else if (b.hasAttribute('data-cancel')) {
    location.href = DASHBOARD_URL;
  } else if (b.hasAttribute('data-submit')) {
    b.textContent = 'PRICING…';
    b.disabled = true;

    /* one order per container kind, each priced live by the fleet
       (POST /orders -> offers), then the rate-quotation slip        */
    const inkBadge = status => {
      const badgeStatus = document.querySelector('.face .rows .r:last-child b');
      if (badgeStatus) badgeStatus.textContent = status;
      const bandText = document.querySelector('.face .band-t');
      if (bandText) bandText.innerHTML = `BOOKING REQUEST&nbsp;&nbsp;—&nbsp;&nbsp;${status}`;
    };
    const CARGO_API = { dry: 'dry', haz: 'hazmat', reef: 'reefer' };
    const types = [...document.querySelectorAll('.ctype')].map(t => ({
      cargo: (t.querySelector('.ct-cargo') || {}).dataset?.cargo || 'dry',
      kg:    parseInt((t.querySelector('.sv-w') || {}).textContent, 10) || 0,
      units: parseInt((t.querySelector('.sv-c') || {}).textContent, 10) || 0,
    })).filter(t => t.units > 0);

    /* departure — this page uses the stamped day-tiles (S.depDay / S.flex),
       not intake-b's ppCode* stamps or a drag calendar (__mlCal). */
    if (S.depDay == null || S.depDay < 0.5) {
      b.textContent = 'CONFIRM BOOKING';
      b.disabled = false;
      inkBadge('NOT PRICED');
      alert('Pick a departure day (½ day or later) before confirming.');
      return;
    }

    const bodies = types.map(t => ({
      origin:      S.origin,
      dest:        S.dest,
      teu:         t.units,
      weight_t:    +((t.kg * t.units) / 1000).toFixed(2),
      cargo_type:  CARGO_API[t.cargo] || 'dry',
      segment:     S.segment,
      req_dep_day: +S.depDay.toFixed(2),
      flex_days:   S.flex,
    }));

    (async () => {
      let results;
      try {
        results = await Promise.all(bodies.map(DockAPI.quote));
      } catch (e) {
        b.textContent = 'CONFIRM BOOKING';
        b.disabled = false;
        b.title = e.message;
        inkBadge('NOT PRICED');
        alert(`We couldn't price this booking: ${e.message}`);
        return;
      }
      b.textContent = 'QUOTE RECEIVED';
      inkBadge('QUOTED');
      const final = await DockOffers.review(results);
      const booked = final.some(o => ['CONFIRMED', 'LOADING'].includes(o.status));
      inkBadge(booked ? 'CONFIRMED' : final.some(o => o.status === 'QUOTED') ? 'QUOTED' : 'CLOSED');
      b.textContent = booked ? '✓ BOOKING CONFIRMED' : 'QUOTE CLOSED';
      b.style.background = '#2c4234';
      setTimeout(() => { location.href = DASHBOARD_URL; }, 900);
    })();
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

/* ==== SCHEDULING — day-tiles, flex stepper, service segment ==== */
/* The departure picker is a row of stamped day-tiles (½ = half a sim-day
   out, then 1–13), a ‹ n › tolerance stepper, and three punched-ticket
   segment chips. Selecting URGENT pins flex to 0 — urgent cargo sails
   on a fixed day. Tapping a tile slams the sage stamp in.             */
(function buildSchedule() {
  const dayRow   = document.getElementById('dayRow');
  const flexStep = document.getElementById('flexStep');
  const flexVal  = document.getElementById('flexVal');
  const flexNum  = document.getElementById('flexNum');
  const segRow   = document.getElementById('segRow');
  if (!dayRow || !segRow) return;

  const DAYS = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const ROT = DAYS.map((v, i) => (mulberry(4109 + i)() * 5 - 2.5).toFixed(2) + 'deg');

  function paintDays() {
    dayRow.querySelectorAll('.dt').forEach(b => {
      const on = +b.dataset.v === S.depDay;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  dayRow.innerHTML = DAYS.map((v, i) => {
    const lab = v === 0.5 ? '½' : String(v);
    const aria = v === 0.5 ? 'half a day' : `${v} days`;
    return `<button class="dt${S.depDay === v ? ' sel' : ''}" type="button" data-v="${v}"
      style="--dt-rot:${ROT[i]}" aria-pressed="${S.depDay === v}"
      aria-label="Departure in ${aria}"><i>${lab}</i><small>${v === 0.5 ? '12H' : 'DAY'}</small></button>`;
  }).join('');
  dayRow.querySelectorAll('.dt').forEach(b => b.addEventListener('click', () => {
    S.depDay = +b.dataset.v;
    paintDays();
    syncCard();
  }));

  /* ---- ± days of departure tolerance ---- */
  function setFlex(v) {
    S.flex = clamp(Math.round(v), 0, 9);
    flexNum.textContent = S.flex;
    flexNum.dataset.t = S.flex;
    flexVal.setAttribute('aria-valuenow', S.flex);
    syncCard();
  }
  flexStep.querySelectorAll('.fsb').forEach(b =>
    b.addEventListener('click', () => setFlex(S.flex + (+b.dataset.d))));
  flexVal.addEventListener('wheel', e => {
    e.preventDefault();
    setFlex(S.flex + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  flexVal.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setFlex(S.flex + 1); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setFlex(S.flex - 1); e.preventDefault(); }
  });
  S.setFlex = setFlex;   /* segment chips may pin it (urgent → 0) */

  /* ---- service segment — punched ticket chips ---- */
  const SEGS = [['flexible', 'FLEXIBLE'], ['standard', 'STANDARD'], ['urgent', 'URGENT']];
  function paintSeg() {
    segRow.querySelectorAll('.seg').forEach(b => {
      const on = b.dataset.k === S.segment;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-checked', String(on));
    });
  }
  segRow.innerHTML = SEGS.map(([k, t]) =>
    `<button class="seg ${k}${S.segment === k ? ' sel' : ''}" type="button" role="radio"
      aria-checked="${S.segment === k}" data-k="${k}"><i class="ph"></i>${t}</button>`
  ).join('');
  segRow.querySelectorAll('.seg').forEach(b => b.addEventListener('click', () => {
    S.segment = b.dataset.k;
    if (S.segment === 'urgent') { setFlex(0); }   /* urgent sails on the fixed day */
    paintSeg();
    syncCard();
  }));
  paintDays();
})();

/* ==== PORT PAIR + REQUEST PRICE ==== */
/* Stamped field blocks (intake-a register) — ORIGIN and DESTINATION are
   boxed selects letterpressed onto the sheet; the destination lane
   re-lists to only servable OD pairs when the origin changes. The
   ledger readout under the pair follows the route; the request-price
   stepper keeps the exact vertical mechanics from buildType.          */
(async function buildPorts() {
  const selO   = document.getElementById('selOrigin');
  const selD   = document.getElementById('selDest');
  const distEl = document.getElementById('ppDist');
  const stepEl = document.getElementById('ppPrice');
  const valEl  = document.getElementById('ppVal');
  const numEl  = document.getElementById('ppNum');
  if (!selO || !selD) return;

  try {
    const net = await DockAPI.network();
    net.ports.forEach(p => {
      PORT_G[p.port_id] = { n: String(p.name).split('/')[0].trim().toUpperCase(),
                            lat: p.lat, lon: p.lon };
    });
    Object.assign(PAIRS, net.servable);
  } catch (e) {
    if (distEl) distEl.textContent = `BOOKING SERVICE UNAVAILABLE — ${String(e.message).toUpperCase()}`;
    document.querySelectorAll('[data-submit]').forEach(b => { b.disabled = true; });
    return;
  }

  const fill = (sel, codes, cur) => {
    sel.innerHTML = codes.map(c =>
      `<option value="${c}"${c === cur ? ' selected' : ''}>${c} · ${PORT_G[c].n}</option>`).join('');
  };
  const fillD = () => fill(selD, PAIRS[S.origin] || [], S.dest);
  fill(selO, Object.keys(PORT_G), S.origin);
  fillD();

  function dist() {
    if (!distEl || !(PAIRS[S.origin] || []).includes(S.dest)) {
      if (distEl) distEl.textContent = '— NO SERVABLE LANE —';
      return;
    }
    const nm = nmOf(S.origin, S.dest);
    const d  = Math.max(8, Math.round(nm / 450));
    distEl.textContent = `≈ ${nm.toLocaleString('en-US')} NM · ${d} DAYS`;
  }

  selO.addEventListener('change', () => {
    S.origin = selO.value;
    const lanes = PAIRS[S.origin] || [];
    if (!lanes.includes(S.dest)) S.dest = lanes[0];
    fillD(); dist(); syncCard();
  });
  selD.addEventListener('change', () => {
    S.dest = selD.value;
    dist(); syncCard();
  });
  dist();

  /* ---- request price — vertical stepper, buildType mechanics ---- */
  let price = 4820;
  const setP = v => {
    price = clamp(Math.round(v / 10) * 10, 0, 999990);
    S.price = price;
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
