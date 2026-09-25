'use strict';
/* ============================================================
   MERIDIAN intake variant B — "THE CARD IS THE FORM"
   ------------------------------------------------------------
   The laminated booking credential IS the intake surface. Fields
   are entered on the card face: tap the origin/destination
   datestamps to cycle servable ports, tap the commodity stamp to
   cycle cargo class, step TEU/weight on the column beside the
   card, punch departure-day tickets on the strip beneath, punch
   service-grade tickets in the filing ledger. Every stamped
   change visibly re-inks the card (stamp slams, barcode re-seed,
   status band PENDING → READY) and kicks the badge on its
   leather cord — a light pendulum, not a physics engine.
   ============================================================ */

const API = location.port === '8399' ? '' : 'http://localhost:8399';
const ORDERS_KEY    = 'ml.orders';
const DASHBOARD_URL = '../dashboard/';

/* ----------------------------- helpers ----------------------------- */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
/* fnv-1a — seeds the barcode off the live order payload */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ----------------------------- DOM refs ---------------------------- */
const zoneEl   = document.getElementById('zone');
const pegEl    = document.getElementById('peg');
const cardEl   = document.getElementById('card');
const shadowEl = document.getElementById('cardShadow');
const strapCv  = document.getElementById('strap');
const ctx      = strapCv.getContext('2d');
const bandEl   = document.getElementById('band');
const bandT    = document.getElementById('bandT');
const noteEl   = document.getElementById('lgNote');
const confirmBtn = document.getElementById('confirm');

let vw = window.innerWidth, vh = window.innerHeight;

/* ==================== PORT NETWORK (contract) ==================== */
const PORT_G = {
  CNSHA: { n: 'SHANGHAI',     lat:  31.2243, lon:  121.4869 },
  SGSIN: { n: 'SINGAPORE',    lat:   1.2644, lon:  103.8200 },
  KRPUS: { n: 'BUSAN',        lat:  35.0951, lon:  129.0398 },
  NLRTM: { n: 'ROTTERDAM',    lat:  51.9480, lon:    4.1420 },
  DEHAM: { n: 'HAMBURG',      lat:  53.5403, lon:    9.9852 },
  BEANR: { n: 'ANTWERP',      lat:  51.2630, lon:    4.4020 },
  USLAX: { n: 'LOS ANGELES',  lat:  33.7292, lon: -118.1970 },
  USNYC: { n: 'NEW YORK',     lat:  40.6690, lon:  -74.0100 },
};
const SRC = ['SGSIN', 'CNSHA', 'KRPUS', 'NLRTM', 'DEHAM', 'BEANR', 'USLAX', 'USNYC'];
/* only these OD pairs are servable — dest cycling is filtered by origin */
const PAIRS = {
  CNSHA: ['NLRTM', 'DEHAM', 'BEANR', 'USLAX', 'USNYC', 'SGSIN'],
  SGSIN: ['NLRTM', 'BEANR', 'CNSHA'],
  KRPUS: ['USLAX', 'CNSHA'],
  NLRTM: ['CNSHA', 'SGSIN', 'BEANR'],
  DEHAM: ['CNSHA'],
  BEANR: ['SGSIN'],
  USLAX: ['CNSHA', 'KRPUS'],
  USNYC: ['CNSHA'],
};
const D2R = Math.PI / 180;
const nmOf = (a, b) => {
  const A = PORT_G[a], B = PORT_G[b];
  const la1 = A.lat * D2R, la2 = B.lat * D2R;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin(((B.lon - A.lon) * D2R) / 2) ** 2;
  return Math.round(3440.065 * 2 * Math.asin(Math.sqrt(h)));
};

/* live port names — merge real /ports names into the stamps (fallback = embedded) */
(async () => {
  try {
    const r = await fetch(`${API}/ports`);
    if (!r.ok) return;
    const list = await r.json();
    for (const p of list) {
      if (PORT_G[p.port_id] && p.name)
        PORT_G[p.port_id].n = String(p.name).split('/')[0].trim().toUpperCase();
    }
    applyPort(0); applyPort(1);
  } catch (e) { /* offline — embedded names stand */ }
})();

