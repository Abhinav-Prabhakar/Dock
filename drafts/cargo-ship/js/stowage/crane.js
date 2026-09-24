// Black ship-to-shore crane, seen end-on at the boom tip: box-girder boom, trolley with operator cab,
// four wire ropes, headblock and a telescopic spreader carrying the box. The trolley running out along the
// boom to the quay (and back) is expressed as depth: it recedes, shrinks and hazes into the paper.
import { CRANE } from './plan.js';
import { drawBox } from './profile.js';

const STEEL = '#131518', STEEL_HI = '#3a4047', STEEL_MID = '#22262b';
const YELLOW = '#f2b705';

function steelRect(g, x, y, w, h, vertical = true) {
  const gr = vertical ? g.createLinearGradient(x, 0, x + w, 0) : g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, STEEL_HI); gr.addColorStop(0.18, STEEL_MID); gr.addColorStop(0.6, STEEL); gr.addColorStop(1, '#0a0b0d');
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

function bolts(g, x0, x1, y, step, r) {
  g.fillStyle = 'rgba(255,255,255,0.18)';
  for (let x = x0; x <= x1; x += step) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
}

function lamp(g, x, y, r, color, glow) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r * 6);
  gr.addColorStop(0, color); gr.addColorStop(0.2, color.replace(/[\d.]+\)$/, `${0.35 * glow})`)); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 6, 0, Math.PI * 2); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}

