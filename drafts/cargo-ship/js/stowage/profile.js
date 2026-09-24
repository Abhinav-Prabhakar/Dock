// Side-elevation renderer (starboard view, bow to the right) of the vessel as a semi-transparent
// "technical drawing", with the stow of the selected row and a ghost of the rows behind it.
import { SHIP, HYDRO } from '../config.js';
import { Y_DECK, Y_CARGO, Y_HOLD, hullOutline, halfBreadth, aftX, stemX } from '../ship.js';
import { boxColor } from '../colors.js';
import { HALF_OFFSET, fmt } from '../cargo.js';

const { L, T } = SHIP;
export const INK = '43,36,25';
const ink = (a) => `rgba(${INK},${a})`;

export function makeView(w, h, ppm, cx, cy) {
  return {
    w, h, ppm, cx, cy,
    X: (x) => w / 2 + (x - cx) * ppm,
    Y: (y) => h / 2 - (y - cy) * ppm,
    toWorld: (sx, sy) => [cx + (sx - w / 2) / ppm, cy - (sy - h / 2) / ppm],
  };
}

const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
};

// A single container in side elevation: corrugated panel, rails, corner castings, door end on the aft side.
export function drawBox(g, v, x, y, len, h, color, { alpha = 1, highlight = false, doorLeft = true, label = null } = {}) {
  const x0 = v.X(x - len / 2), x1 = v.X(x + len / 2), y1 = v.Y(y), y0 = v.Y(y + h);
  const w = x1 - x0, hh = y1 - y0;
  if (w < 0.5) return;
  g.globalAlpha = alpha;
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, shade(color, 0.12)); gr.addColorStop(0.55, color); gr.addColorStop(1, shade(color, -0.18));
  g.fillStyle = gr;
  g.fillRect(x0, y0, w, hh);
  const px = v.ppm;
  if (px > 2.2) {
    const pitch = 0.28 * px;
    const step = Math.max(1, Math.ceil(2.2 / pitch));
    g.fillStyle = 'rgba(0,0,0,0.10)';
    const inset = Math.max(1, 0.18 * px);
    for (let s = x0 + inset + pitch * 0.5; s < x1 - inset; s += pitch * step) g.fillRect(s, y0 + 1, Math.max(0.6, pitch * 0.32), hh - 2);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(x0, y0, w, Math.max(1, 0.12 * px));
    g.fillRect(x0, y1 - Math.max(1, 0.16 * px), w, Math.max(1, 0.16 * px));
    const cw = Math.max(1.2, 0.18 * px);
    g.fillRect(x0, y0, cw, hh); g.fillRect(x1 - cw, y0, cw, hh);
    if (px > 4) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      const cc = Math.max(1.5, 0.2 * px);
      g.fillRect(x0, y0, cc, cc); g.fillRect(x1 - cc, y0, cc, cc); g.fillRect(x0, y1 - cc, cc, cc); g.fillRect(x1 - cc, y1 - cc, cc, cc);
      // door gear hint on the aft end
      const dx = doorLeft ? x0 + cw + 1 : x1 - cw - 3;
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(dx, y0 + hh * 0.15, 1, hh * 0.7);
    }
  }
  g.strokeStyle = highlight ? '#1d7fe0' : 'rgba(20,16,10,0.55)';
  g.lineWidth = highlight ? 2 : 0.8;
  g.strokeRect(x0 + 0.4, y0 + 0.4, w - 0.8, hh - 0.8);
  if (label && px > 5) {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = `600 ${Math.min(11, 0.9 * px)}px Inter, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, (x0 + x1) / 2, (y0 + y1) / 2);
    g.textBaseline = 'alphabetic';
  }
  g.globalAlpha = 1;
}

function hullPath(g, v) {
  const pts = hullOutline(32);
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(v.X(x), v.Y(y)) : g.moveTo(v.X(x), v.Y(y))));
  g.closePath();
}

// Ghost silhouette of the tallest deck stow in any other row, per 20' half-bay ("containers behind").
export function ghostTops(cargo, row) {
  const out = [];
  cargo.bays.forEach((b, bi) => {
    let topF = null, topA = null;
    for (const r of b.rows) {
      if (r.row === row) continue;
      for (const p of cargo.stackLayout(bi, r.row).deck) {
        const top = p.y + p.h;
        if (p.len > 7 || p.x > b.x) topF = Math.max(topF ?? -1e9, top);
        if (p.len > 7 || p.x < b.x) topA = Math.max(topA ?? -1e9, top);
      }
    }
    if (topF != null) out.push({ x0: b.x + 0.04, x1: b.x + HALF_OFFSET * 2 - 0.04, top: topF });
    if (topA != null) out.push({ x0: b.x - HALF_OFFSET * 2 + 0.04, x1: b.x - 0.04, top: topA });
  });
  return out;
}

export function drawProfile(g, v, o) {
  const { ship, cargo, livery, hullMorph = 1, ghostAlpha = 1, placedIds, hatches, colorMode, hoverId, metrics, rowBoxes, rowAlpha = 1, prev } = o;
  const X = v.X, Y = v.Y, ppm = v.ppm;
  const house = ship.house, casing = ship.casing;

  // --- waterline (actual draught with trim)
  if (metrics) {
    const ya = metrics.hydro.Ta - T, yf = metrics.hydro.Tf - T;
    g.strokeStyle = 'rgba(44,110,170,0.55)'; g.lineWidth = 1; g.setLineDash([6, 5]);
    g.beginPath(); g.moveTo(X(-L / 2 - 24), Y(ya - (24 / L) * (yf - ya))); g.lineTo(X(L / 2 + 24), Y(yf + (24 / L) * (yf - ya))); g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(44,110,170,0.75)'; g.font = '600 10px Inter, sans-serif'; g.textAlign = 'left';
    g.fillText(`WL  ${metrics.hydro.Tm.toFixed(2)} m`, X(L / 2 + 8), Y(yf) - 5);
    // summer load line reference
    const ys = HYDRO.summerDraft - T;
    g.strokeStyle = 'rgba(200,70,60,0.35)'; g.setLineDash([2, 4]);
    g.beginPath(); g.moveTo(X(-L / 2), Y(ys)); g.lineTo(X(L / 2), Y(ys)); g.stroke(); g.setLineDash([]);
  }

  // --- ghost of the rows behind (deck)
  if (ghostAlpha > 0.01) {
    g.fillStyle = ink(0.05 * ghostAlpha);
    g.strokeStyle = ink(0.22 * ghostAlpha);
    g.lineWidth = 1; g.setLineDash([3, 3]);
    for (const s of o.ghost) {
      const x0 = X(s.x0), x1 = X(s.x1), y0 = Y(s.top), y1 = Y(Y_CARGO);
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    }
    g.setLineDash([]);
  }

  const drawSet = (boxes, alpha, deck) => {
    for (const p of boxes) {
      if (p.deck !== deck || !placedIds.has(p.box.id)) continue;
      drawBox(g, v, p.x, p.y, p.len, p.h, boxColor(p.box, colorMode), { alpha, highlight: p.box.id === hoverId });
    }
  };
  // --- hold stow (seen through the hull plating)
  if (prev && prev.alpha > 0.01) drawSet(prev.boxes, prev.alpha * hullMorph, false);
  drawSet(rowBoxes, rowAlpha * (0.25 + 0.75 * hullMorph), false);

  // --- hull
  const hullA = 0.92 - 0.72 * hullMorph;
  g.save();
  hullPath(g, v);
  g.globalAlpha = hullA;
  g.fillStyle = livery.hull; g.fill();
  g.clip();
  g.fillStyle = livery.bottom;
  g.fillRect(X(-L / 2 - 5), Y(0.9), (L + 10) * ppm, 30 * ppm);
  g.globalAlpha = 0.12 + 0.1 * hullMorph;
  const glass = g.createLinearGradient(0, Y(Y_DECK), 0, Y(-T));
  glass.addColorStop(0, 'rgba(255,255,255,0.9)'); glass.addColorStop(0.5, 'rgba(255,255,255,0)'); glass.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = glass; g.fillRect(X(-L / 2 - 5), Y(Y_DECK + 1), (L + 10) * ppm, (Y_DECK + T + 2) * ppm);
  g.globalAlpha = 1;
  // internal structure: double bottom, bulkheads, engine room, fore peak
  g.strokeStyle = ink(0.28 * hullMorph); g.lineWidth = 1;
  g.beginPath(); g.moveTo(X(aftX(HYDRO.tankTop) - 2), Y(Y_HOLD)); g.lineTo(X(stemX(HYDRO.tankTop) + 4), Y(Y_HOLD)); g.stroke();
  const bh = new Set();
  cargo.bays.forEach((b) => { bh.add(b.fore.toFixed(2)); bh.add(b.aft.toFixed(2)); });
  g.setLineDash([4, 3]);
  for (const s of bh) { const x = +s; g.beginPath(); g.moveTo(X(x), Y(Y_HOLD)); g.lineTo(X(x), Y(Y_DECK)); g.stroke(); }
  g.setLineDash([]);
  const hatchRegion = (x0, x1, y0, y1, label) => {
    g.save();
    g.beginPath(); g.rect(X(x0), Y(y1), (x1 - x0) * ppm, (y1 - y0) * ppm); g.clip();
    g.strokeStyle = ink(0.12 * hullMorph);
    for (let s = -200; s < (x1 - x0) * ppm + 400; s += 7) { g.beginPath(); g.moveTo(X(x0) + s, Y(y1)); g.lineTo(X(x0) + s - 300, Y(y1) + 300); g.stroke(); }
    g.restore();
    if (label && ppm > 2.5) {
      g.fillStyle = ink(0.45 * hullMorph); g.font = `700 ${Math.min(11, 2.4 * ppm)}px Inter, sans-serif`; g.textAlign = 'center';
      g.fillText(label, X((x0 + x1) / 2), Y((y0 + y1) / 2) + 4);
    }
  };
  const lastBay = cargo.bays[cargo.bays.length - 1], firstBay = cargo.bays[0];
  hatchRegion(casing.aft - 6, casing.fore + 4, Y_HOLD, Y_DECK, 'ENGINE ROOM');
  hatchRegion(firstBay.fore, L / 2 + 2, Y_HOLD - 2, Y_DECK, 'FORE PEAK');
  hatchRegion(-L / 2 - 2, lastBay.aft, Y_HOLD + 4, Y_DECK, 'STEERING');
  hatchRegion(house.aft, house.fore, Y_HOLD, Y_DECK, null);
  g.restore();
  hullPath(g, v);
  g.strokeStyle = livery.hull; g.lineWidth = 1.6; g.stroke();
  g.strokeStyle = ink(0.55); g.lineWidth = 0.8; g.stroke();

  // --- deck fittings: coamings, hatch covers, lashing bridges
  for (const b of cargo.bays) {
    const len = SHIP.bayPitch - 1.3;
    g.fillStyle = ink(0.10); g.strokeStyle = ink(0.4); g.lineWidth = 0.8;
    g.fillRect(X(b.x - len / 2 - 0.2), Y(Y_DECK + 1.6), (len + 0.4) * ppm, 1.6 * ppm);
    g.strokeRect(X(b.x - len / 2 - 0.2), Y(Y_DECK + 1.6), (len + 0.4) * ppm, 1.6 * ppm);
    if (hatches.has(b.index)) {
      g.fillStyle = livery.hatch; g.fillRect(X(b.x - len / 2), Y(Y_CARGO), len * ppm, 0.75 * ppm);
      g.strokeStyle = ink(0.6); g.strokeRect(X(b.x - len / 2), Y(Y_CARGO), len * ppm, 0.75 * ppm);
    }
  }
  g.strokeStyle = ink(0.35); g.lineWidth = Math.max(0.8, 0.22 * ppm);
  for (const br of ship.layout.bridges) {
    const top = Y_CARGO + br.levels * 2.85 + 1.1;
    for (const dx of [-0.55, 0.55]) { g.beginPath(); g.moveTo(X(br.x + dx), Y(Y_CARGO)); g.lineTo(X(br.x + dx), Y(top)); g.stroke(); }
    for (let l = 1; l <= br.levels; l++) { g.beginPath(); g.moveTo(X(br.x - 0.7), Y(Y_CARGO + l * 2.85)); g.lineTo(X(br.x + 0.7), Y(Y_CARGO + l * 2.85)); g.stroke(); }
  }

  // --- deck stow of the selected row
  if (prev && prev.alpha > 0.01) drawSet(prev.boxes, prev.alpha, true);
  drawSet(rowBoxes, rowAlpha, true);

  // --- superstructure
  const sup = (x0, y0, x1, y1, fill = livery.super, a = 0.8) => {
    g.globalAlpha = a; g.fillStyle = fill; g.fillRect(X(x0), Y(y1), (x1 - x0) * ppm, (y1 - y0) * ppm);
    g.globalAlpha = 1; g.strokeStyle = ink(0.6); g.lineWidth = 0.9; g.strokeRect(X(x0), Y(y1), (x1 - x0) * ppm, (y1 - y0) * ppm);
  };
  const tt = ship.towerTop;
  sup(house.aft + 0.25, Y_DECK, house.fore - 0.25, Y_DECK + 6);
  sup(house.aft + 1, Y_DECK + 6, house.fore - 1, tt);
  sup(house.fore - 9, tt, house.fore, tt + 3.8);
  sup(house.fore - 9.4, tt + 3.8, house.fore + 0.4, tt + 4.15, ink(1), 0.6);
  sup(house.aft + 3, tt + 4.15, house.fore - 5, tt + 9.1);
  if (ppm > 1.6) {
    g.fillStyle = ink(0.55);
    for (let d = 0; d < 11; d++) {
      const y = Y_DECK + 7.6 + d * 2.9;
      if (y + 1.2 > tt) break;
      for (let x = house.aft + 2.2; x < house.fore - 2; x += 2.6) g.fillRect(X(x), Y(y + 1.1), 1.2 * ppm, 1.0 * ppm);
    }
    g.fillStyle = 'rgba(40,60,75,0.8)';
    g.fillRect(X(house.fore - 8.6), Y(tt + 3.2), 8.3 * ppm, 1.9 * ppm);
  }
  // mast + radar
  g.strokeStyle = ink(0.7); g.lineWidth = Math.max(1, 0.8 * ppm);
  const mx = ship.mastTop.x;
  g.beginPath(); g.moveTo(X(mx), Y(tt + 9.1)); g.lineTo(X(mx), Y(ship.mastTop.y)); g.stroke();
  g.lineWidth = Math.max(1, 0.3 * ppm);
  g.beginPath(); g.moveTo(X(mx - 2.7), Y(tt + 14.5)); g.lineTo(X(mx + 2.7), Y(tt + 14.5)); g.moveTo(X(mx - 2), Y(tt + 17.6)); g.lineTo(X(mx + 2), Y(tt + 17.6)); g.stroke();
  // casing + funnel
  sup(casing.aft + 0.3, Y_DECK, casing.fore - 0.3, Y_DECK + 20);
  const fx = (casing.fore + casing.aft) / 2 - 0.5;
  g.beginPath();
  g.moveTo(X(fx - 5.4), Y(Y_DECK + 20)); g.lineTo(X(fx + 5.4), Y(Y_DECK + 20));
  g.lineTo(X(fx + 4.9), Y(Y_DECK + 33)); g.lineTo(X(fx - 4.9), Y(Y_DECK + 33)); g.closePath();
  g.globalAlpha = 0.85; g.fillStyle = livery.funnel; g.fill(); g.globalAlpha = 1;
  g.strokeStyle = ink(0.6); g.stroke();
  g.fillStyle = livery.funnelTop; g.fillRect(X(fx - 4.95), Y(Y_DECK + 33), 9.9 * ppm, 1.8 * ppm);
  g.fillStyle = ink(0.8);
  for (const px of [-2, 0.6]) g.fillRect(X(fx + px - 0.85), Y(Y_DECK + 36.3), 1.7 * ppm, 3.3 * ppm);
  // freefall lifeboat
  g.save(); g.translate(X(casing.aft - 3.2), Y(Y_DECK + 7.5)); g.rotate(0.55);
  g.fillStyle = '#ff6a13'; g.beginPath(); g.ellipse(0, 0, 5 * ppm, 1.5 * ppm, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink(0.6); g.lineWidth = 0.8; g.stroke(); g.restore();
  // breakwater, foremast, stern post
  const bwx = firstBay.fore + 3;
  sup(bwx - 0.3, Y_DECK, bwx + 0.3, Y_DECK + 7);
  g.strokeStyle = ink(0.7); g.lineWidth = Math.max(1, 0.6 * ppm);
  g.beginPath(); g.moveTo(X(ship.foremastTop.x), Y(Y_DECK)); g.lineTo(X(ship.foremastTop.x), Y(ship.foremastTop.y)); g.stroke();
  g.beginPath(); g.moveTo(X(-L / 2 + 1.5), Y(Y_DECK)); g.lineTo(X(-L / 2 + 1.5), Y(Y_DECK + 5)); g.stroke();
  // bow bulwark rising to the stem
  g.beginPath(); g.moveTo(X(L / 2 - 52), Y(Y_DECK)); g.quadraticCurveTo(X(L / 2 - 30), Y(Y_DECK + 2.6), X(stemX(SHIP.D) + 0.3), Y(Y_DECK + 2.6)); g.stroke();

  // --- labels: bay numbers + tiers
  if (ppm > 1.4) {
    g.textAlign = 'center';
    for (const b of cargo.bays) {
      g.fillStyle = ink(0.75); g.font = `700 ${Math.min(12, Math.max(8, 2.6 * ppm))}px Inter, sans-serif`;
      g.fillText(fmt(b.bay), X(b.x), Y(-T - 4.2));
      if (ppm > 3) {
        g.fillStyle = ink(0.42); g.font = `600 ${Math.min(10, 2 * ppm)}px Inter, sans-serif`;
        g.fillText(fmt(b.foreBay20), X(b.x + HALF_OFFSET), Y(-T - 7.4));
        g.fillText(fmt(b.aftBay20), X(b.x - HALF_OFFSET), Y(-T - 7.4));
      }
      g.strokeStyle = ink(0.25); g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(b.aft + 0.3), Y(-T - 1.8)); g.lineTo(X(b.fore - 0.3), Y(-T - 1.8)); g.stroke();
    }
    g.textAlign = 'right'; g.font = `600 ${Math.min(10, 2 * ppm)}px Inter, sans-serif`; g.fillStyle = ink(0.45);
    const tx = X(-L / 2 - 5);
    const every = ppm > 3.2 ? 1 : 2;
    for (let i = 0; i < 10; i += every) g.fillText(String(82 + i * 2), tx, Y(Y_CARGO + i * 2.9 + 1.45) + 3);
    for (let i = 0; i < SHIP.holdTiers; i += every) g.fillText(fmt(2 + i * 2), tx, Y(Y_HOLD + i * 2.9 + 1.45) + 3);
    g.save(); g.translate(tx - 20, Y(Y_CARGO + 14)); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('DECK TIERS', 0, 0); g.restore();
    g.save(); g.translate(tx - 20, Y(Y_HOLD + 12)); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('HOLD TIERS', 0, 0); g.restore();
  }

  // --- stack weight tags for the current row (deck)
  if (ppm > 3 && o.stackTags) {
    g.font = `700 ${Math.min(10.5, 2.1 * ppm)}px Inter, sans-serif`; g.textAlign = 'center';
    for (const s of o.stackTags) {
      if (s.w <= 0) continue;
      const ratio = s.w / HYDRO.deckStackLimit;
      const x = X(s.x), y = Y(s.top) - 8;
      const label = `${s.w.toFixed(0)} t`;
      const tw = g.measureText(label).width + 10;
      g.fillStyle = ratio > 1 ? 'rgba(214,60,50,0.92)' : ratio > 0.85 ? 'rgba(220,150,40,0.92)' : 'rgba(255,253,247,0.9)';
      roundRect(g, x - tw / 2, y - 10, tw, 14, 7); g.fill();
      g.strokeStyle = ink(0.15); g.stroke();
      g.fillStyle = ratio > 0.85 ? '#fff' : ink(0.8);
      g.fillText(label, x, y + 1);
    }
  }
}

export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Midship cross-section row picker (viewed from aft: starboard on the right).
export function drawRowPicker(g, w, h, rows, counts, selected, hover) {
  g.clearRect(0, 0, w, h);
  const B = SHIP.B, D = SHIP.D;
  const scale = Math.min((w - 20) / (B * 1.05), (h - 28) / (D + 30));
  const cx = w / 2, deckY = 14 + 28 * scale;
  const Yz = (z) => deckY + (D - z) * scale;
  g.beginPath();
  for (let i = 0; i <= 18; i++) { const z = (i / 18) * D; g.lineTo(cx + halfBreadth(0, z) * scale, Yz(z)); }
  for (let i = 18; i >= 0; i--) { const z = (i / 18) * D; g.lineTo(cx - halfBreadth(0, z) * scale, Yz(z)); }
  g.closePath();
  g.fillStyle = ink(0.05); g.fill(); g.strokeStyle = ink(0.45); g.lineWidth = 1; g.stroke();
  const maxDeck = Math.max(1, ...rows.map((r) => counts.get(r.row)?.deck || 0));
  const maxHold = Math.max(1, ...rows.map((r) => counts.get(r.row)?.hold || 0));
  const cw = SHIP.rowPitch * scale;
  const hits = [];
  for (const r of rows) {
    const x = cx + r.z * scale;
    const c = counts.get(r.row) || { deck: 0, hold: 0 };
    const hd = (c.deck / maxDeck) * 26 * scale, hh = (c.hold / maxHold) * (D - HYDRO.tankTop - 1) * scale;
    const sel = r.row === selected, hov = r.row === hover;
    g.fillStyle = sel ? 'rgba(29,127,224,0.9)' : hov ? ink(0.45) : ink(0.2);
    g.fillRect(x - cw * 0.42, deckY - 2 - hd, cw * 0.84, hd);
    g.fillStyle = sel ? 'rgba(29,127,224,0.45)' : hov ? ink(0.25) : ink(0.1);
    g.fillRect(x - cw * 0.42, deckY + 2, cw * 0.84, hh);
    if (sel) { g.strokeStyle = 'rgba(29,127,224,1)'; g.lineWidth = 1.5; g.strokeRect(x - cw * 0.5, 6, cw, h - 22); }
    hits.push({ row: r.row, x0: x - cw / 2, x1: x + cw / 2 });
  }
  g.fillStyle = ink(0.5); g.font = '700 9px Inter, sans-serif';
  g.textAlign = 'left'; g.fillText('PORT', 6, h - 4);
  g.textAlign = 'right'; g.fillText('STBD', w - 6, h - 4);
  g.textAlign = 'center'; g.fillStyle = ink(0.35); g.fillText('looking forward', w / 2, h - 4);
  return hits;
}