/* ============================ FORM STATE =========================== */
const TYPE_COLORS = [                       // slip edge stripe, per kind
  '#c96a2a', '#e9e5d7', '#8f918a', '#2f5b7e', '#a8402f', '#2a2721',
];
const DEP_DAYS  = [0.5, 1, 2, 3, 5, 7, 10, 14, 21];
const FLEX_DAYS = [0, 1, 2, 3, 5, 7];
const CARGO = [
  { k: 'dry',    word: 'DRY',    t: 'DRY GOODS',  sub: 'GENERAL · NON-TEMP · NON-IMO',
    ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="2.7" fill="currentColor"/></svg>' },
  { k: 'reefer', word: 'REEFER', t: 'REEFER',     sub: 'TEMP CONTROLLED · -25/+15°C',
    ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="none" stroke="currentColor"' +
        ' stroke-width="1.1" stroke-linecap="round">' +
        '<path d="M10.16 8.4L1.84 3.6M6 10.8L6 1.2M1.84 8.4L10.16 3.6"/>' +
        '<path d="M8.64 7.52L9.1 8.95M8.64 7.52L10.11 7.21M6 9.05L5 10.16M6 9.05L7 10.16' +
        'M3.36 7.52L1.89 7.21M3.36 7.52L2.9 8.95M3.36 4.47L2.9 3.05M3.36 4.47L1.89 4.79' +
        'M6 2.95L7 1.84M6 2.95L5 1.84M8.64 4.47L10.11 4.79M8.64 4.47L9.1 3.05"/></g></svg>' },
  { k: 'hazmat', word: 'HAZMAT', t: 'HAZMAT',     sub: 'IMO DECLARED · SEGREGATED STOW',
    ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="currentColor">' +
        '<circle cx="6" cy="6" r="1.3"/>' +
        '<path d="M3.65 1.93A4.7 4.7 0 0 1 8.35 1.93L6.95 4.36A1.9 1.9 0 0 0 5.05 4.36Z"/>' +
        '<path d="M10.7 6A4.7 4.7 0 0 1 8.35 10.07L6.95 7.64A1.9 1.9 0 0 0 7.9 6Z"/>' +
        '<path d="M3.65 10.07A4.7 4.7 0 0 1 1.3 6L4.1 6A1.9 1.9 0 0 0 5.05 7.64Z"/></g></svg>' },
];

const state = {
  oi: 0,                      // index into SRC (origin)
  di: 0,                      // index into PAIRS[origin] (dest)
  seg: 'standard',
  dep: 5,
  flex: 2,
  /* one slip per container kind — slip 0 lives on the card face */
  slips: [{ cargo: 0, teu: 4, wt: 44, wtDirty: false }],
  filed: false,
};
const origin = () => SRC[state.oi];
const dests  = () => PAIRS[origin()] || [];
const dest   = () => dests()[state.di];
const segIsUrgent = () => state.seg === 'urgent';

/* ------------------- generated print: barcode ------------------- */
const barCv  = document.getElementById('barcode');
const barCap = document.getElementById('barCap');
const barWrap = document.getElementById('barWrap');
function drawBarcode(seed) {
  const x = barCv.getContext('2d');
  const r = mulberry(seed);
  x.clearRect(0, 0, barCv.width, barCv.height);
  x.fillStyle = '#16181d';
  let px = 4;
  while (px < barCv.width - 6) {
    const w = 1 + ((r() * 3) | 0);
    if (r() < 0.74) x.fillRect(px, 1, w, 30);
    px += w + 1 + (r() < 0.4 ? 1 : 0);
  }
  x.fillRect(2, 1, 1, 33); x.fillRect(barCv.width - 3, 1, 1, 33);
  barCap.textContent = String(seed % 10000).padStart(4, '0') + ' ' +
                       String((seed >> 7) % 10000).padStart(4, '0');
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

/* ------------- generated print: mini manifest stack ------------- */
/* corrugation-glyphs tinted per cargo class — re-seeded with the form */
function buildStack(seed) {
  const g = document.getElementById('ctnStack');
  if (!g) return;
  const r = mulberry(seed);
  const inks = { dry: '#3a5a44', reefer: '#4a7f9e', hazmat: '#c98f1f' };
  const palette = ['#3a5a44', '#b96f4b', '#a8843e', '#ddd5bd', '#45423a'];
  const kindInk = i => {
    const s = state.slips[Math.floor(i * state.slips.length / 24)];
    return s ? (inks[CARGO[s.cargo].k] || '#3a5a44') : '#d8d2bc';
  };
  const w = 6.6, h = 5.4, gx = 1.1, gy = 1.3;
  let s = '';
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 8; i++) {
      const idx = j * 8 + i;
      const x = i * (w + gx), y = j * (h + gy);
      const fill = r() < 0.62 ? kindInk(idx) : palette[(r() * palette.length) | 0];
      s += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w}" height="${h}"` +
           ` fill="${fill}" stroke="rgba(28,22,12,.30)" stroke-width=".4"/>`;
      s += `<path d="M${(x + w / 2).toFixed(2)} ${(y + .7).toFixed(2)}v${(h - 1.4).toFixed(2)}"` +
           ` stroke="rgba(20,14,6,.20)" stroke-width=".5" fill="none"/>`;
    }
  g.innerHTML = s;
}

/* ================== PENDULUM + BRAIDED CORD ================== */
/* The badge hangs as a true pendulum: it rotates about the peg
   itself (CSS transform-origin at the peg). Every stamped change
   gives the cord a kick — paper settling, not a physics sim.   */
let th = 0.05, thv = 0;              // pendulum angle / velocity
let kickSign = 1;
const OM = 2 * Math.PI / 2.9;        // ~2.9s period
const OM2 = OM * OM, DAMP = 1.15;

function kick(power = 0.55) {
  thv += power * kickSign;
  kickSign *= -1;
}

/* braided-leather pattern tile for the cord */
let strapPat = null;
function makeStrapPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const x = c.getContext('2d');
  x.fillStyle = '#6b4c2d'; x.fillRect(0, 0, 8, 8);
  x.strokeStyle = 'rgba(255,226,182,0.12)'; x.lineWidth = 1;
  for (let i = -8; i < 8; i += 3) {
    x.beginPath(); x.moveTo(i, 8); x.lineTo(i + 8, 0); x.stroke();
  }
  x.strokeStyle = 'rgba(24,12,4,0.20)';
  for (let i = -6; i < 8; i += 3) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 8, 8); x.stroke();
  }
  strapPat = ctx.createPattern(c, 'repeat');
}

