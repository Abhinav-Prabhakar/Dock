// Model — the decision inspector. One screen that shows exactly what the live
// MaskablePPO policy decided, on what evidence, and what happened next:
//   header      live / inspecting state · All/Bookings/Fleet filter · ‹ Live ›
//   KPIs        over the backend's last-60 decision window
//   request     the booking (or fleet state) + its voyage options
//   decision    chosen action, outcome, quote vs bid vs market, ledger, timings
//   policy      top actions by probability, legal-action count, V(s), entropy
//   pricing     the bid-price engine's P(accept) / expected-margin curve
//   compare     the same request priced by the four baseline strategies
//   why         gradient × input attribution + the 112-float observation
//   network     the real weights × activations into the chosen action
//   log         the recent decisions — click one to inspect it
// Everything comes from /live/policy + /live/policy/network (js/pages/
// liveDecision.js), re-polled every 2.5 s so outcomes land as they happen.
// The DOM is rebuilt only when the data or the selection changes.
import { Page, fit, clamp, nf } from './page.js';
import { LiveFeed, actionsFromNetwork, curveAt, OBS_BLOCKS } from './liveDecision.js';
import { VESSELS } from '../config.js';

const TEXT = 'rgba(236,243,248,0.92)', MUTED = 'rgba(230,238,245,0.55)', FAINT = 'rgba(230,238,245,0.12)';
const ACCENT = '#7cc4ff', OK = '#5fe39a', WARN = '#ffc35a', CRIT = '#ff6b6b';
const STAMP_TONE = { BOOKED: 'ok', DECLINED: 'warn', REJECTED: 'crit', PENDING: 'mut', 'ENGINE ORDER': 'acc', REPOSITION: 'acc', HOLD: 'mut' };
const TIMING_ORDER = [['bid', 'Bid price'], ['policy', 'Policy'], ['mask', 'Mask'], ['counterfactuals', 'Baselines'], ['act', 'Act']];
const LOG_ROWS = 20;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}$${nf(Math.abs(Math.round(v)))}`);
const pct = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : `${nf(v * 100, d)}%`);
const ms = (v) => (v == null ? '—' : v >= 100 ? `${nf(v)} ms` : `${nf(v, v >= 10 ? 1 : 2)} ms`);
const shortHash = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '—');
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const vesselName = (id) => (VESSELS[id] ? titleCase(VESSELS[id].name) : id || '—');
const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((p, q) => p - q), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const signed = (v) => (v >= 0 ? ACCENT : CRIT);

export class ModelPage extends Page {
  constructor(root) {
    super(root);
    this.feed = new LiveFeed();
    this.actions = [];
    this.filter = 'all';
    this.selN = null;                       // null = follow the newest decision
    this.dirty = true;
    this.build();
    this.feed.onChange(({ reset }) => {
      if (reset) this.selN = null;          // a new live world: old trace numbers mean nothing
      this.render();
    });
    this.boot();
    window.addEventListener('resize', () => { this.dirty = true; });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(+1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.step(-1); }
      else if (e.key === 'l' || e.key === 'L' || e.key === 'Home') this.follow();
    });
  }

  /* ---------------------------------------------------------------- lifecycle */
  async boot() {
    try {
      await this.feed.init();
      this.actions = actionsFromNetwork(this.feed.network);
      const L = this.feed.network.layers;
      this.k.sub.textContent = `MaskablePPO · ${L[0]} inputs → ${L[1]} → ${L[2]} → ${L[3]} actions · every number read from the live policy`;
      if (this.active) this.feed.start();
      this.render();
    } catch (e) {
      this.setStatus(e.status === 404
        ? 'The live policy is not a neural network (the backend is running a rule-based policy), so there is nothing to inspect.'
        : `Live policy unavailable — ${e.message}`);
    }
  }

  onShow() { if (this.feed.network) this.feed.start(); this.dirty = true; }
  onHide() { this.feed.stop(); }

  /* ---------------------------------------------------------------- DOM */
  build() {
    const r = this.root;
    r.innerHTML = `
      <div class="pg-wrap md">
        <header class="pg-head md-head">
          <div class="pg-title">
            <div class="brand"><span class="dot"></span>DOCK <em>Model</em></div>
            <h1>Decision engine</h1>
            <div class="sub" data-k="sub">Connecting to the live policy…</div>
          </div>
          <div class="md-bar panel">
            <span class="md-live" data-k="live"><i></i><b>Connecting</b></span>
            <div class="seg mini" data-k="filter" role="tablist" aria-label="Decision type">
              <button type="button" data-f="all">All</button><button type="button" data-f="booking">Bookings</button><button type="button" data-f="fleet">Fleet</button>
            </div>
            <div class="md-nav">
              <button type="button" data-a="older" title="Older decision (←)" aria-label="Older decision"><svg viewBox="0 0 12 12" width="11" height="11"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <button type="button" data-a="live" class="md-follow" title="Follow the newest decision (L)">Live</button>
              <button type="button" data-a="newer" title="Newer decision (→)" aria-label="Newer decision"><svg viewBox="0 0 12 12" width="11" height="11"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
          </div>
        </header>
        <p class="md-status" data-k="status" hidden></p>
        <div class="md-kpis" data-k="kpis"></div>
        <div class="pg-grid md-grid">
          <section class="panel sc span-5 md-card"><div class="sc-head"><span data-k="reqTitle">Request</span><em data-k="reqMeta"></em></div><div data-k="request"></div></section>
          <section class="panel sc span-4 md-card"><div class="sc-head"><span>Decision</span><em data-k="decMeta"></em></div><div data-k="decision"></div></section>
          <section class="panel sc span-3 md-card"><div class="sc-head"><span>Policy output</span><em data-k="polMeta"></em></div><div data-k="policy"></div></section>
          <section class="panel sc span-7 md-card"><div class="sc-head"><span>Pricing</span><em data-k="priceMeta"></em></div><canvas class="cv md-price" data-k="priceCv"></canvas><div class="md-legend" data-k="priceLegend"></div></section>
          <section class="panel sc span-5 md-card"><div class="sc-head"><span>Same request, other strategies</span><em>margin over the bid-price floor</em></div><div data-k="compare"></div></section>
          <section class="panel sc span-7 md-card"><div class="sc-head"><span>Why this action</span><em>gradient × input, strongest first</em></div><div data-k="why"></div><canvas class="cv md-obs" data-k="obsCv"></canvas><div class="md-legend" data-k="obsLegend"></div></section>
          <section class="panel sc span-5 md-card"><div class="sc-head"><span>Network</span><em data-k="netMeta"></em></div><canvas class="cv md-net" data-k="netCv"></canvas><div class="md-legend" data-k="netLegend"></div></section>
          <section class="panel sc span-12 md-card"><div class="sc-head"><span>Decision log</span><em data-k="logMeta"></em></div><div class="md-log" data-k="log"></div></section>
        </div>
      </div>`;
    this.k = {};
    r.querySelectorAll('[data-k]').forEach((el) => { this.k[el.dataset.k] = el; });
    this.k.filter.onclick = (e) => {
      const b = e.target.closest('button[data-f]');
      if (!b || b.dataset.f === this.filter) return;
      this.filter = b.dataset.f;
      this.render();
    };
    r.querySelector('.md-nav').onclick = (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      if (b.dataset.a === 'live') this.follow();
      else this.step(b.dataset.a === 'older' ? +1 : -1);
    };
    this.k.log.onclick = (e) => {
      const row = e.target.closest('[data-n]');
      if (row) { this.selN = +row.dataset.n; this.render(); }
    };
    this.k.obsLegend.innerHTML = OBS_BLOCKS.map((b) => `<span><i style="background:${b.color}"></i>${esc(b.label)}</span>`).join('');
  }

  setStatus(text) {
    this.k.status.hidden = !text;
    this.k.status.textContent = text || '';
  }

  /* ---------------------------------------------------------------- selection */
  visible() {
    const f = this.filter;
    return this.feed.decisions.filter((d) => f === 'all' || d.type === f);
  }

  current() {
    const vis = this.visible();
    if (this.selN != null) {
      const d = vis.find((x) => x.n === this.selN);
      if (d) return d;
      this.selN = null;                     // it aged out of the window (or the filter hides it)
    }
    return vis[0] || null;
  }

  step(dir) {                               // +1 = older, -1 = newer
    const vis = this.visible();
    if (!vis.length) return;
    const cur = this.current();
    const i = Math.max(0, vis.findIndex((d) => d.n === cur?.n));
    const j = clamp(i + dir, 0, vis.length - 1);
    this.selN = j === 0 && dir < 0 ? null : vis[j].n;   // stepping back to the newest = following again
    this.render();
  }

  follow() { this.selN = null; this.render(); }

  // Action index 0 is "reject" on a booking step but "hold — no order" on a
  // fleet step (fleet_env.py: 0 = pass); every label goes through here.
  labelFor(d, i) {
    if (d.type === 'fleet' && i === 0) return 'Hold — no fleet order';
    if (i === d.action) return this.actionLabel(d);
    return this.actions[i]?.label ?? `Action ${i}`;
  }

  actionLabel(d) {
    if (d.type === 'fleet' && d.action === 0) return 'Hold — no fleet order';
    const a = this.actions[d.action];
    if (!a) return `Action ${d.action}`;
    if (a.kind === 'reposition' && d.repoPairs && d.repoPairs[a.pair]) {
      const [src, dst] = d.repoPairs[a.pair];
      return `Reposition ${a.teu} TEU ${src} → ${dst}`;
    }
    return a.label;
  }

  /* ---------------------------------------------------------------- render */
  render() {
    if (!this.feed.network) return;
    const d = this.current();
    this.d = d;
    const following = this.selN == null;
    this.setStatus(this.feed.error ? `Live policy unavailable — ${this.feed.error}. Showing the last decisions received.` : '');

    const ep = this.feed.episodeId ? ` · episode ${this.feed.episodeId.slice(0, 6)}` : '';
    this.k.live.className = `md-live ${this.feed.error ? 'err' : following ? 'on' : 'paused'}`;
    this.k.live.innerHTML = `<i></i><b>${this.feed.error ? 'Offline' : following ? 'Following live' : `Inspecting #${d?.n ?? '—'}`}</b><span>day ${this.feed.day != null ? nf(this.feed.day, 1) : '—'}${ep}</span>`;
    this.k.filter.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.f === this.filter));
    this.root.querySelector('.md-follow').classList.toggle('on', following);
    const vis = this.visible(), idx = d ? vis.findIndex((x) => x.n === d.n) : -1;
    this.root.querySelector('[data-a="older"]').disabled = idx < 0 || idx >= vis.length - 1;
    this.root.querySelector('[data-a="newer"]').disabled = idx <= 0;

    this.renderKpis();
    this.renderLog(d);
    if (!d) {
      const none = `<p class="md-empty">${this.feed.decisions.length ? 'No decisions of this type in the current window.' : 'Waiting for the live policy’s first decision…'}</p>`;
      for (const k of ['request', 'decision', 'policy', 'compare', 'why']) this.k[k].innerHTML = none;
      for (const k of ['reqMeta', 'decMeta', 'polMeta', 'priceMeta', 'netMeta']) this.k[k].textContent = '';
      this.dirty = true;
      return;
    }
    this.renderRequest(d);
    this.renderDecision(d);
    this.renderPolicy(d);
    this.renderCompare(d);
    this.renderWhy(d);
    this.dirty = true;                      // canvases repaint on the next frame
  }

  renderKpis() {
    const all = this.feed.decisions;
    const book = all.filter((d) => d.type === 'booking');
    const offers = book.filter((d) => this.actions[d.action]?.kind !== 'reject');
    const booked = book.filter((d) => d.outcome.stamp === 'BOOKED').length;
    const conf = mean(all.map((d) => d.probs[d.action]).filter(Number.isFinite));
    const ent = mean(all.map((d) => d.entropy).filter(Number.isFinite));
    const margins = offers.filter((d) => d.quote).map((d) => d.ev);
    const perTeu = offers.filter((d) => d.quote).map((d) => d.quote.price - d.quote.bid);
    const pol = median(all.map((d) => d.timings.policy).filter(Number.isFinite));
    const bid = median(all.map((d) => d.timings.bid).filter(Number.isFinite));
    const tile = (label, value, sub) => `<div class="md-kpi panel"><label>${label}</label><span>${value}</span><small>${sub}</small></div>`;
    this.k.kpis.innerHTML = [
      tile('Decisions', all.length ? `#${nf(all[0].n)}` : '—', `${all.length} in the live window · ${book.length} bookings`),
      tile('Offer rate', book.length ? pct(offers.length / book.length) : '—', book.length ? `${booked} of ${offers.length} offers booked by the customer` : 'no bookings yet'),
      tile('Confidence', conf != null ? pct(conf) : '—', ent != null ? `mean π(chosen) · entropy ${nf(ent, 2)}` : 'mean π(chosen)'),
      tile('Margin over bid', margins.length ? usd(mean(margins)) : '—', perTeu.length ? `per offer · ${usd(mean(perTeu))}/TEU above the floor` : 'per offer'),
      tile('Policy latency', ms(pol), bid != null ? `median forward pass · bid price ${ms(bid)}` : 'median forward pass'),
    ].join('');
  }

  renderRequest(d) {
    if (d.type === 'fleet') {
      this.k.reqTitle.textContent = 'Fleet step';
      this.k.reqMeta.textContent = `day ${nf(d.day, 1)}`;
      const ships = d.fleet.map((v) => `<tr><td><b>${esc(vesselName(v.id))}</b><small>${v.id}</small></td>
        <td>${v.atSea ? 'At sea' : 'In port'}</td><td class="num">${nf(v.speed, 1)} kn</td>
        <td class="num">${pct(v.fill)}</td><td class="num">${nf(Math.max(0, v.nextEvent), 1)} d</td></tr>`).join('');
      const ports = [...d.ports].sort((a, b) => b.congestion - a.congestion).slice(0, 4)
        .map((p) => `<span class="md-chip${p.closed ? ' crit' : ''}">${p.code}<small>${p.closed ? 'closed' : `${nf(p.wait, 0)} h wait · ${nf(p.empties)} empties`}</small></span>`).join('');
      this.k.request.innerHTML = `
        <table class="md-table"><thead><tr><th>Vessel</th><th>State</th><th class="num">Speed</th><th class="num">Fill</th><th class="num">Next call</th></tr></thead><tbody>${ships}</tbody></table>
        <div class="md-sub">Busiest ports</div><div class="md-chips">${ports}</div>`;
      return;
    }
    const q = d.req;
    this.k.reqTitle.textContent = q.customer ? 'Customer request' : 'Request';
    this.k.reqMeta.textContent = `#${q.id} · day ${nf(d.day, 1)}`;
    const opts = d.options.filter((o) => o.vessel.id !== '—');
    const rows = opts.map((o) => `<tr class="${o.k === d.chosenOpt ? 'chosen' : ''}${o.feasible ? '' : ' off'}">
        <td><b>${esc(vesselName(o.vessel.id))}</b><small>${o.k === 2 ? 'alt hub' : 'requested'}</small></td>
        <td class="num">${o.dep != null ? `+${nf(o.dep - d.day, 1)} d` : '—'}</td>
        <td class="num">${o.eta != null ? `+${nf(o.eta - d.day, 1)} d` : '—'}</td>
        <td>${esc(o.dest)}</td><td class="num">${nf(o.room)}</td><td class="num">${o.bid ? usd(o.bid) : '—'}</td>
        <td>${o.feasible ? '<span class="md-ok">Feasible</span>' : `<span class="md-no">${esc(o.reason || 'infeasible')}</span>`}</td></tr>`).join('');
    const kv = (label, value) => `<div><label>${label}</label><span>${value}</span></div>`;
    this.k.request.innerHTML = `
      <div class="md-lane"><b>${esc(q.origin)}</b><svg viewBox="0 0 22 10" width="22" height="10" aria-hidden="true"><path d="M1 5h19M16 1.5 20 5l-4 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><b>${esc(q.dest)}</b>
        ${q.customer ? '<span class="md-tag acc">Customer</span>' : ''}<span class="md-tag">${esc(q.segment)}</span></div>
      <div class="md-kv">
        ${kv('Cargo', `${nf(q.teu)} TEU · ${esc(q.cargo)}`)}${kv('Weight', `${nf(q.weight, 1)} t`)}
        ${kv('Earliest sailing', `in ${nf(Math.max(0, q.reqDep - d.day), 1)} days`)}${kv('Flexibility', `${q.flex} days`)}
        ${kv('Market rate', `${usd(q.market)}/TEU`)}${kv('Options', `${opts.filter((o) => o.feasible).length} of ${opts.length} feasible`)}
      </div>
      ${opts.length ? `<table class="md-table"><thead><tr><th>Vessel</th><th class="num">Sails</th><th class="num">Arrives</th><th>To</th><th class="num">Room TEU</th><th class="num">Bid</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="md-empty">No sailing could carry it.</p>'}`;
  }

  renderDecision(d) {
    const st = d.outcome.stamp;
    this.k.decMeta.textContent = `#${d.n}`;
    const q = d.quote;
    let scale = '';
    if (q) {
      const pts = [['Bid floor', q.bid, 'crit'], ['Quote', q.price, 'txt'], ['Market', q.market, 'mut']];
      const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
      const pad = Math.max(1, (hi - lo) * 0.18), a = lo - pad, b = hi + pad;
      const x = (v) => `${((v - a) / (b - a)) * 100}%`;
      scale = `<div class="md-scale" aria-hidden="true"><div class="md-scale-line"></div>
          <div class="md-scale-band" style="left:${x(q.bid)};width:calc(${x(q.price)} - ${x(q.bid)})"></div>
          ${pts.map(([l, v, t]) => `<i class="${t}" style="left:${x(v)}"></i>`).join('')}</div>
        <div class="md-figs">
          <div><label>Quote</label><span>${usd(q.price)}<small>/TEU</small></span></div>
          <div><label>Bid floor</label><span class="crit">${usd(q.bid)}<small>/TEU</small></span></div>
          <div><label>Market</label><span>${usd(q.market)}<small>/TEU</small></span></div>
          <div><label>Margin</label><span class="${d.ev >= 0 ? 'ok' : 'crit'}">${usd(d.ev)}</span></div>
        </div>`;
    }
    const t = d.timings;
    const timing = TIMING_ORDER.filter(([k]) => t[k] != null).map(([k, l]) => `<span>${l} <b>${ms(t[k])}</b></span>`).join('');
    const led = d.ledger
      ? `<div class="md-ledger"><label>Ledger</label><span>#${nf(d.ledger.seq)} · <code>${shortHash(d.ledger.hash)}</code> ← <code>${shortHash(d.ledger.prev)}</code>${d.onchain ? ' · on-chain deal' : ''}</span></div>`
      : '';
    this.k.decision.innerHTML = `
      <div class="md-act"><b>${esc(this.actionLabel(d))}</b><span class="md-stamp ${STAMP_TONE[st] || 'mut'}">${esc(st)}</span></div>
      <p class="md-explain">${esc(d.explain)}</p>
      ${scale}${led}
      ${timing ? `<div class="md-timing">${timing}</div>` : ''}`;
  }

  renderPolicy(d) {
    const legal = d.mask.filter(Boolean).length;
    this.k.polMeta.textContent = `${legal} of ${d.mask.length} legal`;
    const top = d.probs.map((p, i) => [p, i]).filter(([, i]) => d.mask[i]).sort((a, b) => b[0] - a[0]).slice(0, 6);
    const rows = top.map(([p, i]) => `<div class="md-pbar${i === d.action ? ' chosen' : ''}">
        <span class="md-pbar-l">${esc(this.labelFor(d, i))}</span>
        <span class="md-pbar-v">${pct(p, p < 0.1 ? 1 : 0)}</span>
        <span class="md-pbar-t"><i style="width:${clamp(p) * 100}%"></i></span></div>`).join('');
    this.k.policy.innerHTML = `${rows}
      <div class="md-figs two">
        <div><label>V(s)</label><span>${nf(d.value, 1)}</span><small>critic’s value, shaped reward units</small></div>
        <div><label>Entropy</label><span>${nf(d.entropy, 2)}</span><small>${d.entropy < 0.3 ? 'decisive' : d.entropy < 1 ? 'fairly sure' : 'uncertain'}</small></div>
      </div>`;
  }

  renderCompare(d) {
    if (!d.baselines) {
      this.k.compare.innerHTML = `<p class="md-empty">${d.type === 'fleet' ? 'Fleet steps have no customer price to compare — baselines are priced on booking requests only.' : 'This request was rejected before pricing, so there is nothing to compare.'}</p>`;
      return;
    }
    const best = Math.max(...d.baselines.map((b) => b.ev ?? -Infinity));
    const rows = d.baselines.map((b) => `<tr class="${b.key === 'ppo' ? 'ours' : ''}">
        <td><b>${esc(b.label)}</b></td><td>${esc(String(b.kind).replace(/_/g, ' '))}</td>
        <td class="num">${b.price != null ? `${usd(b.price)}` : '—'}</td>
        <td class="num ${b.ev === best && best > 0 ? 'best' : ''}">${b.price != null ? usd(b.ev) : '—'}</td></tr>`).join('');
    this.k.compare.innerHTML = `<table class="md-table"><thead><tr><th>Strategy</th><th>Decision</th><th class="num">$/TEU</th><th class="num">Margin</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  renderWhy(d) {
    const attr = d.attr || [];
    if (!attr.length) { this.k.why.innerHTML = '<p class="md-empty">No attribution for this decision.</p>'; return; }
    this.k.why.innerHTML = `<div class="md-attr">${attr.map((a) => `<div class="md-arow">
        <span class="md-alabel" title="obs[${a.idx}]">${esc(a.label)}</span>
        <span class="md-aval">${nf(a.x, 2)}</span>
        <span class="md-atrack"><i class="${a.w >= 0 ? 'pos' : 'neg'}" style="${a.w >= 0 ? 'left:50%' : `right:50%`};width:${Math.abs(a.w) * 50}%"></i></span></div>`).join('')}</div>
      <div class="md-akey"><span><i class="neg"></i>pushed away from this action</span><span><i class="pos"></i>pushed toward it</span></div>`;
  }

  renderLog(cur) {
    const vis = this.visible().slice(0, LOG_ROWS);
    this.k.logMeta.textContent = `newest first · ${this.visible().length} in window${this.selN != null ? ' · click Live to follow again' : ''}`;
    if (!vis.length) { this.k.log.innerHTML = '<p class="md-empty">Waiting for decisions…</p>'; return; }
    this.k.log.innerHTML = `<table class="md-table md-logt"><thead><tr><th class="num">#</th><th class="num">Day</th><th>Type</th><th>Lane / order</th><th>Action</th><th class="num">$/TEU</th><th class="num">Confidence</th><th>Outcome</th></tr></thead><tbody>
      ${vis.map((d) => {
        const lane = d.type === 'booking' ? `${esc(d.req.origin)} → ${esc(d.req.dest)} · ${nf(d.req.teu)} TEU${d.req.customer ? ' · <span class="md-acc">customer</span>' : ''}` : 'Fleet orders';
        const st = d.outcome.stamp;
        return `<tr data-n="${d.n}" class="${d.n === cur?.n ? 'sel' : ''}" tabindex="0">
          <td class="num mut">${d.n}</td><td class="num">${nf(d.day, 1)}</td><td>${d.type === 'booking' ? 'Booking' : 'Fleet'}</td>
          <td>${lane}</td><td>${esc(this.actionLabel(d))}</td><td class="num">${d.quote ? usd(d.quote.price) : '—'}</td>
          <td class="num">${pct(d.probs[d.action])}</td><td><span class="md-stamp sm ${STAMP_TONE[st] || 'mut'}">${esc(st)}</span></td></tr>`;
      }).join('')}</tbody></table>`;
  }

  /* ---------------------------------------------------------------- canvases */
  draw() {
    if (!this.dirty || !this.feed.network) return;
    this.dirty = false;
    this.drawPricing();
    this.drawObs();
    this.drawNetwork();
  }

  drawPricing() {
    const { g, w, h } = fit(this.k.priceCv);
    const d = this.d, q = d?.quote;
    if (!q || !q.curve?.length) {
      this.k.priceMeta.textContent = '';
      this.k.priceLegend.innerHTML = '';
      g.fillStyle = MUTED; g.font = '500 12px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(d?.type === 'fleet' ? 'Fleet steps set speed or move empties — no customer price is quoted.' : 'Rejected before pricing — no quote was made.', w / 2, h / 2);
      return;
    }
    const cur = q.curve, pad = { l: 38, r: 50, t: 18, b: 26 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const x0 = cur[0][0], x1 = cur[cur.length - 1][0];
    const mMin = Math.min(0, ...cur.map((c) => c[2])), mMax = Math.max(1, ...cur.map((c) => c[2]));
    const X = (p) => pad.l + ((p - x0) / (x1 - x0)) * pw;
    const YP = (v) => pad.t + (1 - v) * ph;
    const YM = (v) => pad.t + (1 - (v - mMin) / (mMax - mMin)) * ph;
    // grid + axes
    g.strokeStyle = FAINT; g.lineWidth = 1; g.font = '500 10px Inter, sans-serif'; g.fillStyle = MUTED;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (i / 4) * ph;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
      g.textAlign = 'right'; g.fillText(`${100 - i * 25}%`, pad.l - 6, y + 3);
      g.textAlign = 'left'; g.fillText(usd(mMax - (i / 4) * (mMax - mMin)), w - pad.r + 6, y + 3);
    }
    g.textAlign = 'center';
    for (let i = 0; i <= 5; i++) { const p = x0 + (i / 5) * (x1 - x0); g.fillText(usd(p), X(p), h - 8); }
    // expected margin (area) and P(accept) (line)
    g.beginPath(); g.moveTo(X(cur[0][0]), YM(0));
    cur.forEach((c) => g.lineTo(X(c[0]), YM(c[2])));
    g.lineTo(X(x1), YM(0)); g.closePath();
    g.fillStyle = rgba(OK, 0.14); g.fill();
    g.beginPath(); cur.forEach((c, i) => (i ? g.lineTo : g.moveTo).call(g, X(c[0]), YM(c[2])));
    g.strokeStyle = rgba(OK, 0.85); g.lineWidth = 1.5; g.stroke();
    g.beginPath(); cur.forEach((c, i) => (i ? g.lineTo : g.moveTo).call(g, X(c[0]), YP(c[1])));
    g.strokeStyle = ACCENT; g.lineWidth = 2; g.stroke();
    if (mMin < 0) { g.strokeStyle = 'rgba(230,238,245,0.25)'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(pad.l, YM(0)); g.lineTo(w - pad.r, YM(0)); g.stroke(); g.setLineDash([]); }
    // markers: bid floor, market, quote
    const marks = [[q.bid, CRIT, 'Bid floor', [4, 4]], [q.market, 'rgba(230,238,245,0.55)', 'Market', [2, 4]], [q.price, TEXT, 'Quote', []]];
    const placed = [];
    for (const [v, col, label, dash] of marks) {
      if (v < x0 || v > x1) continue;
      const x = X(v);
      g.strokeStyle = col; g.lineWidth = label === 'Quote' ? 1.6 : 1.2; g.setLineDash(dash);
      g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ph); g.stroke(); g.setLineDash([]);
      let ly = pad.t + 10;
      while (placed.some((p) => Math.abs(p.x - x) < 64 && p.y === ly)) ly += 13;
      placed.push({ x, y: ly });
      g.fillStyle = col; g.font = '700 10px Inter, sans-serif'; g.textAlign = x > w - pad.r - 60 ? 'right' : 'left';
      g.fillText(label, x + (g.textAlign === 'right' ? -5 : 5), ly);
    }
    const at = curveAt(cur, q.price);
    g.fillStyle = TEXT; g.beginPath(); g.arc(X(q.price), YP(at.pAccept), 3.5, 0, Math.PI * 2); g.fill();
    this.k.priceMeta.textContent = `P(accept) at quote ${pct(at.pAccept)} · expected ${usd(at.margin)}/TEU`;
    this.k.priceLegend.innerHTML = `<span><i style="background:${ACCENT}"></i>P(accept) — ${esc(d.req.segment)} willingness-to-pay model</span>
      <span><i style="background:${OK}"></i>Expected margin $/TEU = P · (price − bid)</span>`;
  }

  drawObs() {
    const { g, w, h } = fit(this.k.obsCv);
    const d = this.d;
    if (!d) return;
    const n = d.obs.length, gap = 1, bw = (w - (n - 1) * gap) / n, mid = h * 0.62;
    const attrIdx = new Map((d.attr || []).map((a) => [a.idx, a.w]));
    g.strokeStyle = FAINT; g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(w, mid + 0.5); g.stroke();
    OBS_BLOCKS.forEach((b) => {
      for (let i = b.from; i < b.to; i++) {
        const v = clamp(d.obs[i], -1, 1), x = i * (bw + gap);
        const hi = attrIdx.has(i);
        g.fillStyle = rgba(b.color, hi ? 1 : 0.55);
        const bh = Math.max(1, Math.abs(v) * (v >= 0 ? mid - 4 : h - mid - 2));
        g.fillRect(x, v >= 0 ? mid - bh : mid + 1, Math.max(1, bw), bh);
        if (hi) {
          g.fillStyle = signed(attrIdx.get(i));
          g.beginPath(); g.moveTo(x + bw / 2, h - 1); g.lineTo(x + bw / 2 - 3, h - 6); g.lineTo(x + bw / 2 + 3, h - 6); g.fill();
        }
      }
    });
  }

  drawNetwork() {
    const { g, w, h } = fit(this.k.netCv);
    const d = this.d, net = this.feed.network;
    if (!d) return;
    const W1 = net.w1, W2 = net.w2, W3 = net.w3, K = W1.length;
    const outs = d.probs.map((p, i) => [p, i]).filter(([, i]) => d.mask[i]).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, i]) => i);
    if (!outs.includes(d.action)) outs[outs.length - 1] = d.action;
    const col = [34, w * 0.36, w * 0.6, w - 150];
    const yIn = (b) => 14 + (b + 0.5) * ((h - 28) / OBS_BLOCKS.length);
    const yU = (k) => 12 + (k + 0.5) * ((h - 24) / K);
    const yOut = (o) => 20 + (o + 0.5) * ((h - 40) / outs.length);
    const edge = (xa, ya, xb, yb, s, max, strong) => {
      const a = clamp(Math.abs(s) / max) * (strong ? 0.9 : 0.55);
      if (a < 0.04) return;
      g.strokeStyle = rgba(s >= 0 ? ACCENT : CRIT, a); g.lineWidth = strong ? 0.6 + 2 * a : 0.4 + 1.2 * a;
      g.beginPath(); g.moveTo(xa, ya); g.bezierCurveTo((xa + xb) / 2, ya, (xa + xb) / 2, yb, xb, yb); g.stroke();
    };
    // inputs (blocks) → h1: Σ_i∈block w1[k][i]·obs[i], strongest 40
    const e1 = [];
    OBS_BLOCKS.forEach((b, bi) => { for (let k = 0; k < K; k++) { let s = 0; for (let i = b.from; i < b.to; i++) s += W1[k][i] * d.obs[i]; e1.push([s, bi, k]); } });
    e1.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
    const m1 = Math.abs(e1[0]?.[0] || 1);
    e1.slice(0, 40).forEach(([s, bi, k]) => edge(col[0] + 6, yIn(bi), col[1] - 4, yU(k), s, m1));
    // h1 → h2: w2[j][k]·h1[k], strongest 60
    const e2 = [];
    for (let j = 0; j < K; j++) for (let k = 0; k < K; k++) e2.push([W2[j][k] * d.h1[k], k, j]);
    e2.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
    const m2 = Math.abs(e2[0]?.[0] || 1);
    e2.slice(0, 60).forEach(([s, k, j]) => edge(col[1] + 4, yU(k), col[2] - 4, yU(j), s, m2));
    // h2 → outputs: w3[a][j]·h2[j]; every edge into the chosen action, strongest 6 into the others
    const e3 = [];
    outs.forEach((a, o) => {
      const row = W3[a].map((wt, j) => [wt * d.h2[j], j]).sort((p, q) => Math.abs(q[0]) - Math.abs(p[0]));
      (a === d.action ? row.slice(0, 16) : row.slice(0, 6)).forEach(([s, j]) => e3.push([s, j, o, a === d.action]));
    });
    const m3 = Math.max(...e3.map((e) => Math.abs(e[0])), 1e-6);
    e3.sort((a, b) => a[3] - b[3]).forEach(([s, j, o, strong]) => edge(col[2] + 4, yU(j), col[3] - 6, yOut(o), s, m3, strong));
    // nodes
    g.font = '600 9.5px Inter, sans-serif'; g.textAlign = 'right';
    OBS_BLOCKS.forEach((b, bi) => {
      g.fillStyle = b.color; g.fillRect(col[0], yIn(bi) - 5, 6, 10);
      g.fillStyle = MUTED; g.fillText(b.label.split(' ')[0], col[0] - 4, yIn(bi) + 3);
    });
    const unit = (x, y, v) => { g.fillStyle = rgba(v >= 0 ? ACCENT : CRIT, 0.25 + 0.75 * Math.abs(clamp(v, -1, 1))); g.beginPath(); g.arc(x, y, 3.1, 0, Math.PI * 2); g.fill(); };
    for (let k = 0; k < K; k++) { unit(col[1], yU(k), d.h1[k]); unit(col[2], yU(k), d.h2[k]); }
    g.textAlign = 'left';
    outs.forEach((a, o) => {
      const y = yOut(o), chosen = a === d.action, p = d.probs[a];
      g.fillStyle = chosen ? ACCENT : 'rgba(230,238,245,0.35)';
      g.beginPath(); g.arc(col[3], y, chosen ? 5 : 3.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = chosen ? TEXT : MUTED; g.font = `${chosen ? 700 : 500} 10px Inter, sans-serif`;
      const label = this.labelFor(d, a).replace('Counter · ', '');
      g.fillText(label.length > 22 ? `${label.slice(0, 21)}…` : label, col[3] + 10, y - 1);
      g.fillStyle = MUTED; g.font = '500 9.5px Inter, sans-serif'; g.fillText(pct(p, p < 0.1 ? 1 : 0), col[3] + 10, y + 11);
    });
    g.fillStyle = MUTED; g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center';
    [['Inputs', col[0] + 3], [`Hidden 1 · ${K} of ${net.layers[1]}`, col[1]], [`Hidden 2 · ${K} of ${net.layers[2]}`, col[2]]].forEach(([t, x]) => g.fillText(t.toUpperCase(), x, h - 2));
    this.k.netMeta.textContent = `${K} of ${net.layers[1]} units per layer · the most influential`;
    this.k.netLegend.innerHTML = `<span><i style="background:${ACCENT}"></i>excites (weight × activation &gt; 0)</span><span><i style="background:${CRIT}"></i>inhibits</span><span>edge width = strength</span>`;
  }
}
