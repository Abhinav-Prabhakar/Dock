// Plan (top-down) renderer of the vessel lying port-side-to at the berth: deck stow seen from above with
// a cast shadow per stack, hatch covers, lashing bridges, superstructure, the quay with its crane rails,
// bollards and moorings, and the STS crane's boom, trolley and spreader. Bow to the right, port (quay) up.
// The view works in world coords (x, -z) so makeView(), pan/zoom and follow are shared with the profile.
import { SHIP, CONTAINER_WIDTH } from '../config.js';
import { Y_CARGO, halfBreadth, stemX } from '../ship.js';
import { boxColor } from '../colors.js';
import { HALF_OFFSET, fmt } from '../cargo.js';
import { CRANE } from './plan.js';
import { INK, roundRect } from './profile.js';

const { L, B, D } = SHIP;
const W = CONTAINER_WIDTH, RP = SHIP.rowPitch;
const ink = (a) => `rgba(${INK},${a})`;
const lerp = (a, b, t) => a + (b - a) * t;
const hash = (i) => { const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

// Quay geometry (z < 0 = port side). The crane portal straddles the two rails; trucks run in the lane.
export const QUAY = { edge: -(B / 2 + 7), railSea: -(B / 2 + 10), railLand: -(B / 2 + 40), lane: -(B / 2 + 25), back: -(B / 2 + 52) };
const BOOM = { back: -(B / 2 + 58), out: B / 2 + 16 };
const SHADOW = { x: 0.2, z: 0.32 };            // shadow throw per metre of stack height (sun aft-to-port, high)

const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
};
const luma = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };

export function planLayout(w, h) {
  const top = 88, bottom = h - 196;
  const y0 = -(B / 2 + 18), y1 = B / 2 + 44;        // world y' = -z: starboard water .. quay apron
  const ppm = Math.min((w - 70) / (L + 44), (bottom - top) / (y1 - y0));
  const areaMid = (top + bottom) / 2, yMid = (y0 + y1) / 2;
  return { ppm, cx: -8, cy: yMid - (h / 2 - areaMid) / ppm };
}

// The topmost box over each 20' half of a stack (a 40' covers both halves). bottom-up list in, [{p, n}] out.
function stackTops(list, bx) {
  let f = null, a = null, nf = 0, na = 0;
  for (const p of list) {
    if (p.len > 7 || p.x > bx) { f = p; nf++; }
    if (p.len > 7 || p.x < bx) { a = p; na++; }
  }
  if (f && f === a) return [{ p: f, n: Math.max(nf, na) }];
  return [f && { p: f, n: nf }, a && { p: a, n: na }].filter(Boolean);
}

// Every (bay, row) cell column of the ship with its hold and deck placements.
export function buildCells(cargo) {
  const cells = [];
  cargo.bays.forEach((b, bi) => {
    for (const r of b.rows) {
      const s = cargo.stackLayout(bi, r.row);
      cells.push({ b, bi, row: r.row, z: r.z, deck: s.deck, hold: s.hold });
    }
  });
  return cells;
}

// Hit-test a world point against the cells; returns the cell and the top box under the cursor.
export function hitPlan(cells, wx, wy, visible) {
  const z = -wy;
  const cell = cells.find((c) => Math.abs(wx - c.b.x) <= SHIP.bayPitch / 2 - 0.4 && Math.abs(z - c.z) <= RP / 2);
  if (!cell) return null;
  const deck = visible(cell, cell.deck), hold = visible(cell, cell.hold);
  const tops = stackTops(deck, cell.b.x);
  const top = tops.find((t) => Math.abs(wx - t.p.x) <= t.p.len / 2) || tops[0] || null;
  return { cell, top: top?.p ?? null, deck, hold };
}