/* quadratic-bezier point + tangent */
const qp = (p0, c, p1, t) => ({
  x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p1.x,
  y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p1.y,
});
const qt = (p0, c, p1, t) => ({
  x: 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p1.x - c.x),
  y: 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p1.y - c.y),
});

function drawStrap(peg, att, slack) {
  ctx.clearRect(0, 0, vw, vh);
  const p0 = { x: peg.x - 10, y: peg.y - 8 };     // wraps over the hook's J
  const p1 = att;
  /* control point sags perpendicular to the chord; slacker when settled */
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const dl = Math.hypot(dx, dy) || 1;
  const c  = { x: mx - (dy / dl) * slack + (dx / dl) * 4,
               y: my + (dx / dl) * slack + (dy / dl) * 4 };
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.quadraticCurveTo(c.x, c.y, p1.x, p1.y);
  };

  /* cord's own shadow on the wall */
  ctx.save();
  ctx.translate(8, 12);
  if ('filter' in ctx) ctx.filter = 'blur(4px)';
  path();
  ctx.strokeStyle = 'rgba(44,36,24,0.22)';
  ctx.lineWidth = 7.6; ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  /* leather body — dark edge, then braided pattern */
  path();
  ctx.strokeStyle = 'rgba(28,16,6,0.38)'; ctx.lineWidth = 8.8; ctx.lineCap = 'round'; ctx.stroke();
  path();
  ctx.strokeStyle = strapPat; ctx.lineWidth = 7.4; ctx.stroke();

  /* cylindrical shading — specular above-left, shade below-right */
  path();
  ctx.save(); ctx.translate(-0.9, -1.2);
  ctx.strokeStyle = 'rgba(255,232,196,0.24)'; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.restore();
  path();
  ctx.save(); ctx.translate(0.9, 1.3);
  ctx.strokeStyle = 'rgba(20,10,4,0.26)'; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.restore();

  /* braided chevron wraps along the cord */
  ctx.lineWidth = 1.05;
  for (let i = 0; i < 9; i++) {
    const t = 0.08 + i * 0.105;
    const p = qp(p0, c, p1, t), q = qt(p0, c, p1, t);
    const l = Math.hypot(q.x, q.y) || 1;
    const ux = q.x / l, uy = q.y / l, nx = -uy, ny = ux, hw = 3.4;
    ctx.beginPath();
    ctx.moveTo(p.x - ux * 1.7 + nx * hw, p.y - uy * 1.7 + ny * hw);
    ctx.lineTo(p.x + ux * 2.1, p.y + uy * 2.1);
    ctx.lineTo(p.x - ux * 1.7 - nx * hw, p.y - uy * 1.7 - ny * hw);
    ctx.strokeStyle = i % 2 ? 'rgba(42,24,10,0.45)' : 'rgba(255,222,178,0.30)';
    ctx.stroke();
  }

  /* small brass bead slid down near the top */
  {
    const p = qp(p0, c, p1, 0.14);
    const g = ctx.createRadialGradient(p.x - 1.6, p.y - 2.1, 0.6, p.x, p.y, 6.4);
    g.addColorStop(0, '#f4e2ae'); g.addColorStop(.4, '#c8a45e');
    g.addColorStop(.78, '#8a6a34'); g.addColorStop(1, '#5a401e');
    ctx.beginPath(); ctx.arc(p.x, p.y, 5.4, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(46,30,8,0.55)'; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,18,6,0.55)'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x - 1.7, p.y - 2.2, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,246,214,0.65)'; ctx.fill();
  }

  /* leather-wrap knot where the cord meets the split ring */
  {
    const q = qt(p0, c, p1, 1);
    const ang = Math.atan2(q.y, q.x);
    ctx.save();
    ctx.translate(p1.x, p1.y);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, -6, 0, 6);
    g.addColorStop(0, '#6a4c2c'); g.addColorStop(.5, '#452f1a'); g.addColorStop(1, '#2c1d0e');
    ctx.beginPath();
    ctx.moveTo(-8.5 + 3.2, -5.6);
    ctx.arcTo(8.5, -5.6, 8.5, 5.6, 3.2);
    ctx.arcTo(8.5, 5.6, -8.5, 5.6, 3.2);
    ctx.arcTo(-8.5, 5.6, -8.5, -5.6, 3.2);
    ctx.arcTo(-8.5, -5.6, 8.5, -5.6, 3.2);
    ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(20,10,4,0.55)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-4.5, -5.6); ctx.lineTo(-4.5, 5.6);
    ctx.moveTo(-0.8, -5.6); ctx.lineTo(-0.8, 5.6);
    ctx.moveTo(3, -5.6);    ctx.lineTo(3, 5.6);
    ctx.strokeStyle = 'rgba(18,9,3,0.45)'; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-8.5, -4.6); ctx.lineTo(8.5, -4.6);
    ctx.strokeStyle = 'rgba(255,222,178,0.22)'; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.restore();
  }
}

