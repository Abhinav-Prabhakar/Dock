// Loading-condition calculator. Everything is integrated from the same parametric hull used for rendering:
//  - equilibrium draught + trim (displacement = weight, LCB = LCG) by nested bisection
//  - KB, BM (waterplane inertia), KM, KG, GM (free-surface corrected), heel from TCG, IMO roll period
//  - still-water shear force / bending moment from station weight vs. buoyancy curves
//  - SOLAS V/22 bridge visibility, stack weight limits, heavy-over-light, reefer plugs, IMDG proximity
import { SHIP, HYDRO, CONTAINER_TYPES, PORTS, CATEGORIES } from './config.js';
import { halfBreadth } from './ship.js';
import { fmt } from './cargo.js';

const { L, B, D, T } = SHIP;
const NX = 80, NZ = 8;
const DX = L / NX;
const XS = Array.from({ length: NX }, (_, i) => -L / 2 + (i + 0.5) * DX);
const deg = (r) => (r * 180) / Math.PI;

function section(x, draft) {
  const d = Math.min(Math.max(draft, 0), D + 2);
  const dz = d / NZ;
  let A = 0, M = 0;
  for (let k = 0; k < NZ; k++) {
    const z = (k + 0.5) * dz;
    const w = 2 * halfBreadth(x, z) * dz;
    A += w; M += w * z;
  }
  return [A, M, halfBreadth(x, d)];
}

function hydro(Tm, trim, keepAreas = false) {
  let V = 0, lx = 0, kb = 0, IT = 0, Aw = 0;
  const areas = keepAreas ? new Float64Array(NX) : null;
  for (let i = 0; i < NX; i++) {
    const x = XS[i];
    const [A, M, hw] = section(x, Tm + trim * (x / L));
    V += A * DX; lx += A * x * DX; kb += M * DX;
    IT += (2 / 3) * hw * hw * hw * DX; Aw += 2 * hw * DX;
    if (areas) areas[i] = A;
  }
  return { V, LCB: lx / V, KB: kb / V, IT, Aw, areas };
}

function solveEquilibrium(disp, lcg) {
  const Vt = disp / HYDRO.rho;
  const draftFor = (trim) => {
    let lo = 0.4, hi = D;
    for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (hydro(mid, trim).V < Vt) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  let lo = -14, hi = 14;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (hydro(draftFor(mid), mid).LCB < lcg) lo = mid; else hi = mid;
  }
  const trim = (lo + hi) / 2, Tm = draftFor(trim);
  return { Tm, trim, ...hydro(Tm, trim, true) };
}

// Static reference values (computed once)
const FULL_SECTION = XS.map((x) => section(x, D)[0]);
const DISP_SUMMER = hydro(HYDRO.summerDraft, 0).V * HYDRO.rho;
const LIGHTSHIP = HYDRO.lightship.reduce((s, g) => s + g.w, 0);
const ALLOW_BM = (DISP_SUMMER * L) / 60;         // permissible still-water bending moment (t·m), rule-of-thumb
const ALLOW_SF = (3.2 * ALLOW_BM) / L;           // permissible shear force (t)

function spread(arr, w, x0, x1, shape) {
  if (x1 <= x0) return;
  let tot = 0;
  const parts = [];
  for (let i = 0; i < NX; i++) {
    const a = XS[i] - DX / 2, b = XS[i] + DX / 2;
    const ov = Math.max(0, Math.min(b, x1) - Math.max(a, x0));
    if (ov <= 0) continue;
    const f = ov * (shape ? shape[i] : 1);
    parts.push([i, f]); tot += f;
  }
  for (const [i, f] of parts) arr[i] += (w * f) / tot;
}

