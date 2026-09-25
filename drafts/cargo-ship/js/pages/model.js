// Model — "Inside the helm". A live replay of the real decision engine, one decision at a time,
// sailed through eight ports of call: request → forecast → bid price → observe → policy → mask → act → settle.
// Inputs are drawn as the instruments a navigator would read (manifest, voyage legs, harbour buoys, the
// fleet, a swell forecast, a calendar dial), the network as ocean currents flowing through the trunk, and
// the output as a ship's wheel whose 44 spokes are the action space — masked spokes are anchored, and the
// wheel turns until the chosen action sits under the lubber line. Every number drawn here comes from
// js/api.js's /live/policy, /live/policy/network and /vessels — no mock, no fallback.
import { Page, fit, clamp, lerp, ease, easeOut, nf, roundRect, drawShip } from './page.js';
import { LiveEngine, actionsFromNetwork, curveAt, OBS_BLOCKS, STAGES, PORTS } from './liveDecision.js';
import { API } from '../api.js';

// Populated once from the real network's action_labels (see boot()) — mutated
// in place so every reference below (ACTIONS[i], ACTIONS.map(...), etc.) sees
// the real 44 actions once loaded.
let ACTIONS = [];
// Populated once from /vessels (see boot()) — real capacity, reefer plugs and
// fuel coefficients, in VES1..VES4 order.
let VESSELS = [];

const INK = 'rgba(236,243,248,0.92)', MUTED = 'rgba(230,238,245,0.55)', FAINT = 'rgba(230,238,245,0.14)', GHOST = 'rgba(230,238,245,0.06)';
const OK = '#5fe39a', WARN = '#ffc35a', CRIT = '#ff6b6b', ACCENT = '#7cc4ff', TEAL = '#4fd1c5', VIOLET = '#c99bff';
const GROUP = { book: ACCENT, speed: OK, repo: WARN };
const KIND = { accept: ACCENT, flex_window: '#a8dbff', alt_hub: OK, split: VIOLET, reject: 'rgba(230,238,245,0.35)', speed: TEAL, reposition: WARN };
const CARGO = { dry: '#8f99a3', reefer: '#e9f3ff', hazmat: '#ff7a2f' };
const BOXES = ['#c43a7a', '#8e3226', '#1f3f6d', '#3f7fb7', '#c9cac6', '#2f6a42', '#d2672b', '#6aa6cc'];
const STAGE_W = [1, 0.8, 1.1, 1, 1.5, 0.8, 1, 1.4];
const CYCLE = 7.6, HOLD = 1.1;
const SPEEDS = [0.5, 1, 2, 4];
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const usd = (v) => `$${nf(v)}`;
const kusd = (v) => (Math.abs(v) >= 1e6 ? `$${nf(v / 1e6, 2)}M` : `$${nf(v / 1e3, 1)}k`);
const pressureColor = (p) => (p > 0.9 ? CRIT : p > 0.5 ? WARN : OK);
const ICON = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  step: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 5l9 7-9 7z" fill="currentColor"/><path d="M18 5v14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="11" height="11"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};