/* per-frame: pendulum step → card transform, shadow, cord */
let simT = 0;
function render(dt) {
  simT += dt;

  /* pendulum dynamics + faint air currents */
  thv += (-OM2 * th - DAMP * thv) * dt;
  thv += (Math.sin(simT * 0.83) * 0.05 + Math.sin(simT * 1.9 + 2.1) * 0.03) * dt;
  th  += thv * dt;
  th   = clamp(th, -0.6, 0.6);

  const deg = th * 57.29578;
  const ry = clamp(-thv * 3.4, -11, 11) + 1.6;
  const rx = clamp(-Math.abs(thv) * 1.2, -7, 0) + 1.2;

  cardEl.style.transform =
    `rotate(${th.toFixed(4)}rad) rotateY(${ry.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg)`;
  cardEl.style.setProperty('--sx', clamp(deg * 1.6 + ry * 9, -170, 170).toFixed(1) + 'px');
  cardEl.style.setProperty('--ho', (deg * 3 + ry * 10).toFixed(1) + 'deg');

  /* geometry — the cord is drawn on a fixed canvas (viewport coords),
     while card + shadow live in .zone (document/offset coords) */
  const pr  = pegEl.getBoundingClientRect();
  const peg = { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 };
  const pz  = { x: pegEl.offsetLeft + pr.width / 2, y: pegEl.offsetTop + pr.height / 2 };
  const D   = cardEl.offsetTop - 27 - pegEl.offsetTop;   // peg → split ring
  const att = { x: peg.x + D * Math.sin(th), y: peg.y + D * Math.cos(th) };
  const H   = cardEl.offsetHeight;
  const cx  = pz.x + (D + H / 2) * Math.sin(th);
  const cy  = pz.y + (D + H / 2) * Math.cos(th);

  /* wall contact shadow — drifts + softens with the swing */
  const energy = Math.abs(thv) * 8 + Math.abs(th) * 34;
  const blur = clamp(9 + energy, 9, 26);
  shadowEl.style.transform =
    `translate3d(${(cx - cardEl.offsetWidth / 2 + 13 + deg * 0.6).toFixed(1)}px,` +
    ` ${(cy - H / 2 + 19).toFixed(1)}px, 0) rotate(${deg.toFixed(2)}deg)`;
  shadowEl.style.filter = `blur(${blur.toFixed(1)}px)`;
  shadowEl.style.opacity = clamp(0.40 - energy * 0.006, 0.16, 0.40).toFixed(3);

  const slack = clamp(9 - Math.abs(thv) * 10 - Math.abs(th) * 16, 1.5, 9);
  drawStrap(peg, att, slack);
}

/* a grab on bare card skin nudges the pendulum — fields stopPropagation */
let dragX = null;
cardEl.addEventListener('pointerdown', e => {
  if (e.target.closest('button, .sval, a, [role="spinbutton"]')) return;
  dragX = e.clientX;
});
window.addEventListener('pointermove', e => {
  if (dragX === null) return;
  thv += (e.clientX - dragX) * 0.00045;
  dragX = e.clientX;
});
const lift = () => { dragX = null; };
window.addEventListener('pointerup', lift);
window.addEventListener('pointercancel', lift);

/* ==================== STAMP SLAM PRIMITIVE ==================== */
function slam(el, cls = 'pp-slam') {
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
}

/* ==================== PORT DATESTAMPS ON THE CARD ==================== */
const route  = document.getElementById('ppRoute');
const ship   = document.getElementById('ppShip');
const distEl = document.getElementById('ppDist');
const coinA  = document.getElementById('ppCoinA');
const coinB  = document.getElementById('ppCoinB');
const nameA  = document.getElementById('ppNameA');
const nameB  = document.getElementById('ppNameB');
const codeA  = document.getElementById('ppCodeA');
const codeB  = document.getElementById('ppCodeB');
const hitA   = document.getElementById('ppPortA');
const hitB   = document.getElementById('ppPortB');

function applyPort(which) {
  if (which === 0) {
    const c = origin();
    codeA.textContent = c;
    nameA.textContent = PORT_G[c].n;
    hitA.setAttribute('aria-label',
      `Origin port — ${PORT_G[c].n} ${c}. Activate to cycle origins.`);
  } else {
    const c = dest();
    codeB.textContent = c;
    nameB.textContent = PORT_G[c].n;
    hitB.setAttribute('aria-label',
      `Destination port — ${PORT_G[c].n} ${c}. Activate to cycle servable destinations.`);
  }
}

function distLedger() {
  const nm = nmOf(origin(), dest());
  distEl.textContent = `≈ ${nm.toLocaleString('en-US')} NM · ${Math.max(8, Math.round(nm / 450))} DAYS AT SEA`;
}

/* ---- little freighter rides the dashed route ---- */
const routeL = route.getTotalLength();
let sailRAF = 0;
function placeShip(t) {
  const p = route.getPointAtLength(t * routeL);
  const q = route.getPointAtLength(Math.min(t * routeL + 1.5, routeL));
  const a = Math.atan2(q.y - p.y, q.x - p.x) * 57.29578;
  ship.setAttribute('transform',
    `translate(${p.x.toFixed(1)} ${(p.y - 4.6).toFixed(1)}) rotate(${a.toFixed(1)})`);
}
function sail() {
  cancelAnimationFrame(sailRAF);
  route.classList.remove('pp-run');
  void route.getBoundingClientRect();
  route.classList.add('pp-run');
  const t0 = performance.now(), dur = 950;
  const easeIO = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const step = now => {
    const k = Math.min((now - t0) / dur, 1);
    placeShip(easeIO(k));
    sailRAF = k < 1 ? requestAnimationFrame(step) : 0;
  };
  sailRAF = requestAnimationFrame(step);
}