export function computeMetrics(cargo, ship) {
  const house = ship.house, casing = ship.casing;
  const wDist = new Float64Array(NX);
  let W = 0, mx = 0, mz = 0, my = 0;
  const addGroup = (w, x0, x1, vcg, shape) => {
    spread(wDist, w, x0, x1, shape);
    W += w; mx += w * (x0 + x1) / 2; my += w * vcg;
  };
  for (const g of HYDRO.lightship) {
    const [x0, x1] = g.house ? [house.aft, house.fore] : g.casing ? [casing.aft, casing.fore] : [g.x0, g.x1];
    addGroup(g.w, x0, x1, g.vcg, g.shape === 'hull' ? FULL_SECTION : null);
  }
  for (const g of HYDRO.consumables) addGroup(g.w, g.x0, g.x1, g.vcg);

  // ---- cargo
  const P = cargo.placements();
  const counts = { boxes: 0, teu: 0, t20: 0, t40: 0, t40hc: 0, deck: 0, hold: 0 };
  const cats = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, { n: 0, w: 0 }]));
  const pods = new Map(PORTS.map((p) => [p.code, { ...p, teu: 0, w: 0, n: 0 }]));
  const bays = cargo.bays.map((b) => ({ bay: b.bay, x: b.x, fore: b.fore, aft: b.aft, deckW: 0, holdW: 0, teu: 0, n: 0, top: null, overweight: 0 }));
  const rows = new Map();
  let cargoW = 0, deckW = 0, holdW = 0;
  const imdgNearHouse = [];
  for (const p of P) {
    const b = p.box, w = b.weight, def = CONTAINER_TYPES[b.type];
    spread(wDist, w, p.x - p.len / 2, p.x + p.len / 2);
    W += w; mx += w * p.x; mz += w * p.z; my += w * (p.y + p.h / 2 + T);
    cargoW += w;
    counts.boxes++; counts.teu += def.teu;
    counts[b.type === '20' ? 't20' : b.type === '40' ? 't40' : 't40hc']++;
    const bi = bays[b.bayIndex];
    bi.n++; bi.teu += def.teu;
    if (p.onDeck) {
      counts.deck++; deckW += w; bi.deckW += w;
      bi.top = Math.max(bi.top ?? -Infinity, p.y + p.h);
      if (b.category === 'imdg' && (Math.abs(bi.aft - house.fore) < 0.5 || Math.abs(bi.fore - house.aft) < 0.5)) imdgNearHouse.push(b);
    } else { counts.hold++; holdW += w; bi.holdW += w; }
    cats[b.category].n++; cats[b.category].w += w;
    const pd = pods.get(b.pod); if (pd) { pd.teu += def.teu; pd.w += w; pd.n++; }
    const r = rows.get(b.row) || { row: b.row, z: p.z, w: 0, deckW: 0, n: 0 };
    r.w += w; r.n++; if (p.onDeck) r.deckW += w;
    rows.set(b.row, r);
  }
  // exact LCG from the distribution (includes the hull-shape weighting)
  let lcg = 0; for (let i = 0; i < NX; i++) lcg += wDist[i] * XS[i]; lcg /= W;
  const tcg = mz / W, kg = my / W;

  // ---- equilibrium + stability
  const eq = solveEquilibrium(W, lcg);
  const Tm = eq.Tm, trim = eq.trim;
  const KM = eq.KB + eq.IT / eq.V;
  const GM0 = KM - kg;
  const GM = GM0 - HYDRO.freeSurface;
  const heel = GM > 0.02 ? deg(Math.atan(tcg / GM)) : Math.sign(tcg || 1) * 15;
  const C = 0.373 + 0.023 * (B / Tm) - 0.043 * (L / 100);
  const rollPeriod = GM > 0.02 ? (2 * C * B) / Math.sqrt(GM) : Infinity;
  const draftAt = (x) => Tm + trim * (x / L);

  // ---- longitudinal strength
  const bDist = new Float64Array(NX);
  let bs = 0; for (let i = 0; i < NX; i++) { bDist[i] = eq.areas[i] * DX * HYDRO.rho; bs += bDist[i]; }
  for (let i = 0; i < NX; i++) bDist[i] *= W / bs;
  const sf = new Float64Array(NX + 1), bm = new Float64Array(NX + 1);
  for (let i = 0; i < NX; i++) sf[i + 1] = sf[i] + (bDist[i] - wDist[i]);
  for (let i = 0; i < NX; i++) bm[i + 1] = bm[i] + ((sf[i] + sf[i + 1]) / 2) * DX;
  for (let i = 0; i <= NX; i++) { const f = i / NX; sf[i] -= sf[NX] * f; bm[i] = -(bm[i] - bm[NX] * f); } // + = hogging
  let maxBM = 0, maxSF = 0, maxBMx = 0;
  for (let i = 0; i <= NX; i++) {
    if (Math.abs(bm[i]) > Math.abs(maxBM)) { maxBM = bm[i]; maxBMx = -L / 2 + i * DX; }
    maxSF = Math.max(maxSF, Math.abs(sf[i]));
  }

  // ---- bridge visibility (SOLAS V/22)
  const eyeX = house.fore - 4.5;
  const eyeH = ship.towerTop + 1.7 + T - draftAt(eyeX);
  let blind = 0, blindBay = null;
  const obstacles = bays.filter((b) => b.fore > eyeX && b.top != null).map((b) => ({ x: b.fore - 0.4, y: b.top + 0.1, bay: b.bay }));
  const firstBay = cargo.bays[0];
  obstacles.push({ x: firstBay.fore + 3, y: (SHIP.D - T) + 7, bay: null }); // breakwater
  for (const o of obstacles) {
    const h = o.y + T - draftAt(o.x);
    const d = h >= eyeH ? Infinity : ((o.x - eyeX) * eyeH) / (eyeH - h) - (L / 2 - eyeX);
    if (d > blind) { blind = d; blindBay = o.bay; }
  }

  // ---- stacks
  let overweight = 0, heavyOverLight = 0, worstStack = { w: 0 };
  cargo.bays.forEach((bay, bi) => {
    for (const r of bay.rows) {
      const s = cargo.stackLayout(bi, r.row);
      for (const [list, lim, onDeck] of [[s.deck, HYDRO.deckStackLimit, true], [s.hold, HYDRO.holdStackLimit, false]]) {
        if (!list.length) continue;
        const sw = list.reduce((a, p) => a + p.box.weight, 0);
        if (onDeck && sw > worstStack.w) worstStack = { w: sw, lim, slot: `${fmt(bay.bay)}${fmt(r.row)}` };
        if (sw > lim) { overweight++; bays[bi].overweight++; }
        for (let i = 1; i < list.length; i++) {
          const up = list[i];
          const below = list.slice(0, i).reverse().find((q) => Math.abs(q.x - up.x) < (q.len + up.len) / 2 - 0.5 && q.y < up.y);
          if (below && up.box.weight > below.box.weight + 5) heavyOverLight++;
        }
      }
    }
  });

  const reefers = cats.reefer.n;
  const dwt = W - LIGHTSHIP, dwtMax = DISP_SUMMER - LIGHTSHIP;

  // ---- checks
  const alerts = [];
  const push = (level, text) => alerts.push({ level, text });
  if (Tm > HYDRO.summerDraft) push('crit', `Overloaded: draught ${Tm.toFixed(2)} m exceeds summer mark ${HYDRO.summerDraft} m`);
  if (GM < 0.15) push('crit', `GM ${GM.toFixed(2)} m below IMO minimum 0.15 m`);
  else if (GM < 0.8) push('warn', `Low GM ${GM.toFixed(2)} m — tender vessel`);
  if (Math.abs(heel) > 3) push('crit', `List ${Math.abs(heel).toFixed(1)}° to ${heel > 0 ? 'starboard' : 'port'}`);
  else if (Math.abs(heel) > 0.8) push('warn', `List ${Math.abs(heel).toFixed(1)}° to ${heel > 0 ? 'starboard' : 'port'} — rebalance rows`);
  if (trim > 0.3) push('warn', `Trimmed by the head ${trim.toFixed(2)} m`);
  const bmPct = Math.abs(maxBM) / ALLOW_BM * 100, sfPct = maxSF / ALLOW_SF * 100;
  if (bmPct > 100) push('crit', `Bending moment ${bmPct.toFixed(0)}% of permissible (${maxBM > 0 ? 'hog' : 'sag'})`);
  else if (bmPct > 88) push('warn', `Bending moment ${bmPct.toFixed(0)}% of permissible`);
  if (sfPct > 100) push('crit', `Shear force ${sfPct.toFixed(0)}% of permissible`);
  if (blind > HYDRO.visibilityLimit) push('crit', `Bridge blind sector ${Number.isFinite(blind) ? blind.toFixed(0) + ' m' : '∞'} > 500 m${blindBay ? ` (bay ${fmt(blindBay)})` : ''}`);
  else if (blind > HYDRO.visibilityLimit * 0.85) push('warn', `Blind sector ${blind.toFixed(0)} m close to 500 m limit`);
  if (overweight) push('warn', `${overweight} stack${overweight > 1 ? 's' : ''} over weight limit`);
  if (heavyOverLight) push('warn', `${heavyOverLight} heavy-over-light stow${heavyOverLight > 1 ? 's' : ''}`);
  if (reefers > HYDRO.reeferPlugs) push('crit', `${reefers} reefers exceed ${HYDRO.reeferPlugs} plugs`);
  if (imdgNearHouse.length) push('warn', `${imdgNearHouse.length} IMDG box${imdgNearHouse.length > 1 ? 'es' : ''} adjacent to accommodation`);
  if (!alerts.length) push('ok', 'All loading checks passed');

  return {
    counts, cats, pods: [...pods.values()],
    bays, rows: [...rows.values()].sort((a, b) => b.z - a.z),
    weights: { cargo: cargoW, deck: deckW, hold: holdW, lightship: LIGHTSHIP, consumables: HYDRO.consumables.reduce((s, g) => s + g.w, 0), displacement: W, dwt, dwtMax, perTEU: counts.teu ? cargoW / counts.teu : 0 },
    hydro: {
      Tm, trim, Tf: Tm + trim / 2, Ta: Tm - trim / 2, trimDeg: deg(Math.atan(trim / L)), heel,
      KB: eq.KB, KM, KG: kg, GM, GM0, rollPeriod, freeboard: D - Tm, TPC: (HYDRO.rho * eq.Aw) / 100,
      LCG: lcg, LCB: eq.LCB, TCG: tcg, summerDraft: HYDRO.summerDraft,
    },
    strength: { xs: Array.from({ length: NX + 1 }, (_, i) => -L / 2 + i * DX), sf: [...sf], bm: [...bm], maxBM, maxBMx, maxSF, allowBM: ALLOW_BM, allowSF: ALLOW_SF, bmPct, sfPct, wDist: [...wDist], bDist: [...bDist], stationX: XS },
    visibility: { blind, limit: HYDRO.visibilityLimit, bay: blindBay, eyeH },
    stacks: { overweight, heavyOverLight, worst: worstStack },
    reefer: { used: reefers, plugs: HYDRO.reeferPlugs, kW: reefers * HYDRO.reeferKW },
    imdg: { n: cats.imdg.n, nearHouse: imdgNearHouse.length },
    alerts,
    draftAt,
  };
}

// Static attitude for the 3D hull (sinkage relative to the design waterline, trim and list).
export function staticAttitude(m) {
  return {
    sinkage: T - m.hydro.Tm,
    pitch: -Math.atan(m.hydro.trim / L),
    roll: (Math.max(-15, Math.min(15, m.hydro.heel)) * Math.PI) / 180,
    rollPeriod: Math.min(40, Math.max(8, m.hydro.rollPeriod)),
  };
}
