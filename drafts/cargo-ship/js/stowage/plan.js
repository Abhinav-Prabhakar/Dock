// Crane load plan for one row (column) of the ship, and a fully deterministic state-at-time function,
// so the timeline can be scrubbed forwards (loading) or backwards (discharging) with identical results.
import { SHIP } from '../config.js';
import { Y_DECK } from '../ship.js';

export const CRANE = {
  y: 78,            // trolley underside (ship-local m above design WL)
  hoisted: 70.5,    // spreader underside when fully hoisted
  g: 9.81,
};

const HATCH = { y: Y_DECK + 1.6, h: 0.75 };
const smooth = (u) => u * u * (3 - 2 * u);
const clamp01 = (u) => Math.min(1, Math.max(0, u));
const landingEase = (u) => { const a = smooth(u); return a * 0.55 + (1 - Math.pow(1 - u, 2.4)) * 0.45; };

// Build moves in crane order: stern -> bow; per bay: hold (bottom-up), hatch cover, deck (bottom-up).
export function buildPlan(cargo, row) {
  const moves = [];
  const bays = cargo.bays.map((b, i) => ({ b, i })).sort((p, q) => p.b.x - q.b.x);
  for (const { b, i } of bays) {
    if (!b.rows.some((r) => r.row === row)) continue;
    const s = cargo.stackLayout(i, row);
    const order = (list) => list.slice().sort((p, q) => p.y - q.y || p.x - q.x);
    for (const p of order(s.hold)) moves.push({ kind: 'box', bayIndex: i, bay: b, x: p.x, y: p.y, h: p.h, len: p.len, box: p.box, deck: false });
    moves.push({ kind: 'hatch', bayIndex: i, bay: b, x: b.x, y: HATCH.y, h: HATCH.h, len: SHIP.bayPitch - 1.3, deck: false });
    for (const p of order(s.deck)) moves.push({ kind: 'box', bayIndex: i, bay: b, x: p.x, y: p.y, h: p.h, len: p.len, box: p.box, deck: true });
  }

  let t = 0;
  let prevX = moves[0]?.x ?? 0, prevLen = 12.192;
  const events = [];
  for (const m of moves) {
    const load = CRANE.hoisted - m.h;             // load underside while hoisted
    const drop = Math.max(0.5, load - m.y);
    const dx = m.x - prevX;
    const dur = {
      fetch: 2.0,
      travel: Math.abs(dx) > 0.3 ? 0.7 + Math.abs(dx) / 28 : 0.25,
      lower: 0.9 + drop / 9,
      land: 0.5,
      unlock: 0.4,
      hoist: 0.7 + drop / 15,
      retreat: 1.5,
    };
    m.fromX = prevX; m.dx = dx; m.fromLen = prevLen; m.drop = drop;
    m.t0 = t;
    m.ph = {};
    for (const k of ['fetch', 'travel', 'lower', 'land', 'unlock', 'hoist', 'retreat']) { m.ph[k] = [t, t + dur[k]]; t += dur[k]; }
    m.t1 = t;
    m.placeT = m.ph.land[0];
    events.push({ t: m.ph.fetch[0] + 1.6, type: 'lock', m });
    if (Math.abs(dx) > 0.3) { events.push({ t: m.ph.travel[0], type: 'travelStart', m }); events.push({ t: m.ph.travel[1], type: 'travelEnd', m }); }
    events.push({ t: m.ph.land[0], type: m.kind === 'hatch' ? 'hatch' : 'land', m });
    events.push({ t: m.ph.unlock[0] + 0.12, type: 'unlock', m });
    prevX = m.x; prevLen = m.len;
  }

  // scrubber segments per bay
  const segments = [];
  for (const m of moves) {
    const kind = m.kind === 'hatch' ? 'hatch' : m.deck ? 'deck' : 'hold';
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && last.bayIndex === m.bayIndex) last.t1 = m.t1;
    else segments.push({ kind, bayIndex: m.bayIndex, bay: m.bay.bay, t0: m.t0, t1: m.t1 });
  }
  return { row, moves, events, segments, duration: t };
}