hitA.addEventListener('click', () => {
  state.oi = (state.oi + 1) % SRC.length;
  state.di = 0;                             // re-ink dest to first servable pair
  slam(coinA); slam(coinB); kick();
  setTimeout(() => { applyPort(0); applyPort(1); }, 150);
  sail(); distLedger(); touch();
});
hitB.addEventListener('click', () => {
  state.di = (state.di + 1) % dests().length;
  slam(coinB); kick();
  setTimeout(() => applyPort(1), 150);
  sail(); distLedger(); touch();
});

/* ==================== COMMODITY STAMP ON THE CARD ==================== */
const cstamp  = document.getElementById('cstamp');
const csIn    = cstamp.querySelector('.cs-in');
const csGlyph = document.getElementById('csGlyph');
const csWord  = document.getElementById('csWord');
const csHit   = document.getElementById('csHit');
const cgName  = document.getElementById('cgName');
const cgSub   = document.getElementById('cgSub');
const cgTeu   = document.getElementById('cgTeu');
const cgWt    = document.getElementById('cgWt');

function applyCargo() {
  const s = state.slips[0], c = CARGO[s.cargo];
  cstamp.dataset.cargo = c.k;
  csGlyph.innerHTML =
    `<g transform="translate(41 38) scale(2)"><g transform="translate(-6 -6)">${c.ic}</g></g>`;
  csWord.textContent = c.word;
  cgName.textContent = c.t; cgName.dataset.t = c.t;
  cgSub.textContent = c.sub;
  cgTeu.textContent = s.teu + ' TEU';
  cgWt.textContent  = s.wt.toFixed(1) + ' t';
  csHit.setAttribute('aria-label',
    `cargo class — ${c.t.toLowerCase()}. Activate to cycle dry, reefer, hazmat.`);
}
function cycleCargo(i) {
  const s = state.slips[i];
  s.cargo = (s.cargo + 1) % CARGO.length;
  if (i === 0) {
    slam(csIn, 'cs-slam'); kick();
    setTimeout(applyCargo, 130);
  }
  renderSlips(); touch();
}
csHit.addEventListener('click', () => cycleCargo(0));

/* ==================== STEPPER COLUMN — KIND 01 ==================== */
const svTeu = document.getElementById('svTeu');
const svWt  = document.getElementById('svWt');
const stepsCol = document.getElementById('stepsCol');

function paintSteps() {
  const s = state.slips[0];
  svTeu.textContent = s.teu;
  svTeu.setAttribute('aria-valuenow', s.teu);
  svWt.innerHTML = s.wt.toFixed(1) + '<span class="u">t</span>';
  svWt.setAttribute('aria-valuenow', s.wt);
  cgTeu.textContent = s.teu + ' TEU';
  cgWt.textContent  = s.wt.toFixed(1) + ' t';
}
function stepTeu(d) {
  const s = state.slips[0];
  s.teu = clamp(s.teu + d, 1, 99);
  if (!s.wtDirty) s.wt = s.teu * 11;          // auto-suggest ≈11 t per TEU
  paintSteps(); renderSlips(); touch();
}
function stepWt(d) {
  const s = state.slips[0];
  s.wt = clamp(+(s.wt + 0.5 * d).toFixed(1), 0.5, 30000);
  s.wtDirty = true;
  paintSteps(); renderSlips(); touch();
}
stepsCol.querySelectorAll('.sbtn').forEach(b =>
  b.addEventListener('click', () =>
    (b.dataset.f === 'teu' ? stepTeu : stepWt)(+b.dataset.d)));
svTeu.addEventListener('wheel', e => { e.preventDefault(); stepTeu(e.deltaY < 0 ? 1 : -1); }, { passive: false });
svWt .addEventListener('wheel', e => { e.preventDefault(); stepWt (e.deltaY < 0 ? 1 : -1); }, { passive: false });
svTeu.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp')   { stepTeu(1);  e.preventDefault(); }
  if (e.key === 'ArrowDown') { stepTeu(-1); e.preventDefault(); }
});
svWt.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp')   { stepWt(1);  e.preventDefault(); }
  if (e.key === 'ArrowDown') { stepWt(-1); e.preventDefault(); }
});

/* ==================== DEPARTURE-DAY TICKET STRIP ==================== */
const depTiles  = document.getElementById('depTiles');
const flexTiles = document.getElementById('flexTiles');
const flexNote  = document.getElementById('flexNote');
const depBoard  = document.getElementById('depBoard');
const rDep      = document.getElementById('rDep');

