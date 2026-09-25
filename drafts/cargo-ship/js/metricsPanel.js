// Bottom "Load metrics" drawer: KPI strip + charts, all drawn on DPR-aware canvases.
import { SHIP, CATEGORIES, HYDRO } from './config.js';
import { halfBreadth, hullOutline } from './ship.js';
import { fmt } from './cargo.js';

const { L, B, D, T } = SHIP;
const INK = 'rgba(236,243,248,0.92)', MUTED = 'rgba(230,238,245,0.55)', FAINT = 'rgba(230,238,245,0.14)';
const OK = '#5fe39a', WARN = '#ffc35a', CRIT = '#ff6b6b', ACCENT = '#7cc4ff';
const levelColor = (l) => (l === 'crit' ? CRIT : l === 'warn' ? WARN : OK);
const nf = (v, d = 0) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

function canvasCtx(c) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return { g, w: r.width, h: r.height };
}

export class MetricsPanel {
  constructor(root, { onToggle } = {}) {
    this.root = root;
    this.onToggle = onToggle;
    this.m = null;
    this.curves = { bm: true, sf: true };
    this.$ = (s) => root.querySelector(s);
    this.$('#metrics-tab').onclick = () => this.toggle();
    root.querySelectorAll('[data-curve]').forEach((b) => {
      b.onclick = () => { this.curves[b.dataset.curve] = !this.curves[b.dataset.curve]; b.classList.toggle('active'); this.drawLong(); };
    });
    this.ro = new ResizeObserver(() => this.draw());
    root.querySelectorAll('canvas').forEach((c) => this.ro.observe(c));
    this.hoverX = null;
    const cl = this.$('#c-long');
    cl.addEventListener('pointermove', (e) => { const r = cl.getBoundingClientRect(); this.hoverX = (e.clientX - r.left) / r.width; this.drawLong(); });
    cl.addEventListener('pointerleave', () => { this.hoverX = null; this.drawLong(); });
  }

  get open() { return this.root.classList.contains('open'); }
  toggle(force) {
    this.root.classList.toggle('open', force ?? !this.open);
    this.onToggle?.(this.open);
    if (this.open) requestAnimationFrame(() => this.draw());
  }

  update(m) { this.m = m; this.renderKPIs(); this.renderAlerts(); this.draw(); }

  draw() {
    if (!this.m || !this.open) return;
    this.drawLong(); this.drawTrans(); this.drawStab(); this.drawMix();
  }