// state: from plan.stateAt; carry: { color, len, h, hatchColor } or null; appear: 0..1 slide-in
export function drawCrane(g, v, state, { carry = null, appear = 1, time = 0, hatchColor = '#4d5654' } = {}) {
  const c = state.crane;
  const p = v.ppm;
  const lift = (1 - appear) * 60;
  const cx = v.X(c.x);
  const Yw = (y) => v.Y(y + lift);
  const railY = Yw(CRANE.y);

  g.save();
  // ------------------------------------------------ boom tip (fixed to the gantry, always at depth 0)
  const bw = 14.8 * p, gw = 2.3 * p, gh = 6.6 * p;
  const top = Yw(CRANE.y + 2.4 + 6.6), bot = Yw(CRANE.y + 2.4);
  // receding boom body behind the tip face (atmospheric perspective)
  const rg = g.createLinearGradient(0, top - 40 * p, 0, top);
  rg.addColorStop(0, 'rgba(19,21,24,0)'); rg.addColorStop(1, 'rgba(19,21,24,0.35)');
  g.fillStyle = rg; g.fillRect(cx - bw / 2 + gw * 0.3, top - 40 * p, bw - gw * 0.6, 40 * p);
  // cross bracing between the two girders
  g.strokeStyle = STEEL_MID; g.lineWidth = Math.max(1.2, 0.35 * p);
  g.beginPath();
  g.moveTo(cx - bw / 2 + gw, top + 0.8 * p); g.lineTo(cx + bw / 2 - gw, bot - 0.6 * p);
  g.moveTo(cx + bw / 2 - gw, top + 0.8 * p); g.lineTo(cx - bw / 2 + gw, bot - 0.6 * p);
  g.stroke();
  steelRect(g, cx - bw / 2, top - 1.1 * p, bw, 1.3 * p, false);           // top chord / walkway
  steelRect(g, cx - bw / 2 + gw, bot - 0.7 * p, bw - 2 * gw, 0.7 * p, false); // bottom tie
  steelRect(g, cx - bw / 2, top, gw, gh);                                  // left girder
  steelRect(g, cx + bw / 2 - gw, top, gw, gh);                             // right girder
  // girder flanges, stiffeners, bolts
  g.fillStyle = 'rgba(255,255,255,0.07)';
  for (const gx of [cx - bw / 2, cx + bw / 2 - gw]) {
    for (let k = 1; k < 4; k++) g.fillRect(gx + 1, top + (gh * k) / 4, gw - 2, 1);
    bolts(g, gx + gw * 0.25, gx + gw * 0.8, top + 0.4 * p, Math.max(3, gw * 0.27), Math.max(0.6, 0.09 * p));
  }
  // walkway handrail
  g.strokeStyle = STEEL_MID; g.lineWidth = Math.max(1, 0.12 * p);
  g.beginPath(); g.moveTo(cx - bw / 2, top - 2.2 * p); g.lineTo(cx + bw / 2, top - 2.2 * p); g.stroke();
  for (let k = 0; k <= 6; k++) { const x = cx - bw / 2 + (bw * k) / 6; g.beginPath(); g.moveTo(x, top - 2.2 * p); g.lineTo(x, top - 1.1 * p); g.stroke(); }
  // trolley rails on the girder bottoms
  g.fillStyle = '#8c939a';
  g.fillRect(cx - bw / 2 + gw * 0.2, bot - 0.25 * p, gw * 0.6, 0.25 * p);
  g.fillRect(cx + bw / 2 - gw * 0.8, bot - 0.25 * p, gw * 0.6, 0.25 * p);
  // boom tip lights: aviation red + downward floods
  const blink = Math.sin(time * 3.2) > 0.2 ? 1 : 0.25;
  lamp(g, cx - bw / 2 + gw / 2, top - 2.6 * p, Math.max(1.4, 0.3 * p), `rgba(255,60,50,${0.95 * blink})`, blink);
  lamp(g, cx + bw / 2 - gw / 2, top - 2.6 * p, Math.max(1.4, 0.3 * p), `rgba(255,60,50,${0.95 * blink})`, blink);
  for (const s of [-1, 1]) {
    const lx = cx + s * (bw / 2 - gw / 2), ly = bot + 0.2 * p;
    g.fillStyle = '#2b2f34'; g.fillRect(lx - 0.6 * p, ly, 1.2 * p, 0.5 * p);
    const cone = g.createLinearGradient(0, ly, 0, ly + 26 * p);
    cone.addColorStop(0, 'rgba(255,245,215,0.22)'); cone.addColorStop(1, 'rgba(255,245,215,0)');
    g.fillStyle = cone;
    g.beginPath(); g.moveTo(lx - 0.5 * p, ly + 0.5 * p); g.lineTo(lx + 0.5 * p, ly + 0.5 * p); g.lineTo(lx + 5 * p, ly + 26 * p); g.lineTo(lx - 5 * p, ly + 26 * p); g.closePath(); g.fill();
  }

  // ------------------------------------------------ trolley + hoist (depth-scaled)
  const d = c.depth;
  const s = 1 - 0.38 * d;
  const haze = 0.62 * d;
  const ax = cx, ay = bot - 0.2 * p;         // scale anchor: trolley top at the rails
  const ga = 1 - haze;
  g.save();
  g.globalAlpha = ga;
  g.translate(ax, ay - d * 3 * p);
  g.scale(s, s);
  g.translate(-ax, -ay);

  // festoon power cable to the trolley
  g.strokeStyle = '#0d0e10'; g.lineWidth = Math.max(1, 0.18 * p);
  g.beginPath(); g.moveTo(cx - bw / 2 + gw, bot); g.quadraticCurveTo(cx - 6.5 * p, bot + 3.4 * p, cx - 4.8 * p, bot + 0.6 * p); g.stroke();

  const tw = 11.6 * p, th = 2.7 * p, ty = bot;
  // wheels
  g.fillStyle = '#0b0c0e';
  for (const wx of [-4.9, -3.3, 3.3, 4.9]) { g.beginPath(); g.arc(cx + wx * p, ty + 0.35 * p, 0.55 * p, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#6b7178';
  for (const wx of [-4.9, -3.3, 3.3, 4.9]) { g.beginPath(); g.arc(cx + wx * p, ty + 0.35 * p, 0.18 * p, 0, Math.PI * 2); g.fill(); }
  // frame + machinery housing
  steelRect(g, cx - tw / 2, ty + 0.6 * p, tw, th, false);
  g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(cx - tw / 2, ty + 0.6 * p, tw, 0.25 * p);
  g.fillStyle = YELLOW; g.globalAlpha = 0.85 * ga;
  for (let k = 0; k < 6; k++) g.fillRect(cx - tw / 2 + k * 0.9 * p + 0.2 * p, ty + 0.6 * p + th - 0.45 * p, 0.45 * p, 0.3 * p);
  for (let k = 0; k < 6; k++) g.fillRect(cx + tw / 2 - (k + 1) * 0.9 * p + 0.25 * p, ty + 0.6 * p + th - 0.45 * p, 0.45 * p, 0.3 * p);
  g.globalAlpha = ga;
  bolts(g, cx - tw / 2 + 0.5 * p, cx + tw / 2 - 0.5 * p, ty + 1.1 * p, Math.max(4, 0.9 * p), Math.max(0.5, 0.07 * p));
  // operator cab slung under the trolley
  const cbx = cx - tw / 2 - 0.2 * p, cby = ty + 0.6 * p + th, cbw = 3.4 * p, cbh = 3.3 * p;
  steelRect(g, cbx, cby, cbw, cbh * 0.28, false);
  g.fillStyle = STEEL; g.beginPath();
  g.moveTo(cbx, cby + cbh * 0.28); g.lineTo(cbx + cbw, cby + cbh * 0.28); g.lineTo(cbx + cbw, cby + cbh); g.lineTo(cbx + cbw * 0.28, cby + cbh); g.lineTo(cbx, cby + cbh * 0.72); g.closePath(); g.fill();
  const glass = g.createLinearGradient(cbx, cby, cbx + cbw, cby + cbh);
  glass.addColorStop(0, 'rgba(120,170,190,0.95)'); glass.addColorStop(0.45, 'rgba(40,70,88,0.95)'); glass.addColorStop(1, 'rgba(18,30,40,0.95)');
  g.fillStyle = glass; g.beginPath();
  g.moveTo(cbx + 0.25 * p, cby + cbh * 0.36); g.lineTo(cbx + cbw - 0.25 * p, cby + cbh * 0.36); g.lineTo(cbx + cbw - 0.25 * p, cby + cbh - 0.25 * p);
  g.lineTo(cbx + cbw * 0.3, cby + cbh - 0.25 * p); g.lineTo(cbx + 0.25 * p, cby + cbh * 0.7); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,214,150,0.35)'; g.fillRect(cbx + cbw * 0.45, cby + cbh * 0.5, cbw * 0.35, cbh * 0.3);
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = Math.max(0.6, 0.08 * p);
  g.beginPath(); g.moveTo(cbx + cbw * 0.25, cby + cbh * 0.4); g.lineTo(cbx + cbw * 0.55, cby + cbh * 0.9); g.stroke();
  g.strokeStyle = STEEL; g.lineWidth = Math.max(0.8, 0.14 * p);
  g.beginPath(); g.moveTo(cbx + cbw * 0.62, cby + cbh * 0.36); g.lineTo(cbx + cbw * 0.62, cby + cbh); g.stroke();

  // sheave blocks
  const sheaveY = ty + 0.6 * p + th + 0.25 * p;
  const sheaves = [-3.9, -2.6, 2.6, 3.9];
  for (const sx of sheaves) {
    g.fillStyle = '#0c0d0f'; g.beginPath(); g.arc(cx + sx * p, sheaveY, 0.62 * p, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#4b525a'; g.lineWidth = Math.max(0.6, 0.1 * p); g.beginPath(); g.arc(cx + sx * p, sheaveY, 0.42 * p, 0, Math.PI * 2); g.stroke();
  }

  // ----- headblock / spreader / load, swinging about the rope suspension point
  const ropeTop = sheaveY;
  const spY = v.Y(c.spreaderY + lift);        // spreader underside (px)
  const hbY = spY - 1.0 * p - 1.2 * p;        // headblock underside
  const ropeLen = Math.max(1, hbY - 1.4 * p - ropeTop);
  const sw = c.sway;
  const offX = Math.sin(sw) * (ropeLen + 2 * p);

  // ropes
  const hbTop = hbY - 1.4 * p;
  const ropeEnds = [-1.7, -1.1, 1.1, 1.7];
  g.lineCap = 'round';
  sheaves.forEach((sx, k) => {
    const x0 = cx + sx * p, x1 = cx + offX + ropeEnds[k] * p;
    g.strokeStyle = '#1b1d20'; g.lineWidth = Math.max(1.1, 0.16 * p);
    g.beginPath(); g.moveTo(x0, ropeTop); g.lineTo(x1, hbTop + 0.2 * p); g.stroke();
    g.strokeStyle = 'rgba(200,205,210,0.35)'; g.lineWidth = Math.max(0.4, 0.05 * p);
    g.beginPath(); g.moveTo(x0 + 0.4, ropeTop); g.lineTo(x1 + 0.4, hbTop + 0.2 * p); g.stroke();
  });

  g.save();
  g.translate(cx + offX, hbTop);
  g.rotate(-sw * 0.9);
  const lx = 0; // local frame: x = 0 centre, y = 0 headblock top, y grows downward
  // headblock
  const hbw = 4.6 * p, hbh = 1.4 * p;
  steelRect(g, lx - hbw / 2, 0, hbw, hbh, false);
  for (const sx of [-1.4, 1.4]) {
    g.fillStyle = '#0b0c0e'; g.beginPath(); g.arc(sx * p, 0.1 * p, 0.55 * p, Math.PI, 0); g.fill();
  }
  g.fillStyle = YELLOW; g.fillRect(-hbw / 2, hbh - 0.28 * p, 0.55 * p, 0.28 * p); g.fillRect(hbw / 2 - 0.55 * p, hbh - 0.28 * p, 0.55 * p, 0.28 * p);
  // hydraulic hose loop
  g.strokeStyle = '#0e0f11'; g.lineWidth = Math.max(0.8, 0.12 * p);
  g.beginPath(); g.moveTo(hbw / 2 - 0.4 * p, hbh * 0.6); g.bezierCurveTo(hbw / 2 + 1.6 * p, hbh + 0.3 * p, hbw / 2 + 1.2 * p, hbh + 1.4 * p, hbw / 2 - 0.2 * p, hbh + 1.2 * p); g.stroke();
  // spreader: main housing + telescopic arms + yellow end beams
  const sy0 = hbh + 1.2 * p, sh = 1.0 * p;
  const sl = c.len * p;
  steelRect(g, -sl / 2 + 0.2 * p, sy0 + 0.2 * p, sl - 0.4 * p, sh * 0.55, false);
  steelRect(g, -3.2 * p, sy0, 6.4 * p, sh, false);
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(-3.2 * p, sy0, 6.4 * p, 0.12 * p);
  for (const sgn of [-1, 1]) {
    const ex = sgn * sl / 2 - (sgn > 0 ? 0.45 * p : 0);
    g.fillStyle = YELLOW; g.fillRect(ex, sy0 - 0.1 * p, 0.45 * p, sh + 0.2 * p);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let k = 0; k < 3; k++) g.fillRect(ex, sy0 + k * 0.38 * p, 0.45 * p, 0.12 * p);
    // flipper (guide arm): up when hoisted, down near landing
    const down = state.phase === 'lower' ? Math.min(1, state.u * 2) : (state.phase === 'land' || state.phase === 'unlock') ? 1 : state.phase === 'hoist' ? 1 - Math.min(1, state.u * 2) : 0;
    g.save();
    g.translate(sgn * sl / 2, sy0 + sh);
    g.rotate(sgn * (Math.PI / 2) * (1 - down));
    g.fillStyle = YELLOW; g.fillRect(sgn > 0 ? 0 : -0.25 * p, 0, 0.25 * p, 1.0 * p);
    g.restore();
    // twistlock indicator LEDs
    lamp(g, sgn * (sl / 2 - 0.9 * p), sy0 + sh * 0.35, Math.max(0.9, 0.16 * p), c.locked > 0.5 ? 'rgba(80,230,120,1)' : 'rgba(255,170,40,1)', 0.6);
  }
  // carried box (or hatch pontoon) hangs under the spreader
  if (c.carrying && carry) {
    const hv = { ...v, X: (x) => x * p, Y: (y) => -y * p + sy0 + sh, ppm: p };
    if (c.hatch) {
      g.fillStyle = hatchColor; g.fillRect(-carry.len * p / 2, sy0 + sh, carry.len * p, carry.h * p);
      g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1; g.strokeRect(-carry.len * p / 2, sy0 + sh, carry.len * p, carry.h * p);
      g.strokeStyle = '#1b1d20'; g.lineWidth = Math.max(0.8, 0.1 * p);
      g.beginPath(); g.moveTo(-sl / 2 + 0.3 * p, sy0 + sh); g.lineTo(-carry.len * p / 2 + 0.6 * p, sy0 + sh); g.moveTo(sl / 2 - 0.3 * p, sy0 + sh); g.lineTo(carry.len * p / 2 - 0.6 * p, sy0 + sh); g.stroke();
    } else {
      drawBox(g, hv, 0, -carry.h, carry.len, carry.h, carry.color, { alpha: ga });
    }
  }
  g.restore();

  g.restore();
  g.restore();
}