DEP_DAYS.forEach(v => {
  const b = document.createElement('button');
  b.className = 'dep-tile';
  b.type = 'button';
  b.dataset.v = v;
  b.innerHTML = `<i>D+</i><b>${v}</b><s>${v === 0.5 ? '½ DAY' : v === 1 ? 'DAY' : 'DAYS'}</s>`;
  b.setAttribute('aria-label', `departure day ${v} sim-days`);
  b.addEventListener('click', () => { state.dep = v; paintDep(true); kick(0.4); touch(); });
  depTiles.appendChild(b);
});
FLEX_DAYS.forEach(v => {
  const b = document.createElement('button');
  b.className = 'flex-tile';
  b.type = 'button';
  b.dataset.v = v;
  b.textContent = v;
  b.setAttribute('aria-label', `plus or minus ${v} days flexibility`);
  b.addEventListener('click', () => { state.flex = v; paintFlex(v); kick(0.35); touch(); });
  flexTiles.appendChild(b);
});

function paintDep(withSlam) {
  depTiles.querySelectorAll('.dep-tile').forEach(t => {
    const on = +t.dataset.v === state.dep;
    if (on && withSlam && !t.classList.contains('on')) {
      t.classList.remove('on'); void t.getBoundingClientRect();
    }
    t.classList.toggle('on', on);
  });
  rDep.textContent = `D+${state.dep} ±${state.flex}`;
  rDep.classList.remove('flip'); void rDep.getBoundingClientRect();
  rDep.classList.add('flip');
}
function paintFlex(newV) {
  flexTiles.querySelectorAll('.flex-tile').forEach(t => {
    const on = +t.dataset.v === state.flex;
    if (on && t.dataset.v === String(newV)) {
      t.classList.remove('on'); void t.getBoundingClientRect();
    }
    t.classList.toggle('on', on);
  });
  flexNote.textContent = state.flex === 0 ? 'EXACT DAY ONLY'
                      : `±${state.flex} DAY${state.flex > 1 ? 'S' : ''} EARLY OR LATE`;
  rDep.textContent = `D+${state.dep} ±${state.flex}`;
  rDep.classList.remove('flip'); void rDep.getBoundingClientRect();
  rDep.classList.add('flip');
}

/* ==================== SERVICE-GRADE PUNCHED TICKETS ==================== */
const segChips = document.getElementById('segChips');
const urgStamp = document.getElementById('urgStamp');
const rGrade   = document.getElementById('rGrade');
const SEG_T = { flexible: 'FLEXIBLE', standard: 'STANDARD', urgent: 'URGENT' };

segChips.querySelectorAll('.seg-chip').forEach(ch => {
  ch.addEventListener('click', () => {
    state.seg = ch.dataset.seg;
    segChips.querySelectorAll('.seg-chip').forEach(c =>
      c.classList.toggle('on', c === ch));
    ch.classList.remove('punch'); void ch.getBoundingClientRect();
    ch.classList.add('punch');
    if (segIsUrgent()) {
      urgStamp.classList.remove('on'); void urgStamp.getBoundingClientRect();
      urgStamp.classList.add('on');
      if (state.flex !== 0) { state.flex = 0; paintFlex(0); }   // urgent → exact day
    } else {
      urgStamp.classList.remove('on');
    }
    rGrade.textContent = SEG_T[state.seg];
    rGrade.classList.remove('flip'); void rGrade.getBoundingClientRect();
    rGrade.classList.add('flip');
    kick(); touch();
  });
});

/* ==================== CONSIGNMENT SLIPS ==================== */
const slipsEl = document.getElementById('slips');
const addKindBtn = document.getElementById('addKind');
const CHEV_U = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 5 5 1 9 5"/></svg>';
const CHEV_D = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1 5 5 9 1"/></svg>';

function slipCargoChip(i) {
  const c = CARGO[state.slips[i].cargo];
  return `<button class="ct-cargo" type="button" data-cargo="${c.k}" data-i="${i}"` +
         ` aria-label="kind ${i + 1} cargo class ${c.t.toLowerCase()}, activate to change"` +
         ` title="CARGO CLASS — ${c.t} · CLICK TO CHANGE">` +
         `<span class="cg-ic">${c.ic}</span></button>`;
}

