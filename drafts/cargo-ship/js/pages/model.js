// Model — "The helm". The live MaskablePPO policy, one decision at a time, drawn on the same paper
// chart as the Statistics page and told in the language of the sea:
//   The passage   the request's voyage options as ships sailing their arcs across a tidal window,
//                 flanked by the manifest tag and the verdict (a rubber stamp that slams down)
//   The compass   all 44 actions as bearings; the needle springs to the chosen one and trembles
//                 with the policy's entropy
//   The tide      the bid-price engine's P(accept) as the tideline, the bid floor as a reef, the
//                 market as a lighthouse, the quote as a buoy riding the swell
//   Soundings     gradient × input attributions as sounding lines over a seabed of the 112 inputs
//   The regatta   the same request raced by the baseline strategies, by margin over the floor
//   Currents      the real weights × activations flowing through two hidden layers to the action
//   Ship's log    the recent decisions; click one to inspect it
// Every number comes from /live/policy + /live/policy/network (pages/liveDecision.js → LiveFeed),
// re-polled every 2.5 s so a PENDING decision picks up its outcome when the customer answers.
import { Page, fit, clamp, lerp, easeOut, nf, drawShip, grainURL } from './page.js';
import { LiveFeed, actionsFromNetwork, curveAt, OBS_BLOCKS } from './liveDecision.js';
import { VESSELS } from '../config.js';