  /* ---------------------------------------------------------------- KPI strip */
  renderKPIs() {
    const { hydro: h, weights: w, strength: s, visibility: v, reefer: r } = this.m;
    const heelSide = Math.abs(h.heel) < 0.05 ? 'upright' : h.heel > 0 ? 'stbd' : 'port';
    const trimTxt = Math.abs(h.trim) < 0.02 ? 'even keel' : `by ${h.trim < 0 ? 'stern' : 'head'}`;
    const k = [
      { label: 'Displacement', value: nf(w.displacement), unit: 't', sub: `DWT ${nf(w.dwt)} / ${nf(w.dwtMax)} t`, bar: w.dwt / w.dwtMax, level: h.Tm > h.summerDraft ? 'crit' : w.dwt / w.dwtMax > 0.95 ? 'warn' : 'ok' },
      { label: 'Draught', value: h.Tm.toFixed(2), unit: 'm', sub: `F ${h.Tf.toFixed(2)} · A ${h.Ta.toFixed(2)}`, bar: h.Tm / h.summerDraft, level: h.Tm > h.summerDraft ? 'crit' : 'ok' },
      { label: 'Trim', value: Math.abs(h.trim).toFixed(2), unit: 'm', sub: trimTxt, glyph: 'trim', angle: -h.trimDeg * 12, level: h.trim > 0.3 ? 'warn' : 'ok' },
      { label: 'List', value: Math.abs(h.heel).toFixed(2), unit: '°', sub: heelSide, glyph: 'heel', angle: h.heel * 8, level: Math.abs(h.heel) > 3 ? 'crit' : Math.abs(h.heel) > 0.8 ? 'warn' : 'ok' },
      { label: 'GM (fluid)', value: h.GM.toFixed(2), unit: 'm', sub: `KG ${h.KG.toFixed(1)} · KM ${h.KM.toFixed(1)}`, bar: Math.min(1, h.GM / 6), level: h.GM < 0.15 ? 'crit' : h.GM < 0.8 ? 'warn' : 'ok' },
      { label: 'Roll period', value: Number.isFinite(h.rollPeriod) ? h.rollPeriod.toFixed(1) : '—', unit: 's', sub: 'IMO estimate', level: 'ok' },
      { label: 'Bending mom.', value: s.bmPct.toFixed(0), unit: '%', sub: `${s.maxBM >= 0 ? 'hog' : 'sag'} · SF ${s.sfPct.toFixed(0)}%`, bar: s.bmPct / 100, level: s.bmPct > 100 ? 'crit' : s.bmPct > 88 ? 'warn' : 'ok' },
      { label: 'Blind sector', value: Number.isFinite(v.blind) ? nf(v.blind) : '∞', unit: 'm', sub: `limit ${v.limit} m`, bar: Math.min(1, v.blind / v.limit), level: v.blind > v.limit ? 'crit' : v.blind > v.limit * 0.85 ? 'warn' : 'ok' },
      { label: 'Reefers', value: nf(r.used), unit: `/${nf(r.plugs)}`, sub: `${(r.kW / 1000).toFixed(2)} MW load`, bar: r.used / r.plugs, level: r.used > r.plugs ? 'crit' : 'ok' },
    ];
    this.$('#kpis').innerHTML = k.map((q) => `
      <div class="kpi">
        <label><i style="background:${levelColor(q.level)}"></i>${q.label}</label>
        <div class="kv">${q.glyph ? `<svg class="glyph" viewBox="0 0 40 20"><line x1="4" y1="10" x2="36" y2="10" stroke="${FAINT}" stroke-width="1"/><g transform="rotate(${Math.max(-30, Math.min(30, q.angle)).toFixed(2)} 20 10)">${q.glyph === 'trim'
          ? '<path d="M5 9 L31 9 L35 6 L35 12 L31 13 L7 13 Z" fill="currentColor"/>'
          : '<path d="M10 6 L30 6 L28 14 L12 14 Z" fill="currentColor"/><line x1="20" y1="2" x2="20" y2="17" stroke="currentColor" stroke-width="1"/>'}</g></svg>` : ''}<span>${q.value}</span><small>${q.unit}</small></div>
        <div class="ksub">${q.sub}</div>
        ${q.bar != null ? `<div class="kbar"><b style="width:${Math.min(100, Math.max(0, q.bar * 100)).toFixed(1)}%;background:${levelColor(q.level)}"></b></div>` : ''}
      </div>`).join('');
  }

  renderAlerts() {
    const { alerts, stacks, counts, weights } = this.m;
    this.$('#alerts').innerHTML = alerts.map((a) => `<li><i style="background:${levelColor(a.level)}"></i>${a.text}</li>`).join('')
      + `<li class="mut"><i></i>Heaviest deck stack ${stacks.worst.slot ?? '—'}: ${nf(stacks.worst.w || 0, 1)} t / ${HYDRO.deckStackLimit} t</li>`
      + `<li class="mut"><i></i>${nf(counts.hold)} boxes in holds · ${nf(counts.deck)} on deck · ${weights.perTEU.toFixed(1)} t/TEU</li>`;
  }