function renderSlips() {
  let h = '';
  state.slips.forEach((s, i) => {
    const c = CARGO[s.cargo];
    h += `<div class="slip" data-i="${i}" style="--cc:${TYPE_COLORS[i % TYPE_COLORS.length]}">` +
      `<div class="slip-h">` +
        `<span class="slip-n">KIND ${String(i + 1).padStart(2, '0')}</span>` +
        (i === 0 ? '<span class="slip-cardtag">ON CARD</span>'
                 : `<button class="slip-x" type="button" data-x="${i}"` +
                   ` aria-label="remove kind ${i + 1}">✕</button>`) +
      `</div>` +
      `<div class="slip-b">` +
        slipCargoChip(i) +
        `<span class="slip-cg-lbl">${c.word}</span>` +
        `<div class="mstep">` +
          `<button class="mb" type="button" data-i="${i}" data-f="teu" data-d="-1"` +
          ` aria-label="kind ${i + 1} fewer TEU">${CHEV_D}</button>` +
          `<span class="mv">${s.teu}</span><span class="mu">TEU</span>` +
          `<button class="mb" type="button" data-i="${i}" data-f="teu" data-d="1"` +
          ` aria-label="kind ${i + 1} more TEU">${CHEV_U}</button>` +
        `</div>` +
        `<div class="mstep">` +
          `<button class="mb" type="button" data-i="${i}" data-f="wt" data-d="-1"` +
          ` aria-label="kind ${i + 1} lighter">${CHEV_D}</button>` +
          `<span class="mv">${s.wt.toFixed(1)}</span><span class="mu">t</span>` +
          `<button class="mb" type="button" data-i="${i}" data-f="wt" data-d="1"` +
          ` aria-label="kind ${i + 1} heavier">${CHEV_U}</button>` +
        `</div>` +
      `</div>` +
    `</div>`;
  });
  slipsEl.innerHTML = h;
}
slipsEl.addEventListener('click', e => {
  const x = e.target.closest('.slip-x');
  if (x) {
    state.slips.splice(+x.dataset.x, 1);
    addKindBtn.disabled = false;
    addKindBtn.textContent = '+ ANOTHER KIND';
    renderSlips(); kick(); touch();
    return;
  }
  const cg = e.target.closest('.ct-cargo');
  if (cg) { cycleCargo(+cg.dataset.i); return; }
  const mb = e.target.closest('.mb');
  if (mb) {
    const s = state.slips[+mb.dataset.i], d = +mb.dataset.d;
    if (mb.dataset.f === 'teu') {
      s.teu = clamp(s.teu + d, 1, 99);
      if (!s.wtDirty) s.wt = s.teu * 11;
    } else {
      s.wt = clamp(+(s.wt + 0.5 * d).toFixed(1), 0.5, 30000);
      s.wtDirty = true;
    }
    if (+mb.dataset.i === 0) paintSteps();
    renderSlips(); kick(0.3); touch();
  }
});
addKindBtn.addEventListener('click', () => {
  if (state.slips.length >= 6) return;
  state.slips.push({ cargo: 0, teu: 2, wt: 22, wtDirty: false });
  if (state.slips.length >= 6) {
    addKindBtn.disabled = true;
    addKindBtn.textContent = '— SIX KINDS LISTED';
  }
  renderSlips(); kick(); touch();
});

/* ==================== SUMMARY · VALIDATION · RE-INK ==================== */
const ctnNum  = document.getElementById('ctnNum');
const ctnTip  = document.getElementById('ctnTip');
const statTeu = document.getElementById('statTeu');
const wtNum   = document.getElementById('wtNum');
const gaugeFill = document.getElementById('gaugeFill');
const depNum  = document.getElementById('depNum');
const depFlex = document.getElementById('depFlex');
const rStatus = document.getElementById('rStatus');
const lgSum   = document.getElementById('lgSum');
const lgTag   = document.getElementById('lgTag');
const bkId    = document.getElementById('bkId');

function payload() {
  return state.slips.map(s => ({
    origin:      origin(),
    dest:        dest(),
    teu:         s.teu,
    weight_t:    +s.wt.toFixed(2),
    cargo_type:  CARGO[s.cargo].k,
    segment:     state.seg,
    req_dep_day: state.dep,
    flex_days:   state.flex,
  }));
}

function problems() {
  const p = new Set();
  if (!dests().includes(dest())) p.add('pair');
  if (!(state.dep >= 0.5))       p.add('dep');
  state.slips.forEach((s, i) => {
    if (!(s.teu >= 1) || !(s.wt > 0)) p.add('slip:' + i);
  });
  return p;
}

let bandState = '';
function setBand(txt, cls) {
  const key = txt + '|' + cls;
  if (key === bandState) return;
  bandState = key;
  bandT.innerHTML = txt;
  bandEl.className = 'band' + (cls ? ' ' + cls : '');
  bandEl.classList.remove('flip'); void bandEl.getBoundingClientRect();
  bandEl.classList.add('flip');
  rStatus.textContent = txt.replace(/&nbsp;/g, ' ').split('—')[1].trim();
  rStatus.classList.remove('flip'); void rStatus.getBoundingClientRect();
  rStatus.classList.add('flip');
}

function note(msg) {
  if (!msg) { noteEl.hidden = true; noteEl.textContent = ''; return; }
  noteEl.hidden = false;
  noteEl.textContent = msg;
  noteEl.style.animation = 'none';
  void noteEl.getBoundingClientRect();
  noteEl.style.animation = '';
}