export class ModelPage extends Page {
  constructor(root) {
    super(root);
    this.engine = new LiveEngine();
    this.playing = true;
    this.speedIdx = 1;
    this.phase = 0;
    this.stage = -1;
    this.wake = [];
    this.rot = 0; this.rotFrom = 0; this.rotTo = 0;
    this.hover = {};
    this.waiting = false;
    this.build();
    this.showStatus('Connecting to the live policy…');
    this.boot();
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.target.tagName === 'INPUT') return;
      if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'ArrowRight') this.stepStage();
    });
  }

  /* ---------------------------------------------------------------- boot */
  showStatus(html) {
    if (!this.statusEl) {
      this.statusEl = document.createElement('div');
      this.statusEl.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
        + 'text-align:center;padding:40px;font:600 14px Inter,sans-serif;color:rgba(230,238,245,0.85);'
        + 'background:rgba(6,10,16,0.92);z-index:80;';
      this.root.appendChild(this.statusEl);
    }
    this.statusEl.innerHTML = html;
    this.statusEl.style.display = 'flex';
  }

  hideStatus() { if (this.statusEl) this.statusEl.style.display = 'none'; }

  async boot() {
    try {
      const [network, vessels] = await Promise.all([
        (async () => { await this.engine.init(); return this.engine.network; })(),
        API.vessels(),
      ]);
      ACTIONS = actionsFromNetwork(network);
      VESSELS = vessels.map((v) => ({ id: v.vessel_id, name: v.name, cap: v.capacity_teu, reefer: v.reefer_plugs, fuelA: v.fuel_a_tpd, fuelB: v.fuel_b_tpd }));
    } catch (e) {
      this.showStatus(`<div><b>Live policy unavailable</b><div style="margin-top:8px;opacity:.75;font-weight:500">${(e && e.message) || String(e)}</div></div>`);
      return;
    }
    this.awaitFirst();
  }

  awaitFirst() {
    const tryNext = () => {
      if (this._stopped) return;
      const d = this.engine.next();
      if (d) {
        this.cur = d;
        this.phase = 0;
        this.stage = -1;
        this.rotFrom = this.rot;
        this.rotTo = this.rotFor(d.action);
        this.prepNet(d);
        this.hideStatus();
        return;
      }
      this._awaitTimer = setTimeout(tryNext, 300);
    };
    tryNext();
  }

  /* ---------------------------------------------------------------- DOM */
  build() {
    const r = this.root;
    const card = (stage, key, title, tag, body) => `
      <section class="br-card" data-stage="${stage}" data-card="${key}">
        <div class="card-head"><span>${title}</span>${tag ? `<em class="obs-tag">${tag}</em>` : ''}</div>${body}
      </section>`;
    const block = (k) => OBS_BLOCKS.find((b) => b.key === k);
    const tag = (...ks) => ks.map((k) => { const b = block(k); return `<i style="background:${b.color}"></i>obs[${b.from}:${b.to}]`; }).join(' ');
    r.innerHTML = `
      <div class="pg-wrap br-wrap">
        <header class="pg-head">
          <div class="pg-title">
            <div class="brand"><span class="dot"></span>DOCK <em>Decision engine</em></div>
            <h1>Inside the helm <small>MaskablePPO · live policy · /live/policy</small></h1>
            <div class="sub">Every booking and fleet order, sailed through the model: 112-d observation → 2 × 256 trunk → π over 44 masked actions ⊕ V(s)</div>
            <div class="telemetry" data-k="tele"></div>
          </div>
          <div class="panel br-controls">
            <div class="br-transport">
              <button class="br-play" data-a="play" title="Play / pause (Space)">${ICON.pause}</button>
              <button data-a="step" title="Next stage (→)">${ICON.step}</button>
              <div class="seg" data-k="speeds">${SPEEDS.map((s, i) => `<button data-i="${i}">${s}×</button>`).join('')}</div>
            </div>
            <div class="br-scen"><span class="dot"></span><span data-k="scen">Live world · deterministic policy (argmax)</span></div>
          </div>
        </header>

        <section class="panel br-voyage">
          <div class="card-head"><span>The decision's voyage</span><em data-k="voyageNote">—</em></div>
          <canvas class="cv" data-c="voyage" style="height:96px"></canvas>
        </section>

        <section class="br-main">
          <div class="br-col">
            <div class="br-col-head"><b>01</b> What the agent sees <em>observation · 112 floats</em></div>
            ${card(0, 'req', 'Manifest · the request', tag('req'), `<div class="br-req"><canvas class="cv" data-c="box" style="height:64px"></canvas><div class="br-kv" data-k="req"></div></div>`)}
            ${card(2, 'opt', 'Voyage options · bid price per leg', tag('opt'), `<canvas class="cv" data-c="opts" style="height:176px"></canvas>`)}
            ${card(3, 'sea', 'Harbour & fleet state', tag('port', 'ves'), `<canvas class="cv" data-c="sea" style="height:150px"></canvas>`)}
            ${card(1, 'fc', 'Swell forecast · demand next week', tag('fc', 'cal'), `<canvas class="cv" data-c="fc" style="height:96px"></canvas>`)}
          </div>

          <div class="br-center">
            <div class="br-col-head"><b>02</b> How it thinks <em>policy network · currents = weight × activation</em></div>
            <section class="br-card br-net" data-stage="3" data-card="net">
              <div class="card-head"><span>Trunk &amp; heads</span><em>112 → 256 → 256 → π(44) ⊕ V · 28 of 256 units shown per layer</em></div>
              <canvas class="cv" data-c="net"></canvas>
              <div class="br-why" data-stage="6" data-k="why"></div>
            </section>
          </div>

          <div class="br-col">
            <div class="br-col-head"><b>03</b> What it does <em>masked action · quote · settlement</em></div>
            <section class="br-card" data-stage="4" data-card="helm">
              <div class="card-head"><span>The helm · 44 actions</span><em data-k="maskNote">—</em></div>
              <canvas class="cv" data-c="helm" style="height:318px"></canvas>
              <div class="legend br-legend"><span><i style="background:${ACCENT}"></i>Booking 12</span><span><i style="background:${OK}"></i>Speed 16</span><span><i style="background:${WARN}"></i>Reposition 16</span><span class="mut">${ICON.lock} masked</span></div>
            </section>
            <section class="br-card" data-stage="6" data-card="top">
              <div class="card-head"><span>Policy distribution · top actions</span><em data-k="entNote">—</em></div>
              <div class="br-top" data-k="top"></div>
            </section>
            <section class="br-card" data-stage="6" data-card="price">
              <div class="card-head"><span data-k="priceTitle">Pricing the voyage</span><em data-k="priceNote">—</em></div>
              <canvas class="cv" data-c="price" style="height:132px"></canvas>
            </section>
            <section class="br-card" data-stage="7" data-card="out">
              <div class="card-head"><span>Settlement &amp; ledger</span><em data-k="outNote">—</em></div>
              <div class="br-out" data-k="out"></div>
            </section>
          </div>
        </section>

        <section class="panel br-wakebar">
          <div class="br-wake-l">
            <div class="card-head"><span>Wake · recent decisions</span><em>height = margin over bid floor · dashed = customer walked</em></div>
            <canvas class="cv" data-c="wake" style="height:92px"></canvas>
          </div>
          <div class="br-wake-r" data-stage="7">
            <div class="card-head"><span>Same request, other captains</span><em>margin over bid floor · counterfactual</em></div>
            <div class="br-cf" data-k="cf"></div>
          </div>
        </section>
      </div>`;
    this.k = {}; this.c = {};
    r.querySelectorAll('[data-k]').forEach((el) => (this.k[el.dataset.k] = el));
    r.querySelectorAll('[data-c]').forEach((el) => (this.c[el.dataset.c] = el));
    this.staged = [...r.querySelectorAll('[data-stage]')];
    this.btnPlay = r.querySelector('[data-a="play"]');
    this.btnPlay.onclick = () => this.togglePlay();
    r.querySelector('[data-a="step"]').onclick = () => this.stepStage();
    this.k.speeds.querySelectorAll('button').forEach((b) => (b.onclick = () => this.setSpeed(+b.dataset.i)));
    this.setSpeed(this.speedIdx);

    const pos = (e, c) => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    const helm = this.c.helm;
    helm.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e, helm), g = this.helmGeom;
      if (!g || !this.cur) return;
      const rr = Math.hypot(x - g.cx, y - g.cy);
      let a = Math.atan2(y - g.cy, x - g.cx) - this.rot;
      const i = rr > g.r0 - 4 && rr < g.R ? ACTIONS.findIndex((_, k) => Math.abs(Math.atan2(Math.sin(a - g.ang(k)), Math.cos(a - g.ang(k)))) < g.unit * 0.5) : -1;
      this.hover.helm = i >= 0 ? i : null;
      if (i >= 0) {
        const d = this.cur, act = ACTIONS[i];
        this.tip(e, `<b>${act.label}</b> <span class="mut">#${i}</span><br>${d.mask[i] ? `π = ${(d.probs[i] * 100).toFixed(1)}% · logit ${d.logits[i].toFixed(2)}` : `<span class="mut">masked — ${this.maskReason(d, act)}</span>`}`);
      } else this.tip(null);
    });
    helm.addEventListener('pointerleave', () => { this.hover.helm = null; this.tip(null); });
    const wk = this.c.wake;
    wk.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e, wk);
      const hit = this.wakeHits?.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y - 4 && y <= q.y + q.h + 4);
      this.hover.wake = hit ? hit.k : null;
      if (hit) { const w = this.wake[hit.k]; this.tip(e, `<b>${w.label}</b><br>${w.sub}<br><span class="mut">${w.outcome} · EV ${kusd(w.ev)}</span>`); } else this.tip(null);
    });
    wk.addEventListener('pointerleave', () => { this.hover.wake = null; this.tip(null); });
  }

  tip(e, html) {
    const t = document.getElementById('tooltip');
    if (!e || !html) { t.classList.remove('show'); return; }
    t.classList.remove('light');
    t.innerHTML = html; t.style.left = `${e.clientX}px`; t.style.top = `${e.clientY}px`;
    t.classList.add('show');
  }

  togglePlay() { this.playing = !this.playing; this.btnPlay.innerHTML = this.playing ? ICON.pause : ICON.play; }
  setSpeed(i) { this.speedIdx = i; this.k.speeds.querySelectorAll('button').forEach((b, j) => b.classList.toggle('active', j === i)); }
  stepStage() {
    const b = this.bounds();
    const s = Math.max(0, this.stage);
    if (s >= STAGES.length - 1) this.phase = b.total + HOLD + 0.001;
    else this.phase = b.starts[s + 1] + 0.001;
    if (this.playing) this.togglePlay();
  }
  onShow() { this.stage = -1; }
  onHide() { this.tip(null); }

  bounds() {
    const sum = STAGE_W.reduce((a, b) => a + b, 0);
    const starts = []; let acc = 0;
    for (const w of STAGE_W) { starts.push(acc); acc += (w / sum) * CYCLE; }
    return { starts, total: acc, len: STAGE_W.map((w) => (w / sum) * CYCLE) };
  }

  nextDecision() {
    const nxt = this.engine.next();
    if (!nxt) {
      // Nothing new from the live world yet — hold on the current decision
      // rather than advancing into nothing.
      this.waiting = true;
      this.phase = this.bounds().total + HOLD;
      return;
    }
    this.waiting = false;
    if (this.cur) {
      const d = this.cur, a = ACTIONS[d.action];
      this.wake.unshift({
        kind: a.kind, color: KIND[a.kind], ev: d.ev, ok: d.outcome.ok || d.type === 'fleet',
        label: a.label, outcome: d.outcome.key,
        sub: d.req ? `${d.req.origin} → ${d.req.dest} · ${d.req.teu} TEU · ${d.req.segment}` : 'fleet order',
      });
      this.wake.length = Math.min(this.wake.length, 40);
      this.wakeT = this.time;
    }
    this.cur = nxt;
    this.phase = 0;
    this.stage = -1;
    this.rotFrom = this.rot;
    this.rotTo = this.rotFor(this.cur.action);
    this.prepNet(this.cur);
  }

  /* ---------------------------------------------------------------- frame */
  draw(dt) {
    if (!this.cur) return;
    const b = this.bounds();
    if (this.playing) this.phase += dt * SPEEDS[this.speedIdx];
    if (this.phase > b.total + HOLD) this.nextDecision();
    let s = 0;
    while (s < STAGES.length - 1 && this.phase >= b.starts[s + 1]) s++;
    this.u = clamp((this.phase - b.starts[s]) / b.len[s]);
    if (this.phase >= b.total) this.u = 1;
    if (s !== this.stage) { this.stage = s; this.syncDOM(); }
    const r6 = this.sp(6);
    this.rot = this.rotFrom + (this.rotTo - this.rotFrom) * ease(r6);
    this.drawVoyage(); this.drawBox(); this.drawOptions(); this.drawSea(); this.drawForecast();
    this.drawNet(); this.drawHelm(); this.drawPrice(); this.drawWake();
  }

  // progress of stage s: 0 before, u during, 1 after
  sp(s) { return this.stage > s ? 1 : this.stage < s ? 0 : this.u; }

  maskReason(d, a) {
    if (d.type === 'fleet' && a.group === 'book') return 'fleet step · no booking on the table';
    if (d.type === 'booking' && a.group !== 'book') return 'booking step · fleet orders gated';
    if (a.kind === 'accept') return d.options[0].reason || 'option 0 infeasible';
    if (a.kind === 'flex_window') return d.options[1].reason || 'discount too small for an urgent shipper';
    if (a.kind === 'alt_hub') return d.options[2].reason || 'alt hub infeasible';
    if (a.kind === 'split') return (d.req && d.req.teu < 20) ? 'consignment too small to split' : 'second sailing cannot take the remainder';
    if (a.kind === 'speed') return a.vessel === d.inPort ? `${VESSELS[a.vessel]?.id ?? `VES${a.vessel + 1}`} alongside` : 'outside the vessel\'s speed table';
    if (a.kind === 'reposition') {
      const pair = d.repoPairs && d.repoPairs[a.pair];
      return pair ? `not enough empties at ${pair[0]}${d.shock && pair[0] === 'NLRTM' ? ' (port closed)' : ''}` : 'not enough empties on this pair';
    }
    return 'infeasible';
  }

  syncDOM() {
    const d = this.cur, s = this.stage, a = ACTIONS[d.action];
    this.staged.forEach((el) => el.classList.toggle('pending', +el.dataset.stage > s));
    this.k.voyageNote.textContent = this.waiting
      ? `step ${nf(d.step)} · holding — waiting for the next live decision…`
      : `step ${nf(d.step)} · ${d.type === 'booking' ? 'booking step' : 'fleet step'} · ${STAGES[s].label.toLowerCase()} — ${STAGES[s].sub}`;
    if (this.filledFor !== d) {
      this.filledFor = d;
      this.k.top.innerHTML = ''; this.k.why.innerHTML = ''; this.k.out.innerHTML = ''; this.k.cf.innerHTML = '';
      this.k.tele.innerHTML = [
        // V(s) is a discounted *shaped-reward* estimate, not dollars — shown
        // as the raw number, never ×10,000 or formatted as $.
        ['Step', nf(d.step), ''], ['Day', nf(d.day, 1), d.shock ? 'shock' : ''], ['V(s)', d.value.toFixed(1), 'value est.'],
        ['Entropy', d.entropy.toFixed(2), 'nats'], ['Masked', `${d.masked}`, '/ 44'],
      ].map(([l, v, u]) => `<div><label>${l}</label><span>${v}</span><small>${u}</small></div>`).join('');
      if (d.req) {
        const r = d.req;
        this.k.req.innerHTML = [
          ['Route', `${r.origin} → ${r.dest}`], ['Volume', `${r.teu} TEU`], ['Segment', r.segment], ['Cargo', r.cargo],
          ['Req. sailing', `day ${nf(r.reqDep, 1)}`], ['Flex', r.flex ? `± ${r.flex} d` : 'none'], ['Market', `${usd(r.market)}/TEU`],
          ['WTP', `<span class="mut">${ICON.lock} hidden</span>`],
        ].map(([l, v]) => `<div><label>${l}</label><span>${v}</span></div>`).join('');
      } else {
        this.k.req.innerHTML = `<div class="br-fleetmsg"><b>Fleet step</b><span>No booking on the table. The mask closes all 12 booking spokes and opens speed &amp; repositioning orders.</span></div>`;
      }
      this.k.maskNote.textContent = '—'; this.k.entNote.textContent = '—'; this.k.outNote.textContent = '—';
    }
    if (s >= 5) this.k.maskNote.textContent = `${d.masked} of 44 anchored`;
    if (s >= 6) {
      const top = d.probs.map((p, i) => [p, i]).filter(([, i]) => d.mask[i]).sort((x, y) => y[0] - x[0]).slice(0, 5);
      this.k.top.innerHTML = top.map(([p, i]) => `
        <div class="br-bar ${i === d.action ? 'on' : ''}"><i style="background:${GROUP[ACTIONS[i].group]}"></i><span>${ACTIONS[i].label}</span>
          <b>${(p * 100).toFixed(1)}%</b><em style="width:${(p * 100).toFixed(1)}%;background:${GROUP[ACTIONS[i].group]}"></em></div>`).join('')
        + `<div class="br-note">${d.masked} actions masked before the softmax · deterministic eval takes argmax</div>`;
      this.k.entNote.textContent = `H = ${d.entropy.toFixed(2)} nats`;
      this.k.priceTitle.textContent = d.quote ? 'Pricing the voyage · argmax P(accept)·(p − bid)' : a.kind === 'speed' ? 'Engine order · fuel ∝ v³' : 'Empties · before & after';
      this.k.priceNote.textContent = d.quote ? (d.quote.offer ? `${d.quote.reason.replace(/_/g, ' ')}` : 'no profitable price') : a.label;
      this.k.why.innerHTML = `<div class="br-why-head">Why · top attributions toward <b>${a.label}</b></div>` + d.attr.map((f, k) => `
        <div class="br-attr"><b>${k + 1}</b><span>${f.label}</span><em class="${f.w >= 0 ? 'pos' : 'neg'}"><i style="width:${Math.min(100, Math.abs(f.w) * 110).toFixed(0)}%"></i></em><small>${f.w >= 0 ? '+' : '−'}${Math.abs(f.w).toFixed(2)}</small></div>`).join('');
    }
    if (s >= 7) {
      const o = d.outcome;
      this.k.outNote.textContent = o.key;
      this.k.out.innerHTML = `
        <div class="br-stamp ${o.ok ? 'ok' : o.key.startsWith('rejected') ? 'bad' : 'warn'}">${o.stamp}</div>
        <p>${d.explain}</p>
        <div class="br-ledger"><span>ledger #${nf(d.ledger.seq)}</span><code>0x${d.ledger.hash.slice(0, 10)}…${d.ledger.hash.slice(-6)}</code><span class="mut">prev 0x${d.ledger.prev.slice(0, 6)}… · keccak-256 chained</span></div>
        ${d.onchain ? `<div class="br-ledger chain"><span>deal registered</span><code>tx 0x${d.ledger.tx.slice(0, 10)}…</code><span class="mut">DockSettlement · window ±2 d · penalty 10%</span></div>` : ''}`;
      this.k.cf.innerHTML = d.baselines
        ? d.baselines.map((q) => `<div class="br-cfc ${q.key === 'ppo' ? 'on' : ''}"><label>${q.label}</label><b>${q.kind}</b><span>${q.price ? `${usd(q.price)}/TEU` : '—'}</span><em>${kusd(q.ev)}</em></div>`).join('')
        : `<div class="br-cfc wide"><label>Fleet step</label><b>Baselines hold speed and never reposition proactively</b><span>Dock order: ${a.label}</span><em>${kusd(d.ev)}</em></div>`;
    }
  }

  /* ---------------------------------------------------------------- voyage pipeline */
  drawVoyage() {
    const { g, w, h } = fit(this.c.voyage);
    const d = this.cur, t = this.time, n = STAGES.length;
    const pad = 46, mid = 34;
    const X = (i) => pad + (i * (w - pad * 2)) / (n - 1);
    const Y = (x) => mid + Math.sin(((x - pad) / (w - pad * 2)) * Math.PI * 3) * 6;
    // lane
    g.strokeStyle = FAINT; g.lineWidth = 2; g.setLineDash([2, 6]);
    g.beginPath(); for (let x = pad; x <= w - pad; x += 4) g.lineTo(x, Y(x)); g.stroke(); g.setLineDash([]);
    const shipX = this.stage < n - 1 ? lerp(X(this.stage), X(this.stage + 1), ease(this.u)) : X(n - 1);
    g.strokeStyle = rgba(ACCENT, 0.7); g.lineWidth = 2;
    g.beginPath(); for (let x = pad; x <= shipX; x += 4) g.lineTo(x, Y(x)); g.stroke();
    // stations
    STAGES.forEach((s, i) => {
      const x = X(i), y = Y(x), done = i < this.stage || (i === this.stage && this.u >= 1), cur = i === this.stage;
      if (cur) { const p = (t * 1.2) % 1; g.strokeStyle = rgba(ACCENT, 0.5 * (1 - p)); g.lineWidth = 2; g.beginPath(); g.arc(x, y, 13 + p * 10, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = done ? ACCENT : cur ? 'rgba(124,196,255,0.25)' : 'rgba(12,18,26,0.8)';
      g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill();
      g.strokeStyle = done || cur ? ACCENT : FAINT; g.lineWidth = 1.2; g.stroke();
      g.fillStyle = done ? '#081018' : INK; g.font = '700 9.5px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(String(i + 1).padStart(2, '0'), x, y + 3.5);
      g.fillStyle = i <= this.stage ? INK : MUTED; g.font = '700 10.5px Inter, sans-serif';
      g.fillText(s.label, x, y + 30);
      g.fillStyle = MUTED; g.font = '500 9.5px Inter, sans-serif';
      g.fillText(done && d.latency[i] != null ? `${s.sub} · ${d.latency[i]} ms` : s.sub, x, y + 43);
    });
    // the decision itself, sailing between stations
    const sy = Y(shipX) - 6, len = 34;
    g.save(); g.translate(shipX, sy); g.rotate(Math.atan2(Y(shipX + 1) - Y(shipX - 1), 2) * 0.6);
    drawShip(g, -len / 2, 0, len, { hull: '#dfe9f2', colors: BOXES, house: '#9fb0c0', ink: 'rgba(8,16,24,0.7)', fill: 0.8, seed: d.step % 17, bowWave: this.playing ? 1 : 0 });
    g.restore();
  }

  /* ---------------------------------------------------------------- inputs */
  drawBox() {
    const { g, w, h } = fit(this.c.box);
    const d = this.cur, a = easeOut(this.sp(0) * 1.4);
    if (!d.req) {
      drawShip(g, w / 2 - 50, h - 10, 100, { hull: '#dfe9f2', colors: BOXES, house: '#9fb0c0', ink: 'rgba(8,16,24,0.7)', fill: 0.7, seed: 4, bowWave: 1 });
      return;
    }
    const r = d.req, col = CARGO[r.cargo];
    const bw = Math.min(w - 16, 150), bh = 40, x = (w - bw) / 2 + (1 - a) * -40, y = h - bh - 12;
    g.globalAlpha = a;
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(x + bw / 2, h - 8, bw * 0.55, 4, 0, 0, Math.PI * 2); g.fill();
    const gr = g.createLinearGradient(0, y, 0, y + bh);
    gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = col; g.fillRect(x, y, bw, bh);
    g.fillStyle = gr; g.globalAlpha = a * 0.5; g.fillRect(x, y, bw, bh); g.globalAlpha = a;
    g.fillStyle = 'rgba(0,0,0,0.14)'; for (let s = x + 5; s < x + bw - 4; s += 4) g.fillRect(s, y + 3, 1.6, bh - 6);
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x, y, bw, 3); g.fillRect(x, y + bh - 3, bw, 3); g.fillRect(x, y, 4, bh); g.fillRect(x + bw - 4, y, 4, bh);
    if (r.cargo === 'reefer') { g.fillStyle = '#2b3a48'; g.fillRect(x + bw - 22, y + 6, 16, bh - 12); g.fillStyle = '#7cc4ff'; g.beginPath(); g.arc(x + bw - 14, y + bh / 2, 4.5, 0, Math.PI * 2); g.fill(); }
    if (r.cargo === 'hazmat') {
      g.save(); g.translate(x + bw - 20, y + bh / 2); g.rotate(Math.PI / 4);
      g.fillStyle = '#fff'; g.fillRect(-8, -8, 16, 16); g.strokeStyle = '#c0392b'; g.lineWidth = 1.5; g.strokeRect(-6.5, -6.5, 13, 13); g.restore();
      g.fillStyle = '#c0392b'; g.font = '800 7px Inter, sans-serif'; g.textAlign = 'center'; g.fillText('3', x + bw - 20, y + bh / 2 + 3);
    }
    g.fillStyle = r.cargo === 'reefer' ? '#1b2530' : '#fff'; g.font = '800 11px Inter, sans-serif'; g.textAlign = 'left';
    g.fillText(`${r.teu} TEU`, x + 10, y + 17);
    g.font = '700 8.5px Inter, sans-serif'; g.globalAlpha = a * 0.8;
    g.fillText(`${r.origin} → ${r.dest} · #${r.id}`, x + 10, y + 30);
    g.globalAlpha = 1;
  }

  drawOptions() {
    const { g, w, h } = fit(this.c.opts);
    const d = this.cur, p2 = this.sp(2), t = this.time;
    if (!d.options.length) {
      g.fillStyle = MUTED; g.font = '600 11px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText('Fleet step — option block zeroed (obs[14:34] = 0)', w / 2, h / 2);
      return;
    }
    const rowH = h / 4, sx0 = 104, sx1 = w - 72;
    const chosenOpt = this.stage >= 6 && d.quote ? d.quote.opt : -1;
    d.options.forEach((o, k) => {
      const y = k * rowH + 4, cy = y + rowH / 2;
      if (chosenOpt === k) { g.strokeStyle = ACCENT; g.lineWidth = 1.2; roundRect(g, 1, y, w - 2, rowH - 6, 8); g.stroke(); g.fillStyle = 'rgba(124,196,255,0.07)'; g.fill(); }
      g.textAlign = 'left'; g.fillStyle = INK; g.font = '700 10px Inter, sans-serif';
      g.fillText(`OPT ${k} · ${o.vessel.id}`, 8, cy - 4);
      g.fillStyle = MUTED; g.font = '500 9px Inter, sans-serif';
      g.fillText(k === 2 ? `alt hub ${o.dest}` : (o.dep != null ? `dep day ${nf(o.dep, 1)}` : 'no sailing'), 8, cy + 9);
      if (!o.legs.length) { g.fillStyle = MUTED; g.fillText(o.reason ? `— ${o.reason}` : '— no partner hub on this lane', sx0, cy + 3); return; }
      const n = o.legs.length, lw = (sx1 - sx0) / n;
      o.legs.forEach((l, j) => {
        const x0 = sx0 + j * lw, x1 = x0 + lw - 3, fillP = clamp(p2 * 1.6 - j * 0.25);
        g.fillStyle = GHOST; roundRect(g, x0, cy - 5, x1 - x0, 10, 5); g.fill();
        g.fillStyle = pressureColor(l.pressure); g.globalAlpha = 0.85;
        roundRect(g, x0, cy - 5, Math.max(4, (x1 - x0) * clamp(l.pressure / 1.4) * fillP), 10, 5); g.fill(); g.globalAlpha = 1;
        g.fillStyle = MUTED; g.font = '600 8px Inter, sans-serif'; g.textAlign = 'left';
        g.fillText(l.from, x0, cy - 9);
        if (j === n - 1) { g.textAlign = 'right'; g.fillText(l.to, x1, cy - 9); }
        if (fillP > 0.5) { g.textAlign = 'left'; g.fillStyle = MUTED; g.font = '500 8px Inter, sans-serif'; g.fillText(`p ${l.pressure.toFixed(2)} · ${nf(l.remaining)} left`, x0, cy + 16); }
      });
      g.textAlign = 'right'; g.fillStyle = INK; g.font = '700 11px Inter, sans-serif';
      g.fillText(`$${nf(o.bid * easeOut(p2))}`, w - 8, cy - 1);
      g.fillStyle = MUTED; g.font = '500 8.5px Inter, sans-serif'; g.fillText('bid / TEU', w - 8, cy + 11);
      if (!o.feasible) {
        g.save(); roundRect(g, sx0 - 4, cy - 12, sx1 - sx0 + 8, 30, 6); g.clip();
        g.strokeStyle = 'rgba(255,107,107,0.35)'; g.lineWidth = 1;
        for (let s = sx0 - 40 + ((t * 10) % 8); s < sx1 + 20; s += 8) { g.beginPath(); g.moveTo(s, cy + 18); g.lineTo(s + 30, cy - 12); g.stroke(); }
        g.restore();
        g.fillStyle = 'rgba(12,18,26,0.85)'; g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center';
        const tw = g.measureText(o.reason).width + 14;
        roundRect(g, (sx0 + sx1) / 2 - tw / 2, cy - 7, tw, 15, 7.5); g.fill();
        g.fillStyle = CRIT; g.fillText(o.reason, (sx0 + sx1) / 2, cy + 3.5);
      }
    });
  }

  drawSea() {
    const { g, w, h } = fit(this.c.sea);
    const d = this.cur, t = this.time, a = this.sp(3) > 0 ? 1 : 0.35;
    g.globalAlpha = a;
    const wl = 58;
    g.fillStyle = 'rgba(124,196,255,0.06)'; g.fillRect(0, wl, w, 34);
    g.strokeStyle = 'rgba(124,196,255,0.3)'; g.lineWidth = 1;
    g.beginPath(); for (let x = 0; x <= w; x += 3) g.lineTo(x, wl + Math.sin(x * 0.07 + t * 1.6) * 1.2); g.stroke();
    const n = d.ports.length, cw = w / n;
    d.ports.forEach((p, i) => {
      const x = cw * (i + 0.5), bob = Math.sin(t * (1.4 + p.congestion) + i) * (1 + p.congestion * 3);
      const col = p.closed ? CRIT : pressureColor(p.congestion * 1.1);
      const by = wl + 4 + bob;
      // buoy: can body, cage, light
      g.fillStyle = col; g.globalAlpha = a * 0.9;
      g.beginPath(); g.moveTo(x - 7, by); g.lineTo(x + 7, by); g.lineTo(x + 4, by - 16); g.lineTo(x - 4, by - 16); g.closePath(); g.fill();
      g.globalAlpha = a;
      g.strokeStyle = INK; g.lineWidth = 1; g.beginPath(); g.moveTo(x, by - 16); g.lineTo(x, by - 26); g.moveTo(x - 4, by - 22); g.lineTo(x + 4, by - 22); g.stroke();
      const blink = (Math.sin(t * (2 + p.congestion * 5) + i * 2) + 1) / 2;
      const lg = g.createRadialGradient(x, by - 28, 0, x, by - 28, 10);
      lg.addColorStop(0, rgba(col, 0.6 * blink)); lg.addColorStop(1, rgba(col, 0));
      g.fillStyle = lg; g.beginPath(); g.arc(x, by - 28, 10, 0, Math.PI * 2); g.fill();
      g.fillStyle = col; g.beginPath(); g.arc(x, by - 28, 2.2, 0, Math.PI * 2); g.fill();
      // empties on the quay
      const ne = Math.min(6, Math.round(p.empties / 280));
      for (let k = 0; k < ne; k++) { g.strokeStyle = 'rgba(230,238,245,0.45)'; g.strokeRect(x + 9 + (k % 2) * 7, by - 5 - Math.floor(k / 2) * 5, 6, 4); }
      if (p.closed) { g.strokeStyle = CRIT; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 8, by - 40); g.lineTo(x + 8, by - 32); g.moveTo(x + 8, by - 40); g.lineTo(x - 8, by - 32); g.stroke(); }
      g.fillStyle = INK; g.font = '700 8.5px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(p.code, x, wl + 22);
      g.fillStyle = MUTED; g.font = '500 8px Inter, sans-serif';
      g.fillText(p.closed ? 'closed' : `${nf(p.congestion * 100)}% berth`, x, wl + 32);
    });
    // fleet row
    const fy = h - 8, fw = w / 4;
    d.fleet.forEach((v, i) => {
      const x = fw * i + 10, len = fw - 36;
      g.fillStyle = 'rgba(124,196,255,0.08)'; g.fillRect(fw * i + 4, fy - 4, fw - 8, 6);
      drawShip(g, x, fy + Math.sin(t * 1.5 + i) * 0.6, len, { hull: v.inPort ? '#6d7a86' : '#dfe9f2', colors: BOXES, house: '#9fb0c0', ink: 'rgba(8,16,24,0.7)', fill: v.fill, seed: 50 + i, bowWave: v.inPort ? 0 : v.speed / 18 });
      g.fillStyle = INK; g.font = '700 8.5px Inter, sans-serif'; g.textAlign = 'left';
      g.fillText(v.id, fw * i + 8, fy - len * 0.34 - 8);
      g.fillStyle = MUTED; g.font = '500 8px Inter, sans-serif';
      g.fillText(v.inPort ? 'alongside' : `${v.speed} kn · ${nf(v.fill * 100)}%`, fw * i + 34, fy - len * 0.34 - 8);
    });
    g.globalAlpha = 1;
  }

  drawForecast() {
    const { g, w, h } = fit(this.c.fc);
    const d = this.cur, t = this.time, p = this.sp(1);
    const dial = 74, x0 = 6, x1 = w - dial - 12, top = 14, bot = h - 18;
    const n = d.forecast.length, X = (i) => x0 + (i / (n - 1)) * (x1 - x0), Y = (v) => bot - v * (bot - top);
    const hl = d.attr.find((f) => f.idx >= 84 && f.idx < 102)?.idx - 84;
    // swell body
    const gr = g.createLinearGradient(0, top, 0, bot);
    gr.addColorStop(0, rgba(TEAL, 0.5)); gr.addColorStop(1, rgba(TEAL, 0.04));
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(x0, bot);
    for (let x = x0; x <= x1; x += 2) {
      const f = ((x - x0) / (x1 - x0)) * (n - 1), i = Math.floor(f), k = f - i;
      const v = lerp(d.forecast[i], d.forecast[Math.min(n - 1, i + 1)], (1 - Math.cos(k * Math.PI)) / 2) * (0.25 + 0.75 * easeOut(p));
      g.lineTo(x, Y(v) + Math.sin(x * 0.12 + t * 2.4) * 1.2);
    }
    g.lineTo(x1, bot); g.closePath(); g.fill();
    g.strokeStyle = TEAL; g.lineWidth = 1.3; g.stroke();
    for (let i = 0; i < n; i++) {
      g.fillStyle = i === hl ? '#fff' : FAINT; g.fillRect(X(i) - 0.5, bot + 2, 1, i === hl ? 7 : 4);
      if (i === hl) { g.strokeStyle = 'rgba(255,255,255,0.6)'; g.setLineDash([2, 2]); g.beginPath(); g.moveTo(X(i), top); g.lineTo(X(i), bot); g.stroke(); g.setLineDash([]); g.fillStyle = INK; g.font = '700 8.5px Inter, sans-serif'; g.textAlign = 'center'; g.fillText('this lane', X(i), top - 3); }
    }
    g.fillStyle = MUTED; g.font = '500 8px Inter, sans-serif'; g.textAlign = 'left';
    g.fillText('18 route-week slots · forecaster.next_week() · no oracle', x0, h - 2);
    // calendar dial: day of week hand + week ring
    const cx = w - dial / 2 - 4, cy = h / 2 - 2, R = dial / 2 - 6;
    g.strokeStyle = FAINT; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = rgba(ACCENT, 0.6); g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, R + 3, -Math.PI / 2, -Math.PI / 2 + (d.day / 90) * Math.PI * 2); g.stroke();
    'MTWTFSS'.split('').forEach((c, i) => {
      const an = -Math.PI / 2 + (i / 7) * Math.PI * 2;
      g.fillStyle = i === d.calendar.dow ? INK : MUTED; g.font = `${i === d.calendar.dow ? 800 : 600} 8px Inter, sans-serif`; g.textAlign = 'center';
      g.fillText(c, cx + Math.cos(an) * (R - 8), cy + Math.sin(an) * (R - 8) + 3);
    });
    const han = -Math.PI / 2 + ((d.calendar.dow + d.calendar.frac) / 7) * Math.PI * 2;
    g.strokeStyle = INK; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(han) * (R - 16), cy + Math.sin(han) * (R - 16)); g.stroke();
    g.fillStyle = INK; g.font = '700 8px Inter, sans-serif'; g.fillText(`W${d.calendar.week}`, cx, cy + 14);
  }

  /* ---------------------------------------------------------------- the network as currents */
  prepNet(d) {
    const net = this.engine.network;
    const top = (arr, k) => arr.sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, k);
    this.e1 = []; this.e2 = []; this.e3 = [];
    net.w1.forEach((w, j) => this.e1.push(...top(w.map((wi, i) => ({ i, j, c: wi * d.obs[i] })), 3)));
    net.w2.forEach((w, j) => this.e2.push(...top(w.map((wi, i) => ({ i, j, c: wi * d.h1[i] })), 3)));
    net.w3.forEach((w, a) => { if (d.mask[a]) this.e3.push(...top(w.map((wi, j) => ({ j, a, c: wi * d.h2[j] })), 2)); });
    const norm = (arr) => { const m = Math.max(1e-6, ...arr.map((q) => Math.abs(q.c))); arr.forEach((q, k) => { q.n = Math.abs(q.c) / m; q.seed = (k * 0.618) % 1; }); };
    norm(this.e1); norm(this.e2); norm(this.e3);
    // Masked actions get a uniform stub (not a score) until the mask stage
    // removes them — the API nulls masked logits/probs, so nothing is implied.
    this.ghost = ACTIONS.map(() => 0.08);
    // attribution streams: obs cell → strongest h1 unit for that input → path h2 → action
    this.streams = d.attr.map((f, k) => {
      let bj = 0, bw = 0;
      net.w1.forEach((w, j) => { if (Math.abs(w[f.idx]) > bw) { bw = Math.abs(w[f.idx]); bj = j; } });
      return { ...f, h1: bj, h2: d.path.h2[k % d.path.h2.length], k };
    });
  }

  drawNet() {
    const c = this.c.net;
    const { g, w, h } = fit(c);
    const d = this.cur, t = this.time;
    const top = 22, bot = h - 14;
    const tapeX = 128, tapeW = 11, h1X = w * 0.4, h2X = w * 0.6, outX = w - 138;
    const cellH = (bot - top) / 112;
    const tapeY = (i) => top + (i + 0.5) * cellH;
    const nodeY = (i, n) => top + 12 + (i + 0.5) * ((bot - top - 24) / n);
    const rowH = (bot - top) / (44 + 2.4);
    const outY = (i) => top + (i + (i >= 12 ? 1.2 : 0) + (i >= 28 ? 1.2 : 0) + 0.5) * rowH;
    const pObs = this.sp(3), pFwd = this.sp(4), pMask = this.sp(5), pAct = this.sp(6);

    // column captions
    g.fillStyle = MUTED; g.font = '700 8.5px Inter, sans-serif'; g.textAlign = 'center';
    g.fillText('OBS', tapeX + tapeW / 2, top - 8); g.fillText('H1 · 256', h1X, top - 8); g.fillText('H2 · 256', h2X, top - 8); g.fillText('π · 44', outX + 6, top - 8);

    // observation tape with block brackets
    const shown = this.stage > 3 ? 112 : Math.floor(112 * pObs);
    for (const b of OBS_BLOCKS) {
      const y0 = tapeY(b.from) - cellH / 2, y1 = tapeY(b.to - 1) + cellH / 2;
      g.fillStyle = b.color; g.fillRect(tapeX - 7, y0 + 1, 2, y1 - y0 - 2);
      g.textAlign = 'right'; g.fillStyle = INK; g.font = '700 9px Inter, sans-serif';
      g.fillText(b.label, tapeX - 12, (y0 + y1) / 2 + 1);
      g.fillStyle = MUTED; g.font = '500 8px Inter, sans-serif';
      g.fillText(`[${b.from}:${b.to}]`, tapeX - 12, (y0 + y1) / 2 + 11);
      for (let i = b.from; i < b.to; i++) {
        const v = d.obs[i], on = i < shown;
        g.fillStyle = on ? (v < 0 ? rgba(CRIT, 0.2 + 0.75 * clamp(-v)) : rgba(b.color, 0.1 + 0.85 * clamp(v))) : GHOST;
        g.fillRect(tapeX, tapeY(i) - cellH / 2 + 0.3, tapeW, Math.max(0.6, cellH - 0.6));
      }
    }
    if (this.stage === 3) { const y = tapeY(shown); g.fillStyle = '#fff'; g.fillRect(tapeX - 3, y - 0.5, tapeW + 6, 1); }

    // skeleton nodes (always), then the forward pass clipped at the wavefront
    const nodes = (X, acts, n, lit, hl) => {
      for (let i = 0; i < n; i++) {
        const y = nodeY(i, n), a = lit ? acts[i] : 0;
        if (lit && a > 0.05) { const gr = g.createRadialGradient(X, y, 0, X, y, 12); gr.addColorStop(0, rgba(ACCENT, 0.35 * a)); gr.addColorStop(1, rgba(ACCENT, 0)); g.fillStyle = gr; g.beginPath(); g.arc(X, y, 12, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = lit ? rgba(ACCENT, 0.08 + 0.9 * a) : 'rgba(12,18,26,0.9)';
        g.beginPath(); g.arc(X, y, 4.2, 0, Math.PI * 2); g.fill();
        g.strokeStyle = hl?.includes(i) && this.stage >= 6 ? '#fff' : FAINT; g.lineWidth = hl?.includes(i) && this.stage >= 6 ? 1.5 : 1; g.stroke();
      }
    };
    const curve = (x0, y0, x1, y1) => { const mx = (x0 + x1) / 2; g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(mx, y0, mx, y1, x1, y1); };
    const bez = (x0, y0, x1, y1, u) => { const mx = (x0 + x1) / 2, v = 1 - u; return [v * v * v * x0 + 3 * v * v * u * mx + 3 * v * u * u * mx + u * u * u * x1, v * v * v * y0 + 3 * v * v * u * y0 + 3 * v * u * u * y1 + u * u * u * y1]; };
    const layers = [
      { edges: this.e1, from: (e) => [tapeX + tapeW, tapeY(e.i)], to: (e) => [h1X - 4, nodeY(e.j, 28)] },
      { edges: this.e2, from: (e) => [h1X + 4, nodeY(e.i, 28)], to: (e) => [h2X - 4, nodeY(e.j, 28)] },
      { edges: this.e3, from: (e) => [h2X + 4, nodeY(e.j, 28)], to: (e) => [outX - 2, outY(e.a)] },
    ];
    const front = this.stage > 4 ? w : this.stage < 4 ? 0 : lerp(tapeX + tapeW, outX, easeOut(pFwd));
    // faint skeleton edges before the pass
    g.lineWidth = 0.6; g.strokeStyle = GHOST;
    for (const L of layers) for (const e of L.edges) { const [x0, y0] = L.from(e), [x1, y1] = L.to(e); curve(x0, y0, x1, y1); g.stroke(); }
    g.save(); g.beginPath(); g.rect(0, 0, front, h); g.clip();
    for (const L of layers) for (const e of L.edges) {
      const [x0, y0] = L.from(e), [x1, y1] = L.to(e);
      g.strokeStyle = e.c >= 0 ? rgba(ACCENT, 0.05 + 0.4 * e.n) : rgba(CRIT, 0.05 + 0.35 * e.n);
      g.lineWidth = 0.6 + 1.6 * e.n; curve(x0, y0, x1, y1); g.stroke();
      if (e.n > 0.35) {
        for (let k = 0; k < 2; k++) {
          const u = (t * (0.35 + e.n * 0.4) + e.seed + k * 0.5) % 1;
          const [px, py] = bez(x0, y0, x1, y1, u);
          g.fillStyle = e.c >= 0 ? 'rgba(200,235,255,0.9)' : 'rgba(255,190,190,0.9)';
          g.beginPath(); g.arc(px, py, 1.1 + e.n, 0, Math.PI * 2); g.fill();
        }
      }
    }
    g.restore();
    if (this.stage === 4) { const gr = g.createLinearGradient(front - 40, 0, front, 0); gr.addColorStop(0, 'rgba(124,196,255,0)'); gr.addColorStop(1, 'rgba(124,196,255,0.18)'); g.fillStyle = gr; g.fillRect(front - 40, top, 40, bot - top); }
    nodes(h1X, d.h1, 28, front > h1X, this.streams.map((s) => s.h1));
    nodes(h2X, d.h2, 28, front > h2X, d.path.h2);

    // policy head rows
    const maxP = Math.max(...d.probs);
    const groups = [['BOOK', 0, 12, ACCENT], ['SPEED', 12, 28, OK], ['REPO', 28, 44, WARN]];
    for (const [lbl, a0, a1, col] of groups) {
      g.fillStyle = col; g.fillRect(outX - 8, outY(a0) - rowH / 2 + 1, 2, outY(a1 - 1) - outY(a0) + rowH - 2);
      g.save(); g.translate(outX - 13, (outY(a0) + outY(a1 - 1)) / 2); g.rotate(-Math.PI / 2); g.fillStyle = MUTED; g.font = '700 8px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(lbl, 0, 0); g.restore();
    }
    for (let i = 0; i < 44; i++) {
      const y = outY(i), act = ACTIONS[i], on = d.mask[i], chosen = i === d.action && this.stage >= 6;
      const lit = front >= outX;
      const len = lit ? (on ? (d.probs[i] / maxP) * easeOut(pFwd) : this.ghost[i] * (1 - pMask)) : 0;
      g.fillStyle = chosen ? '#fff' : GHOST; g.fillRect(outX, y - rowH * 0.36, 12, rowH * 0.72);
      if (len > 0) { g.fillStyle = on ? rgba(GROUP[act.group], chosen ? 1 : 0.35 + 0.6 * (d.probs[i] / maxP)) : 'rgba(230,238,245,0.18)'; g.fillRect(outX + 14, y - rowH * 0.3, Math.max(1.5, len * 70), rowH * 0.6); }
      if (!on && pMask > 0) { g.globalAlpha = pMask; g.strokeStyle = 'rgba(230,238,245,0.3)'; g.lineWidth = 1; g.beginPath(); g.moveTo(outX + 1, y + rowH * 0.3); g.lineTo(outX + 11, y - rowH * 0.3); g.stroke(); g.globalAlpha = 1; }
      if (rowH > 9) {
        g.fillStyle = chosen ? INK : on ? MUTED : 'rgba(230,238,245,0.25)'; g.font = `${chosen ? 800 : 600} ${Math.min(8.5, rowH * 0.62)}px Inter, sans-serif`; g.textAlign = 'right';
        const pair = d.repoPairs && d.repoPairs[act.pair];
        const lbl = act.group === 'speed' ? `${VESSELS[act.vessel]?.id ?? `VES${act.vessel + 1}`} ${act.kt}kn` : act.group === 'repo' ? (pair ? `${pair[0].slice(0, 2)}→${pair[1].slice(0, 2)} ${act.teu}` : `#${act.pair + 1} ${act.teu}`) : act.short;
        g.fillText(lbl, w - 4, y + 3);
      }
      if (chosen) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(outX - 1.5, y - rowH * 0.5, w - outX - 2, rowH); }
    }

    // attribution currents (after the action is taken)
    if (this.stage >= 6) {
      const a = easeOut(pAct);
      g.save(); g.lineCap = 'round';
      for (const s of this.streams) {
        const col = s.w >= 0 ? OK : CRIT;
        const p0 = [tapeX + tapeW, tapeY(s.idx)], p1 = [h1X, nodeY(s.h1, 28)], p2 = [h2X, nodeY(s.h2, 28)], p3 = [outX - 2, outY(d.action)];
        g.strokeStyle = rgba(col, 0.55 * a); g.lineWidth = 1 + Math.abs(s.w) * 3.5;
        g.shadowColor = col; g.shadowBlur = 8;
        g.setLineDash([6, 5]); g.lineDashOffset = -t * 26;
        g.beginPath(); g.moveTo(...p0);
        for (const [q0, q1] of [[p0, p1], [p1, p2], [p2, p3]]) { const mx = (q0[0] + q1[0]) / 2; g.bezierCurveTo(mx, q0[1], mx, q1[1], q1[0], q1[1]); }
        g.stroke();
        g.setLineDash([]); g.shadowBlur = 0;
        g.fillStyle = col; g.beginPath(); g.arc(p0[0] + 8, p0[1], 6.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#081018'; g.font = '800 8px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(String(s.k + 1), p0[0] + 8, p0[1] + 3);
      }
      g.restore();
    }
  }

  /* ---------------------------------------------------------------- the helm */
  rotFor(i) {
    const unit = (Math.PI * 2) / 50;
    const ang = (i + 0.5 + (i >= 12 ? 2 : 0) + (i >= 28 ? 2 : 0)) * unit;
    let target = -Math.PI / 2 - ang;
    // shortest way round from the current heading
    const cur = this.rot ?? 0;
    target = cur + Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
    return target;
  }

  drawHelm() {
    const { g, w, h } = fit(this.c.helm);
    const d = this.cur, t = this.time;
    const cx = w / 2, cy = h / 2 + 8, R = Math.min(w, h) / 2 - 30, r0 = R * 0.3;
    const unit = (Math.PI * 2) / 50;
    const ang = (i) => (i + 0.5 + (i >= 12 ? 2 : 0) + (i >= 28 ? 2 : 0)) * unit;
    this.helmGeom = { cx, cy, R, r0, unit, ang };
    const pFwd = this.sp(4), pMask = this.sp(5), pAct = this.sp(6);
    const maxP = Math.max(...d.probs);

    // fixed bezel: compass ticks + lubber line
    g.strokeStyle = FAINT; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R + 20, 0, Math.PI * 2); g.stroke();
    for (let k = 0; k < 72; k++) {
      const an = (k / 72) * Math.PI * 2, l = k % 6 === 0 ? 6 : 3;
      g.strokeStyle = k % 6 === 0 ? MUTED : FAINT;
      g.beginPath(); g.moveTo(cx + Math.cos(an) * (R + 20), cy + Math.sin(an) * (R + 20)); g.lineTo(cx + Math.cos(an) * (R + 20 - l), cy + Math.sin(an) * (R + 20 - l)); g.stroke();
    }
    g.fillStyle = ACCENT;
    g.beginPath(); g.moveTo(cx, cy - R - 14); g.lineTo(cx - 7, cy - R - 26); g.lineTo(cx + 7, cy - R - 26); g.closePath(); g.fill();

    g.save(); g.translate(cx, cy); g.rotate(this.rot);
    // teak wheel: rim + 8 handles
    for (let k = 0; k < 8; k++) {
      const an = (k * Math.PI) / 4;
      g.strokeStyle = '#7a5230'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(Math.cos(an) * (R - 2), Math.sin(an) * (R - 2)); g.lineTo(Math.cos(an) * (R + 12), Math.sin(an) * (R + 12)); g.stroke();
      g.fillStyle = '#a8763f'; g.beginPath(); g.arc(Math.cos(an) * (R + 13), Math.sin(an) * (R + 13), 4.5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(176,141,60,0.25)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(Math.cos(an) * r0, Math.sin(an) * r0); g.lineTo(Math.cos(an) * (R - 8), Math.sin(an) * (R - 8)); g.stroke();
    }
    const rim = g.createRadialGradient(0, 0, R - 9, 0, 0, R);
    rim.addColorStop(0, '#6b4424'); rim.addColorStop(0.5, '#b07d45'); rim.addColorStop(1, '#5c3a1f');
    g.strokeStyle = rim; g.lineWidth = 9; g.beginPath(); g.arc(0, 0, R - 4.5, 0, Math.PI * 2); g.stroke();
    g.lineCap = 'butt';
    // action spokes
    const rmax = R - 14;
    for (let i = 0; i < 44; i++) {
      const act = ACTIONS[i], on = d.mask[i], a = ang(i), chosen = i === d.action && this.stage >= 6, hov = this.hover.helm === i;
      const full = on ? 0.14 + 0.86 * Math.sqrt(d.probs[i] / maxP) : lerp(0.1 + this.ghost[i] * 2, 0.1, pMask);
      const L = (rmax - r0) * full * (this.stage >= 4 ? easeOut(pFwd) : 0.12);
      const hw = unit * 0.4;
      g.beginPath(); g.arc(0, 0, r0 + L, a - hw, a + hw); g.arc(0, 0, r0, a + hw, a - hw, true); g.closePath();
      if (on || pMask < 1) {
        const col = GROUP[act.group];
        g.fillStyle = on ? rgba(col, chosen ? 1 : 0.25 + 0.6 * (d.probs[i] / maxP)) : rgba(col, 0.25 * (1 - pMask));
        if (chosen) { g.shadowColor = col; g.shadowBlur = 14; }
        g.fill(); g.shadowBlur = 0;
      }
      if (!on && pMask > 0) {
        g.fillStyle = `rgba(230,238,245,${0.05 * pMask})`; g.fill();
        g.strokeStyle = `rgba(230,238,245,${0.22 * pMask})`; g.lineWidth = 0.8; g.stroke();
        // anchor: a small ring + shank at the stub
        const ax = Math.cos(a) * (r0 + 9), ay = Math.sin(a) * (r0 + 9);
        g.strokeStyle = `rgba(230,238,245,${0.4 * pMask})`; g.lineWidth = 1;
        g.beginPath(); g.arc(ax, ay, 2, 0, Math.PI * 2); g.stroke();
      }
      if (chosen || hov) { g.strokeStyle = '#fff'; g.lineWidth = chosen ? 1.5 : 1; g.beginPath(); g.arc(0, 0, r0 + L, a - hw, a + hw); g.arc(0, 0, r0, a + hw, a - hw, true); g.closePath(); g.stroke(); }
    }
    // group names engraved on the rim
    for (const [lbl, a0, a1] of [['BOOKING', 0, 11], ['SPEED ORDERS', 12, 27], ['REPOSITION', 28, 43]]) {
      const mid = (ang(a0) + ang(a1)) / 2;
      g.save(); g.rotate(mid + Math.PI / 2);
      g.fillStyle = 'rgba(30,18,8,0.85)'; g.font = '800 7.5px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(lbl, 0, -R + 7.5);
      g.restore();
    }
    g.restore();

    // hub (does not rotate)
    g.fillStyle = 'rgba(8,14,22,0.92)'; g.beginPath(); g.arc(cx, cy, r0 - 5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(176,141,60,0.6)'; g.lineWidth = 2; g.stroke();
    g.textAlign = 'center';
    g.fillStyle = MUTED; g.font = '700 7.5px Inter, sans-serif';
    g.fillText(d.type === 'booking' ? 'BOOKING STEP' : 'FLEET STEP', cx, cy - 12);
    if (this.stage >= 6) {
      const a = ACTIONS[d.action];
      g.globalAlpha = easeOut(pAct);
      g.fillStyle = GROUP[a.group]; g.font = '800 13px Inter, sans-serif';
      g.fillText(a.group === 'book' ? a.short : a.group === 'speed' ? `${a.kt} kn` : `${a.teu} TEU`, cx, cy + 4);
      g.fillStyle = INK; g.font = '700 9px Inter, sans-serif';
      g.fillText(`π ${(d.probs[d.action] * 100).toFixed(0)}%`, cx, cy + 17);
      g.globalAlpha = 1;
    } else {
      g.fillStyle = MUTED; g.font = '600 9px Inter, sans-serif';
      g.fillText(this.stage >= 4 ? 'weighing…' : 'awaiting state', cx, cy + 6);
    }
    // selected action label under the lubber line
    if (this.stage >= 6) {
      const a = ACTIONS[d.action];
      g.fillStyle = INK; g.font = '700 10px Inter, sans-serif';
      g.globalAlpha = easeOut(pAct);
      g.fillText(a.label, cx, 12);
      g.globalAlpha = 1;
    }
    void t;
  }

  /* ---------------------------------------------------------------- pricing / fleet economics */
  drawPrice() {
    const { g, w, h } = fit(this.c.price);
    const d = this.cur, t = this.time, p = easeOut(this.sp(6));
    const pad = { l: 10, r: 10, t: 14, b: 22 };
    const ww = w - pad.l - pad.r, hh = h - pad.t - pad.b;
    const a = ACTIONS[d.action];
    if (d.quote) {
      const q = d.quote, curve = q.curve;
      const p0 = curve[0][0], p1 = curve[curve.length - 1][0];
      const X = (v) => pad.l + ((v - p0) / Math.max(1e-9, p1 - p0)) * ww;
      const marg = (v) => curveAt(curve, v).margin;
      const mMax = Math.max(1, ...curve.map((row) => row[2]));
      g.save(); g.beginPath(); g.rect(0, 0, pad.l + ww * p, h); g.clip();
      // margin swell (the bid-price engine's own P(accept)·(price−bid) objective)
      const gr = g.createLinearGradient(0, pad.t, 0, pad.t + hh);
      gr.addColorStop(0, rgba(ACCENT, 0.55)); gr.addColorStop(1, rgba(ACCENT, 0.03));
      g.fillStyle = gr; g.beginPath(); g.moveTo(X(p0), pad.t + hh);
      for (let v = p0; v <= p1; v += (p1 - p0) / 120) g.lineTo(X(v), pad.t + hh - (Math.max(0, marg(v)) / mMax) * hh * 0.82 + Math.sin(v * 0.05 + t * 2) * 0.8);
      g.lineTo(X(p1), pad.t + hh); g.closePath(); g.fill();
      // P(accept)
      g.strokeStyle = MUTED; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.beginPath(); for (let v = p0; v <= p1; v += (p1 - p0) / 120) g.lineTo(X(v), pad.t + hh - curveAt(curve, v).pAccept * hh); g.stroke(); g.setLineDash([]);
      g.restore();
      const vline = (v, col, lbl, row, dash) => {
        const x = X(v); if (x < pad.l || x > w - pad.r) return;
        g.strokeStyle = col; g.lineWidth = 1; if (dash) g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(x, pad.t - 2); g.lineTo(x, pad.t + hh); g.stroke(); g.setLineDash([]);
        g.fillStyle = col; g.font = '700 8.5px Inter, sans-serif'; g.textAlign = x > w - 60 ? 'right' : x < 60 ? 'left' : 'center';
        g.fillText(lbl, x, row ? pad.t + hh + 18 : pad.t + hh + 9);
      };
      vline(q.bid, CRIT, `bid $${nf(q.bid)}`, 0);
      vline(q.market, MUTED, `mkt $${nf(q.market)}`, 1, true);
      if (q.guard != null && Math.abs(q.guard - q.price) > 0.5) vline(q.guard, WARN, 'list', 0, true);
      // buoy at the bid floor
      const bx = X(q.bid), by = pad.t + hh - 4 + Math.sin(t * 2) * 1.2;
      g.fillStyle = CRIT; g.beginPath(); g.moveTo(bx - 4, by); g.lineTo(bx + 4, by); g.lineTo(bx + 2, by - 8); g.lineTo(bx - 2, by - 8); g.closePath(); g.fill();
      if (q.offer && p > 0.3) {
        const x = X(q.offer), y = pad.t + hh - (Math.max(0, marg(q.offer)) / mMax) * hh * 0.82;
        g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, y); g.lineTo(x, pad.t + hh); g.stroke();
        g.save(); g.translate(x, y + Math.sin(t * 2) * 1); drawShip(g, -14, 1, 28, { hull: '#fff', colors: BOXES, house: '#9fb0c0', ink: 'rgba(8,16,24,0.7)', fill: 0.8, seed: 7 }); g.restore();
        g.fillStyle = INK; g.font = '800 10px Inter, sans-serif'; g.textAlign = x > w - 90 ? 'right' : 'left';
        g.fillText(`quote $${nf(q.offer)}${q.disc ? ` (−${Math.round(q.disc * 100)}%)` : ''} · P ${nf(curveAt(curve, q.offer).pAccept * 100)}%`, x + (x > w - 90 ? -8 : 8), Math.max(pad.t + 8, y - 12));
      }
      g.fillStyle = MUTED; g.font = '600 8px Inter, sans-serif'; g.textAlign = 'left';
      g.fillText('– – P(accept)', pad.l, pad.t - 3);
      g.fillStyle = rgba(ACCENT, 0.9); g.fillText('▲ expected margin', pad.l + 62, pad.t - 3);
      return;
    }
    if (a.kind === 'speed') {
      const v = VESSELS[a.vessel];
      const burn = (kt) => v.fuelA + v.fuelB * Math.pow(kt, 3);
      const X = (kt) => pad.l + ((kt - 11) / 8) * ww, Y = (b) => pad.t + hh - (b / burn(19)) * hh;
      g.save(); g.beginPath(); g.rect(0, 0, pad.l + ww * p, h); g.clip();
      const gr = g.createLinearGradient(0, pad.t, 0, pad.t + hh); gr.addColorStop(0, rgba(TEAL, 0.5)); gr.addColorStop(1, rgba(TEAL, 0.03));
      g.fillStyle = gr; g.beginPath(); g.moveTo(X(11), pad.t + hh);
      for (let kt = 11; kt <= 19; kt += 0.1) g.lineTo(X(kt), Y(burn(kt)));
      g.lineTo(X(19), pad.t + hh); g.closePath(); g.fill();
      g.restore();
      [12, 14, 16, 18].forEach((kt) => {
        const i = 12 + a.vessel * 4 + [12, 14, 16, 18].indexOf(kt), on = d.mask[i], sel = kt === a.kt;
        const x = X(kt), y = Y(burn(kt));
        g.fillStyle = sel ? '#fff' : on ? TEAL : 'rgba(230,238,245,0.2)';
        g.beginPath(); g.arc(x, y, sel ? 5 : 3.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = sel ? INK : MUTED; g.font = `${sel ? 800 : 600} 9px Inter, sans-serif`; g.textAlign = 'center';
        g.fillText(`${kt} kn`, x, pad.t + hh + 14);
        if (sel) g.fillText(`${nf(burn(kt))} t/d`, x, y - 10);
      });
      g.fillStyle = MUTED; g.font = '600 8px Inter, sans-serif'; g.textAlign = 'left'; g.fillText(`${v ? v.name : `VES${a.vessel + 1}`} · fuel t/day = a + b·v³`, pad.l, pad.t - 3);
      return;
    }
    // reposition: empties before / after at the two ports (real pair for this decision)
    const pair = d.repoPairs && d.repoPairs[a.pair];
    const [o, dst] = pair || ['—', '—'];
    const io = PORTS.indexOf(o), id = PORTS.indexOf(dst);
    const before = [io >= 0 ? d.ports[io].empties : 0, id >= 0 ? d.ports[id].empties : 0];
    const after = [before[0] - a.teu, before[1] + a.teu];
    const maxE = Math.max(...before, ...after, 1);
    [[o, 0], [dst, 1]].forEach(([code, k]) => {
      const x = pad.l + 30 + k * (ww / 2), bw = 26;
      const hb = (before[k] / maxE) * hh * 0.85, ha = (lerp(before[k], after[k], p) / maxE) * hh * 0.85;
      g.strokeStyle = MUTED; g.setLineDash([2, 2]); g.strokeRect(x, pad.t + hh - hb, bw, hb); g.setLineDash([]);
      g.fillStyle = rgba(WARN, 0.7); g.fillRect(x + bw + 6, pad.t + hh - ha, bw, ha);
      g.fillStyle = INK; g.font = '700 9px Inter, sans-serif'; g.textAlign = 'left';
      g.fillText(code, x, pad.t + hh + 14);
      g.fillStyle = MUTED; g.font = '600 8.5px Inter, sans-serif';
      g.fillText(`${nf(before[k])} → ${nf(after[k])}`, x + 32, pad.t + hh + 14);
    });
    const ax0 = pad.l + 30 + 58, ax1 = pad.l + 30 + ww / 2 - 6, ay = pad.t + 16;
    g.strokeStyle = WARN; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.lineDashOffset = -t * 20;
    g.beginPath(); g.moveTo(ax0, ay); g.quadraticCurveTo((ax0 + ax1) / 2, ay - 12, ax1, ay); g.stroke(); g.setLineDash([]); g.lineDashOffset = 0;
    g.fillStyle = WARN; g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(`${a.teu} empty TEU`, (ax0 + ax1) / 2, ay - 14);
  }

  /* ---------------------------------------------------------------- wake */
  drawWake() {
    const { g, w, h } = fit(this.c.wake);
    const t = this.time;
    const shipLen = 92, sx = w - shipLen - 18, wl = h * 0.64;
    const slide = easeOut((t - (this.wakeT ?? -9)) / 0.9);
    // sea + V wake
    g.fillStyle = 'rgba(124,196,255,0.05)'; g.fillRect(0, wl, w, h - wl);
    g.strokeStyle = 'rgba(230,238,245,0.18)'; g.lineWidth = 1;
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(sx + 4, wl + 2); g.quadraticCurveTo(sx - w * 0.3, wl + s * 10 + 6, 0, wl + s * 18 + 6); g.stroke(); }
    g.strokeStyle = 'rgba(124,196,255,0.3)';
    g.beginPath(); for (let x = 0; x <= w; x += 3) g.lineTo(x, wl + Math.sin(x * 0.06 + t * 1.8) * 1.2); g.stroke();
    // decisions afloat
    const sp = 34, maxEv = Math.max(1, ...this.wake.map((q) => q.ev));
    this.wakeHits = [];
    this.wake.forEach((q, k) => {
      const x = sx - 24 - (k + 1 - (1 - slide)) * sp;
      if (x < -30) return;
      const bh = 7 + (q.ev / maxEv) * 24, bw = 26;
      const y = wl - bh + 3 + Math.sin(t * 1.6 + k * 0.9) * 1.5;
      const fade = clamp(1 - k / 26);
      g.globalAlpha = fade * (this.hover.wake == null || this.hover.wake === k ? 1 : 0.4);
      if (q.kind === 'reject' || !q.ok) {
        g.strokeStyle = q.color; g.lineWidth = 1; g.setLineDash([3, 2]); g.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1); g.setLineDash([]);
      } else {
        g.fillStyle = q.color; g.fillRect(x, y, bw, bh);
        g.fillStyle = 'rgba(0,0,0,0.18)'; for (let s = x + 3; s < x + bw - 2; s += 3) g.fillRect(s, y + 1, 1, bh - 2);
        g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 0.8; g.strokeRect(x + 0.4, y + 0.4, bw - 0.8, bh - 0.8);
      }
      this.wakeHits.push({ x, y, w: bw, h: bh, k });
    });
    g.globalAlpha = 1;
    drawShip(g, sx, wl + 6 + Math.sin(t * 1.3) * 0.8, shipLen, { hull: '#dfe9f2', colors: BOXES, house: '#9fb0c0', ink: 'rgba(8,16,24,0.7)', fill: 0.8, seed: 21, bowWave: 1 });
    g.fillStyle = MUTED; g.font = '600 8.5px Inter, sans-serif'; g.textAlign = 'right';
    g.fillText(`${this.wake.length} decisions astern`, sx - 8, 12);
    const legend = [['accept', 'accept'], ['flex_window', 'flex'], ['alt_hub', 'alt hub'], ['split', 'split'], ['speed', 'speed'], ['reposition', 'repo']];
    let lx = 6;
    g.textAlign = 'left';
    for (const [k, l] of legend) { g.fillStyle = KIND[k]; g.fillRect(lx, 5, 8, 8); g.fillStyle = MUTED; g.fillText(l, lx + 11, 12); lx += g.measureText(l).width + 24; }
  }
}