  /* ---------------------------------------------------------------- longitudinal */
  drawLong() {
    if (!this.m || !this.open) return;
    const { g, w, h } = canvasCtx(this.$('#c-long'));
    const m = this.m, s = m.strength;
    const pad = { l: 8, r: 8, t: 10, b: 34 };
    const X = (x) => pad.l + ((x + L / 2) / L) * (w - pad.l - pad.r);
    const baseY = h - pad.b;
    const chartH = baseY - pad.t;

    // grid
    g.strokeStyle = FAINT; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const y = pad.t + (chartH * i) / 4; g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); }

    // bay weight bars (hold + deck)
    const maxW = Math.max(1, ...m.bays.map((b) => b.deckW + b.holdW));
    for (const b of m.bays) {
      const x0 = X(b.aft + 0.7), x1 = X(b.fore - 0.7);
      const hh = (b.holdW / maxW) * chartH * 0.9, hd = (b.deckW / maxW) * chartH * 0.9;
      const gr = g.createLinearGradient(0, baseY - hh - hd, 0, baseY);
      gr.addColorStop(0, 'rgba(124,196,255,0.55)'); gr.addColorStop(1, 'rgba(124,196,255,0.22)');
      g.fillStyle = 'rgba(124,196,255,0.16)'; g.fillRect(x0, baseY - hh, x1 - x0, hh);
      g.fillStyle = gr; g.fillRect(x0, baseY - hh - hd, x1 - x0, hd);
      g.fillStyle = b.overweight ? WARN : 'rgba(124,196,255,0.9)';
      g.fillRect(x0, baseY - hh - hd, x1 - x0, 1.5);
    }

    // curves
    const midY = pad.t + chartH * 0.5;
    const curve = (arr, allow, color, dash) => {
      const k = (chartH * 0.46) / (allow * 1.15);
      g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,107,107,0.45)'; g.lineWidth = 1;
      for (const sgn of [1, -1]) { const y = midY - sgn * allow * k; g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); }
      g.setLineDash(dash); g.strokeStyle = color; g.lineWidth = 2;
      g.beginPath();
      arr.forEach((v, i) => { const x = X(s.xs[i]), y = midY - v * k; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke(); g.setLineDash([]);
      return k;
    };
    g.strokeStyle = FAINT; g.beginPath(); g.moveTo(pad.l, midY); g.lineTo(w - pad.r, midY); g.stroke();
    if (this.curves.sf) curve(s.sf, s.allowSF, 'rgba(255,195,90,0.85)', [5, 3]);
    let kBM = 0;
    if (this.curves.bm) {
      kBM = curve(s.bm, s.allowBM, '#ffffff', []);
      const x = X(s.maxBMx), y = midY - s.maxBM * kBM;
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
      g.font = '600 10.5px Inter, sans-serif'; g.fillStyle = INK; g.textAlign = x > w * 0.8 ? 'right' : 'left';
      g.fillText(`${s.maxBM >= 0 ? 'Hog' : 'Sag'} ${(Math.abs(s.maxBM) / 1e6).toFixed(2)} Mt·m · ${s.bmPct.toFixed(0)}%`, x + (x > w * 0.8 ? -8 : 8), y - 6);
    }

    // hull silhouette + waterline under the chart
    const sil = hullOutline();
    const sy = (y) => baseY + 6 + ((D - T - y) / D) * (pad.b - 12);
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
    g.beginPath(); sil.forEach(([x, y], i) => (i ? g.lineTo(X(x), sy(y)) : g.moveTo(X(x), sy(y)))); g.closePath(); g.fill(); g.stroke();
    const dA = m.hydro.Ta, dF = m.hydro.Tf;
    g.strokeStyle = ACCENT; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(X(-L / 2), sy(dA - T)); g.lineTo(X(L / 2), sy(dF - T)); g.stroke();
    g.font = '600 9px Inter, sans-serif'; g.fillStyle = MUTED; g.textAlign = 'center';
    for (const b of m.bays) if (b.bay % 8 === 2 || m.bays.length < 14) g.fillText(fmt(b.bay), X(b.x), h - 2);

    // hover readout
    if (this.hoverX != null) {
      const xm = -L / 2 + this.hoverX * L;
      const px = X(xm);
      g.strokeStyle = 'rgba(255,255,255,0.4)'; g.beginPath(); g.moveTo(px, pad.t); g.lineTo(px, baseY); g.stroke();
      const i = Math.max(0, Math.min(s.xs.length - 1, Math.round(((xm + L / 2) / L) * (s.xs.length - 1))));
      const bay = m.bays.find((b) => xm <= b.fore && xm >= b.aft);
      const lines = [
        bay ? `Bay ${fmt(bay.bay)} · hold ${nf(bay.holdW)} t · deck ${nf(bay.deckW)} t` : `x ${xm.toFixed(0)} m`,
        `BM ${(s.bm[i] / 1e6).toFixed(2)} Mt·m · SF ${nf(s.sf[i])} t`,
      ];
      g.font = '600 10.5px Inter, sans-serif';
      const tw = Math.max(...lines.map((l) => g.measureText(l).width)) + 14;
      const bx = Math.min(w - tw - 4, Math.max(4, px + 8));
      g.fillStyle = 'rgba(8,12,18,0.78)'; g.fillRect(bx, pad.t + 2, tw, 34);
      g.fillStyle = INK; g.textAlign = 'left';
      lines.forEach((l, j) => g.fillText(l, bx + 7, pad.t + 16 + j * 13));
    }
  }

  /* ---------------------------------------------------------------- transverse */
  drawTrans() {
    const { g, w, h } = canvasCtx(this.$('#c-trans'));
    const m = this.m;
    const heel = m.hydro.heel;
    const scale = Math.min((w - 20) / (B * 1.25), (h - 34) / (D * 1.9));
    const cx = w / 2, wlY = h * 0.62;
    // water line reference (static)
    g.strokeStyle = 'rgba(124,196,255,0.5)'; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(8, wlY); g.lineTo(w - 8, wlY); g.stroke(); g.setLineDash([]);
    g.save();
    g.translate(cx, wlY);
    g.rotate((Math.max(-12, Math.min(12, heel * 3)) * Math.PI) / 180); // exaggerated ×3
    const Y = (yl) => -(yl + T - m.hydro.Tm) * scale; // ship-local y -> px (0 = actual WL)
    // midship section
    g.beginPath();
    for (let i = 0; i <= 20; i++) { const z = (i / 20) * D; g.lineTo(halfBreadth(0, z) * scale, Y(z - T)); }
    for (let i = 20; i >= 0; i--) { const z = (i / 20) * D; g.lineTo(-halfBreadth(0, z) * scale, Y(z - T)); }
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.45)'; g.stroke();
    // row weight bars: hold part inside the hull, deck part above
    const maxRow = Math.max(1, ...m.rows.map((r) => r.w));
    const deckY = Y(D - T);
    for (const r of m.rows) {
      const x = r.z * scale, bw = SHIP.rowPitch * scale * 0.82;
      const hold = r.w - r.deckW;
      const hh = (hold / maxRow) * D * 1.6 * scale * 0.5, hd = (r.deckW / maxRow) * D * 1.6 * scale * 0.5;
      g.fillStyle = r.z > 0 ? 'rgba(99,227,154,0.35)' : 'rgba(255,107,107,0.32)';
      g.fillRect(x - bw / 2, deckY, bw, hh);
      g.fillStyle = r.z > 0 ? 'rgba(99,227,154,0.8)' : 'rgba(255,120,120,0.8)';
      g.fillRect(x - bw / 2, deckY - hd, bw, hd);
    }
    // centre of gravity marker
    const gy = Y(m.hydro.KG - T), gx = m.hydro.TCG * scale * 20;
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(0, Y(-T) + 4); g.lineTo(0, deckY - D * 0.9 * scale); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(gx, gy, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = ACCENT; g.beginPath(); g.arc(0, Y(m.hydro.KM - T), 3, 0, Math.PI * 2); g.fill();
    g.restore();
    const port = m.rows.filter((r) => r.z < 0).reduce((a, r) => a + r.w, 0), stbd = m.rows.filter((r) => r.z > 0).reduce((a, r) => a + r.w, 0);
    g.font = '600 10px Inter, sans-serif'; g.textAlign = 'left'; g.fillStyle = '#ff8a8a';
    g.fillText(`P ${nf(port)} t`, 8, h - 6);
    g.textAlign = 'right'; g.fillStyle = '#7ef0b0';
    g.fillText(`S ${nf(stbd)} t`, w - 8, h - 6);
    g.textAlign = 'center'; g.fillStyle = MUTED;
    g.fillText(`TCG ${(m.hydro.TCG * 100).toFixed(0)} cm · G ● M`, w / 2, h - 6);
  }

  /* ---------------------------------------------------------------- stability gauge */
  drawStab() {
    const { g, w, h } = canvasCtx(this.$('#c-stab'));
    const m = this.m, GM = m.hydro.GM;
    const cx = w / 2, cy = h * 0.66, R = Math.min(w * 0.42, h * 0.58);
    const max = 8;
    const ang = (v) => Math.PI + (Math.max(0, Math.min(max, v)) / max) * Math.PI;
    const zones = [[0, 0.15, CRIT], [0.15, 0.8, WARN], [0.8, 5, OK], [5, max, ACCENT]];
    g.lineWidth = 9; g.lineCap = 'butt';
    for (const [a, b, c] of zones) { g.strokeStyle = c; g.globalAlpha = 0.75; g.beginPath(); g.arc(cx, cy, R, ang(a) + 0.01, ang(b) - 0.01); g.stroke(); }
    g.globalAlpha = 1;
    g.lineWidth = 1; g.strokeStyle = FAINT;
    g.font = '600 9px Inter, sans-serif'; g.fillStyle = MUTED; g.textAlign = 'center';
    for (let v = 0; v <= max; v += 2) {
      const a = ang(v);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - 8), cy + Math.sin(a) * (R - 8)); g.lineTo(cx + Math.cos(a) * (R - 14), cy + Math.sin(a) * (R - 14)); g.stroke();
      g.fillText(String(v), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24) + 3);
    }
    const a = ang(GM);
    g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6)); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.fill();
    g.font = '700 20px Inter, sans-serif'; g.fillStyle = INK;
    g.fillText(`${GM.toFixed(2)} m`, cx, cy + 26);
    g.font = '600 9.5px Inter, sans-serif'; g.fillStyle = MUTED;
    g.fillText(`GM · roll ${Number.isFinite(m.hydro.rollPeriod) ? m.hydro.rollPeriod.toFixed(1) : '—'} s · freeboard ${m.hydro.freeboard.toFixed(1)} m`, cx, cy + 41);
  }

  /* ---------------------------------------------------------------- mix */
  drawMix() {
    const { g, w, h } = canvasCtx(this.$('#c-mix'));
    const m = this.m;
    const R = Math.min(h * 0.4, w * 0.22), cx = R + 10, cy = h * 0.46;
    const tot = m.pods.reduce((s, p) => s + p.teu, 0) || 1;
    let a0 = -Math.PI / 2;
    for (const p of m.pods) {
      const a1 = a0 + (p.teu / tot) * Math.PI * 2;
      g.strokeStyle = p.color; g.lineWidth = R * 0.34;
      g.beginPath(); g.arc(cx, cy, R * 0.8, a0 + 0.015, a1 - 0.015); g.stroke();
      a0 = a1;
    }
    g.textAlign = 'center'; g.fillStyle = INK; g.font = `700 ${Math.round(R * 0.36)}px Inter, sans-serif`;
    g.fillText(nf(m.counts.teu), cx, cy + R * 0.1);
    g.font = '600 9px Inter, sans-serif'; g.fillStyle = MUTED; g.fillText('TEU', cx, cy + R * 0.36);
    // ports legend
    g.textAlign = 'left'; g.font = '600 10px Inter, sans-serif';
    const lx = cx + R + 14;
    m.pods.forEach((p, i) => {
      const y = 14 + i * 15;
      g.fillStyle = p.color; g.fillRect(lx, y - 8, 8, 8);
      g.fillStyle = INK; g.fillText(p.name, lx + 13, y);
      g.fillStyle = MUTED; g.textAlign = 'right'; g.fillText(`${Math.round((p.teu / tot) * 100)}%`, w - 8, y); g.textAlign = 'left';
    });
    // category bar
    const by = h - 30, bw = w - 16;
    let x = 8;
    const ctot = Object.values(m.cats).reduce((s, c) => s + c.n, 0) || 1;
    for (const [k, c] of Object.entries(m.cats)) {
      const ww = (c.n / ctot) * bw;
      g.fillStyle = CATEGORIES[k].color; g.fillRect(x, by, Math.max(0, ww - 1.5), 6);
      x += ww;
    }
    g.font = '600 9.5px Inter, sans-serif'; g.fillStyle = MUTED;
    const lbl = Object.entries(m.cats).map(([k, c]) => `${CATEGORIES[k].label} ${nf(c.n)}`).join(' · ');
    g.fillText(lbl, 8, h - 10);
    g.textAlign = 'right';
    g.fillText(`20' ${nf(m.counts.t20)} · 40' ${nf(m.counts.t40)} · HC ${nf(m.counts.t40hc)}`, w - 8, by - 6);
  }
}