/* re-ink the whole credential from state — barcode re-seeds, ghosts update */
function touch() {
  const bodies = payload();
  const teuSum = state.slips.reduce((a, s) => a + s.teu, 0);
  const wtSum  = state.slips.reduce((a, s) => a + s.wt, 0);

  ctnNum.textContent = teuSum; ctnNum.dataset.t = teuSum;
  const counts = { dry: 0, reefer: 0, hazmat: 0 };
  state.slips.forEach(s => { counts[CARGO[s.cargo].k] += s.teu; });
  const parts = [];
  if (counts.dry)    parts.push('DRY ×' + counts.dry);
  if (counts.reefer) parts.push('REEFER ×' + counts.reefer);
  if (counts.hazmat) parts.push('HAZMAT ×' + counts.hazmat);
  ctnTip.innerHTML = parts.join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  statTeu.setAttribute('aria-label',
    `${teuSum} containers — ${parts.join(', ').toLowerCase()}`);

  wtNum.textContent = wtSum.toFixed(1);
  gaugeFill.style.width = clamp(wtSum / 1200 * 100, 2, 96) + '%';

  depNum.textContent = 'D+' + state.dep;
  depNum.dataset.t = depNum.textContent;
  depFlex.textContent = `± ${state.flex} DAY${state.flex === 1 ? '' : 'S'}`;

  lgSum.textContent =
    `${state.slips.length} KIND${state.slips.length > 1 ? 'S' : ''} · ${teuSum} TEU · ${wtSum.toFixed(1)} t`;

  /* validity → status band; barcode re-seeds off the canonical payload */
  const bad = problems();
  if (!state.filed) {
    if (bad.size === 0) setBand('BOOKING REQUEST&nbsp;&nbsp;—&nbsp;&nbsp;READY TO FILE', 'ready');
    else                setBand('BOOKING REQUEST&nbsp;&nbsp;—&nbsp;&nbsp;PENDING', '');
  }
  confirmBtn.disabled = state.filed;

  /* a fresh field re-inks — earlier terracotta recheck marks lift */
  depBoard.classList.remove('err');
  stepsCol.classList.remove('err');
  slipsEl.querySelectorAll('.slip.err').forEach(el => el.classList.remove('err'));
  if (bad.size === 0 && !state.filed &&
      /CHECK THE FIELDS/.test(noteEl.textContent)) note(null);

  const seed = hash32(JSON.stringify(bodies));
  drawBarcode(seed);
  buildStack(seed);
  barWrap.classList.remove('reink'); void barWrap.getBoundingClientRect();
  barWrap.classList.add('reink');
}



/* ==================== CONFIRM — one POST per kind ==================== */
confirmBtn.addEventListener('click', async () => {
  if (state.filed) return;
  const bad = problems();
  /* terracotta stamps on whatever fails the check */
  depBoard.classList.toggle('err', bad.has('dep'));
  stepsCol.classList.toggle('err', bad.has('slip:0'));
  slipsEl.querySelectorAll('.slip').forEach(el =>
    el.classList.toggle('err', bad.has('slip:' + el.dataset.i)));
  if (bad.size) {
    note('CHECK THE FIELDS MARKED IN TERRACOTTA — THE CREDENTIAL IS NOT READY TO FILE.');
    kick(0.9);
    return;
  }

  const bodies = payload();
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = 'STAMPING&nbsp;…';

  try {
    const created = await Promise.all(bodies.map(b =>
      fetch(`${API}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      }).then(r => {
        if (!r.ok) return r.json().then(j => Promise.reject({ status: r.status, detail: j.detail }));
        return r.json();
      })));

    try {
      const cache = JSON.parse(localStorage.getItem(ORDERS_KEY)) || [];
      localStorage.setItem(ORDERS_KEY, JSON.stringify(created.concat(cache)));
    } catch (e) {}

    /* the credential re-inks itself with the real booking number */
    state.filed = true;
    if (created[0] && created[0].id) {
      bkId.textContent = created[0].id; bkId.dataset.t = created[0].id;
      lgTag.textContent = created[0].id;
    }
    setBand(`ORDER${created.length > 1 ? 'S' : ''} FILED&nbsp;&nbsp;—&nbsp;&nbsp;CONFIRMED`, 'ready filed');
    confirmBtn.classList.add('filed');
    confirmBtn.innerHTML = `✓ ${created.length > 1 ? created.length + ' ORDERS' : 'ORDER'} FILED`;
    kick(1.2);
    setTimeout(() => { location.href = DASHBOARD_URL; }, 1400);

  } catch (err) {
    if (err && err.status) {
      /* API declined — stamp the detail onto the ledger, stay on the form */
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = 'CONFIRM&nbsp;<span class="arr">→</span>';
      const det = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail);
      note(`DECLINED ${err.status} — ${det || 'THE LINE REFUSED THIS MANIFEST.'}`);
      kick(0.9);
    } else {
      /* offline — mirror the orders into the local cache, still hand off */
      try {
        const orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || [];
        bodies.forEach((b, i) => orders.unshift({
          id: 'BK-' + (2487 + orders.length + i) + '-TC',
          status: 'PENDING REVIEW',
          ...b,
          vessel: null, voyage: null, eta: null,
          progress: 0, price_usd: null,
          created: Date.now() / 1000,
        }));
        localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
      } catch (e2) {}
      state.filed = true;
      setBand('FILED OFFLINE&nbsp;&nbsp;—&nbsp;&nbsp;CACHED', 'ready filed');
      confirmBtn.classList.add('filed');
      confirmBtn.innerHTML = '✓ CACHED — OFFLINE';
      setTimeout(() => { location.href = DASHBOARD_URL; }, 1100);
    }
  }
});

/* ============================ BOOT & LOOP =========================== */
applyPort(0); applyPort(1);
distLedger();
placeShip(0.55);
applyCargo();
paintSteps();
renderSlips();
paintDep(false);
paintFlex();
touch();

function resize() {
  vw = window.innerWidth; vh = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  strapCv.width = Math.round(vw * dpr);
  strapCv.height = Math.round(vh * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();
makeStrapPattern();

let last = performance.now();
function frame(t) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