function findMove(plan, t) {
  const ms = plan.moves;
  let lo = 0, hi = ms.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ms[mid].t0 <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

// Everything needed to draw a frame at crane-time t.
export function stateAt(plan, t) {
  const ms = plan.moves;
  const st = {
    placed: 0, move: null, phase: 'idle', u: 0,
    crane: { x: 0, depth: 1, spreaderY: CRANE.hoisted, sway: 0, len: 12.192, locked: 0, carrying: false, hatch: false },
  };
  if (!ms.length) return st;
  if (t <= ms[0].t0) { st.crane.x = ms[0].x; return st; }
  if (t >= plan.duration) { const m = ms[ms.length - 1]; st.placed = ms.length; st.crane.x = m.x; st.crane.len = m.len; return st; }
  const i = findMove(plan, t), m = ms[i];
  st.move = m;
  st.placed = i + (t >= m.placeT ? 1 : 0);
  const c = st.crane;
  c.hatch = m.kind === 'hatch';
  let phase = 'retreat';
  for (const k of ['fetch', 'travel', 'lower', 'land', 'unlock', 'hoist', 'retreat']) if (t < m.ph[k][1]) { phase = k; break; }
  const [a, b] = m.ph[phase];
  const u = clamp01((t - a) / (b - a));
  st.phase = phase; st.u = u;
  const top = m.y + m.h;

  c.x = phase === 'fetch' ? m.fromX : phase === 'travel' ? m.fromX + m.dx * smooth(u) : m.x;
  c.len = phase === 'fetch' ? m.fromLen + (m.len - m.fromLen) * smooth(clamp01(u * 1.4 - 0.2)) : m.len;
  c.depth = phase === 'fetch' ? 1 - smooth(u) : phase === 'retreat' ? smooth(u) : 0;
  c.carrying = phase === 'fetch' || phase === 'travel' || phase === 'lower';
  c.locked = phase === 'unlock' ? 1 - u : (phase === 'hoist' || phase === 'retreat') ? 0 : 1;
  switch (phase) {
    case 'lower': c.spreaderY = CRANE.hoisted + (top - CRANE.hoisted) * landingEase(u); break;
    case 'land': c.spreaderY = top - Math.sin(u * Math.PI) * 0.12 * (1 - u); break;
    case 'unlock': c.spreaderY = top; break;
    case 'hoist': c.spreaderY = top + (CRANE.hoisted - top) * smooth(u); break;
    default: c.spreaderY = CRANE.hoisted;
  }
  // load sway: quasi-static lag during gantry travel, then a damped residual swing
  const [ta, tb] = m.ph.travel, D = tb - ta;
  if (Math.abs(m.dx) > 0.3) {
    if (phase === 'travel') c.sway = -(m.dx * (6 - 12 * u)) / (D * D) / CRANE.g * 1.6;
    else if (t > tb) {
      const tau = t - tb;
      const amp = Math.min(0.05, (Math.abs(m.dx) / D) * 0.01) * Math.sign(m.dx);
      c.sway = amp * Math.sin(2.1 * tau) * Math.exp(-0.9 * tau);
    }
  }
  if (phase === 'land' || phase === 'unlock') c.sway *= 0.2;
  return st;
}

export function describeMove(m, cargo) {
  if (!m) return null;
  if (m.kind === 'hatch') return { title: `Hatch cover · bay ${String(m.bay.bay).padStart(2, '0')}`, sub: 'Closing hold before deck stow' };
  const d = cargo.describe(m.box);
  return { title: `${d.slot.slice(0, 2)} · ${d.slot.slice(2, 4)} · ${d.slot.slice(4)}`, sub: `${d.id} · ${d.type === '20' ? "20' GP" : d.type === '40' ? "40' GP" : "40' HC"} · ${d.weight.toFixed(1)} t · ${d.pod}${d.category !== 'dry' ? ' · ' + d.category.toUpperCase() : ''}`, box: d };
}
