// Statistics — the port operator's ledger, drawn as an Admiralty chart on the same cream "paper" as the
// stowage screen. Every figure is a maritime picture: a regatta for cumulative profit, a Plimsoll mark for
// utilisation, a portolan chart for the rotation, canal locks for the booking funnel, a container yard for
// the outcome mix, a tide table for daily revenue and the fleet riding at its real draught.
import { Page, fit, clamp, lerp, ease, easeOut, nf, money, roundRect, spline, along, mulberry32, drawShip, grainURL } from './page.js';
import { loadStats, SEGMENTS } from './statsLive.js';

// The scenario selector offers exactly two live sources: a holdout replay
// (5 policies, pre-aggregated over 2 unseen scenarios x 3 seeds) and a shock
// replay (2 policies, a forced NLRTM closure). See statsLive.js.
const SOURCES = [
  { key: 'holdout', label: 'Holdout · 2 unseen scenarios × 3 seeds' },
  { key: 'shock', label: 'Shock replay · NLRTM closure' },
];

const ink = (a) => `rgba(43,36,25,${a})`;
const sea = (a) => `rgba(44,110,170,${a})`;
const PAPER = '#f3eee2';
const BLUE = '#1d7fe0', ORANGE = '#e27820', GREEN = '#3f9a5f', AMBER = '#d69a1c', RED = '#c8452f', BRASS = '#b08d3c';
const BOXES = ['#c43a7a', '#8e3226', '#1f3f6d', '#3f7fb7', '#c9cac6', '#2f6a42', '#d2672b', '#6aa6cc', '#a8442e', '#e7e4da'];
const SEG_COLORS = { flexible: '#8fb8d8', standard: BLUE, urgent: ORANGE };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const niceStep = (span, n) => { const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const pct = (v, d = 0) => (v == null ? 'n/a' : `${v >= 0 ? '+' : '−'}${nf(Math.abs(v), d)}%`);
const kfmt = (v) => (Math.abs(v) >= 1e6 ? `$${nf(v / 1e6, 2)}M` : `$${nf(v / 1e3, 0)}k`);
// Display nudges so the tight North-Sea cluster stays legible at chart scale.
const NUDGE = { NLRTM: [0, 55.5], BEANR: [-4, 47.5], DEHAM: [14, 58] };

// The horizon selector (7/30/90 days) only changes how much of the already-loaded
// 90-day series is shown — it never re-fetches. Everything that isn't a daily
// series (ports, loops, funnel, outcomes, lift, headline) is a live/aggregate
// figure and doesn't depend on the horizon.
function sliceModel(raw, days) {
  const policies = {};
  for (const [k, p] of Object.entries(raw.policies)) {
    const cum = p.cum.slice(0, days), cumRev = p.cumRev.slice(0, days);
    policies[k] = { ...p, cum, cumRev, daily: p.daily.slice(0, days), revenue: p.revenue.slice(0, days), profit: cum[cum.length - 1], revTotal: cumRev[cumRev.length - 1] };
  }
  return { ...raw, days, policies, tide: raw.tide.slice(0, days) };
}

export class StatsPage extends Page {
  constructor(root) {
    super(root);
    this.scenario = 'holdout';
    this.days = 90;
    this.segment = 'all';
    this.hover = {};
    this.raw = null;
    this.d = null;
    this.build();
    this.load();
  }

  /* ---------------------------------------------------------------- DOM */
  build() {
    const r = this.root;
    r.style.setProperty('--grain', `url(${grainURL(10)})`);
    r.innerHTML = `
      <div class="pg-wrap">
        <header class="pg-head">
          <div class="pg-title">
            <div class="brand"><span class="dot"></span>DOCK <em>Harbour statistics</em></div>
            <h1>Statistics <small data-k="scen">Holdout</small></h1>
            <div class="sub">Scenario replay · identical seeds across policies · every figure vs the static rate card</div>
            <div class="hint" data-k="metaLine"></div>
            <div class="stow-stats" data-k="head"></div>
          </div>
          <div class="lpanel pg-controls">
            <label class="field-label">Scenario</label>
            <div class="seg light" data-k="scenSeg">${SOURCES.map((s) => `<button data-v="${s.key}">${s.label}</button>`).join('')}</div>
            <label class="field-label">Horizon</label>
            <div class="seg light" data-k="rangeSeg"><button data-v="7">7 days</button><button data-v="30">30 days</button><button data-v="90">90 days</button></div>
          </div>
        </header>

        <div class="lpanel hint" data-k="status" style="display:none"></div>

        <section class="pg-grid" data-k="grid">
          <article class="lpanel sc span-12">
            <div class="sc-head"><span>The regatta · cumulative profit by policy</span><em data-k="raceNote">day 0</em>
              <button class="pill-btn" data-a="replay"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Replay</button></div>
            <canvas class="cv" data-c="regatta" style="height:300px"></canvas>
            <canvas class="cv log" data-c="log" style="height:46px"></canvas>
          </article>

          <div class="span-12 skpis" data-k="kpis"></div>

          <article class="lpanel sc span-7">
            <div class="sc-head"><span>Chart of the rotation · lanes, calls &amp; congestion</span><em>line weight = TEU moved</em></div>
            <canvas class="cv" data-c="map" style="height:380px"></canvas>
            <div class="legend light sc-foot" data-k="loopLegend"></div>
          </article>
          <article class="lpanel sc span-5">
            <div class="sc-head"><span>Compass of demand · TEU by destination</span><em>petal area ∝ TEU</em></div>
            <canvas class="cv" data-c="rose" style="height:380px"></canvas>
            <div class="legend light sc-foot"><span><i style="background:${ink(0.12)};outline:1px dashed ${ink(0.4)}"></i>Requested</span><span><i style="background:${BLUE}"></i>Booked</span></div>
          </article>

          <article class="lpanel sc span-7">
            <div class="sc-head"><span>The locks · request → quote → booking → delivery</span>
              <div class="seg light mini" data-k="segSeg"><button data-v="all">All</button>${SEGMENTS.map((s) => `<button data-v="${s.key}">${s.label}</button>`).join('')}</div></div>
            <canvas class="cv" data-c="locks" style="height:250px"></canvas>
          </article>
          <article class="lpanel sc span-5">
            <div class="sc-head"><span>The yard · outcome of every request</span><em>1 box ≈ <b data-k="perBox">0</b> requests</em></div>
            <canvas class="cv" data-c="yard" style="height:196px"></canvas>
            <div class="legend light sc-foot yard-legend" data-k="yardLegend"></div>
          </article>

          <article class="lpanel sc span-12">
            <div class="sc-head"><span>Tide table · daily revenue, Dock vs static</span><em>high &amp; low water per week · moon = week</em></div>
            <canvas class="cv" data-c="tide" style="height:210px"></canvas>
          </article>

          <article class="lpanel sc span-12">
            <div class="sc-head"><span>The fleet at sea · loaded to draught</span><em>stack colour = customer segment · bow wave = speed</em></div>
            <div class="fleet-grid" data-k="fleet"></div>
          </article>
        </section>
      </div>`;
    this.k = {}; this.c = {};
    r.querySelectorAll('[data-k]').forEach((el) => (this.k[el.dataset.k] = el));
    r.querySelectorAll('[data-c]').forEach((el) => (this.c[el.dataset.c] = el));
    const seg = (el, cur, fn) => {
      const sync = (v) => el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(v)));
      el.querySelectorAll('button').forEach((b) => (b.onclick = () => { sync(b.dataset.v); fn(b.dataset.v); }));
      sync(cur);
    };
    seg(this.k.scenSeg, this.scenario, (v) => { this.scenario = v; this.load(); });
    seg(this.k.rangeSeg, this.days, (v) => { this.days = +v; if (this.raw) this.setData(); });
    seg(this.k.segSeg, this.segment, (v) => { this.segment = v; this.locksT = this.time; });
    r.querySelector('[data-a="replay"]').onclick = () => { this.scrub = null; this.raceT = this.time; };

    // interactions
    const pos = (e, c) => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    const on = (name, move, leave) => {
      const c = this.c[name];
      c.addEventListener('pointermove', (e) => move(...pos(e, c), e));
      c.addEventListener('pointerleave', () => { leave?.(); this.tip(null); });
    };
    on('map', (x, y) => (this.hover.map = this.mapHits?.find((p) => Math.hypot(p.x - x, p.y - y) < 16)?.i ?? null), () => (this.hover.map = null));
    on('rose', (x, y, e) => {
      const h = this.roseHits; if (!h) return;
      const a = Math.atan2(y - h.cy, x - h.cx), rr = Math.hypot(x - h.cx, y - h.cy);
      const i = h.petals.findIndex((p) => Math.abs(Math.atan2(Math.sin(a - p.a), Math.cos(a - p.a))) < 0.3 && rr < p.r + 20);
      this.hover.rose = i >= 0 ? i : null;
      if (i >= 0) { const p = this.d.ports[i]; this.tip(e, `<b>${p.name}</b> <span class="mut">${p.code}</span><br>${nf(p.booked)} TEU booked of ${nf(p.requested)} requested<br><span class="mut">${nf(p.requested ? (p.booked / p.requested) * 100 : 0)}% captured</span>`); } else this.tip(null);
    });
    on('yard', (x, y, e) => {
      const hit = this.yardHits?.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      this.hover.yard = hit ? hit.o : null;
      if (hit) { const o = this.d.outcomes[hit.o]; this.tip(e, `<span class="sw" style="background:${o.color}"></span><b>${o.label}</b><br>${nf(o.n)} requests · ${nf(this.d.requests ? (o.n / this.d.requests) * 100 : 0, 1)}%<br><span class="mut">${o.key}</span>`); } else this.tip(null);
    }, () => (this.hover.yard = null));
    on('tide', (x, y, e) => {
      const t = this.tideGeom; if (!t) return;
      const d = Math.round(clamp((x - t.l) / (t.w), 0, 1) * (this.d.days - 1));
      this.hover.tide = x >= t.l ? d : null;
      if (this.hover.tide != null) { const q = this.d.tide[d]; this.tip(e, `<b>Day ${q.day}</b><br><span class="sw" style="background:${BLUE}"></span>Dock ${kfmt(q.ppo)}<br><span class="sw" style="background:${ink(0.5)}"></span>Static ${kfmt(q.stat)}`); }
    }, () => (this.hover.tide = null));
    const lg = this.c.log;
    let drag = false;
    const seek = (e) => { const [x] = pos(e, lg); const g = this.logGeom; if (g && this.d) this.scrub = clamp((x - g.l) / g.w) * this.d.days; };
    lg.addEventListener('pointerdown', (e) => { drag = true; lg.setPointerCapture(e.pointerId); seek(e); });
    lg.addEventListener('pointermove', (e) => drag && seek(e));
    lg.addEventListener('pointerup', () => (drag = false));
    this.k.yardLegend.addEventListener('pointerover', (e) => { const i = e.target.closest('[data-o]')?.dataset.o; this.hover.yard = i != null ? +i : null; });
    this.k.yardLegend.addEventListener('pointerleave', () => (this.hover.yard = null));
  }

  tip(e, html) {
    const t = document.getElementById('tooltip');
    if (!e || !html) { t.classList.remove('show', 'light'); return; }
    t.innerHTML = html; t.style.left = `${e.clientX}px`; t.style.top = `${e.clientY}px`;
    t.classList.add('show', 'light');
  }

  // Fetch from the live backend for the current scenario source. No mock, no
  // cached fallback — a failed call renders an explicit unavailable state.
  async load() {
    this.k.status.style.display = '';
    this.k.status.textContent = 'Loading statistics from the Dock backend…';
    this.k.grid.style.display = 'none';
    this.raw = null; this.d = null;
    try {
      const raw = await loadStats(this.scenario);
      this.raw = raw;
      this.k.status.style.display = 'none';
      this.k.grid.style.display = '';
      this.setData();
    } catch (e) {
      this.k.status.textContent = `Statistics unavailable — ${e.message}`;
      this.k.grid.style.display = 'none';
    }
  }

  setData() {
    if (!this.raw) return;
    const d = (this.d = sliceModel(this.raw, this.days));
    this.raceT = this.time; this.appearT = this.time; this.locksT = this.time; this.scrub = null;
    const lead = d.policies.ppo;
    this.k.scen.textContent = `${d.scenario.label} · ${d.days} d`;
    this.k.metaLine.textContent = `generated ${d.meta.generated_at} · episodes: ${d.meta.episodes} · ${nf(d.customerDecisions)} customer-originated of ${nf(d.requests)} decisions`;
    this.k.head.innerHTML = [
      ['Revenue', money(d.headline.revenue), ''], ['Profit', money(d.headline.profit), ''],
      ['TEU booked', nf(d.headline.teu), ''], ['Requests', nf(d.requests), ''],
      ['Lift vs static', pct(d.lift.profit), 'profit'],
    ].map(([l, v, s]) => `<div><label>${l}</label><span>${v}</span>${s ? `<small>${s}</small>` : ''}</div>`).join('');
    const st = d.policies.static;
    const heur = d.policies.heuristic;
    const kpis = [
      { id: 'rev', label: 'Cargo landed', value: money(lead.revTotal), unit: 'revenue', sub: `$${nf(lead.revPerTEU)}/TEU · ${pct(d.lift.rpt)} vs static` },
      { id: 'util', label: 'Loaded to the mark', value: nf(lead.util * 100), unit: '% util.', sub: `${d.lift.util >= 0 ? '+' : '−'}${nf(Math.abs(d.lift.util), 1)} pp vs static` },
      { id: 'co2', label: 'Funnel emissions', value: nf(lead.co2, 2), unit: 't CO₂/TEU', sub: `${pct(st.co2 ? ((lead.co2 - st.co2) / st.co2) * 100 : null)} vs static · slow steaming` },
      { id: 'win', label: 'Counter-offers won', value: nf(lead.counterWin * 100), unit: '%', sub: `${heur ? `heuristic ${nf(heur.counterWin * 100)}% · ` : ''}static never counters` },
      { id: 'empty', label: 'Empty miles', value: nf(lead.empty / 1e6, 1), unit: 'M TEU-nm', sub: `${pct(st.empty ? ((lead.empty - st.empty) / st.empty) * 100 : null)} repositioning waste` },
    ];
    this.kpis = kpis;
    this.k.kpis.innerHTML = kpis.map((q) => `
      <article class="lpanel skpi">
        <div class="skpi-txt"><label>${q.label}</label><div class="kv"><span>${q.value}</span><small>${q.unit}</small></div><div class="ksub">${q.sub}</div></div>
        <canvas class="cv" data-kpi="${q.id}"></canvas>
      </article>`).join('');
    this.kpiCanvases = [...this.k.kpis.querySelectorAll('[data-kpi]')];
    this.k.loopLegend.innerHTML = d.loops.map((l) => `<span><i style="background:${l.color}"></i>${l.vessel} ${l.name}</span>`).join('')
      + `<span><i style="background:${GREEN};border-radius:50%"></i>Berth free</span><span><i style="background:${RED};border-radius:50%"></i>Congested</span>`;
    this.k.perBox.textContent = nf(d.requests / 120);
    this.k.yardLegend.innerHTML = d.outcomes.map((o, i) => `<span data-o="${i}"><i style="background:${o.color}"></i>${o.label} <b>${nf(d.requests ? (o.n / d.requests) * 100 : 0)}%</b></span>`).join('');
    this.k.fleet.innerHTML = d.loops.map((l, i) => `
      <div class="fleet-card">
        <canvas class="cv" data-ship="${i}"></canvas>
        <div class="fleet-meta">
          <div class="fleet-name"><i style="background:${l.color}"></i><b>${l.name}</b><span>${l.vessel} · ${nf(l.teu)} TEU · ${l.age} y</span></div>
          <div class="fleet-stats">
            <div><label>Util.</label><span>${nf(l.util * 100)}<small>%</small></span></div>
            <div><label>Speed</label><span>${nf(l.speed, 1)}<small>kn</small></span></div>
            <div><label>Fuel</label><span>${nf(l.fuelDay)}<small>t/d</small></span></div>
            <div><label>CO₂</label><span>${nf(l.co2Day)}<small>t/d</small></span></div>
            <div><label>Rate</label><span>${l.ratePerTEU != null ? `$${nf(l.ratePerTEU)}` : '—'}<small>/TEU</small></span></div>
          </div>
          ${l.segShares ? '' : '<div class="ksub">no recent bookings — stack colour not split by segment</div>'}
        </div>
      </div>`).join('');
    this.shipCanvases = [...this.k.fleet.querySelectorAll('[data-ship]')];
    if (this.active) this.draw(0);
  }

  onShow() { this.root.scrollTop = 0; this.raceT = this.time; this.appearT = this.time; this.locksT = this.time; }
  onHide() { this.tip(null); }

  /* ---------------------------------------------------------------- frame */
  draw() {
    if (!this.d) return;
    this.appear = easeOut((this.time - this.appearT) / 1.3);
    this.raceDay = this.scrub ?? this.d.days * ease(clamp((this.time - this.raceT - 0.5) / 3.6));
    this.k.raceNote.textContent = `day ${Math.round(this.raceDay)} / ${this.d.days}`;
    this.drawRegatta(); this.drawLog();
    this.kpiCanvases.forEach((c) => this.drawKpi(c));
    this.drawMap(); this.drawRose(); this.drawLocks(); this.drawYard(); this.drawTide();
    this.shipCanvases.forEach((c) => this.drawFleetShip(c));
  }

  valAt(p, t) {
    if (t <= 0) return 0;
    const n = this.d.days, i = Math.floor(t), f = t - i;
    const a = i > 0 ? p.cum[Math.min(n - 1, i - 1)] : 0, b = p.cum[Math.min(n - 1, i)];
    return lerp(a, b, f);
  }

  /* ---------------------------------------------------------------- regatta */
  drawRegatta() {
    const { g, w, h } = fit(this.c.regatta);
    const d = this.d, P = d.order.map((k) => d.policies[k]);
    const pad = { l: 168, r: 118, t: 30, b: 6 };
    const all = P.flatMap((p) => p.cum.slice(0, d.days));
    const lo = Math.min(0, ...all) * 1.12, hi = Math.max(...all) * 1.06;
    const X = (v) => pad.l + ((v - lo) / (hi - lo)) * (w - pad.l - pad.r);
    const laneH = (h - pad.t - pad.b) / P.length;
    const t = this.time, day = this.raceDay;

    // course scale
    const step = niceStep(hi - lo, 7);
    g.font = '600 9.5px Inter, sans-serif'; g.textAlign = 'center';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const x = X(v);
      g.strokeStyle = ink(v === 0 ? 0 : 0.07); g.setLineDash([2, 5]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, pad.t - 4); g.lineTo(x, h - pad.b); g.stroke(); g.setLineDash([]);
      g.fillStyle = ink(0.45); g.fillText(money(v, Math.abs(step) < 1e6 ? 1 : 0), x, pad.t - 12);
      g.fillStyle = ink(0.3); g.fillRect(x - 0.5, pad.t - 7, 1, 4);
    }
    // lanes: water, ripples, lane ropes with floats
    P.forEach((p, i) => {
      const y0 = pad.t + i * laneH;
      g.fillStyle = sea(0.05 + (i % 2) * 0.025); g.fillRect(pad.l - 10, y0, w - pad.l - pad.r + 20, laneH);
      g.strokeStyle = sea(0.16); g.lineWidth = 1;
      for (let k = 0; k < 2; k++) {
        const yc = y0 + laneH * (0.4 + k * 0.32);
        g.beginPath();
        for (let x = pad.l - 10; x <= w - pad.r + 10; x += 6) g.lineTo(x, yc + Math.sin(x * 0.045 + t * (1.2 + k * 0.4) + i * 1.7) * 1.4);
        g.stroke();
      }
      if (i > 0) {
        g.strokeStyle = ink(0.18); g.setLineDash([1, 3]);
        g.beginPath(); g.moveTo(pad.l - 10, y0); g.lineTo(w - pad.r + 10, y0); g.stroke(); g.setLineDash([]);
        for (let x = pad.l; x < w - pad.r; x += 44) { g.fillStyle = (x / 44) % 2 < 1 ? 'rgba(200,70,60,0.55)' : '#fffaf0'; g.beginPath(); g.arc(x, y0, 2.2, 0, Math.PI * 2); g.fill(); g.strokeStyle = ink(0.25); g.stroke(); }
      }
    });
    // start line + finish (leader's final)
    const sx = X(0);
    g.fillStyle = ink(0.7); g.fillRect(sx - 1, pad.t, 2, h - pad.t - pad.b);
    const fin = X(Math.max(...P.map((p) => p.cum[d.days - 1])));
    for (let y = pad.t, k = 0; y < h - pad.b; y += 5, k++) for (let j = 0; j < 2; j++) { g.fillStyle = (k + j) % 2 ? ink(0.75) : '#fffaf0'; g.fillRect(fin + j * 5 - 5, y, 5, 5); }
    g.save(); g.translate(sx - 6, pad.t + 22); g.rotate(-Math.PI / 2); g.fillStyle = ink(0.55); g.font = '700 8.5px Inter, sans-serif'; g.textAlign = 'right'; g.fillText('START', 0, 0); g.restore();

    // storm over the course during the shock window
    const sh = d.scenario.shock;
    if (sh && day >= sh.lo && day <= sh.hi + 3) {
      const a = clamp(Math.min(day - sh.lo, sh.hi + 3 - day) / 3) * 0.9;
      const gr = g.createLinearGradient(0, pad.t, 0, h);
      gr.addColorStop(0, `rgba(60,64,72,${0.22 * a})`); gr.addColorStop(1, `rgba(60,64,72,${0.04 * a})`);
      g.fillStyle = gr; g.fillRect(pad.l - 10, pad.t, w - pad.l - pad.r + 20, h - pad.t - pad.b);
      g.strokeStyle = `rgba(70,90,110,${0.22 * a})`; g.lineWidth = 1;
      g.beginPath();
      for (let k = 0; k < 90; k++) { const x = pad.l + ((k * 97 + t * 260) % (w - pad.l - pad.r)); const y = pad.t + ((k * 53 + t * 420) % (h - pad.t - 20)); g.moveTo(x, y); g.lineTo(x - 4, y + 12); }
      g.stroke();
      g.fillStyle = `rgba(200,69,47,${a})`; g.font = '700 9.5px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(`STORM · ${sh.text.toUpperCase()}`, (pad.l + w - pad.r) / 2, pad.t + 12);
    }

    // boats
    const vals = P.map((p) => this.valAt(p, day));
    const rank = vals.map((v) => vals.filter((q) => q > v).length + 1);
    const len = Math.min(104, laneH * 2.2);
    const base = vals[d.order.indexOf('static')];
    P.forEach((p, i) => {
      const y0 = pad.t + i * laneH, keel = y0 + laneH * 0.7 + Math.sin(t * 1.8 + i) * 1.1;
      const v = vals[i], x = X(v);
      // wake: tapered wedge from the start line + foam
      const stern = x - len;
      if (Math.abs(stern - sx) > 2) {
        const gr = g.createLinearGradient(sx, 0, stern, 0);
        gr.addColorStop(0, rgba(p.color, 0)); gr.addColorStop(1, rgba(p.color, 0.32));
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(sx, keel - 1); g.lineTo(stern, keel - len * 0.05); g.lineTo(stern, keel + 2); g.lineTo(sx, keel); g.closePath(); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.8)';
        for (let k = 1; k < 9; k++) { const fx = stern - k * 9 - ((t * 30) % 9); if ((fx - sx) * (stern - sx) < 0) break; g.globalAlpha = (1 - k / 9) * 0.9; g.fillRect(fx, keel - 1 + Math.sin(k + t * 3), 5, 1.4); }
        g.globalAlpha = 1;
      }
      drawShip(g, stern, keel, len, { hull: p.hull, colors: BOXES, fill: 0.55 + p.util * 0.45, seed: 11 + i, bowWave: day > 0 && day < d.days ? 1 : 0.3 });
      // labels
      const cy = y0 + laneH / 2;
      g.fillStyle = p.key === 'ppo' ? BLUE : ink(0.12);
      g.beginPath(); g.arc(14, cy, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = p.key === 'ppo' ? '#fff' : ink(0.8); g.font = '700 10px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(String(rank[i]), 14, cy + 3.5);
      g.textAlign = 'left'; g.fillStyle = p.key === 'ppo' ? '#1566b5' : ink(0.85); g.font = '700 12px Inter, sans-serif';
      g.fillText(p.label, 30, cy - 1);
      g.fillStyle = ink(0.5); g.font = '600 9.5px Inter, sans-serif';
      g.fillText(`$${nf(p.revPerTEU)}/TEU · ${nf(p.util * 100)}% util`, 30, cy + 12);
      g.textAlign = 'right'; g.fillStyle = ink(0.9); g.font = '700 14px Inter, sans-serif';
      g.fillText(money(v, 2), w - 8, cy);
      if (p.key !== 'static') {
        const l = Math.abs(base) > 5e4 ? ((v - base) / Math.abs(base)) * 100 : null;
        g.fillStyle = l == null ? ink(0.4) : l >= 0 ? GREEN : RED; g.font = '600 9.5px Inter, sans-serif';
        g.fillText(l == null ? '—' : `${pct(l)} vs static`, w - 8, cy + 13);
      } else { g.fillStyle = ink(0.4); g.font = '600 9.5px Inter, sans-serif'; g.fillText('baseline', w - 8, cy + 13); }
    });
  }

  drawLog() {
    const { g, w, h } = fit(this.c.log);
    const d = this.d, l = 168, r = 118, ww = w - l - r;
    this.logGeom = { l, w: ww };
    const X = (day) => l + (day / d.days) * ww;
    const y = 18;
    g.fillStyle = ink(0.06); roundRect(g, l, y - 4, ww, 8, 4); g.fill();
    const sh = d.scenario.shock;
    if (sh && sh.lo < d.days) {
      const x0 = X(sh.lo), x1 = X(Math.min(d.days, sh.hi));
      g.save(); g.beginPath(); g.rect(x0, y - 9, x1 - x0, 18); g.clip();
      g.fillStyle = 'rgba(200,69,47,0.08)'; g.fillRect(x0, y - 9, x1 - x0, 18);
      g.strokeStyle = 'rgba(200,69,47,0.35)'; g.lineWidth = 1;
      for (let s = x0 - 20; s < x1 + 20; s += 5) { g.beginPath(); g.moveTo(s, y + 9); g.lineTo(s + 10, y - 9); g.stroke(); }
      g.restore();
      g.fillStyle = RED; g.font = '700 8.5px Inter, sans-serif'; g.textAlign = 'center'; g.fillText('SHOCK', (x0 + x1) / 2, y + 22);
    }
    const px = X(this.raceDay);
    g.fillStyle = sea(0.3); roundRect(g, l, y - 4, px - l, 8, 4); g.fill();
    g.font = '600 9px Inter, sans-serif'; g.textAlign = 'center';
    const wk = d.days <= 7 ? 1 : 7;
    for (let dd = 0; dd <= d.days; dd += wk) {
      const x = X(dd);
      g.fillStyle = ink(0.35); g.fillRect(x - 0.5, y + 5, 1, 4);
      if (d.days > 7 && (dd / 7) % (d.days > 30 ? 2 : 1) === 0 && dd > 0) { g.fillStyle = ink(0.5); g.fillText(`W${dd / 7}`, x, y + 20); }
      else if (d.days <= 7) { g.fillStyle = ink(0.5); g.fillText(`D${dd}`, x, y + 20); }
    }
    // playhead: a tiny hull
    g.fillStyle = BLUE;
    g.beginPath(); g.moveTo(px - 8, y - 6); g.lineTo(px + 8, y - 6); g.lineTo(px + 5, y + 1); g.lineTo(px - 6, y + 1); g.closePath(); g.fill();
    g.fillRect(px - 5, y - 11, 5, 5);
    g.textAlign = 'right'; g.fillStyle = ink(0.55); g.font = '600 10px Inter, sans-serif';
    g.fillText('drag the log line to scrub', l - 12, y + 4);
  }

  /* ---------------------------------------------------------------- KPI pictograms */
  drawKpi(c) {
    const { g, w, h } = fit(c);
    const d = this.d, lead = d.policies.ppo, st = d.policies.static, t = this.time, a = this.appear;
    switch (c.dataset.kpi) {
      case 'rev': {
        // stacks of landed boxes + a hook lowering the next one
        const cols = 5, bw = Math.min(18, (w - 16) / cols), bh = bw * 0.5, x0 = w - cols * (bw + 2) - 6, base = h - 6;
        const heights = [3, 5, 4, 6, 5].map((n) => Math.round(n * a));
        g.fillStyle = ink(0.5); g.fillRect(x0 - 4, base, cols * (bw + 2) + 8, 1.5);
        heights.forEach((n, i) => { for (let k = 0; k < n; k++) this.box(g, x0 + i * (bw + 2), base - (k + 1) * (bh + 1), bw, bh, BOXES[(i * 3 + k) % BOXES.length]); });
        const ci = Math.floor(t / 2.4) % cols, u = (t % 2.4) / 2.4;
        const hx = x0 + ci * (bw + 2) + bw / 2, top = 4, land = base - (heights[ci] + 1) * (bh + 1);
        const hy = top + (land - top) * Math.sin(Math.min(1, u * 1.6) * Math.PI / 2) * (u < 0.8 ? 1 : 1 - (u - 0.8) * 5);
        g.strokeStyle = ink(0.55); g.lineWidth = 0.8; g.beginPath(); g.moveTo(hx, 0); g.lineTo(hx, hy); g.stroke();
        if (u < 0.8) this.box(g, hx - bw / 2, hy, bw, bh, BLUE);
        break;
      }
      case 'util': {
        // hull side with draught marks, Plimsoll disc and the sea at the utilisation line
        const x0 = 8, x1 = w - 10, top = 8, keel = h - 6, hh = keel - top;
        g.beginPath(); g.moveTo(x0, top); g.lineTo(x1 - 16, top); g.quadraticCurveTo(x1 + 4, top, x1, keel - hh * 0.3); g.quadraticCurveTo(x1 - 6, keel, x1 - 24, keel); g.lineTo(x0 + 4, keel); g.lineTo(x0, top); g.closePath();
        g.fillStyle = '#2a241b'; g.fill();
        g.fillStyle = 'rgba(160,40,40,0.9)'; g.fillRect(x0 + 2, keel - hh * 0.35, x1 - x0 - 30, hh * 0.35);
        // draught marks
        g.fillStyle = 'rgba(255,255,255,0.8)'; g.font = '700 7px Inter, sans-serif'; g.textAlign = 'left';
        for (let k = 0; k < 5; k++) { const yy = keel - (k + 0.5) * (hh / 5); g.fillText(String(8 + k * 2), x1 - 24, yy + 2.5); }
        // Plimsoll
        const pc = x0 + (x1 - x0) * 0.42, py = keel - hh * 0.9;
        g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.2;
        g.beginPath(); g.arc(pc, py, 7, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(pc - 11, py); g.lineTo(pc + 11, py); g.stroke();
        const lvl = keel - hh * lead.util * a;
        g.save(); g.beginPath(); g.rect(0, 0, w, h); g.clip();
        g.fillStyle = sea(0.45);
        g.beginPath(); g.moveTo(0, h);
        for (let x = 0; x <= w; x += 3) g.lineTo(x, lvl + Math.sin(x * 0.18 + t * 2.2) * 1.2);
        g.lineTo(w, h); g.closePath(); g.fill();
        g.restore();
        g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1; g.setLineDash([3, 3]);
        const sl = keel - hh * st.util;
        g.beginPath(); g.moveTo(x0 - 4, sl); g.lineTo(x0 + 22, sl); g.stroke(); g.setLineDash([]);
        g.fillStyle = ink(0.55); g.font = '600 7.5px Inter, sans-serif'; g.fillText('static', x0 - 2, sl - 3);
        break;
      }
      case 'co2': {
        // funnel + drifting puffs, a dashed ghost puff shows the static-policy plume size
        const fx = 14, base = h - 4, fw = 18;
        g.fillStyle = '#c3166b';
        g.beginPath(); g.moveTo(fx, base); g.lineTo(fx + fw, base); g.lineTo(fx + fw - 2, base - 30); g.lineTo(fx + 2, base - 30); g.closePath(); g.fill();
        g.fillStyle = '#1b1b1d'; g.fillRect(fx + 1.5, base - 34, fw - 3, 5);
        const k = lead.co2 / 1.5;
        for (let i = 0; i < 6; i++) {
          const u = (t * 0.3 + i / 6) % 1;
          const x = fx + fw / 2 + u * (w - 40), y = base - 38 - u * (h * 0.35) - Math.sin(u * 6 + i) * 2;
          g.fillStyle = ink((1 - u) * 0.28);
          g.beginPath(); g.arc(x, y, (3 + u * 9) * k, 0, Math.PI * 2); g.fill();
        }
        const gx = w - 18, gy = 16, gr = 12 * (st.co2 / 1.5);
        g.strokeStyle = ink(0.4); g.setLineDash([2, 2]); g.beginPath(); g.arc(gx, gy, gr, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        g.fillStyle = ink(0.45); g.font = '600 7.5px Inter, sans-serif'; g.textAlign = 'center'; g.fillText('static', gx, gy + gr + 9);
        break;
      }
      case 'win': {
        // engine-order telegraph dial
        const cx = w / 2, cy = h - 8, r = Math.min(w / 2 - 6, h - 14);
        g.lineWidth = 4; g.strokeStyle = BRASS; g.beginPath(); g.arc(cx, cy, r, Math.PI, 0); g.stroke();
        const labels = ['0', '25', '50', '75', '100'];
        for (let i = 0; i < 4; i++) {
          g.fillStyle = i % 2 ? ink(0.08) : '#fffaf0';
          g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r - 3, Math.PI + (i * Math.PI) / 4, Math.PI + ((i + 1) * Math.PI) / 4); g.closePath(); g.fill();
        }
        g.fillStyle = ink(0.55); g.font = '700 7px Inter, sans-serif'; g.textAlign = 'center';
        labels.forEach((l, i) => { const an = Math.PI + (i * Math.PI) / 4; g.fillText(l, cx + Math.cos(an) * (r - 10), cy + Math.sin(an) * (r - 10) + 3); });
        const hv = d.policies.heuristic.counterWin;
        const mark = (v, col, wd) => { const an = Math.PI + v * Math.PI; g.strokeStyle = col; g.lineWidth = wd; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(an) * (r - 4), cy + Math.sin(an) * (r - 4)); g.stroke(); };
        mark(hv * a, ink(0.3), 1.2);
        mark(lead.counterWin * a + Math.sin(t * 3) * 0.005, '#b3261e', 2);
        g.fillStyle = BRASS; g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'empty': {
        // barge: laden boxes solid, empty repositioning moves as dashed outlines
        const base = h - 12, bw = Math.min(14, (w - 20) / 6), bh = bw * 0.55, x0 = w - 6 * (bw + 1.5) - 10;
        g.fillStyle = '#2a241b';
        g.beginPath(); g.moveTo(x0 - 6, base); g.lineTo(x0 + 6 * (bw + 1.5) + 6, base); g.lineTo(x0 + 6 * (bw + 1.5), base + 7); g.lineTo(x0, base + 7); g.closePath(); g.fill();
        const empties = Math.round(12 * 0.5 * (lead.empty / st.empty));
        for (let i = 0; i < 12; i++) {
          const cx = x0 + (i % 6) * (bw + 1.5), cy = base - (Math.floor(i / 6) + 1) * (bh + 1.5);
          if (i / 12 > a) continue;
          if (i >= 12 - empties) { g.strokeStyle = ink(0.5); g.setLineDash([2, 1.5]); g.strokeRect(cx + 0.5, cy + 0.5, bw - 1, bh - 1); g.setLineDash([]); }
          else this.box(g, cx, cy, bw, bh, BOXES[(i * 7) % BOXES.length]);
        }
        g.strokeStyle = sea(0.45); g.lineWidth = 1;
        g.beginPath(); for (let x = 0; x <= w; x += 3) g.lineTo(x, base + 5 + Math.sin(x * 0.2 + t * 2) * 1); g.stroke();
        break;
      }
      default:
    }
  }

  box(g, x, y, w, h, color) {
    g.fillStyle = color; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1);
    if (w > 10) { g.fillStyle = 'rgba(0,0,0,0.1)'; for (let s = x + 2; s < x + w - 1; s += 2.5) g.fillRect(s, y + 1, 0.8, h - 2); }
    g.strokeStyle = 'rgba(20,16,10,0.5)'; g.lineWidth = 0.6; g.strokeRect(x + 0.3, y + 0.3, w - 0.6, h - 0.6);
  }

  /* ---------------------------------------------------------------- chart of the rotation */
  drawMap() {
    const { g, w, h } = fit(this.c.map);
    const d = this.d, t = this.time;
    const pad = 26, lon0 = -16, lon1 = 296, lat0 = -8, lat1 = 64;
    const sx = (w - pad * 2) / (lon1 - lon0), sy = (h - pad * 2) / (lat1 - lat0);
    const X = (lon) => pad + (lon - lon0) * sx, Y = (lat) => h - pad - (lat - lat0) * sy;
    const P = (q) => [X(q[0]), Y(q[1])];

    // water tint + graticule + chart border
    g.fillStyle = sea(0.05); g.fillRect(pad, pad, w - pad * 2, h - pad * 2);
    g.strokeStyle = ink(0.07); g.lineWidth = 1;
    g.font = '600 8px Inter, sans-serif'; g.fillStyle = ink(0.45); g.textAlign = 'center';
    for (let lon = 0; lon <= 290; lon += 30) {
      g.beginPath(); g.moveTo(X(lon), pad); g.lineTo(X(lon), h - pad); g.stroke();
      const lbl = lon === 0 ? '0°' : lon === 180 ? '180°' : lon < 180 ? `${lon}°E` : `${360 - lon}°W`;
      g.fillText(lbl, X(lon), h - pad + 17);
    }
    g.textAlign = 'right';
    for (let lat = 0; lat <= 60; lat += 15) { g.beginPath(); g.moveTo(pad, Y(lat)); g.lineTo(w - pad, Y(lat)); g.stroke(); g.fillText(`${lat}°${lat ? 'N' : ''}`, pad - 8, Y(lat) + 3); }
    g.strokeStyle = ink(0.6); g.lineWidth = 1; g.strokeRect(pad - 0.5, pad - 0.5, w - pad * 2 + 1, h - pad * 2 + 1);
    g.strokeRect(pad - 6.5, pad - 6.5, w - pad * 2 + 13, h - pad * 2 + 13);
    for (let lon = lon0, k = 0; lon < lon1; lon += 10, k++) if (k % 2) { g.fillStyle = ink(0.55); g.fillRect(X(lon), pad - 6, 10 * sx, 5.5); g.fillRect(X(lon), h - pad + 0.5, 10 * sx, 5.5); }
    for (let lat = lat0, k = 0; lat < lat1; lat += 10, k++) if (k % 2) { g.fillStyle = ink(0.55); g.fillRect(pad - 6, Y(lat + 10), 5.5, 10 * sy); g.fillRect(w - pad + 0.5, Y(lat + 10), 5.5, 10 * sy); }

    g.save(); g.beginPath(); g.rect(pad, pad, w - pad * 2, h - pad * 2); g.clip();
    // portolan rhumb lines from two wind roses
    for (const [clon, clat] of [[62, 22], [205, 26]]) {
      const [cx, cy] = P([clon, clat]);
      for (let k = 0; k < 32; k++) {
        const an = (k / 32) * Math.PI * 2;
        g.strokeStyle = k % 8 === 0 ? ink(0.1) : k % 2 === 0 ? 'rgba(200,70,60,0.07)' : sea(0.07);
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(an) * w, cy + Math.sin(an) * w); g.stroke();
      }
    }
    // soundings
    if (!this.soundings) { const R = mulberry32(9); this.soundings = Array.from({ length: 80 }, () => [lon0 + R() * (lon1 - lon0), lat0 + R() * (lat1 - lat0), Math.round(800 + R() * 5200)]); }
    g.font = 'italic 500 7.5px Inter, sans-serif'; g.fillStyle = ink(0.18); g.textAlign = 'center';
    for (const [lo, la, v] of this.soundings) g.fillText(String(v), X(lo), Y(la));

    // lanes
    const coord = (q) => (typeof q === 'string' ? (NUDGE[q] || [d.ports.find((p) => p.code === q).lon, d.ports.find((p) => p.code === q).lat]) : q);
    const maxMoved = Math.max(1, ...d.loops.map((l) => l.teuMoved));
    const hovered = this.hover.map != null ? d.ports[this.hover.map].code : null;
    for (const [li, l] of d.loops.entries()) {
      const poly = spline(l.lane.map((q) => P(coord(q))), 10);
      const touches = !hovered || l.lane.includes(hovered);
      const wd = 1.5 + 4.5 * (l.teuMoved / maxMoved);
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = rgba(l.color, touches ? 0.55 : 0.12); g.lineWidth = wd;
      g.beginPath(); poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      g.strokeStyle = `rgba(255,255,255,${touches ? 0.7 : 0.2})`; g.lineWidth = 1; g.setLineDash([2, 7]); g.lineDashOffset = -t * 14;
      g.stroke(); g.setLineDash([]); g.lineDashOffset = 0;
      // two ships per loop, shuttling out and back
      for (let j = 0; j < 2; j++) {
        const ph = (t * 0.012 * (l.speed / 16) + j * 0.5 + li * 0.17) % 1;
        const back = ph > 0.5, u = back ? 2 - 2 * ph : 2 * ph;
        const s = along(poly, u);
        const an = s.a + (back ? Math.PI : 0);
        g.save(); g.translate(s.x, s.y); g.rotate(an);
        g.fillStyle = 'rgba(255,255,255,0.7)';
        for (let k = 1; k < 5; k++) { g.globalAlpha = (1 - k / 5) * (touches ? 0.9 : 0.3); g.beginPath(); g.arc(-6 - k * 4, 0, 1.2 + k * 0.3, 0, Math.PI * 2); g.fill(); }
        g.globalAlpha = touches ? 1 : 0.35;
        g.fillStyle = l.color; g.strokeStyle = ink(0.7); g.lineWidth = 0.7;
        g.beginPath(); g.moveTo(8, 0); g.lineTo(3, -3.2); g.lineTo(-6, -3.2); g.lineTo(-6, 3.2); g.lineTo(3, 3.2); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = '#fffaf0'; g.fillRect(-5, -1.2, 2.5, 2.4);
        g.restore();
      }
    }
    g.globalAlpha = 1;
    g.restore();

    // ports: congestion ring, throughput, closures
    this.mapHits = [];
    const cc = (v) => (v > 0.8 ? RED : v > 0.55 ? AMBER : GREEN);
    const labelSide = { NLRTM: 'up', BEANR: 'right', DEHAM: 'right', SGSIN: 'right', CNSHA: 'left', KRPUS: 'right', USLAX: 'left', USNYC: 'left' };
    const maxThroughput = Math.max(1, ...d.ports.map((p) => p.throughput));
    d.ports.forEach((p, i) => {
      const [x, y] = P(coord(p.code));
      this.mapHits.push({ x, y, i });
      const hov = this.hover.map === i;
      const r = 5 + 9 * Math.sqrt(p.throughput / maxThroughput);
      if (p.shocked) {
        const pu = (t * 0.8) % 1;
        g.strokeStyle = `rgba(200,69,47,${0.6 * (1 - pu)})`; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, r + 4 + pu * 14, 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = '#fffaf0'; g.beginPath(); g.arc(x, y, r + 3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = ink(0.15); g.lineWidth = 3; g.beginPath(); g.arc(x, y, r + 1.5, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = cc(p.congestion); g.beginPath(); g.arc(x, y, r + 1.5, -Math.PI / 2, -Math.PI / 2 + p.congestion * Math.PI * 2 * this.appear); g.stroke();
      g.fillStyle = hov ? BLUE : ink(0.85); g.beginPath(); g.arc(x, y, r * 0.45, 0, Math.PI * 2); g.fill();
      const up = labelSide[p.code] === 'up', side = labelSide[p.code] === 'left' ? -1 : 1;
      const lx = up ? x : x + side * (r + 7), ly = up ? y - r - 16 : y - 1;
      g.textAlign = up ? 'center' : side > 0 ? 'left' : 'right';
      g.fillStyle = ink(0.9); g.font = '700 10px Inter, sans-serif';
      g.fillText(p.code, lx, ly);
      g.fillStyle = p.shocked ? RED : ink(0.5); g.font = '600 8.5px Inter, sans-serif';
      g.fillText(p.shocked ? 'CLOSED' : `${nf(p.throughput / 1000, 1)}k TEU`, lx, ly + 10);
    });
    // compass rose ornament + scale bar
    this.rose(g, pad + 44, h - pad - 44, 30);
    const nm = 1000 / 60 * sx;
    g.fillStyle = ink(0.7); g.fillRect(w - pad - 16 - nm, h - pad - 18, nm / 2, 3); g.strokeStyle = ink(0.7); g.lineWidth = 0.8; g.strokeRect(w - pad - 16 - nm / 2, h - pad - 18, nm / 2, 3);
    g.font = '600 8px Inter, sans-serif'; g.textAlign = 'center'; g.fillStyle = ink(0.6); g.fillText('1,000 nm at the equator', w - pad - 16 - nm / 2, h - pad - 24);

    // hover card
    if (this.hover.map != null) {
      const p = d.ports[this.hover.map], hit = this.mapHits[this.hover.map];
      const lines = [[p.name, `${p.code}`], ['Throughput', `${nf(p.throughput)} TEU`], ['Berth occupancy', `${nf(p.congestion * 100)}%`], ['Empties on hand', `${nf(p.empties)} TEU`], ['Mean dwell', `${nf(p.dwell)} h`]];
      const bw = 176, bh = 16 + lines.length * 15, bx = clamp(hit.x + 16, pad, w - pad - bw), by = clamp(hit.y - bh - 12, pad, h - pad - bh);
      g.fillStyle = 'rgba(255,252,244,0.95)'; roundRect(g, bx, by, bw, bh, 8); g.fill(); g.strokeStyle = ink(0.15); g.stroke();
      lines.forEach(([a, b], k) => {
        g.textAlign = 'left'; g.fillStyle = k ? ink(0.55) : ink(0.9); g.font = k ? '600 9.5px Inter, sans-serif' : '700 11px Inter, sans-serif';
        g.fillText(a, bx + 10, by + 18 + k * 15);
        g.textAlign = 'right'; g.fillStyle = ink(0.85); g.fillText(b, bx + bw - 10, by + 18 + k * 15);
      });
    }
  }

  // Classic eight-point compass rose with split light/dark points.
  rose(g, cx, cy, R) {
    g.save(); g.translate(cx, cy);
    g.strokeStyle = ink(0.4); g.lineWidth = 0.8;
    g.beginPath(); g.arc(0, 0, R * 0.78, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(0, 0, R * 0.7, 0, Math.PI * 2); g.stroke();
    for (let k = 0; k < 8; k++) {
      const an = (k * Math.PI) / 4 - Math.PI / 2, long = k % 2 === 0, len = long ? R : R * 0.55, wd = long ? R * 0.14 : R * 0.1;
      const tip = [Math.cos(an) * len, Math.sin(an) * len];
      const l = [Math.cos(an - Math.PI / 2) * wd, Math.sin(an - Math.PI / 2) * wd], r = [Math.cos(an + Math.PI / 2) * wd, Math.sin(an + Math.PI / 2) * wd];
      g.fillStyle = long ? ink(0.8) : ink(0.45); g.beginPath(); g.moveTo(0, 0); g.lineTo(...l); g.lineTo(...tip); g.closePath(); g.fill();
      g.fillStyle = '#fffaf0'; g.beginPath(); g.moveTo(0, 0); g.lineTo(...r); g.lineTo(...tip); g.closePath(); g.fill(); g.strokeStyle = ink(0.6); g.stroke();
    }
    g.fillStyle = 'rgba(200,70,60,0.9)'; g.font = `700 ${Math.max(8, R * 0.3)}px Inter, sans-serif`; g.textAlign = 'center';
    g.fillText('N', 0, -R - 4);
    g.restore();
  }

  /* ---------------------------------------------------------------- compass of demand */
  drawRose() {
    const { g, w, h } = fit(this.c.rose);
    const d = this.d, a = this.appear;
    const cx = w / 2, cy = h / 2 + 6, R = Math.min(w, h) / 2 - 42;
    const maxReq = Math.max(1, ...d.ports.map((p) => p.requested));
    // rings + degree scale
    g.strokeStyle = ink(0.1); g.lineWidth = 1; g.setLineDash([2, 4]);
    [0.25, 0.5, 0.75, 1].forEach((f) => { g.beginPath(); g.arc(cx, cy, R * Math.sqrt(f), 0, Math.PI * 2); g.stroke(); });
    g.setLineDash([]);
    g.fillStyle = ink(0.4); g.font = '600 8px Inter, sans-serif'; g.textAlign = 'left';
    [0.25, 0.5, 1].forEach((f) => g.fillText(`${nf((maxReq * f) / 1000)}k`, cx + 3, cy - R * Math.sqrt(f) - 2));
    g.strokeStyle = ink(0.5); g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, R + 10, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, R + 18, 0, Math.PI * 2); g.stroke();
    for (let deg = 0; deg < 360; deg += 5) {
      const an = (deg * Math.PI) / 180 - Math.PI / 2, l = deg % 30 === 0 ? 8 : deg % 10 === 0 ? 5 : 3;
      g.strokeStyle = ink(deg % 30 === 0 ? 0.6 : 0.3);
      g.beginPath(); g.moveTo(cx + Math.cos(an) * (R + 10), cy + Math.sin(an) * (R + 10)); g.lineTo(cx + Math.cos(an) * (R + 10 + l), cy + Math.sin(an) * (R + 10 + l)); g.stroke();
      if (deg % 30 === 0) { g.fillStyle = ink(0.45); g.textAlign = 'center'; g.font = '600 7.5px Inter, sans-serif'; g.fillText(String(deg).padStart(3, '0'), cx + Math.cos(an) * (R + 27), cy + Math.sin(an) * (R + 27) + 3); }
    }
    // petals
    const petals = [];
    const petal = (an, r, hw) => {
      const p = (aa, rr) => [cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr];
      g.beginPath(); g.moveTo(cx, cy);
      g.quadraticCurveTo(...p(an - hw, r * 0.62), ...p(an, r));
      g.quadraticCurveTo(...p(an + hw, r * 0.62), cx, cy);
    };
    d.ports.forEach((p, i) => {
      const an = -Math.PI / 2 + (i * Math.PI * 2) / d.ports.length;
      const rq = R * Math.sqrt(p.requested / maxReq) * a, rb = R * Math.sqrt(p.booked / maxReq) * a;
      const hov = this.hover.rose === i, dim = this.hover.rose != null && !hov;
      petal(an, rq, 0.34); g.fillStyle = ink(dim ? 0.02 : 0.05); g.fill(); g.strokeStyle = ink(dim ? 0.15 : 0.4); g.setLineDash([3, 3]); g.lineWidth = 1; g.stroke(); g.setLineDash([]);
      petal(an, rb, 0.3);
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, rb));
      gr.addColorStop(0, sea(dim ? 0.05 : 0.15)); gr.addColorStop(1, hov ? 'rgba(29,127,224,0.85)' : `rgba(29,127,224,${dim ? 0.2 : 0.55})`);
      g.fillStyle = gr; g.fill(); g.strokeStyle = hov ? '#1566b5' : rgba(BLUE, dim ? 0.3 : 0.8); g.lineWidth = hov ? 1.6 : 1; g.stroke();
      petals.push({ a: an, r: rq });
      const lx = cx + Math.cos(an) * (rq + 14), ly = cy + Math.sin(an) * (rq + 14);
      g.textAlign = Math.abs(Math.cos(an)) < 0.3 ? 'center' : Math.cos(an) > 0 ? 'left' : 'right';
      g.fillStyle = ink(dim ? 0.35 : 0.9); g.font = '700 9.5px Inter, sans-serif'; g.fillText(p.code, lx, ly);
      g.fillStyle = ink(dim ? 0.25 : 0.5); g.font = '600 8.5px Inter, sans-serif'; g.fillText(`${nf(p.requested ? (p.booked / p.requested) * 100 : 0)}% won`, lx, ly + 10);
    });
    this.roseHits = { cx, cy, petals };
    this.rose(g, cx, cy, 20);
  }

  /* ---------------------------------------------------------------- the locks */
  drawLocks() {
    const { g, w, h } = fit(this.c.locks);
    const d = this.d, t = this.time;
    const segs = this.segment === 'all' ? d.funnel : d.funnel.filter((s) => s.key === this.segment);
    const sum = (k) => segs.reduce((a, s) => a + s[k], 0);
    // Delivered has no per-segment breakdown in the live event stream (delivery.confirmed
    // carries no segment) — it's shown as a total across all segments regardless of filter.
    const stages = [['Requests', sum('req')], ['Quoted', sum('quoted')], ['Booked', sum('booked')], ['Delivered', d.deliveredTotal]];
    const countered = sum('countered');
    const n = stages.length, pad = 14, gateW = 10, top = 26, step = 16, bottom = 44;
    const cw = (w - pad * 2 - gateW * (n - 1)) / n;
    const maxDepth = h - top - bottom - step * (n - 1) - 8;
    const fill = easeOut((this.time - this.locksT) / 1.4);
    const x0s = stages.map((_, i) => pad + i * (cw + gateW));
    const floors = stages.map((_, i) => top + maxDepth + 8 + i * step);
    stages.forEach(([name, v], i) => {
      const x0 = x0s[i], x1 = x0 + cw, floor = floors[i];
      const depth = maxDepth * (v / (stages[0][1] || 1)) * fill;
      const surf = floor - depth;
      // chamber masonry
      g.fillStyle = ink(0.06); g.fillRect(x0, top, cw, floor - top);
      g.fillStyle = ink(0.55); g.fillRect(x0 - 1, floor, cw + 2, 3);
      g.strokeStyle = ink(0.12); g.lineWidth = 1;
      for (let y = floor + 3, r = 0; y < h - bottom + step * (n - 1) + 6 && r < 3; y += 5, r++) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); for (let x = x0 + (r % 2) * 6; x < x1; x += 12) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 5); g.stroke(); } }
      // water
      const gr = g.createLinearGradient(0, surf, 0, floor);
      gr.addColorStop(0, sea(0.42)); gr.addColorStop(1, sea(0.16));
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(x0, floor);
      for (let x = x0; x <= x1; x += 3) g.lineTo(x, surf + Math.sin(x * 0.12 + t * 2 + i) * 1.3);
      g.lineTo(x1, floor); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1;
      g.beginPath(); for (let x = x0; x <= x1; x += 3) g.lineTo(x, surf + Math.sin(x * 0.12 + t * 2 + i) * 1.3); g.stroke();
      // boats on the surface
      const boats = Math.max(1, Math.round(6 * (v / (stages[0][1] || 1))));
      for (let b = 0; b < boats; b++) {
        const bx = x0 + 10 + (b + 0.5) * ((cw - 20) / 6), by = surf + Math.sin(bx * 0.12 + t * 2 + i) * 1.3;
        drawShip(g, bx - 11, by + 2, 22, { hull: i === 3 ? '#1d4f86' : '#2a241b', colors: BOXES, fill: 0.7, seed: b + i * 7 });
      }
      // labels
      g.textAlign = 'left'; g.fillStyle = ink(0.5); g.font = '700 9px Inter, sans-serif';
      g.fillText(name.toUpperCase(), x0 + 2, top - 12);
      g.fillStyle = ink(0.9); g.font = '700 16px Inter, sans-serif';
      g.fillText(nf(v), x0 + 2, top + 8);
      // gate to the next chamber
      if (i < n - 1) {
        const gx = x1 + gateW / 2;
        g.fillStyle = ink(0.75); g.fillRect(x1, top - 4, gateW, 4);
        g.strokeStyle = ink(0.75); g.lineWidth = 2;
        g.beginPath(); g.moveTo(gx - 3, top); g.lineTo(gx, floor - 6); g.lineTo(gx + 3, top); g.stroke();
        const drop = (stages[i + 1][1] - v) / (v || 1) * 100;
        const lbl = `${drop >= 0 ? '+' : '−'}${nf(Math.abs(drop), 1)}%`;
        g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center';
        const tw = g.measureText(lbl).width + 10;
        g.fillStyle = Math.abs(drop) > 20 ? 'rgba(226,120,32,0.16)' : ink(0.07); roundRect(g, gx - tw / 2, floor + 10, tw, 15, 7.5); g.fill();
        g.fillStyle = Math.abs(drop) > 20 ? '#b35b12' : ink(0.65); g.fillText(lbl, gx, floor + 21);
      }
    });
    // counter-offer bypass channel: quoted -> booked
    const qa = x0s[1] + cw * 0.5, qb = x0s[2] + cw * 0.5, yb = h - 10;
    g.strokeStyle = 'rgba(29,127,224,0.55)'; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.lineDashOffset = -t * 12;
    g.beginPath(); g.moveTo(qa, floors[1] + 4); g.bezierCurveTo(qa, yb, qb, yb, qb, floors[2] + 4); g.stroke();
    g.setLineDash([]); g.lineDashOffset = 0;
    g.fillStyle = '#1566b5'; g.font = '700 9.5px Inter, sans-serif'; g.textAlign = 'center';
    const won = Math.round(countered * d.policies.ppo.counterWin);
    g.fillText(`counter-offer bypass · ${nf(countered)} issued · ${nf(won)} won`, (qa + qb) / 2, yb - 2);
  }

  /* ---------------------------------------------------------------- the yard */
  drawYard() {
    const { g, w, h } = fit(this.c.yard);
    const d = this.d, t = this.time;
    const cols = 15, tiers = 8, total = cols * tiers;
    // largest-remainder allocation of 120 boxes
    const raw = d.outcomes.map((o) => (o.n / (d.requests || 1)) * total);
    const alloc = raw.map(Math.floor);
    let rest = total - alloc.reduce((a, b) => a + b, 0);
    raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest-- > 0) alloc[i]++; });
    const seq = alloc.flatMap((n, i) => Array(n).fill(i));
    const pad = 10, bw = (w - pad * 2) / cols, bh = Math.min(bw * 0.46, (h - 30) / tiers), base = h - 8;
    g.fillStyle = ink(0.55); g.fillRect(pad - 4, base, w - pad * 2 + 8, 1.5);
    g.fillStyle = ink(0.12); for (let x = pad; x < w - pad; x += 14) g.fillRect(x, base + 3, 7, 1);
    this.yardHits = [];
    const shown = Math.floor(total * this.appear);
    seq.forEach((o, k) => {
      if (k >= shown) return;
      const c = Math.floor(k / tiers), tr = k % tiers;
      const x = pad + c * bw, y = base - (tr + 1) * bh;
      g.globalAlpha = this.hover.yard == null || this.hover.yard === o ? 1 : 0.28;
      this.box(g, x + 0.8, y + 0.6, bw - 1.6, bh - 1.2, d.outcomes[o].color);
      this.yardHits.push({ x, y, w: bw, h: bh, o });
    });
    g.globalAlpha = 1;
    // rubber-tyred gantry drifting over the block
    const span = 3 * bw, gx = pad + ((Math.sin(t * 0.25) + 1) / 2) * (w - pad * 2 - span), gtop = base - tiers * bh - 14;
    g.strokeStyle = 'rgba(242,183,5,0.9)'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(gx, base); g.lineTo(gx, gtop); g.lineTo(gx + span, gtop); g.lineTo(gx + span, base); g.stroke();
    g.fillStyle = ink(0.8); g.fillRect(gx - 3, base - 3, 6, 3); g.fillRect(gx + span - 3, base - 3, 6, 3);
    const tx = gx + span / 2 + Math.sin(t * 0.9) * span * 0.3;
    g.fillStyle = ink(0.8); g.fillRect(tx - 6, gtop - 2, 12, 5);
    const hy = gtop + 8 + (Math.sin(t * 1.3) + 1) * 6;
    g.strokeStyle = ink(0.6); g.lineWidth = 0.8; g.beginPath(); g.moveTo(tx - 3, gtop + 3); g.lineTo(tx - 3, hy); g.moveTo(tx + 3, gtop + 3); g.lineTo(tx + 3, hy); g.stroke();
    g.fillStyle = ink(0.75); g.fillRect(tx - bw / 2, hy, bw, 2);
  }

  /* ---------------------------------------------------------------- tide table */
  drawTide() {
    const { g, w, h } = fit(this.c.tide);
    const d = this.d, t = this.time, n = d.days;
    const pad = { l: 54, r: 18, t: 34, b: 22 };
    const ww = w - pad.l - pad.r, hh = h - pad.t - pad.b;
    this.tideGeom = { l: pad.l, w: ww };
    const maxV = Math.max(...d.tide.map((q) => Math.max(q.ppo, q.stat))) * 1.12;
    const minV = Math.min(0, ...d.tide.map((q) => Math.min(q.ppo, q.stat)));
    const X = (i) => pad.l + (n === 1 ? 0.5 : i / (n - 1)) * ww, Y = (v) => pad.t + hh - ((v - minV) / (maxV - minV)) * hh;
    // axis
    g.strokeStyle = ink(0.07); g.lineWidth = 1; g.font = '600 8.5px Inter, sans-serif'; g.textAlign = 'right';
    const step = niceStep(maxV - minV, 4);
    for (let v = Math.ceil(minV / step) * step; v <= maxV; v += step) { g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(w - pad.r, Y(v)); g.stroke(); g.fillStyle = ink(0.45); g.fillText(kfmt(v), pad.l - 8, Y(v) + 3); }
    // shock band
    const sh = d.scenario.shock;
    if (sh && sh.lo < n) {
      const x0 = X(sh.lo - 1), x1 = X(Math.min(n - 1, sh.hi - 1));
      g.save(); g.beginPath(); g.rect(x0, pad.t, x1 - x0, hh); g.clip();
      g.fillStyle = 'rgba(200,69,47,0.05)'; g.fillRect(x0, pad.t, x1 - x0, hh);
      g.strokeStyle = 'rgba(200,69,47,0.14)';
      for (let s = x0 - hh; s < x1; s += 7) { g.beginPath(); g.moveTo(s, pad.t + hh); g.lineTo(s + hh, pad.t); g.stroke(); }
      g.restore();
    }
    // moons, one per week
    for (let wk = 0; wk * 7 < n; wk++) {
      const x = X(Math.min(n - 1, wk * 7 + 3)), p = ((wk * 7) % 29.5) / 29.5;
      this.moon(g, x, 13, 5.5, p);
      if (n > 7) { g.fillStyle = ink(0.4); g.font = '600 8px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(`W${wk + 1}`, x, 30); }
    }
    // water body (Dock) with a live surface
    const pts = d.tide.map((q, i) => [X(i), Y(q.ppo)]);
    const curve = n > 2 ? spline(pts, 4) : pts;
    const gr = g.createLinearGradient(0, pad.t, 0, pad.t + hh);
    gr.addColorStop(0, sea(0.45)); gr.addColorStop(1, sea(0.05));
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(curve[0][0], Y(minV));
    curve.forEach(([x, y], i) => g.lineTo(x, y + Math.sin(i * 0.7 + t * 2.4) * 0.9));
    g.lineTo(curve[curve.length - 1][0], Y(minV)); g.closePath(); g.fill();
    g.strokeStyle = BLUE; g.lineWidth = 1.6;
    g.beginPath(); curve.forEach(([x, y], i) => (i ? g.lineTo(x, y + Math.sin(i * 0.7 + t * 2.4) * 0.9) : g.moveTo(x, y))); g.stroke();
    // static as the chart datum
    g.strokeStyle = ink(0.55); g.lineWidth = 1.2; g.setLineDash([4, 4]);
    g.beginPath(); d.tide.forEach((q, i) => (i ? g.lineTo(X(i), Y(q.stat)) : g.moveTo(X(i), Y(q.stat)))); g.stroke(); g.setLineDash([]);
    // high / low water per week
    const roomy = ww / Math.ceil(n / 7) > 70;
    for (let wk = 0; wk * 7 < n; wk++) {
      const sl = d.tide.slice(wk * 7, wk * 7 + 7);
      if (sl.length < 2) continue;
      const hi = sl.reduce((a, b) => (b.ppo > a.ppo ? b : a)), lo = sl.reduce((a, b) => (b.ppo < a.ppo ? b : a));
      for (const [q, up] of [[hi, true], [lo, false]]) {
        const x = X(q.day - 1), y = Y(q.ppo);
        g.fillStyle = up ? '#1566b5' : ink(0.55);
        g.beginPath(); if (up) { g.moveTo(x, y - 9); g.lineTo(x - 3.5, y - 3.5); g.lineTo(x + 3.5, y - 3.5); } else { g.moveTo(x, y + 9); g.lineTo(x - 3.5, y + 3.5); g.lineTo(x + 3.5, y + 3.5); } g.closePath(); g.fill();
        if (roomy || n <= 7) { g.font = '700 8px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(`${up ? 'HW' : 'LW'} ${kfmt(q.ppo)}`, x, up ? y - 12 : y + 18); }
      }
    }
    g.textAlign = 'left'; g.font = '700 9px Inter, sans-serif';
    g.fillStyle = BLUE; g.fillText('Dock · PPO', pad.l + 6, pad.t + hh + 16);
    g.fillStyle = ink(0.55); g.fillText('– – static rate card (datum)', pad.l + 76, pad.t + hh + 16);
    if (this.hover.tide != null) {
      const x = X(this.hover.tide);
      g.strokeStyle = ink(0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + hh); g.stroke();
      const q = d.tide[this.hover.tide];
      g.fillStyle = BLUE; g.beginPath(); g.arc(x, Y(q.ppo), 3.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = ink(0.6); g.beginPath(); g.arc(x, Y(q.stat), 3, 0, Math.PI * 2); g.fill();
    }
  }

  moon(g, x, y, r, p) {
    g.save();
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = '#fffaf0'; g.fill(); g.clip();
    g.fillStyle = ink(0.65);
    g.fillRect(p < 0.5 ? x - r : x, y - r, r, r * 2);
    const k = Math.cos(p * Math.PI * 2);
    g.beginPath(); g.ellipse(x, y, Math.abs(k) * r + 0.01, r, 0, 0, Math.PI * 2);
    g.fillStyle = k > 0 ? ink(0.65) : '#fffaf0'; g.fill();
    g.restore();
    g.strokeStyle = ink(0.5); g.lineWidth = 0.8; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  }

  /* ---------------------------------------------------------------- fleet */
  drawFleetShip(c) {
    const { g, w, h } = fit(c);
    const l = this.d.loops[+c.dataset.ship], t = this.time, i = +c.dataset.ship;
    // Real per-vessel cargo mix (booked TEU by segment, from recent live bookings for
    // this vessel_id). No split is invented: with no bookings yet, stacks are neutral ink.
    let colors = l.segShares
      ? Object.entries(l.segShares).flatMap(([k, s]) => Array(Math.round(s * 10)).fill(SEG_COLORS[k]))
      : [];
    if (!colors.length) colors = [ink(0.4)];
    const len = w * 0.72, x = w * 0.13, wl = h * 0.72;
    const sink = (l.util - 0.5) * 8;
    const keel = wl + len * 0.06 + sink + Math.sin(t * 1.4 + i) * 0.8;
    // sky / water
    g.fillStyle = sea(0.1); g.fillRect(0, wl, w, h - wl);
    const vk = l.speed / 18;
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1;
    for (let k = 0; k < 6; k++) {
      const yy = wl + 3 + k * 2.2, x1 = x - k * 10 * vk - 8;
      g.globalAlpha = 0.8 - k * 0.12;
      g.beginPath(); g.moveTo(x + 4, wl + 1); g.lineTo(x1 - 40 * vk, yy); g.stroke();
    }
    g.globalAlpha = 1;
    drawShip(g, x, keel, len, { hull: '#2a241b', colors, fill: l.util, seed: 30 + i, bowWave: vk });
    // translucent water over the submerged hull + surface
    g.fillStyle = sea(0.35);
    g.beginPath(); g.moveTo(0, h);
    for (let xx = 0; xx <= w; xx += 4) g.lineTo(xx, wl + Math.sin(xx * 0.08 + t * 2 + i) * 1.2);
    g.lineTo(w, h); g.closePath(); g.fill();
    // bow wave foam
    g.fillStyle = `rgba(255,255,255,${0.5 + 0.4 * vk})`;
    g.beginPath(); g.ellipse(x + len * 0.99, wl + 1, 6 + 10 * vk, 2 + vk, 0, 0, Math.PI * 2); g.fill();
    // draught marks at the stem
    g.fillStyle = ink(0.6); g.font = '700 7.5px Inter, sans-serif'; g.textAlign = 'left';
    const draft = l.draft * (0.72 + 0.28 * l.util);
    g.fillText(`${nf(draft, 1)} m`, x + len + 10, wl + 3);
    g.strokeStyle = ink(0.4); g.beginPath(); g.moveTo(x + len + 4, wl); g.lineTo(x + len + 8, wl); g.stroke();
    g.fillStyle = ink(0.45); g.fillText(`design ${nf(l.draft, 1)} m`, x + len + 10, wl + 13);
  }
}