const ink = (a) => `rgba(43,36,25,${a})`;
const sea = (a) => `rgba(44,110,170,${a})`;
const PAPER = '#f3eee2';
const BLUE = '#1d7fe0', GREEN = '#3f9a5f', AMBER = '#d69a1c', RED = '#c8452f', BRASS = '#b08d3c', INKHEX = '#6b645a';
const BOXES = ['#c43a7a', '#8e3226', '#1f3f6d', '#3f7fb7', '#c9cac6', '#2f6a42', '#d2672b', '#6aa6cc'];
const STRAT = { static: '#8e3226', greedy: '#e27820', heuristic: '#c9a42a', heuristic_bid: '#2c8a8e', ppo: BLUE };
const STAMP = { BOOKED: GREEN, DECLINED: AMBER, REJECTED: RED, PENDING: INKHEX, 'ENGINE ORDER': BLUE, REPOSITION: BLUE, HOLD: INKHEX };
const GROUPS = [
  { key: 'book', label: 'BOOKING', from: 0, to: 12, color: BLUE },
  { key: 'speed', label: 'ENGINE ORDERS', from: 12, to: 28, color: GREEN },
  { key: 'repo', label: 'EMPTIES', from: 28, to: 44, color: AMBER },
];
const LOG_ROWS = 18;

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
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const bearingOf = (i) => -Math.PI / 2 + ((i + 0.5) / 44) * Math.PI * 2;   // action i → compass bearing (N = up)
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class ModelPage extends Page {
  constructor(root) {
    super(root);
    this.feed = new LiveFeed();
    this.actions = [];
    this.filter = 'all';
    this.selN = null;                      // null = follow the newest decision
    this.shownN = null;                    // decision on screen (drives the arrival animations)
    this.arriveT = -99;                    // this.time when it arrived
    this.needle = { a: -Math.PI / 2, v: 0 };
    this.hits = {};
    this.build();
    this.feed.onChange(({ reset }) => { if (reset) this.selN = null; this.render(); });
    this.boot();
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
      this.k.sub.textContent = `MaskablePPO · ${L[0]} inputs → ${L[1]} → ${L[2]} → ${L[3]} actions · every mark on this chart is read from the live policy`;
      if (this.active) this.feed.start();
      this.render();
    } catch (e) {
      this.setStatus(e.status === 404
        ? 'The live policy is not a neural network (the backend is running a rule-based policy), so there is no helm to read.'
        : `Live policy unavailable — ${e.message}`);
    }
  }

  onShow() { this.root.scrollTop = 0; if (this.feed.network) this.feed.start(); this.arriveT = this.time; }
  onHide() { this.feed.stop(); this.tip(null); }

  /* ---------------------------------------------------------------- DOM */
  build() {
    const r = this.root;
    r.style.setProperty('--grain', `url(${grainURL(10)})`);
    const nav = (a, title, path) => `<button type="button" data-a="${a}" title="${title}" aria-label="${title}"><svg viewBox="0 0 12 12" width="11" height="11"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    r.innerHTML = `
      <div class="pg-wrap hm">
        <header class="pg-head">
          <div class="pg-title">
            <div class="brand"><span class="dot"></span>DOCK <em>Decision engine</em></div>
            <h1>The helm <small data-k="helmNo">—</small></h1>
            <div class="sub" data-k="sub">Taking bearings from the live policy…</div>
            <div class="stow-stats" data-k="head"></div>
          </div>
          <div class="lpanel pg-controls hm-controls">
            <label class="field-label">Watch</label>
            <div class="hm-watch" data-k="watch"><i></i><b>Connecting</b><span></span></div>
            <label class="field-label">Show</label>
            <div class="seg light" data-k="filter"><button data-f="all">All</button><button data-f="booking">Bookings</button><button data-f="fleet">Fleet</button></div>
            <div class="hm-nav">
              ${nav('older', 'Older decision (←)', 'M7.5 2.5 4 6l3.5 3.5')}
              <button type="button" data-a="live" class="hm-live" title="Follow the newest decision (L)">Follow live</button>
              ${nav('newer', 'Newer decision (→)', 'M4.5 2.5 8 6l-3.5 3.5')}
            </div>
          </div>
        </header>

        <div class="lpanel hint hm-status" data-k="status" hidden></div>

        <section class="pg-grid">
          <article class="lpanel sc span-12 hm-passage">
            <div class="sc-head"><span data-k="passTitle">The passage</span><em data-k="passNote"></em></div>
            <div class="hm-stage">
              <canvas class="cv" data-c="passage"></canvas>
              <div class="hm-tag" data-k="tag"></div>
              <div class="hm-verdict" data-k="verdict"></div>
            </div>
          </article>

          <article class="lpanel sc span-5">
            <div class="sc-head"><span>The compass · where the policy points</span><em data-k="compNote"></em></div>
            <canvas class="cv" data-c="compass" style="height:340px"></canvas>
            <div class="legend light sc-foot" data-k="compLegend"></div>
          </article>
          <article class="lpanel sc span-7">
            <div class="sc-head"><span data-k="tideTitle">The tide · chance the customer accepts, by price</span><em data-k="tideNote"></em></div>
            <canvas class="cv" data-c="tide" style="height:340px"></canvas>
            <div class="legend light sc-foot" data-k="tideLegend"></div>
          </article>

          <article class="lpanel sc span-7">
            <div class="sc-head"><span>Soundings · what swayed the helm</span><em>gradient × input · the deeper the line, the stronger the pull</em></div>
            <canvas class="cv" data-c="sound" style="height:300px"></canvas>
            <div class="legend light sc-foot"><span><i style="background:${BLUE}"></i>pulls toward this action</span><span><i style="background:${RED}"></i>pulls away</span><span><i style="background:#e6dcc4;outline:1px solid ${ink(0.25)}"></i>seabed = all 112 inputs</span></div>
          </article>
          <article class="lpanel sc span-5">
            <div class="sc-head"><span>The regatta · the same request, other captains</span><em>distance = margin over the bid floor</em></div>
            <canvas class="cv" data-c="regatta" style="height:300px"></canvas>
          </article>

          <article class="lpanel sc span-12">
            <div class="sc-head"><span>Currents through the helm · weights × activations</span><em data-k="curNote"></em></div>
            <canvas class="cv" data-c="currents" style="height:340px"></canvas>
            <div class="legend light sc-foot"><span><i style="background:${BLUE}"></i>current that drives toward the action</span><span><i style="background:${RED}"></i>current that holds it back</span><span>buoy tint = unit activation</span><span>width &amp; drift speed = strength</span></div>
          </article>

          <article class="lpanel sc span-12">
            <div class="sc-head"><span>Ship’s log</span><em data-k="logNote"></em></div>
            <div class="hm-log" data-k="log"></div>
          </article>
        </section>
      </div>`;
    this.k = {}; this.c = {};
    r.querySelectorAll('[data-k]').forEach((el) => (this.k[el.dataset.k] = el));
    r.querySelectorAll('[data-c]').forEach((el) => (this.c[el.dataset.c] = el));
    this.k.filter.onclick = (e) => {
      const b = e.target.closest('button[data-f]');
      if (!b || b.dataset.f === this.filter) return;
      this.filter = b.dataset.f; this.render();
    };
    r.querySelector('.hm-nav').onclick = (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b || b.disabled) return;
      if (b.dataset.a === 'live') this.follow(); else this.step(b.dataset.a === 'older' ? +1 : -1);
    };
    const pick = (e) => { const row = e.target.closest('[data-n]'); if (row) { this.selN = +row.dataset.n; this.render(); } };
    this.k.log.onclick = pick;
    this.k.log.onkeydown = (e) => { if (e.key === 'Enter') pick(e); };
    // hover read-outs on the canvases
    const hover = (name, fn) => {
      const c = this.c[name];
      c.addEventListener('pointermove', (e) => { const b = c.getBoundingClientRect(); const html = fn(e.clientX - b.left, e.clientY - b.top); this.tip(html ? e : null, html); });
      c.addEventListener('pointerleave', () => this.tip(null));
    };
    hover('compass', (x, y) => {
      const h = this.hits.compass, d = this.d; if (!h || !d) return null;
      const rr = Math.hypot(x - h.cx, y - h.cy); if (rr > h.R + 14 || rr < h.R * 0.2) return null;
      const a = Math.atan2(y - h.cy, x - h.cx);
      let best = -1, bd = 1e9;
      for (let i = 0; i < 44; i++) { const dd = Math.abs(wrapAngle(a - bearingOf(i))); if (dd < bd) { bd = dd; best = i; } }
      if (bd > 0.08) return null;
      return `<b>${esc(this.labelFor(d, best))}</b><br>${d.mask[best] ? `π = ${pct(d.probs[best], 1)}${best === d.action ? ' · <b>chosen</b>' : ''}` : '<span class="mut">not allowed here (masked)</span>'}`;
    });
    hover('sound', (x) => {
      const h = this.hits.sound; if (!h) return null;
      const s = h.find((q) => Math.abs(q.x - x) < 16); if (!s) return null;
      return `<b>${esc(s.a.label)}</b><br>input value ${nf(s.a.x, 3)}<br><span class="mut">${s.a.w >= 0 ? 'pulls toward' : 'pulls away from'} this action · ${nf(Math.abs(s.a.w) * 100)}% of the strongest pull</span>`;
    });
    hover('passage', (x, y) => {
      const s = (this.hits.passage || []).find((q) => Math.hypot(q.x - x, q.y - y) < 28);
      return s ? s.html : null;
    });
  }

  tip(e, html) {
    const t = document.getElementById('tooltip');
    if (!t) return;
    if (!e || !html) { t.classList.remove('show', 'light'); return; }
    t.innerHTML = html; t.style.left = `${e.clientX}px`; t.style.top = `${e.clientY}px`;
    t.classList.add('show', 'light');
  }

  setStatus(text) { this.k.status.hidden = !text; this.k.status.textContent = text || ''; }

  /* ---------------------------------------------------------------- selection */
  visible() { const f = this.filter; return this.feed.decisions.filter((d) => f === 'all' || d.type === f); }

  current() {
    const vis = this.visible();
    if (this.selN != null) {
      const d = vis.find((x) => x.n === this.selN);
      if (d) return d;
      this.selN = null;                     // aged out of the window, or hidden by the filter
    }
    return vis[0] || null;
  }

  step(dir) {                               // +1 = older, -1 = newer
    const vis = this.visible(); if (!vis.length) return;
    const cur = this.current();
    const i = Math.max(0, vis.findIndex((d) => d.n === cur?.n));
    const j = clamp(i + dir, 0, vis.length - 1);
    this.selN = j === 0 && dir < 0 ? null : vis[j].n;   // stepping back to the newest = following again
    this.render();
  }

  follow() { this.selN = null; this.render(); }

  // Action index 0 is "reject" on a booking step but "hold — no order" on a fleet step.
  labelFor(d, i) {
    if (d.type === 'fleet' && i === 0) return 'Hold — no fleet order';
    const a = this.actions[i];
    if (!a) return `Action ${i}`;
    if (a.kind === 'reposition' && d.repoPairs && d.repoPairs[a.pair]) {
      const [src, dst] = d.repoPairs[a.pair];
      return `Reposition ${a.teu} TEU ${src} → ${dst}`;
    }
    return a.label;
  }

  /* ---------------------------------------------------------------- render (DOM, on data change) */
  render() {
    if (!this.feed.network) return;
    const d = this.current();
    this.d = d;
    if (d && d.n !== this.shownN) { this.shownN = d.n; this.arriveT = this.time; }   // replay the arrivals
    const following = this.selN == null;
    this.setStatus(this.feed.error ? `The live policy went quiet — ${this.feed.error}. Showing the last decisions received.` : '');
    const w = this.k.watch;
    w.className = `hm-watch ${this.feed.error ? 'err' : following ? 'on' : 'paused'}`;
    w.innerHTML = `<i></i><b>${this.feed.error ? 'Offline' : following ? 'On watch · following live' : `Inspecting #${nf(d?.n ?? 0)}`}</b><span>sim day ${this.feed.day != null ? nf(this.feed.day, 1) : '—'}</span>`;
    this.k.filter.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.f === this.filter));
    this.root.querySelector('.hm-live').classList.toggle('on', following);
    const vis = this.visible(), idx = d ? vis.findIndex((x) => x.n === d.n) : -1;
    this.root.querySelector('[data-a="older"]').disabled = idx < 0 || idx >= vis.length - 1;
    this.root.querySelector('[data-a="newer"]').disabled = idx <= 0;
    this.k.helmNo.textContent = d ? `#${nf(d.n)} · day ${nf(d.day, 1)}` : '—';
    this.renderHead();
    this.renderLog(d);
    this.renderPassageDom(d);
    this.renderLegends(d);
  }

  renderHead() {
    const all = this.feed.decisions;
    const book = all.filter((d) => d.type === 'booking');
    const offers = book.filter((d) => this.actions[d.action]?.kind !== 'reject');
    const booked = book.filter((d) => d.outcome.stamp === 'BOOKED').length;
    const conf = mean(all.map((d) => d.probs[d.action]).filter(Number.isFinite));
    const margins = offers.filter((d) => d.quote).map((d) => d.ev);
    const pol = median(all.map((d) => d.timings.policy).filter(Number.isFinite));
    const stat = (label, value, small) => `<div><label>${label}</label><span>${value}</span>${small ? `<small>${small}</small>` : ''}</div>`;
    this.k.head.innerHTML = [
      stat('Decisions', all.length ? nf(all.length) : '—', 'this watch'),
      stat('Offers made', book.length ? pct(offers.length / book.length) : '—', book.length ? `${booked} booked` : ''),
      stat('Steady hand', conf != null ? pct(conf) : '—', 'mean π'),
      stat('Over the floor', margins.length ? usd(mean(margins)) : '—', 'per offer'),
      stat('Helm response', ms(pol), ''),
    ].join('');
    this.k.logNote.textContent = `newest first · ${this.visible().length} decisions this watch${this.selN != null ? ' · Follow live to return' : ''}`;
  }

  renderPassageDom(d) {
    if (!d) {
      this.k.passTitle.textContent = 'The passage';
      this.k.passNote.textContent = '';
      this.k.tag.innerHTML = `<p class="hm-quiet">${this.feed.decisions.length ? 'No decisions of this kind on this watch.' : 'Waiting for the first request to come over the horizon…'}</p>`;
      this.k.verdict.innerHTML = '';
      return;
    }
    const st = d.outcome.stamp;
    if (d.type === 'booking') {
      const q = d.req;
      this.k.passTitle.textContent = q.customer ? 'The passage · a customer’s request' : 'The passage · a booking request';
      this.k.passNote.textContent = 'each ship is a sailing this cargo could take · green band = the window the customer asked for';
      const boxes = Math.min(12, Math.max(1, Math.round(Math.log2(q.teu + 1) * 2)));
      this.k.tag.innerHTML = `
        <div class="hm-tag-hole"></div>
        <label>Manifest · request #${nf(q.id)}</label>
        <div class="hm-route"><b>${esc(q.origin)}</b><svg viewBox="0 0 26 10" width="26" height="10"><path d="M1 5h22M19 1.5 23 5l-4 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><b>${esc(q.dest)}</b></div>
        <div class="hm-boxes" title="${nf(q.teu)} TEU">${Array.from({ length: boxes }, (_, i) => `<i style="background:${BOXES[i % BOXES.length]}"></i>`).join('')}</div>
        <dl>
          <dt>Cargo</dt><dd>${nf(q.teu)} TEU · ${esc(q.cargo)} · ${nf(q.weight, 0)} t</dd>
          <dt>Service</dt><dd>${esc(q.segment)}${q.customer ? ' · <b class="hm-cust">customer</b>' : ''}</dd>
          <dt>Window</dt><dd>sail in ${nf(Math.max(0, q.reqDep - d.day), 1)} d · ±${q.flex} d</dd>
          <dt>Market</dt><dd>${usd(q.market)}/TEU</dd>
        </dl>`;
    } else {
      this.k.passTitle.textContent = 'The passage · orders to the fleet';
      this.k.passNote.textContent = 'every few days the policy may re-trim a ship’s speed or move empty boxes between ports';
      this.k.tag.innerHTML = `
        <div class="hm-tag-hole"></div>
        <label>Fleet step · day ${nf(d.day, 1)}</label>
        <div class="hm-route"><b>The fleet</b></div>
        <dl>${d.fleet.map((v) => `<dt>${esc(vesselName(v.id))}</dt><dd>${v.atSea ? 'at sea' : 'in port'} · ${nf(v.speed, 0)} kn · ${pct(v.fill)}</dd>`).join('')}</dl>`;
    }
    const q = d.quote;
    const figs = q ? `<div class="hm-figs">
        <div><label>Quote</label><span>${usd(q.price)}</span></div>
        <div><label>Floor</label><span class="red">${usd(q.bid)}</span></div>
        <div><label>Market</label><span>${usd(q.market)}</span></div>
        <div><label>Margin</label><span class="${d.ev >= 0 ? 'green' : 'red'}">${usd(d.ev)}</span></div></div>` : '';
    const led = d.ledger
      ? `<div class="hm-ledger">Logged <b>#${nf(d.ledger.seq)}</b> · <code>${shortHash(d.ledger.hash)}</code> ← <code>${shortHash(d.ledger.prev)}</code>${d.onchain ? ' · on-chain' : ''}</div>`
      : '<div class="hm-ledger mut">Not in the ledger yet</div>';
    const slam = this.verdictN !== d.n || this.verdictStamp !== st;   // re-slam on a new decision or outcome
    this.verdictN = d.n; this.verdictStamp = st;
    this.k.verdict.innerHTML = `
      <label>The verdict</label>
      <div class="hm-act">${esc(this.labelFor(d, d.action))}</div>
      <div class="hm-stamp${slam ? ' slam' : ''}" style="--st:${STAMP[st] || INKHEX}">${esc(st)}</div>
      <p>${esc(d.explain)}</p>
      ${figs}${led}`;
  }

  renderLegends(d) {
    this.k.compNote.textContent = d ? `${d.mask.filter(Boolean).length} of 44 bearings open` : '';
    this.k.compLegend.innerHTML = GROUPS.map((g) => `<span><i style="background:${rgba(g.color, 0.5)}"></i>${g.label.toLowerCase()}</span>`).join('')
      + `<span><i style="background:${BLUE}"></i>chosen</span><span><i style="background:${ink(0.1)}"></i>tick = masked</span>`;
    if (d?.quote) {
      const at = curveAt(d.quote.curve, d.quote.price);
      this.k.tideTitle.textContent = 'The tide · chance the customer accepts, by price';
      this.k.tideNote.textContent = `at the quote: ${pct(at.pAccept)} accept · ${usd(at.margin)}/TEU expected`;
      this.k.tideLegend.innerHTML = `<span><i style="background:${sea(0.5)}"></i>tide = P(accept) · ${esc(d.req.segment)} customers</span><span><i style="background:${GREEN}"></i>expected margin · ★ best</span><span><i style="background:${RED}"></i>reef = below the bid floor</span><span><i style="background:${BRASS}"></i>lighthouse = market rate</span>`;
    } else {
      this.k.tideTitle.textContent = d?.type === 'fleet' ? 'The engine room · the order given' : 'The tide · no price was set';
      this.k.tideNote.textContent = '';
      this.k.tideLegend.innerHTML = '';
    }
    const net = this.feed.network;
    this.k.curNote.textContent = `${net.w1.length} of ${net.layers[1]} units per layer · the most influential`;
  }

  renderLog(cur) {
    const vis = this.visible().slice(0, LOG_ROWS);
    if (!vis.length) { this.k.log.innerHTML = '<p class="hm-quiet">The log is empty for now.</p>'; return; }
    this.k.log.innerHTML = `<table class="hm-logt"><thead><tr><th>No.</th><th>Day</th><th>Passage</th><th>Helm order</th><th class="num">Rate</th><th class="num">Sure</th><th>Outcome</th></tr></thead><tbody>
      ${vis.map((d) => {
        const st = d.outcome.stamp;
        const lane = d.type === 'booking' ? `${esc(d.req.origin)} → ${esc(d.req.dest)} <small>${nf(d.req.teu)} TEU${d.req.customer ? ' · customer' : ''}</small>` : '<span class="mut">Fleet orders</span>';
        return `<tr data-n="${d.n}" tabindex="0" class="${d.n === cur?.n ? 'sel' : ''}">
          <td class="mut">${nf(d.n)}</td><td>${nf(d.day, 1)}</td><td>${lane}</td><td>${esc(this.labelFor(d, d.action))}</td>
          <td class="num">${d.quote ? usd(d.quote.price) : '—'}</td><td class="num">${pct(d.probs[d.action])}</td>
          <td><span class="hm-mini" style="--st:${STAMP[st] || INKHEX}">${esc(st)}</span></td></tr>`;
      }).join('')}</tbody></table>`;
  }

  /* ---------------------------------------------------------------- frame (canvases, every frame) */
  draw(dt = 0) {
    if (!this.feed.network) return;
    this.dt = Math.min(0.1, dt || 1 / 30);
    this.arrive = easeOut((this.time - this.arriveT) / 1.4);
    this.drawPassage();
    this.drawCompass();
    this.drawTide();
    this.drawSoundings();
    this.drawRegatta();
    this.drawCurrents();
  }

  quiet(g, cx, cy, text) {
    g.fillStyle = ink(0.45); g.font = 'italic 500 13px Georgia, "Times New Roman", serif'; g.textAlign = 'center';
    g.fillText(text, cx, cy);
  }

  /* ---- The passage */
  drawPassage() {
    const { g, w, h } = fit(this.c.passage);
    const d = this.d, t = this.time, a = this.arrive;
    this.hits.passage = [];
    const L = Math.min(250, w * 0.23) + 26, R = w - (Math.min(290, w * 0.26) + 26);   // clear of the tag and the verdict
    const horizon = h * 0.34;
    g.fillStyle = sea(0.05); g.fillRect(0, horizon, w, h - horizon);
    for (let k = 0; k < 5; k++) {
      g.strokeStyle = sea(0.1 - k * 0.012); g.lineWidth = 1;
      g.beginPath();
      const yy = horizon + 14 + k * ((h - horizon) / 5);
      for (let x = 0; x <= w; x += 6) g.lineTo(x, yy + Math.sin(x * 0.04 + t * (0.9 + k * 0.2) + k) * (1 + k * 0.4));
      g.stroke();
    }
    g.strokeStyle = ink(0.18); g.beginPath(); g.moveTo(0, horizon); g.lineTo(w, horizon); g.stroke();
    if (!d) { this.quiet(g, (L + R) / 2, h / 2, 'Nothing on the horizon yet…'); return; }
    if (d.type === 'fleet') { this.drawFleetPassage(g, L, R, h, horizon, d, t, a); return; }

    const opts = d.options.filter((o) => o.vessel.id !== '—');
    if (!opts.length) { this.quiet(g, (L + R) / 2, h / 2, 'No sailing could carry this cargo — it stays on the quay.'); return; }
    const now = d.day;
    const tMax = Math.max(now + 5, ...opts.map((o) => o.eta ?? o.dep ?? now), d.req.reqDep + d.req.flex) + 2;
    const X = (day) => L + ((day - now) / (tMax - now)) * (R - L);
    // day marks along the top
    g.font = '600 9.5px Inter, sans-serif'; g.textAlign = 'center';
    const stepD = (tMax - now) > 60 ? 14 : (tMax - now) > 25 ? 7 : 2;
    for (let dd = 0; dd <= tMax - now; dd += stepD) {
      const x = X(now + dd);
      g.fillStyle = ink(0.45); g.fillText(dd === 0 ? 'today' : `+${dd} d`, x, 14);
      g.strokeStyle = ink(0.08); g.setLineDash([2, 5]); g.beginPath(); g.moveTo(x, 20); g.lineTo(x, h - 8); g.stroke(); g.setLineDash([]);
    }
    // the customer's window: a tidal band
    const w0 = X(Math.max(now, d.req.reqDep - d.req.flex)), w1 = X(d.req.reqDep + d.req.flex);
    const band = g.createLinearGradient(0, 22, 0, h);
    band.addColorStop(0, rgba(GREEN, 0.03)); band.addColorStop(1, rgba(GREEN, 0.16));
    g.fillStyle = band; g.fillRect(w0, 22, Math.max(3, w1 - w0), h - 30);
    g.fillStyle = rgba(GREEN, 0.85); g.font = '700 9px Inter, sans-serif'; g.fillText('WINDOW', (w0 + w1) / 2, 32);
    // each sailing: an arc from departure to arrival with a ship sailing it
    const laneH = (h - horizon - 14) / opts.length;
    opts.forEach((o, i) => {
      const chosen = o.k === d.chosenOpt;
      const y = horizon + 8 + laneH * (i + 0.74);
      const xa = X(o.dep ?? now), xb = Math.max(xa + 30, X(o.eta ?? o.dep ?? now));
      const lift = Math.min(40, laneH * 0.85);
      const col = chosen ? BLUE : o.feasible ? ink(0.55) : ink(0.25);
      g.strokeStyle = chosen ? rgba(BLUE, 0.75) : o.feasible ? ink(0.3) : ink(0.14);
      g.lineWidth = chosen ? 2 : 1.2; g.setLineDash(o.feasible ? [5, 4] : [2, 4]);
      g.lineDashOffset = -t * (chosen ? 14 : 5);
      g.beginPath(); g.moveTo(xa, y); g.quadraticCurveTo((xa + xb) / 2, y - lift, xb, y); g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
      for (const x of [xa, xb]) { g.fillStyle = '#fffaf0'; g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
      // feasible ships sail their arc (the chosen one sets out on arrival); infeasible ones ride at anchor
      const len = Math.min(66, Math.max(34, laneH * 1.4));
      let u = o.feasible ? ((t * (chosen ? 0.06 : 0.04) + i * 0.29) % 1) : 0.1;
      if (chosen) u *= a;
      const px = lerp(lerp(xa, (xa + xb) / 2, u), lerp((xa + xb) / 2, xb, u), u);
      const py = lerp(lerp(y, y - lift, u), lerp(y - lift, y, u), u) + Math.sin(t * 2 + i) * 1.2;
      g.save();
      g.globalAlpha = o.feasible ? (chosen ? 1 : 0.72) : 0.38;
      if (chosen) {
        const wg = g.createLinearGradient(px - len * 1.7, 0, px - len * 0.4, 0);
        wg.addColorStop(0, rgba(BLUE, 0)); wg.addColorStop(1, rgba(BLUE, 0.28));
        g.fillStyle = wg; g.beginPath(); g.moveTo(px - len * 1.7, py + 1); g.lineTo(px - len * 0.4, py - 3); g.lineTo(px - len * 0.4, py + 4); g.closePath(); g.fill();
      }
      drawShip(g, px - len / 2, py + 3, len, { hull: chosen ? '#1d3b63' : '#2a241b', fill: o.feasible ? 0.75 : 0.3, colors: BOXES, seed: 7 + i, bowWave: o.feasible ? 0.8 : 0 });
      g.restore();
      if (!o.feasible) {
        g.strokeStyle = ink(0.45); g.lineWidth = 1;
        g.beginPath(); g.moveTo(px, py + 4); g.lineTo(px, py + 16); g.stroke();
        g.beginPath(); g.arc(px, py + 12, 4, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
        g.fillStyle = RED; g.font = 'italic 600 9.5px Inter, sans-serif'; g.textAlign = 'left';
        g.fillText(o.reason || 'cannot carry it', px + len / 2 + 6, py + 2);
      }
      g.fillStyle = chosen ? BLUE : ink(o.feasible ? 0.72 : 0.4);
      g.font = `${chosen ? 700 : 600} 10.5px Inter, sans-serif`; g.textAlign = 'center';
      g.fillText(`${vesselName(o.vessel.id)}${o.k === 2 ? ` · alt hub ${o.dest}` : ''}`, (xa + xb) / 2, y - lift - 10);
      if (o.feasible && o.bid) { g.fillStyle = ink(0.45); g.font = '600 9px Inter, sans-serif'; g.fillText(`floor ${usd(o.bid)}/TEU · room ${nf(o.room)} TEU`, (xa + xb) / 2, y + 16); }
      if (chosen) {                                   // a pennant on the chosen ship
        const fx = px + len * 0.1, fy = py - len * 0.42, wave = Math.sin(t * 4) * 1.5;
        g.strokeStyle = ink(0.7); g.lineWidth = 1; g.beginPath(); g.moveTo(fx, fy + 16); g.lineTo(fx, fy - 4); g.stroke();
        g.fillStyle = BLUE; g.beginPath(); g.moveTo(fx, fy - 4); g.lineTo(fx + 13, fy - 1 + wave); g.lineTo(fx, fy + 3); g.closePath(); g.fill();
      }
      this.hits.passage.push({ x: px, y: py - 6, html: `<b>${esc(vesselName(o.vessel.id))}</b>${o.k === 2 ? ` <span class="mut">alt hub ${esc(o.dest)}</span>` : ''}<br>sails +${nf((o.dep ?? now) - now, 1)} d · arrives +${nf((o.eta ?? now) - now, 1)} d<br>${o.feasible ? `floor ${usd(o.bid)}/TEU · ${nf(o.room)} TEU of room` : `<span class="mut">${esc(o.reason || 'infeasible')}</span>`}${chosen ? '<br><b>the sailing the policy priced</b>' : ''}` });
    });
  }

  drawFleetPassage(g, L, R, h, horizon, d, t, a) {
    const act = this.actions[d.action];
    const ordered = act?.kind === 'speed' ? act.vessel : -1;
    const span = (R - L) / d.fleet.length;
    d.fleet.forEach((v, i) => {
      const cx = L + span * (i + 0.5), len = Math.min(120, span * 0.78);
      const y = horizon + (h - horizon) * 0.55 + Math.sin(t * 1.6 + i) * 1.5;
      const hot = i === ordered;
      if (v.atSea) {
        const wl = len * (0.3 + v.speed / 20);
        const wg = g.createLinearGradient(cx - len / 2 - wl, 0, cx - len / 2, 0);
        wg.addColorStop(0, sea(0)); wg.addColorStop(1, sea(0.28));
        g.fillStyle = wg; g.beginPath(); g.moveTo(cx - len / 2 - wl, y); g.lineTo(cx - len / 2, y - 3); g.lineTo(cx - len / 2, y + 3); g.closePath(); g.fill();
      } else {
        g.fillStyle = ink(0.14); g.fillRect(cx - len / 2 - 6, y + 4, len + 12, 5);   // alongside a quay
      }
      drawShip(g, cx - len / 2, y, len, { hull: hot ? '#1d3b63' : '#2a241b', fill: clamp(v.fill, 0.05, 1), colors: BOXES, seed: 11 + i, bowWave: v.atSea ? clamp(v.speed / 18) : 0 });
      g.fillStyle = hot ? BLUE : ink(0.72); g.font = `${hot ? 700 : 600} 11px Inter, sans-serif`; g.textAlign = 'center';
      g.fillText(vesselName(v.id), cx, y + 22);
      g.fillStyle = ink(0.45); g.font = '600 9.5px Inter, sans-serif';
      g.fillText(`${v.atSea ? 'at sea' : 'in port'} · ${nf(v.speed, 0)} kn · ${pct(v.fill)}`, cx, y + 35);
      if (hot) this.telegraph(g, cx, horizon - 8, 26, act.kt, t, a);
    });
    if (act?.kind === 'reposition' && d.repoPairs?.[act.pair]) {
      const [src, dst] = d.repoPairs[act.pair];
      g.fillStyle = BLUE; g.font = '700 12px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(`${act.teu} empty TEU  ${src}  →  ${dst}`, (L + R) / 2, 30);
      for (let k = 0; k < 6; k++) {                   // boxes hopping across
        const u = (t * 0.35 + k / 6) % 1;
        const x = lerp(L + 40, R - 40, u), y = 54 - Math.sin(u * Math.PI) * 16;
        g.globalAlpha = Math.sin(u * Math.PI); g.fillStyle = BOXES[k % BOXES.length]; g.fillRect(x - 7, y - 4, 14, 8); g.globalAlpha = 1;
      }
    } else if (d.action === 0) {
      this.quiet(g, (L + R) / 2, 36, 'Steady as she goes — no fleet order this step.');
    }
  }

  // An engine-order telegraph: the handle swings to the ordered speed.
  telegraph(g, cx, cy, r, kt, t, a) {
    const steps = [12, 14, 16, 18], target = Math.max(0, steps.indexOf(kt));
    g.fillStyle = '#fffaf0'; g.strokeStyle = BRASS; g.lineWidth = Math.max(2, r * 0.07);
    g.beginPath(); g.arc(cx, cy, r, Math.PI, 0); g.closePath(); g.fill(); g.stroke();
    steps.forEach((s, i) => {
      const ang = Math.PI + ((i + 0.5) / steps.length) * Math.PI;
      g.fillStyle = i === target ? BLUE : ink(0.5); g.font = `${i === target ? 700 : 600} ${Math.max(8, r * 0.13)}px Inter, sans-serif`; g.textAlign = 'center';
      g.fillText(String(s), cx + Math.cos(ang) * r * 0.72, cy + Math.sin(ang) * r * 0.72 + 3);
    });
    const ang = Math.PI + ((lerp(0, target, a) + 0.5) / steps.length) * Math.PI + Math.sin(t * 9) * 0.03 * (1 - a);
    g.strokeStyle = ink(0.85); g.lineWidth = Math.max(2, r * 0.05);
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang) * r * 0.95, cy + Math.sin(ang) * r * 0.95); g.stroke();
    g.fillStyle = BRASS; g.beginPath(); g.arc(cx, cy, Math.max(3.5, r * 0.08), 0, Math.PI * 2); g.fill();
    g.fillStyle = ink(0.55); g.font = `700 ${Math.max(8, r * 0.1)}px Inter, sans-serif`; g.fillText('KNOTS', cx, cy + Math.max(11, r * 0.2));
  }

  /* ---- The compass */
  drawCompass() {
    const { g, w, h } = fit(this.c.compass);
    const d = this.d, t = this.time, a = this.arrive;
    const cx = w / 2, cy = h / 2 + 4, R = Math.min(w, h) / 2 - 34;
    this.hits.compass = { cx, cy, R };
    g.strokeStyle = ink(0.12); g.lineWidth = 1;
    for (const k of [1, 0.72, 0.44]) { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke(); }
    for (let i = 0; i < 32; i++) {                     // rhumb lines
      const an = (i / 32) * Math.PI * 2;
      g.strokeStyle = ink(i % 8 === 0 ? 0.16 : 0.06);
      g.beginPath(); g.moveTo(cx + Math.cos(an) * R * 0.2, cy + Math.sin(an) * R * 0.2); g.lineTo(cx + Math.cos(an) * R, cy + Math.sin(an) * R); g.stroke();
    }
    g.fillStyle = ink(0.05);                           // faint compass star
    for (let i = 0; i < 8; i++) {
      const an = (i / 8) * Math.PI * 2 - Math.PI / 2, len = i % 2 ? R * 0.55 : R * 0.95;
      g.beginPath(); g.moveTo(cx + Math.cos(an) * len, cy + Math.sin(an) * len);
      g.lineTo(cx + Math.cos(an + 0.2) * R * 0.14, cy + Math.sin(an + 0.2) * R * 0.14);
      g.lineTo(cx + Math.cos(an - 0.2) * R * 0.14, cy + Math.sin(an - 0.2) * R * 0.14); g.closePath(); g.fill();
    }
    GROUPS.forEach((gr) => {                          // the three kinds of order, as arcs on the rim
      const a0 = bearingOf(gr.from) - Math.PI / 44, a1 = bearingOf(gr.to - 1) + Math.PI / 44;
      g.strokeStyle = rgba(gr.color, 0.4); g.lineWidth = 3;
      g.beginPath(); g.arc(cx, cy, R + 7, a0 + 0.02, a1 - 0.02); g.stroke();
      const am = (a0 + a1) / 2, flip = Math.sin(am) > 0.2;
      g.save(); g.translate(cx + Math.cos(am) * (R + 20), cy + Math.sin(am) * (R + 20)); g.rotate(am + Math.PI / 2 + (flip ? Math.PI : 0));
      g.fillStyle = rgba(gr.color, 0.9); g.font = '700 8.5px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(gr.label, 0, 3); g.restore();
    });
    if (!d) { this.quiet(g, w / 2, h / 2, 'No bearing yet.'); return; }
    for (let i = 0; i < 44; i++) {                     // ticks for masked, petals for open bearings
      const an = bearingOf(i);
      if (!d.mask[i]) {
        g.strokeStyle = ink(0.12); g.lineWidth = 1;
        g.beginPath(); g.moveTo(cx + Math.cos(an) * (R - 5), cy + Math.sin(an) * (R - 5)); g.lineTo(cx + Math.cos(an) * R, cy + Math.sin(an) * R); g.stroke();
        continue;
      }
      const p = d.probs[i], chosen = i === d.action;
      const len = R * (0.22 + 0.76 * Math.sqrt(p)) * a, half = (Math.PI / 44) * 0.9;
      g.fillStyle = chosen ? rgba(BLUE, 0.3) : ink(0.12 + 0.25 * Math.sqrt(p));
      g.beginPath(); g.moveTo(cx + Math.cos(an) * R * 0.2, cy + Math.sin(an) * R * 0.2);
      g.lineTo(cx + Math.cos(an - half) * len, cy + Math.sin(an - half) * len);
      g.quadraticCurveTo(cx + Math.cos(an) * (len + 8), cy + Math.sin(an) * (len + 8), cx + Math.cos(an + half) * len, cy + Math.sin(an + half) * len);
      g.closePath(); g.fill();
      g.strokeStyle = chosen ? BLUE : ink(0.4); g.lineWidth = chosen ? 1.6 : 0.8; g.stroke();
    }
    // the needle: a damped spring to the chosen bearing, trembling with the policy's entropy
    const nd = this.needle, target = bearingOf(d.action), sub = 4;
    for (let k = 0; k < sub; k++) {
      nd.v += (wrapAngle(target - nd.a) * 42 - nd.v * 5.2) * (this.dt / sub);
      nd.a += nd.v * (this.dt / sub);
    }
    const e = clamp(d.entropy, 0, 2);
    const na = nd.a + Math.sin(t * 13) * 0.05 * e + Math.sin(t * 7.3) * 0.03 * e;
    g.save(); g.translate(cx, cy); g.rotate(na + Math.PI / 2);
    g.shadowColor = 'rgba(43,36,25,0.25)'; g.shadowBlur = 4; g.shadowOffsetY = 2;
    g.fillStyle = BLUE; g.beginPath(); g.moveTo(0, -R * 0.9); g.lineTo(6, 0); g.lineTo(-6, 0); g.closePath(); g.fill();
    g.fillStyle = ink(0.75); g.beginPath(); g.moveTo(0, R * 0.34); g.lineTo(6, 0); g.lineTo(-6, 0); g.closePath(); g.fill();
    g.restore();
    // labels for the top three bearings (drawn over the needle so they stay readable)
    d.probs.map((p, i) => [p, i]).filter(([, i]) => d.mask[i]).sort((x, y) => y[0] - x[0]).slice(0, 3).forEach(([p, i]) => {
      const an = bearingOf(i), rr = Math.min(R, R * (0.22 + 0.76 * Math.sqrt(p)) + 14);
      const x = cx + Math.cos(an) * rr, y = cy + Math.sin(an) * rr;
      const label = trunc(this.labelFor(d, i).replace('Counter · ', ''), 26);
      g.font = `${i === d.action ? 700 : 600} 10px Inter, sans-serif`;
      g.textAlign = Math.cos(an) > 0.2 ? 'left' : Math.cos(an) < -0.2 ? 'right' : 'center';
      const tw = g.measureText(label).width;
      const bx = g.textAlign === 'left' ? x - 3 : g.textAlign === 'right' ? x - tw - 3 : x - tw / 2 - 3;
      g.fillStyle = 'rgba(250,246,236,0.92)'; g.fillRect(bx, y - 11, tw + 6, 25);
      g.fillStyle = i === d.action ? BLUE : ink(0.78); g.fillText(label, x, y);
      g.fillStyle = ink(0.5); g.font = '600 9px Inter, sans-serif'; g.fillText(`π ${pct(p, p < 0.1 ? 1 : 0)}`, x, y + 11);
    });
    g.fillStyle = PAPER; g.strokeStyle = BRASS; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, 25, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = ink(0.9); g.font = '700 14px Inter, sans-serif'; g.textAlign = 'center';
    g.fillText(pct(d.probs[d.action]), cx, cy + 2);
    g.fillStyle = ink(0.5); g.font = '700 7.5px Inter, sans-serif'; g.fillText('SURE', cx, cy + 12);
    g.textAlign = 'left'; g.font = '700 8.5px Inter, sans-serif'; g.fillStyle = ink(0.5);
    g.fillText('ENTROPY', 8, h - 26);
    g.textAlign = 'right'; g.fillText('V(s) · VALUE', w - 8, h - 26);
    g.font = '700 14px Inter, sans-serif'; g.fillStyle = ink(0.85);
    g.textAlign = 'left'; g.fillText(`${nf(d.entropy, 2)} ${d.entropy < 0.3 ? '· steady' : d.entropy < 1 ? '· wavering' : '· unsure'}`, 8, h - 10);
    g.textAlign = 'right'; g.fillText(nf(d.value, 1), w - 8, h - 10);
  }

  /* ---- The tide */
  drawTide() {
    const { g, w, h } = fit(this.c.tide);
    const d = this.d, t = this.time, a = this.arrive, q = d?.quote;
    if (!d) return;
    if (!q || !q.curve?.length) { this.drawEngineRoom(g, w, h, d, t, a); return; }
    const cur = q.curve, pad = { l: 46, r: 60, t: 40, b: 28 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b, floor = pad.t + ph;
    const x0 = cur[0][0], x1 = cur[cur.length - 1][0];
    const mMin = Math.min(0, ...cur.map((c) => c[2])), mMax = Math.max(1, ...cur.map((c) => c[2]));
    const X = (p) => pad.l + ((p - x0) / (x1 - x0)) * pw;
    const YP = (v) => pad.t + (1 - v) * ph;
    const YM = (v) => pad.t + (1 - (v - mMin) / (mMax - mMin)) * ph;
    const surf = (x) => Math.sin(x * 0.06 + t * 1.8) * 1.6;
    g.font = '600 9.5px Inter, sans-serif';
    for (let i = 0; i <= 4; i++) {                    // tide gauge (left) and margin scale (right)
      const y = pad.t + (i / 4) * ph;
      g.strokeStyle = ink(0.07); g.setLineDash([2, 5]); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = ink(0.45); g.textAlign = 'right'; g.fillText(`${100 - i * 25}%`, pad.l - 8, y + 3);
      g.textAlign = 'left'; g.fillStyle = rgba(GREEN, 0.85); g.fillText(usd(mMax - (i / 4) * (mMax - mMin)), w - pad.r + 8, y + 3);
    }
    g.textAlign = 'center'; g.fillStyle = ink(0.45);
    for (let i = 0; i <= 5; i++) { const p = x0 + (i / 5) * (x1 - x0); g.fillText(usd(p), X(p), h - 8); }
    // the reef: prices below the bid floor run aground
    const rb = X(clamp(q.bid, x0, x1));
    if (rb > pad.l + 2) {
      g.save(); g.beginPath(); g.rect(pad.l, pad.t, rb - pad.l, ph); g.clip();
      g.fillStyle = rgba(RED, 0.05); g.fillRect(pad.l, pad.t, rb - pad.l, ph);
      g.strokeStyle = rgba(RED, 0.16); g.lineWidth = 1;
      for (let s = pad.l - ph; s < rb; s += 8) { g.beginPath(); g.moveTo(s, floor); g.lineTo(s + ph, pad.t); g.stroke(); }
      g.fillStyle = rgba(RED, 0.32);
      for (let x = pad.l + 6; x < rb - 4; x += 15) { g.beginPath(); g.moveTo(x - 7, floor); g.quadraticCurveTo(x, floor - 10 - ((x * 7) % 7), x + 7, floor); g.fill(); }
      g.restore();
      g.fillStyle = RED; g.font = '700 9px Inter, sans-serif'; g.textAlign = 'right';
      g.fillText('REEF · below the floor', rb - 6, floor - 16);
      g.strokeStyle = rgba(RED, 0.7); g.lineWidth = 1.2; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(rb, pad.t); g.lineTo(rb, floor); g.stroke(); g.setLineDash([]);
    }
    // the water rises under the P(accept) tideline, its surface rippling
    const tideY = (c) => lerp(floor, YP(c[1]), a) + surf(X(c[0]));
    g.save();
    g.beginPath(); g.moveTo(X(x0), floor);
    cur.forEach((c) => g.lineTo(X(c[0]), tideY(c)));
    g.lineTo(X(x1), floor); g.closePath();
    const wg = g.createLinearGradient(0, pad.t, 0, floor);
    wg.addColorStop(0, sea(0.34)); wg.addColorStop(1, sea(0.08));
    g.fillStyle = wg; g.fill();
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 1;
    for (let k = 1; k < 6; k++) {
      g.beginPath();
      for (let x = pad.l; x <= w - pad.r; x += 6) g.lineTo(x, pad.t + ph * (0.2 + k * 0.15) + Math.sin(x * 0.03 + t * (0.8 + k * 0.1) + k) * 2);
      g.stroke();
    }
    g.restore();
    g.beginPath(); cur.forEach((c, i) => (i ? g.lineTo : g.moveTo).call(g, X(c[0]), tideY(c)));
    g.strokeStyle = sea(0.95); g.lineWidth = 2; g.stroke();
    // expected margin: dashed green line, best point starred
    g.beginPath(); cur.forEach((c, i) => (i ? g.lineTo : g.moveTo).call(g, X(c[0]), lerp(YM(0), YM(c[2]), a)));
    g.strokeStyle = rgba(GREEN, 0.9); g.lineWidth = 1.6; g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
    const best = cur.reduce((m, c) => (c[2] > m[2] ? c : m), cur[0]);
    this.star(g, X(best[0]), lerp(YM(0), YM(best[2]), a) - 9, 5.5, GREEN, t);
    g.fillStyle = rgba(GREEN, 0.95); g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center';
    g.fillText(`best ${usd(best[0])}`, X(best[0]), lerp(YM(0), YM(best[2]), a) - 19);
    if (q.market >= x0 && q.market <= x1) this.lighthouse(g, X(q.market), pad.t - 6, floor, t);
    // the quote: a buoy riding the tide
    const at = curveAt(cur, q.price);
    const bx = X(clamp(q.price, x0, x1));
    this.buoy(g, bx, lerp(floor, YP(at.pAccept), a) + surf(bx), t, `Quote ${usd(q.price)}`);
  }

  // Fleet steps have no price: show the order itself.
  drawEngineRoom(g, w, h, d, t, a) {
    if (d.type !== 'fleet') { this.quiet(g, w / 2, h / 2, 'Rejected before a price was set — the tide never came in.'); return; }
    const act = this.actions[d.action];
    if (act?.kind === 'speed') {
      this.telegraph(g, w / 2, h * 0.72, Math.min(w * 0.3, h * 0.5), act.kt, t, a);
      g.fillStyle = ink(0.78); g.font = '700 13px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(`${vesselName(`VES${act.vessel + 1}`)} rung to ${act.kt} knots`, w / 2, 26);
      g.fillStyle = ink(0.45); g.font = '500 11px Inter, sans-serif';
      g.fillText('fuel burn grows with the cube of speed — slower saves fuel, faster keeps the schedule', w / 2, 44);
    } else if (act?.kind === 'reposition') {
      const pair = d.repoPairs?.[act.pair] || ['—', '—'];
      const lx = w * 0.22, rx = w * 0.78, base = h * 0.74;
      [[lx, pair[0], 'surplus'], [rx, pair[1], 'short of boxes']].forEach(([x, code, role], side) => {
        const n = side ? Math.round(2 + 4 * a) : Math.round(6 - 3 * a);
        for (let k = 0; k < n; k++) { g.fillStyle = BOXES[(k + side * 3) % BOXES.length]; g.fillRect(x - 18, base - (k + 1) * 11, 36, 10); }
        g.fillStyle = ink(0.8); g.font = '700 13px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(code, x, base + 18);
        g.fillStyle = ink(0.45); g.font = '600 9.5px Inter, sans-serif'; g.fillText(role, x, base + 31);
      });
      for (let k = 0; k < 4; k++) {
        const u = (t * 0.4 + k / 4) % 1, x = lerp(lx + 24, rx - 24, u), y = base - 60 - Math.sin(u * Math.PI) * 50;
        g.globalAlpha = Math.sin(u * Math.PI); g.fillStyle = BLUE; g.fillRect(x - 9, y - 5, 18, 10); g.globalAlpha = 1;
      }
      g.fillStyle = ink(0.78); g.font = '700 13px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(`${act.teu} empty TEU moved ${pair[0]} → ${pair[1]}`, w / 2, 26);
    } else {
      this.quiet(g, w / 2, h / 2, 'Steady as she goes — no order given.');
    }
  }

  lighthouse(g, x, y, bottom, t) {
    const beam = Math.sin(t * 1.2);
    g.fillStyle = `rgba(214,154,28,${0.14 + 0.12 * Math.abs(beam)})`;
    g.beginPath(); g.moveTo(x, y - 12); g.lineTo(x + 70 * beam - 12, y - 32); g.lineTo(x + 70 * beam + 12, y - 22); g.closePath(); g.fill();
    g.fillStyle = '#fffaf0'; g.strokeStyle = ink(0.7); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x - 5, y + 4); g.lineTo(x - 3, y - 12); g.lineTo(x + 3, y - 12); g.lineTo(x + 5, y + 4); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = RED; g.fillRect(x - 4.2, y - 6, 8.4, 3);
    g.fillStyle = AMBER; g.fillRect(x - 3, y - 16, 6, 4);
    g.fillStyle = BRASS; g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center'; g.fillText('MARKET', x, y + 15);
    g.strokeStyle = rgba(BRASS, 0.6); g.lineWidth = 1; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(x, y + 19); g.lineTo(x, bottom); g.stroke(); g.setLineDash([]);
  }

  buoy(g, x, y, t, label) {
    g.save(); g.translate(x, y); g.rotate(Math.sin(t * 2.3) * 0.18);
    g.fillStyle = RED; g.beginPath(); g.moveTo(-7, 0); g.lineTo(7, 0); g.lineTo(4, -16); g.lineTo(-4, -16); g.closePath(); g.fill();
    g.fillStyle = '#fffaf0'; g.fillRect(-5.2, -10, 10.4, 4);
    g.strokeStyle = ink(0.8); g.lineWidth = 1.2; g.beginPath(); g.moveTo(0, -16); g.lineTo(0, -26); g.stroke();
    g.fillStyle = ink(0.85); g.beginPath(); g.arc(0, -27, 2.4, 0, Math.PI * 2); g.fill();
    g.restore();
    g.font = '700 10.5px Inter, sans-serif'; g.textAlign = 'center';
    const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(250,246,236,0.92)'; g.fillRect(x - tw / 2 - 4, y - 49, tw + 8, 15);
    g.strokeStyle = ink(0.15); g.strokeRect(x - tw / 2 - 4, y - 49, tw + 8, 15);
    g.fillStyle = ink(0.9); g.fillText(label, x, y - 38);
  }

  star(g, x, y, r, col, t) {
    g.save(); g.translate(x, y); g.rotate(t * 0.6);
    g.fillStyle = col; g.beginPath();
    for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.45 : r, an = (i / 10) * Math.PI * 2; g.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); }
    g.closePath(); g.fill(); g.restore();
  }

  /* ---- Soundings */
  drawSoundings() {
    const { g, w, h } = fit(this.c.sound);
    const d = this.d, t = this.time, a = this.arrive;
    const water = 72, bed = h - 26;
    const sg = g.createLinearGradient(0, water, 0, bed);
    sg.addColorStop(0, sea(0.06)); sg.addColorStop(1, sea(0.2));
    g.fillStyle = sg; g.fillRect(0, water, w, bed - water);
    g.strokeStyle = sea(0.55); g.lineWidth = 1.2; g.beginPath();
    for (let x = 0; x <= w; x += 5) g.lineTo(x, water + Math.sin(x * 0.05 + t * 1.6) * 1.2);
    g.stroke();
    this.hits.sound = [];
    if (!d) return;
    // the seabed = all 112 inputs (|value|), a coloured strip per input block
    const dx = w / (d.obs.length - 1);
    g.beginPath(); g.moveTo(0, h);
    d.obs.forEach((v, i) => g.lineTo(i * dx, bed - clamp(Math.abs(v)) * 22));
    g.lineTo(w, h); g.closePath(); g.fillStyle = '#e6dcc4'; g.fill();
    g.strokeStyle = ink(0.25); g.lineWidth = 1; g.stroke();
    OBS_BLOCKS.forEach((b) => { g.fillStyle = rgba(b.color, 0.6); g.fillRect(b.from * dx, h - 5, (b.to - b.from) * dx, 5); });
    // survey ship + sonar ping
    const sx = 30;
    drawShip(g, sx - 20, water + 2, 40, { fill: 0.6, colors: BOXES, seed: 5 });
    const ping = (t % 3) / 3;
    g.strokeStyle = sea(0.5 * (1 - ping)); g.lineWidth = 1.2;
    g.beginPath(); g.arc(sx, water + 4, 10 + ping * w * 0.9, 0.05, Math.PI * 0.5); g.stroke();
    const attr = (d.attr || []).slice(0, 8);
    if (!attr.length) { this.quiet(g, w / 2, (water + bed) / 2, 'The lead found no bottom — no attribution for this decision.'); return; }
    const x0 = 90, span = (w - x0 - 30) / attr.length;
    attr.forEach((f, i) => {
      const x = x0 + span * (i + 0.5);
      const depth = water + 10 + Math.abs(f.w) * (bed - water - 44) * a;
      const col = f.w >= 0 ? BLUE : RED;
      const sway = Math.sin(t * 1.4 + i) * 1.5;
      g.strokeStyle = rgba(col, 0.8); g.lineWidth = 1.2; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, water - 2); g.lineTo(x + sway, depth); g.stroke(); g.setLineDash([]);
      g.fillStyle = col; g.beginPath(); g.moveTo(x + sway - 5, depth); g.lineTo(x + sway + 5, depth); g.lineTo(x + sway + 3, depth + 9); g.lineTo(x + sway - 3, depth + 9); g.closePath(); g.fill();
      g.font = '700 10px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText(`${f.w >= 0 ? '+' : '−'}${nf(Math.abs(f.w) * 100)}`, x + sway, depth + 22);
      // the feature's name on a float at the surface, alternating rows so neighbours don't collide
      const ly = i % 2 ? water - 22 : water - 44;
      const label = trunc(f.label, Math.max(10, Math.floor(span / 5.4)));
      g.font = '600 9.5px Inter, sans-serif';
      const tw = g.measureText(label).width;
      g.strokeStyle = ink(0.22); g.beginPath(); g.moveTo(x, ly + 5); g.lineTo(x, water - 2); g.stroke();
      g.fillStyle = 'rgba(250,246,236,0.96)'; g.fillRect(x - tw / 2 - 4, ly - 9, tw + 8, 14);
      g.strokeStyle = ink(0.14); g.strokeRect(x - tw / 2 - 4, ly - 9, tw + 8, 14);
      g.fillStyle = ink(0.82); g.fillText(label, x, ly + 1.5);
      this.hits.sound.push({ x, a: f });
    });
  }

  /* ---- The regatta */
  drawRegatta() {
    const { g, w, h } = fit(this.c.regatta);
    const d = this.d, t = this.time;
    if (!d) return;
    if (!d.baselines) { this.quiet(g, w / 2, h / 2, d.type === 'fleet' ? 'No race on a fleet step — the captains only price bookings.' : 'Rejected before pricing — no race to sail.'); return; }
    const rows = d.baselines.map((b) => ({ ...b, color: STRAT[b.key] || INKHEX }));
    const vals = rows.filter((r) => r.price != null).map((r) => r.ev);
    const lo = Math.min(0, ...vals), hi = Math.max(1, ...vals) * 1.1;
    const pad = { l: 124, r: 78, t: 24, b: 8 }, laneH = (h - pad.t - pad.b) / rows.length;
    const X = (v) => pad.l + ((v - lo) / (hi - lo)) * (w - pad.l - pad.r);
    g.font = '600 9px Inter, sans-serif'; g.textAlign = 'center'; g.fillStyle = ink(0.45);
    g.fillText('START · $0 margin', X(0), 13);
    for (let y = pad.t, k = 0; y < h - pad.b; y += 5, k++) { g.fillStyle = k % 2 ? ink(0.7) : '#fffaf0'; g.fillRect(X(0) - 2, y, 4, 5); }
    rows.forEach((r, i) => {
      const y0 = pad.t + i * laneH, yc = y0 + laneH * 0.6;
      g.fillStyle = sea(0.05 + (i % 2) * 0.03); g.fillRect(pad.l - 8, y0, w - pad.l - pad.r + 16, laneH);
      g.strokeStyle = sea(0.16); g.lineWidth = 1; g.beginPath();
      for (let x = pad.l - 8; x <= w - pad.r + 8; x += 6) g.lineTo(x, y0 + laneH * 0.82 + Math.sin(x * 0.05 + t * 1.5 + i) * 1.2);
      g.stroke();
      const ours = r.key === 'ppo';
      g.fillStyle = ours ? BLUE : ink(0.78); g.font = `${ours ? 700 : 600} 11px Inter, sans-serif`; g.textAlign = 'right';
      g.fillText(r.label, pad.l - 16, yc - 2);
      g.fillStyle = ink(0.45); g.font = '500 9.5px Inter, sans-serif';
      g.fillText(trunc(String(r.kind).replace(/_/g, ' '), 18), pad.l - 16, yc + 10);
      if (r.price == null) {                          // rejected: stayed in port, anchored at the start
        const x = X(0) + 16;
        g.strokeStyle = ink(0.45); g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(x, yc - 8); g.lineTo(x, yc + 6); g.stroke();
        g.beginPath(); g.arc(x, yc + 2, 5, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
        g.fillStyle = ink(0.5); g.font = 'italic 500 10.5px Georgia, serif'; g.textAlign = 'left'; g.fillText('stayed in port', x + 10, yc + 3);
        return;
      }
      const x = lerp(X(0), X(r.ev), easeOut(clamp((this.time - this.arriveT - i * 0.14) / 1.8)));
      const bob = Math.sin(t * 2 + i) * 1.2;
      const wg = g.createLinearGradient(X(0), 0, x, 0);
      wg.addColorStop(0, rgba(r.color, 0)); wg.addColorStop(1, rgba(r.color, 0.3));
      g.fillStyle = wg; g.fillRect(Math.min(X(0), x), yc + 3 + bob, Math.abs(x - X(0)), 2);
      this.sailboat(g, x, yc + 4 + bob, Math.min(28, laneH * 0.72), r.color, ours, t + i);
      g.fillStyle = ours ? BLUE : ink(0.82); g.font = `${ours ? 700 : 600} 11px Inter, sans-serif`; g.textAlign = 'left';
      g.fillText(usd(r.ev), x + 16, yc - 2);
      g.fillStyle = ink(0.45); g.font = '500 9.5px Inter, sans-serif'; g.fillText(`@ ${usd(r.price)}/TEU`, x + 16, yc + 10);
    });
  }

  sailboat(g, x, y, s, col, ours, t) {
    g.fillStyle = ours ? '#1d3b63' : '#2a241b';
    g.beginPath(); g.moveTo(x - s * 0.55, y - s * 0.12); g.lineTo(x + s * 0.55, y - s * 0.12); g.lineTo(x + s * 0.35, y + s * 0.12); g.lineTo(x - s * 0.4, y + s * 0.12); g.closePath(); g.fill();
    g.strokeStyle = ink(0.7); g.lineWidth = 1; g.beginPath(); g.moveTo(x, y - s * 0.12); g.lineTo(x, y - s * 1.05); g.stroke();
    const luff = Math.sin(t * 3) * s * 0.05;
    g.fillStyle = col; g.beginPath(); g.moveTo(x + 1, y - s); g.quadraticCurveTo(x + s * 0.55 + luff, y - s * 0.55, x + 1, y - s * 0.2); g.closePath(); g.fill();
    g.fillStyle = rgba(col, 0.55); g.beginPath(); g.moveTo(x - 1, y - s * 0.85); g.lineTo(x - s * 0.4, y - s * 0.2); g.lineTo(x - 1, y - s * 0.2); g.closePath(); g.fill();
  }

  /* ---- Currents */
  drawCurrents() {
    const { g, w, h } = fit(this.c.currents);
    const d = this.d, net = this.feed.network, t = this.time, a = this.arrive;
    if (!d) return;
    const W1 = net.w1, W2 = net.w2, W3 = net.w3, K = W1.length;
    const outs = d.probs.map((p, i) => [p, i]).filter(([, i]) => d.mask[i]).sort((x, y) => y[0] - x[0]).slice(0, 5).map(([, i]) => i);
    if (!outs.includes(d.action)) outs[outs.length - 1] = d.action;
    const col = [138, w * 0.4, w * 0.62, w - 230];
    const yIn = (b) => 24 + (b + 0.5) * ((h - 48) / OBS_BLOCKS.length);
    const yU = (k) => 20 + (k + 0.5) * ((h - 36) / K);
    const yOut = (o) => 30 + (o + 0.5) * ((h - 60) / outs.length);
    const edges = [];
    const e1 = [];                                    // input streams → layer 1: Σ w1·obs per block
    OBS_BLOCKS.forEach((b, bi) => { for (let k = 0; k < K; k++) { let s = 0; for (let i = b.from; i < b.to; i++) s += W1[k][i] * d.obs[i]; e1.push({ s, xa: col[0] + 8, ya: yIn(bi), xb: col[1] - 5, yb: yU(k) }); } });
    e1.sort((p, q) => Math.abs(q.s) - Math.abs(p.s)); const m1 = Math.abs(e1[0]?.s || 1);
    e1.slice(0, 36).forEach((e) => edges.push({ ...e, m: m1, strong: false }));
    const e2 = [];                                    // layer 1 → layer 2: w2·h1
    for (let j = 0; j < K; j++) for (let k = 0; k < K; k++) e2.push({ s: W2[j][k] * d.h1[k], xa: col[1] + 5, ya: yU(k), xb: col[2] - 5, yb: yU(j) });
    e2.sort((p, q) => Math.abs(q.s) - Math.abs(p.s)); const m2 = Math.abs(e2[0]?.s || 1);
    e2.slice(0, 54).forEach((e) => edges.push({ ...e, m: m2, strong: false }));
    const e3 = [];                                    // layer 2 → actions: w3·h2 (every strong one into the chosen action)
    outs.forEach((act, o) => {
      const row = W3[act].map((wt, j) => ({ s: wt * d.h2[j], xa: col[2] + 5, ya: yU(j), xb: col[3] - 8, yb: yOut(o), strong: act === d.action }))
        .sort((p, q) => Math.abs(q.s) - Math.abs(p.s));
      e3.push(...(act === d.action ? row.slice(0, 16) : row.slice(0, 5)));
    });
    const m3 = Math.max(...e3.map((e) => Math.abs(e.s)), 1e-6);
    e3.forEach((e) => edges.push({ ...e, m: m3 }));
    edges.sort((p, q) => p.strong - q.strong).forEach((e, idx) => {
      const k = clamp(Math.abs(e.s) / e.m), alpha = k * (e.strong ? 0.75 : 0.4) * a;
      if (alpha < 0.03) return;
      const colr = e.s >= 0 ? BLUE : RED, mx = (e.xa + e.xb) / 2;
      g.strokeStyle = rgba(colr, alpha); g.lineWidth = 0.5 + (e.strong ? 3 : 1.6) * k;
      g.beginPath(); g.moveTo(e.xa, e.ya); g.bezierCurveTo(mx, e.ya, mx, e.yb, e.xb, e.yb); g.stroke();
      const n = e.strong ? 3 : k > 0.5 ? 2 : 1;       // particles drift downstream, faster in stronger currents
      for (let p = 0; p < n; p++) {
        const u = (t * (0.16 + 0.5 * k) + p / n + idx * 0.137) % 1, v = 1 - u;
        const bx = v * v * v * e.xa + 3 * v * v * u * mx + 3 * v * u * u * mx + u * u * u * e.xb;
        const by = v * v * v * e.ya + 3 * v * v * u * e.ya + 3 * v * u * u * e.yb + u * u * u * e.yb;
        g.fillStyle = rgba(colr, Math.min(1, alpha * 1.7)); g.beginPath(); g.arc(bx, by, e.strong ? 2 : 1.4, 0, Math.PI * 2); g.fill();
      }
    });
    g.textAlign = 'right'; g.font = '600 10px Inter, sans-serif';
    OBS_BLOCKS.forEach((b, bi) => {                   // the input streams
      const y = yIn(bi);
      g.fillStyle = rgba(b.color, 0.9); g.beginPath(); g.arc(col[0], y, 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = ink(0.4); g.lineWidth = 0.8; g.stroke();
      g.fillStyle = ink(0.72); g.fillText(b.label, col[0] - 10, y + 3.5);
    });
    const unit = (x, y, v) => {                       // hidden units as buoys tinted by activation
      g.fillStyle = '#fffaf0'; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = rgba(v >= 0 ? BLUE : RED, 0.15 + 0.8 * Math.abs(clamp(v, -1, 1))); g.fill();
      g.strokeStyle = ink(0.35); g.lineWidth = 0.7; g.stroke();
    };
    for (let k = 0; k < K; k++) { unit(col[1], yU(k), d.h1[k]); unit(col[2], yU(k), d.h2[k]); }
    g.fillStyle = ink(0.48); g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center';
    g.fillText('INPUT STREAMS', col[0] - 44, 12); g.fillText(`HIDDEN 1 · ${K} of ${net.layers[1]}`, col[1], 11);
    g.fillText(`HIDDEN 2 · ${K} of ${net.layers[2]}`, col[2], 11); g.fillText('HARBOURS · ACTIONS', col[3] + 60, 12);
    outs.forEach((act, o) => {                       // the harbours: the top actions, the chosen one lit
      const y = yOut(o), chosen = act === d.action, p = d.probs[act];
      if (chosen) { g.fillStyle = rgba(BLUE, 0.1 + 0.06 * Math.sin(t * 3)); g.beginPath(); g.arc(col[3], y, 17, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = chosen ? BLUE : ink(0.4); g.beginPath(); g.arc(col[3], y, chosen ? 6 : 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = chosen ? BLUE : ink(0.72); g.font = `${chosen ? 700 : 600} 11px Inter, sans-serif`; g.textAlign = 'left';
      g.fillText(trunc(this.labelFor(d, act).replace('Counter · ', ''), 28), col[3] + 14, y - 1);
      g.fillStyle = ink(0.45); g.font = '600 9.5px Inter, sans-serif'; g.fillText(`π ${pct(p, p < 0.1 ? 1 : 0)}`, col[3] + 14, y + 12);
    });
  }
}