// Container roof seen from above: transverse corrugation, side rails, corner castings, optional tier count.
function roof(g, v, x, z, len, color, { highlight = false, n = 0, dim = 0, alpha = 1 } = {}) {
  const Z = (q) => v.Y(-q), ppm = v.ppm;
  const x0 = v.X(x - len / 2), x1 = v.X(x + len / 2), y0 = Z(z - W / 2), y1 = Z(z + W / 2);
  const w = x1 - x0, hh = y1 - y0;
  if (w < 0.5) return;
  g.globalAlpha = alpha;
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, shade(color, 0.14)); gr.addColorStop(0.5, color); gr.addColorStop(1, shade(color, -0.14));
  g.fillStyle = gr; g.fillRect(x0, y0, w, hh);
  if (ppm > 2.6) {
    g.fillStyle = 'rgba(0,0,0,0.09)';
    const pitch = 0.45 * ppm, step = Math.max(1, Math.ceil(2.4 / pitch));
    for (let s = x0 + pitch; s < x1 - pitch * 0.5; s += pitch * step) g.fillRect(s, y0 + 1, Math.max(0.5, 0.12 * ppm), hh - 2);
    g.fillStyle = 'rgba(0,0,0,0.2)';
    const rail = Math.max(0.8, 0.1 * ppm);
    g.fillRect(x0, y0, w, rail); g.fillRect(x0, y1 - rail, w, rail);
    if (ppm > 4) {
      g.fillStyle = 'rgba(0,0,0,0.38)';
      const cc = Math.max(1.4, 0.18 * ppm);
      g.fillRect(x0, y0, cc, cc); g.fillRect(x1 - cc, y0, cc, cc); g.fillRect(x0, y1 - cc, cc, cc); g.fillRect(x1 - cc, y1 - cc, cc, cc);
    }
  }
  if (dim > 0) { g.fillStyle = `rgba(20,16,10,${dim})`; g.fillRect(x0, y0, w, hh); }
  g.strokeStyle = highlight ? '#1d7fe0' : 'rgba(20,16,10,0.55)';
  g.lineWidth = highlight ? 2 : 0.7;
  g.strokeRect(x0 + 0.35, y0 + 0.35, w - 0.7, hh - 0.7);
  if (n > 0 && ppm > 5.2 && w > 22) {
    const fs = Math.min(9, 0.95 * ppm);
    g.font = `700 ${fs}px Inter, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = luma(color) > 0.6 ? ink(0.7) : 'rgba(255,255,255,0.88)';
    g.fillText(`×${n}`, x1 - fs * 1.3, (y0 + y1) / 2 + 0.5);
    g.textBaseline = 'alphabetic';
  }
  g.globalAlpha = 1;
}

export function drawPlan(g, v, o) {
  const { ship, cargo, livery, cells, row, rowZ, visible, hatches, colorMode, hoverId, time = 0, rows } = o;
  const X = v.X, Z = (z) => v.Y(-z), ppm = v.ppm;
  const hb = (x) => halfBreadth(x, D);
  const xStem = stemX(D);
  const onHull = (x, z) => x > -L / 2 - 1 && x < xStem + 1 && Math.abs(z) < hb(Math.min(xStem, Math.max(-L / 2, x))) + 2.5;

  // --- water: drifting ripple marks between the hull and the quay, and off the starboard side
  g.strokeStyle = ink(0.08); g.lineWidth = 1;
  for (let i = 0; i < 220; i++) {
    const x = -L / 2 - 40 + hash(i) * (L + 90), z = QUAY.edge + 1.2 + hash(i + 500) * (B + 34);
    if (onHull(x, z)) continue;
    const s = X(x + Math.sin(time * 0.35 + i) * 0.8), y = Z(z), len = 1.6 * ppm, a = 0.45 * ppm;
    g.beginPath(); g.moveTo(s - len, y); g.quadraticCurveTo(s - len / 2, y - a, s, y); g.quadraticCurveTo(s + len / 2, y + a, s + len, y); g.stroke();
  }

  // --- quay apron: concrete, joints, crane rails, truck lane, fenders, bollards
  const qx0 = -L / 2 - 80, qx1 = L / 2 + 80, qTop = QUAY.back - 40;
  g.fillStyle = ink(0.055); g.fillRect(X(qx0), Z(qTop), (qx1 - qx0) * ppm, (QUAY.edge - qTop) * ppm);
  g.strokeStyle = ink(0.07); g.lineWidth = 1;
  g.beginPath();
  for (let x = Math.ceil(qx0 / 24) * 24; x < qx1; x += 24) { g.moveTo(X(x), Z(qTop)); g.lineTo(X(x), Z(QUAY.edge)); }
  g.stroke();
  g.strokeStyle = ink(0.3); g.lineWidth = Math.max(1, 0.22 * ppm);
  for (const z of [QUAY.railSea, QUAY.railLand]) for (const d of [-0.4, 0.4]) { g.beginPath(); g.moveTo(X(qx0), Z(z + d)); g.lineTo(X(qx1), Z(z + d)); g.stroke(); }
  g.strokeStyle = 'rgba(226,165,32,0.55)'; g.lineWidth = Math.max(1, 0.18 * ppm); g.setLineDash([3 * ppm, 2 * ppm]);
  for (const z of [QUAY.lane - 3.2, QUAY.lane + 3.2]) { g.beginPath(); g.moveTo(X(qx0), Z(z)); g.lineTo(X(qx1), Z(z)); g.stroke(); }
  g.setLineDash([]);
  g.strokeStyle = ink(0.6); g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(X(qx0), Z(QUAY.edge)); g.lineTo(X(qx1), Z(QUAY.edge)); g.stroke();
  g.strokeStyle = ink(0.25); g.lineWidth = 1;
  g.beginPath(); g.moveTo(X(qx0), Z(QUAY.edge - 0.9)); g.lineTo(X(qx1), Z(QUAY.edge - 0.9)); g.stroke();
  const bollards = [];
  for (let x = Math.ceil(qx0 / 16) * 16; x < qx1; x += 16) {
    g.fillStyle = ink(0.32); g.fillRect(X(x + 6.8), Z(QUAY.edge), 2.4 * ppm, 1.1 * ppm);        // fender
    const bx = X(x), by = Z(QUAY.edge - 1.9);
    g.fillStyle = ink(0.55); g.beginPath(); g.arc(bx, by, Math.max(1.4, 0.45 * ppm), 0, Math.PI * 2); g.fill();
    bollards.push(x);
  }
  if (ppm > 1.6) {
    g.fillStyle = ink(0.4); g.font = `700 ${Math.min(10, 2 * ppm)}px Inter, sans-serif`; g.textAlign = 'left';
    if ('letterSpacing' in g) g.letterSpacing = '0.22em';
    g.fillText('QUAY · BERTH 4', X(-L / 2 + 4), Z(QUAY.lane) + 3.5);
    g.textAlign = 'right'; g.fillText('TRUCK LANE', X(L / 2 - 4), Z(QUAY.lane) + 3.5);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
  }

  // --- hull: cast shadow on the water, deck plating, sheer strake, centreline
  const xs = [];
  for (let x = -L / 2; x < xStem; x += 2) xs.push(x);
  xs.push(xStem);
  const hullPath = (dx = 0, dz = 0) => {
    g.beginPath();
    xs.forEach((x, i) => (i ? g.lineTo(X(x + dx), Z(-hb(x) + dz)) : g.moveTo(X(x + dx), Z(-hb(x) + dz))));
    for (let i = xs.length - 1; i >= 0; i--) g.lineTo(X(xs[i] + dx), Z(hb(xs[i]) + dz));
    g.closePath();
  };
  hullPath(1.6, 2.4); g.fillStyle = ink(0.09); g.fill();
  // mooring lines: head, breast and spring lines to the quay bollards
  const nearest = (x) => bollards.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a), bollards[0]);
  g.strokeStyle = ink(0.4); g.lineWidth = Math.max(0.8, 0.14 * ppm);
  for (const [hx, qx] of [[L / 2 - 14, L / 2 + 26], [L / 2 - 30, L / 2 - 20], [L / 2 - 46, L / 2 - 90], [-L / 2 + 10, -L / 2 - 26], [-L / 2 + 24, -L / 2 + 14], [-L / 2 + 40, -L / 2 + 84]]) {
    const bx = nearest(qx);
    g.beginPath(); g.moveTo(X(hx), Z(-hb(hx))); g.lineTo(X(bx), Z(QUAY.edge - 1.9)); g.stroke();
  }
  hullPath(); g.fillStyle = '#ebe4d4'; g.fill();
  g.strokeStyle = livery.hull; g.lineWidth = Math.max(2, 0.8 * ppm); g.stroke();
  g.strokeStyle = ink(0.6); g.lineWidth = 0.8; g.stroke();
  g.strokeStyle = ink(0.16); g.lineWidth = 1; g.setLineDash([8, 4, 2, 4]);
  g.beginPath(); g.moveTo(X(-L / 2 - 6), Z(0)); g.lineTo(X(xStem + 6), Z(0)); g.stroke(); g.setLineDash([]);

  // --- selected row band (under the stow)
  const bx0 = X(-L / 2 - 16), bx1 = X(xStem + 2);
  g.fillStyle = 'rgba(29,127,224,0.09)'; g.fillRect(bx0, Z(rowZ - RP / 2), bx1 - bx0, RP * ppm);

  // --- hatch covers (full width panels) and lashing bridges
  for (const b of cargo.bays) {
    const len = SHIP.bayPitch - 1.3, half = (b.rowCount * RP) / 2 + 0.5;
    const n = b.rowCount >= 16 ? 4 : 3, pw = (2 * half) / n;
    g.strokeStyle = ink(0.4); g.lineWidth = 0.8;
    g.strokeRect(X(b.x - len / 2 - 0.25), Z(-half - 0.25), (len + 0.5) * ppm, (2 * half + 0.5) * ppm);
    for (let k = 0; k < n; k++) {
      const z0 = -half + k * pw, y = Z(z0), x = X(b.x - len / 2);
      g.globalAlpha = 0.5; g.fillStyle = livery.hatch; g.fillRect(x, y, len * ppm, pw * ppm); g.globalAlpha = 1;
      g.strokeStyle = ink(0.45); g.strokeRect(x + 0.4, y + 0.4, len * ppm - 0.8, pw * ppm - 0.8);
      if (ppm > 3) {
        g.strokeStyle = 'rgba(255,255,255,0.14)';
        g.beginPath(); for (const f of [0.33, 0.66]) { g.moveTo(x + 2, y + pw * ppm * f); g.lineTo(x + len * ppm - 2, y + pw * ppm * f); } g.stroke();
      }
    }
  }
  for (const br of ship.layout.bridges) {
    g.globalAlpha = 0.75; g.fillStyle = livery.lashing;
    g.fillRect(X(br.x - 0.55), Z(-br.halfWidth), 1.1 * ppm, 2 * br.halfWidth * ppm); g.globalAlpha = 1;
    g.strokeStyle = ink(0.45); g.lineWidth = 0.7; g.strokeRect(X(br.x - 0.55), Z(-br.halfWidth), 1.1 * ppm, 2 * br.halfWidth * ppm);
  }

  // --- the selected row's open holds: until its hatch is closed the well and its top hold box show
  for (const c of cells) {
    if (c.row !== row || hatches.has(c.bi)) continue;
    const len = SHIP.bayPitch - 1.3;
    g.fillStyle = ink(0.62); g.fillRect(X(c.b.x - len / 2), Z(c.z - RP / 2), len * ppm, RP * ppm);
    for (const t of stackTops(visible(c, c.hold), c.b.x)) roof(g, v, t.p.x, c.z, t.p.len, boxColor(t.p.box, colorMode), { dim: 0.38, n: t.n, highlight: t.p.box.id === hoverId });
  }

  // --- deck stow: shadows first (so they fall across neighbouring stacks), then roofs
  const tops = cells.map((c) => ({ c, t: stackTops(visible(c, c.deck), c.b.x) }));
  g.fillStyle = ink(0.13);
  for (const { c, t } of tops) for (const { p } of t) {
    const hgt = p.y + p.h - Y_CARGO + 1.2;
    g.fillRect(X(p.x - p.len / 2 + hgt * SHADOW.x), Z(c.z - W / 2 + hgt * SHADOW.z), p.len * ppm, W * ppm);
  }
  for (const { c, t } of tops) for (const { p, n } of t) roof(g, v, p.x, c.z, p.len, boxColor(p.box, colorMode), { n, highlight: p.box.id === hoverId });

  // --- superstructure: accommodation with full-width bridge wings, engine casing + funnel
  const house = ship.house, casing = ship.casing;
  const block = (x0, x1, half, fill, a = 0.92) => {
    g.globalAlpha = a; g.fillStyle = fill; g.fillRect(X(x0), Z(-half), (x1 - x0) * ppm, 2 * half * ppm); g.globalAlpha = 1;
    g.strokeStyle = ink(0.6); g.lineWidth = 0.9; g.strokeRect(X(x0), Z(-half), (x1 - x0) * ppm, 2 * half * ppm);
  };
  const hc = (house.fore + house.aft) / 2;
  g.fillStyle = ink(0.12); g.fillRect(X(house.aft + 2), Z(-(B + 3.2) / 2 + 6), (house.fore - house.aft) * ppm, (B + 3.2) * ppm);
  block(house.aft + 0.25, house.fore - 0.25, 22, livery.super);
  block(hc - 7.5, hc + 7.5, 15, shade(livery.super, -0.06));
  block(house.fore - 9, house.fore, (B + 3.2) / 2, livery.super);
  g.fillStyle = 'rgba(40,60,75,0.8)'; g.fillRect(X(house.fore - 0.9), Z(-(B + 3.2) / 2 + 0.6), 0.6 * ppm, (B + 2) * ppm);
  g.fillStyle = ink(0.7); g.beginPath(); g.arc(X(hc - 1), Z(0), Math.max(1.2, 0.6 * ppm), 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink(0.6); g.lineWidth = Math.max(1, 0.25 * ppm);
  g.beginPath(); g.moveTo(X(hc - 1), Z(-4.5)); g.lineTo(X(hc - 1), Z(4.5)); g.stroke();
  block(casing.aft + 0.3, casing.fore - 0.3, B / 2 - 6, livery.super);
  const fx = (casing.fore + casing.aft) / 2 - 0.5;
  g.fillStyle = livery.funnel; g.beginPath(); g.ellipse(X(fx), Z(0), 5.4 * ppm, 7.2 * ppm, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink(0.6); g.lineWidth = 0.9; g.stroke();
  g.fillStyle = livery.funnelTop; g.beginPath(); g.ellipse(X(fx), Z(0), 4.4 * ppm, 6 * ppm, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = ink(0.85);
  for (const dz of [-2.2, 2.2]) { g.beginPath(); g.arc(X(fx), Z(dz), 1.3 * ppm, 0, Math.PI * 2); g.fill(); }
  g.save(); g.translate(X(casing.aft - 3.2), Z(B / 2 - 5));
  g.fillStyle = '#ff6a13'; g.beginPath(); g.ellipse(0, 0, 5 * ppm, 1.4 * ppm, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink(0.6); g.lineWidth = 0.8; g.stroke(); g.restore();
  // breakwater + foremast
  const firstBay = cargo.bays[0];
  const bwx = firstBay.fore + 3;
  g.strokeStyle = ink(0.6); g.lineWidth = Math.max(1, 0.5 * ppm);
  g.beginPath(); g.moveTo(X(bwx), Z(-hb(bwx) + 1.5)); g.quadraticCurveTo(X(bwx + 5), Z(0), X(bwx), Z(hb(bwx) - 1.5)); g.stroke();
  g.fillStyle = ink(0.7); g.beginPath(); g.arc(X(ship.foremastTop.x), Z(0), Math.max(1.2, 0.5 * ppm), 0, Math.PI * 2); g.fill();

  // --- selected row outline on top of the stow
  g.strokeStyle = 'rgba(29,127,224,0.85)'; g.lineWidth = 1.2; g.setLineDash([5, 4]);
  for (const e of [-RP / 2, RP / 2]) { g.beginPath(); g.moveTo(bx0, Z(rowZ + e)); g.lineTo(bx1, Z(rowZ + e)); g.stroke(); }
  g.setLineDash([]);

  // --- labels: rows at the stern, bays along the starboard side, sides + bow
  if (RP * ppm >= 6.5) {
    const fs = Math.min(10, Math.max(6.5, 0.36 * RP * ppm));
    g.textAlign = 'right';
    for (const r of rows) {
      const sel = r.row === row;
      g.fillStyle = sel ? '#1566b5' : ink(0.45); g.font = `${sel ? 800 : 600} ${fs}px Inter, sans-serif`;
      g.fillText(fmt(r.row), X(-L / 2 - 7), Z(r.z) + fs * 0.36);
    }
  }
  if (ppm > 1.4) {
    g.textAlign = 'center';
    for (const b of cargo.bays) {
      g.fillStyle = ink(0.75); g.font = `700 ${Math.min(12, Math.max(8, 2.6 * ppm))}px Inter, sans-serif`;
      g.fillText(fmt(b.bay), X(b.x), Z(B / 2 + 5.5));
      if (ppm > 3) {
        g.fillStyle = ink(0.42); g.font = `600 ${Math.min(10, 2 * ppm)}px Inter, sans-serif`;
        g.fillText(fmt(b.foreBay20), X(b.x + HALF_OFFSET), Z(B / 2 + 9));
        g.fillText(fmt(b.aftBay20), X(b.x - HALF_OFFSET), Z(B / 2 + 9));
      }
      g.strokeStyle = ink(0.25); g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(b.aft + 0.3), Z(B / 2 + 2.2)); g.lineTo(X(b.fore - 0.3), Z(B / 2 + 2.2)); g.stroke();
    }
    g.fillStyle = ink(0.45); g.font = `700 ${Math.min(10, 2 * ppm)}px Inter, sans-serif`; g.textAlign = 'right';
    g.fillText('PORT', X(-L / 2 - 7), Z(-B / 2 - 2.5));
    g.fillText('STBD', X(-L / 2 - 7), Z(B / 2 + 4.5));
    g.textAlign = 'left'; g.fillText('BOW ▸', X(xStem + 5), Z(0) + 3.5);
  }
}

// STS crane from above: portal legs on the quay rails, lattice boom out over the ship, trolley, spreader
// and the swinging load with a shadow thrown in proportion to its height above the deck stow.
export function drawPlanCrane(g, v, st, { rowZ, carry, appear = 1, time = 0 }) {
  const X = v.X, Z = (z) => v.Y(-z), ppm = v.ppm, c = st.crane;
  const zt = lerp(rowZ, QUAY.lane, c.depth);
  const hang = Math.max(0, CRANE.y - c.spreaderY), lx = c.x + Math.sin(c.sway) * hang;
  const lift = Math.max(0, c.spreaderY - Y_CARGO) + 1.2;
  g.save(); g.globalAlpha = appear;

  // load + its shadow
  if (carry) {
    g.fillStyle = ink(0.14);
    g.fillRect(X(lx - carry.len / 2 + lift * SHADOW.x), Z(zt - W / 2 + lift * SHADOW.z), carry.len * ppm, W * ppm);
    if (carry.color) roof(g, v, lx, zt, carry.len, carry.color, { alpha: appear });
    else { g.fillStyle = carry.hatchColor; g.fillRect(X(lx - carry.len / 2), Z(zt - W / 2), carry.len * ppm, W * ppm); g.strokeStyle = ink(0.6); g.lineWidth = 0.8; g.strokeRect(X(lx - carry.len / 2), Z(zt - W / 2), carry.len * ppm, W * ppm); }
    g.globalAlpha = appear;
  }
  // spreader frame + twistlock lamps
  const sl = c.len;
  g.strokeStyle = '#e2a520'; g.lineWidth = Math.max(1, 0.28 * ppm);
  g.strokeRect(X(lx - sl / 2), Z(zt - W / 2 - 0.15), sl * ppm, (W + 0.3) * ppm);
  g.beginPath(); g.moveTo(X(lx - sl / 2), Z(zt)); g.lineTo(X(lx + sl / 2), Z(zt)); g.stroke();
  const lamp = c.locked > 0.5 ? 'rgba(80,230,120,1)' : 'rgba(255,170,40,1)';
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = X(lx + sx * (sl / 2 - 0.4)), py = Z(zt + sz * (W / 2 - 0.2));
    const gl = g.createRadialGradient(px, py, 0, px, py, Math.max(3, 0.9 * ppm));
    gl.addColorStop(0, lamp); gl.addColorStop(1, 'rgba(255,170,40,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(px, py, Math.max(3, 0.9 * ppm), 0, Math.PI * 2); g.fill();
  }

  // portal: legs on both rails, sill beams along the quay, portal beams across
  const legX = [c.x - 9, c.x + 9];
  g.strokeStyle = 'rgba(29,26,22,0.7)'; g.lineWidth = Math.max(1.2, 0.55 * ppm);
  for (const z of [QUAY.railSea, QUAY.railLand]) { g.beginPath(); g.moveTo(X(legX[0]), Z(z)); g.lineTo(X(legX[1]), Z(z)); g.stroke(); }
  for (const x of legX) { g.beginPath(); g.moveTo(X(x), Z(QUAY.railSea)); g.lineTo(X(x), Z(QUAY.railLand)); g.stroke(); }
  g.fillStyle = 'rgba(29,26,22,0.9)';
  for (const x of legX) for (const z of [QUAY.railSea, QUAY.railLand]) g.fillRect(X(x - 1.3), Z(z - 1.3), 2.6 * ppm, 2.6 * ppm);

  // boom: two chords with Warren lacing, from the backreach over the quay to the outreach past starboard
  const b0 = c.x - 1.7, b1 = c.x + 1.7;
  g.fillStyle = 'rgba(29,26,22,0.08)'; g.fillRect(X(b0), Z(BOOM.back), 3.4 * ppm, (BOOM.out - BOOM.back) * ppm);
  g.strokeStyle = 'rgba(29,26,22,0.35)'; g.lineWidth = Math.max(0.6, 0.12 * ppm);
  g.beginPath();
  for (let z = BOOM.back; z < BOOM.out - 1; z += 3) { g.moveTo(X(b0), Z(z)); g.lineTo(X(b1), Z(z + 1.5)); g.lineTo(X(b0), Z(z + 3)); }
  g.stroke();
  g.strokeStyle = 'rgba(29,26,22,0.8)'; g.lineWidth = Math.max(1, 0.3 * ppm);
  for (const x of [b0, b1]) { g.beginPath(); g.moveTo(X(x), Z(BOOM.back)); g.lineTo(X(x), Z(BOOM.out)); g.stroke(); }
  // hinge line where the boom lifts, machinery house on the backreach
  g.strokeStyle = 'rgba(29,26,22,0.6)'; g.lineWidth = Math.max(1, 0.4 * ppm);
  g.beginPath(); g.moveTo(X(b0 - 1), Z(QUAY.edge + 1)); g.lineTo(X(b1 + 1), Z(QUAY.edge + 1)); g.stroke();
  g.fillStyle = 'rgba(29,26,22,0.85)'; g.fillRect(X(c.x - 4), Z(BOOM.back), 8 * ppm, 9 * ppm);
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(X(c.x - 3), Z(BOOM.back + 1.2), 6 * ppm, 0.8 * ppm);
  // aviation light at the boom tip
  const blink = Math.sin(time * 3) > 0.2;
  if (blink) { g.fillStyle = 'rgba(230,60,50,0.9)'; g.beginPath(); g.arc(X(c.x), Z(BOOM.out - 0.8), Math.max(1.6, 0.5 * ppm), 0, Math.PI * 2); g.fill(); }

  // trolley + operator cab (glass on the sea side)
  g.fillStyle = '#2a241b'; roundRect(g, X(c.x - 2.6), Z(zt - 2.4), 5.2 * ppm, 4.8 * ppm, Math.max(1, 0.4 * ppm)); g.fill();
  g.fillStyle = 'rgba(120,170,200,0.9)'; g.fillRect(X(c.x - 1.6), Z(zt + 1.1), 3.2 * ppm, 0.9 * ppm);
  if (ppm > 2.2) {
    g.fillStyle = ink(0.55); g.font = `700 ${Math.min(10, 2 * ppm)}px Inter, sans-serif`; g.textAlign = 'left';
    g.fillText('STS 03', X(c.x + 5), Z(BOOM.back + 5) + 3);
  }
  g.restore();
}

