// Live decision engine for the Model page ("Inside the helm"): turns the real
// backend's policy-inspection API into exactly the shape model.js draws.
// Nothing here is invented — every field is read from the trained
// MaskablePPO's own forward pass (js/api.js -> /live/policy, /live/policy/network),
// the bid-price engine's own pricing/curve output, or de-normalised from the
// real 112-float observation using the layout in backend/env/fleet_env.py
// `_obs()`. The curve shown on the pricing card is the bid-price engine's own
// segment willingness-to-pay *model* (from calibration) — not the customer's
// hidden realised value, which the policy never sees and neither do we.
import { API } from '../api.js';

// ---------------------------------------------------------------- constants
// Real, fixed port codes (backend/data/calibration.py C.PORTS) — same order
// _obs() uses, confirmed against /live/policy/network's obs_labels.
export const PORTS = ['CNSHA', 'SGSIN', 'KRPUS', 'NLRTM', 'DEHAM', 'BEANR', 'USLAX', 'USNYC'];

// The 8-station replay is a fixed structural label set, independent of any
// decision's content.
export const STAGES = [
  { key: 'request',  label: 'Request',     sub: 'booking arrives' },
  { key: 'forecast', label: 'Forecast',    sub: 'DemandForecaster' },
  { key: 'bid',      label: 'Bid price',   sub: 'BidPriceEngine' },
  { key: 'observe',  label: 'Observe',     sub: '112-d state' },
  { key: 'policy',   label: 'Policy',      sub: 'PPO forward' },
  { key: 'mask',     label: 'Mask',        sub: 'action_masks()' },
  { key: 'act',      label: 'Act',         sub: 'argmax π' },
  { key: 'ledger',   label: 'Settle',      sub: 'customer · ledger' },
];

// Real observation layout, from backend/env/fleet_env.py `_obs()`:
//   request(14) + options(4*5=20) + market(6) + ports(8*3=24) + vessels(4*6=24)
//   + forecast(18) + calendar(4) + flags(2) = 112
export const OBS_BLOCKS = [
  { key: 'req',    label: 'Request & market', from: 0,   to: 14,  color: '#7cc4ff' },
  { key: 'opt',    label: 'Voyage options',   from: 14,  to: 34,  color: '#5fe39a' },
  { key: 'market', label: 'Market & network', from: 34,  to: 40,  color: '#e0c341' },
  { key: 'port',   label: 'Ports',            from: 40,  to: 64,  color: '#ffc35a' },
  { key: 'ves',    label: 'Vessels',          from: 64,  to: 88,  color: '#c99bff' },
  { key: 'fc',     label: 'Forecast',         from: 88,  to: 106, color: '#4fd1c5' },
  { key: 'cal',    label: 'Calendar',         from: 106, to: 110, color: '#9fb0c0' },
  { key: 'flag',   label: 'Flags',            from: 110, to: 112, color: '#ff8a7a' },
];

const FLEX_TIERS = [5, 10, 15, 20];
const ALT_TIERS = [5, 10, 15];
const SPLIT_TIERS = [[50, 50], [60, 40], [70, 30]];
const SPEED_TIERS = [12, 14, 16, 18];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- actions
// The 44-action descriptor set model.js draws (helm spokes, top-actions list,
// policy-head rows). Labels come straight from the real network's own
// action_labels (which already carry generic "Reposition #k" names when the
// real per-decision port pair isn't known yet — that's filled in per-decision
// from trace.repo_pairs, since reposition pairs are chosen fresh each fleet
// step and aren't fixed).
export function actionsFromNetwork(network) {
  const labels = network.action_labels;
  return labels.map((label, i) => {
    if (i === 0) return { i, group: 'book', kind: 'reject', label, short: 'REJ' };
    if (i === 1) return { i, group: 'book', kind: 'accept', label, short: 'ACC' };
    if (i >= 2 && i <= 5) {
      const p = FLEX_TIERS[i - 2];
      return { i, group: 'book', kind: 'flex_window', disc: p / 100, label, short: `FX${p}` };
    }
    if (i >= 6 && i <= 8) {
      const p = ALT_TIERS[i - 6];
      return { i, group: 'book', kind: 'alt_hub', disc: p / 100, label, short: `AH${p}` };
    }
    if (i >= 9 && i <= 11) {
      const [a] = SPLIT_TIERS[i - 9];
      return { i, group: 'book', kind: 'split', ratio: a / 100, label, short: `SP${a}` };
    }
    if (i >= 12 && i <= 27) {
      const k = i - 12, vessel = Math.floor(k / 4), kt = SPEED_TIERS[k % 4];
      return { i, group: 'speed', kind: 'speed', vessel, kt, label, short: `${kt}` };
    }
    const k = i - 28, pair = Math.floor(k / 2), teu = [75, 150][k % 2];
    return { i, group: 'repo', kind: 'reposition', pair, teu, label, short: `${teu}` };
  });
}

// ---------------------------------------------------------------- helpers
function stampFor(step, actionDesc, outcome) {
  if (step === 'fleet') {
    if (actionDesc.kind === 'speed') return 'ENGINE ORDER';
    if (actionDesc.kind === 'reposition') return 'REPOSITION';
    return 'HOLD';
  }
  // No outcome recorded yet for this request — true for a genuine reject
  // (nothing ever books it) but not for an accept/counter, so only stamp
  // REJECTED once the outcome event has actually been seen.
  if (outcome == null) return actionDesc.kind === 'reject' ? 'REJECTED' : 'PENDING';
  const o = outcome.outcome;
  if (o === 'booked') return 'BOOKED';
  if (o === 'declined' || o === 'counter_declined' || o === 'price_reject') return 'DECLINED';
  return 'REJECTED';
}

function explainFor(step, actionDesc, req, pricing, outcome, repoPairs) {
  if (step === 'fleet') {
    if (actionDesc.kind === 'speed') return `VES${actionDesc.vessel + 1} ordered to ${actionDesc.kt} kn.`;
    if (actionDesc.kind === 'reposition') {
      const pair = repoPairs && repoPairs[actionDesc.pair];
      return pair
        ? `Move ${actionDesc.teu} empty TEU ${pair[0]} → ${pair[1]} — surplus toward a deficit port.`
        : `Reposition order #${actionDesc.pair + 1}: ${actionDesc.teu} empty TEU.`;
    }
    return 'Hold — no fleet order issued this step.';
  }
  if (actionDesc.kind === 'reject') {
    const reason = outcome && outcome.reason ? outcome.reason.replace(/_/g, ' ') : 'infeasible or below the bid-price floor';
    return `Reject — ${reason}.`;
  }
  if (!pricing) return `${actionDesc.label}.`;
  const disc = pricing.discount_pct ? ` (−${Math.round(pricing.discount_pct * 100)}%)` : '';
  const reason = (pricing.reason || '').replace(/_/g, ' ');
  return `${actionDesc.label}${disc}: bid floor $${Math.round(pricing.bid_price)}/TEU · market $${Math.round(pricing.market_rate)}/TEU`
    + ` → quote $${Math.round(pricing.price)}/TEU${reason ? ` (${reason})` : ''}.`;
}

// ---------------------------------------------------------------- pricing curve
// The bid-price engine's own P(accept)/margin objective, sampled at 64 prices
// by the backend (trace.pricing.curve = [[price, P(accept), margin], ...]).
// This is a data-source swap for the page's old `pAccept(price, mu)` — linear
// interpolation over the real, returned curve instead of a synthetic model.
export function curveAt(curve, price) {
  if (!curve || !curve.length) return { pAccept: 0, margin: 0 };
  if (price <= curve[0][0]) return { pAccept: curve[0][1], margin: curve[0][2] };
  const last = curve[curve.length - 1];
  if (price >= last[0]) return { pAccept: last[1], margin: last[2] };
  for (let i = 0; i < curve.length - 1; i++) {
    const [p0, pa0, m0] = curve[i], [p1, pa1, m1] = curve[i + 1];
    if (price >= p0 && price <= p1) {
      const u = (price - p0) / Math.max(1e-9, p1 - p0);
      return { pAccept: pa0 + (pa1 - pa0) * u, margin: m0 + (m1 - m0) * u };
    }
  }
  return { pAccept: last[1], margin: last[2] };
}

// ---------------------------------------------------------------- voyage options
// The page draws a fixed 4-slot layout (0: nearest requested sailing, 1: a
// later requested sailing — the flex-window candidate, 2: the alt-hub option,
// 3: a third requested sailing — the split candidate), same layout the old
// mock always produced. The live world returns 1-3 real options per request
// (`kind: 'requested' | 'alt_hub'`); whichever slot it didn't offer gets an
// honest infeasible placeholder (zeroed, never a fabricated number).
function mapOpt(k, o) {
  return {
    k,
    vessel: { id: o.vessel_id },
    dep: o.board_day,
    dest: o.dest,
    legs: (o.legs || []).map((l) => ({ from: l.from, to: l.to, remaining: l.remaining_teu, pressure: l.pressure, bid: l.bid_price })),
    bid: o.bid,
    room: o.room_teu,
    feasible: o.feasible,
    reason: o.reason,
  };
}
function emptyOpt(k, reason) {
  return { k, vessel: { id: '—' }, dep: null, dest: '—', legs: [], bid: 0, room: 0, feasible: false, reason };
}
function buildOptions(trace) {
  const raw = trace.options || [];
  const requested = raw.filter((o) => o.kind === 'requested');
  const alt = raw.find((o) => o.kind === 'alt_hub');
  return [
    requested[0] ? mapOpt(0, requested[0]) : emptyOpt(0, 'no sailing on the books'),
    requested[1] ? mapOpt(1, requested[1]) : emptyOpt(1, 'no secondary sailing within flex'),
    alt ? mapOpt(2, alt) : emptyOpt(2, 'no partner hub on this lane'),
    requested[2] ? mapOpt(3, requested[2]) : emptyOpt(3, 'no further sailing offered'),
  ];
}
function findChosenOpt(options, pricing) {
  if (!pricing) return -1;
  return options.findIndex((o) => o.vessel.id === pricing.vessel_id && o.dest === pricing.dest
    && o.dep != null && Math.abs(o.dep - pricing.board_day) < 0.01);
}

// ---------------------------------------------------------------- toDecision
// PURE: builds exactly the decision object model.js draws, from a trace (one
// item of API.livePolicy()'s `decisions`) and the (also real) network slice.
export function toDecision(trace, network) {
  const obs = trace.obs;
  const actions = actionsFromNetwork(network);
  const action = actions[trace.action];
  const pricing = trace.pricing || null;
  const req = trace.request ? {
    id: trace.request.request_id,
    origin: trace.request.origin,
    dest: trace.request.dest,
    teu: trace.request.teu,
    weight: trace.request.weight_t,
    cargo: trace.request.cargo_type,
    segment: trace.request.segment,
    reqDep: trace.request.req_dep_day,
    flex: trace.request.flex_days,
    market: trace.request.market_rate,
  } : null;

  // Fleet steps carry no voyage options at all (mirrors the option block
  // reading as all-zero in obs[14:34) on a fleet step).
  const options = trace.step === 'booking' ? buildOptions(trace) : [];
  const chosenOpt = findChosenOpt(options, pricing);

  // Ports: obs[40:64), 8 ports x 3 (wait/200, empties/2000, closed).
  const ports = PORTS.map((code, i) => {
    const base = 40 + 3 * i;
    return { code, wait: obs[base] * 200, congestion: clamp01(obs[base]), empties: Math.round(obs[base + 1] * 2000), closed: obs[base + 2] > 0.5 };
  });

  // Fleet: obs[64:88), 4 vessels x 6 (speed/20, at sea, stowage used, onboard
  // frac, empties aboard frac, next event /30 clipped +-1).
  const fleet = [];
  for (let i = 0; i < 4; i++) {
    const base = 64 + 6 * i;
    fleet.push({
      id: `VES${i + 1}`,
      speed: obs[base] * 20,
      atSea: obs[base + 1] > 0.5,
      inPort: obs[base + 1] <= 0.5,
      stowageUsed: obs[base + 2],
      fill: obs[base + 3],
      emptiesAboard: obs[base + 4],
      nextEvent: obs[base + 5] * 30,
    });
  }
  const inPortIdx = fleet.findIndex((v) => v.inPort);

  // Forecast: obs[88:106), 18 route-week slots, already 0..~1 (TEU/wk / 1200).
  const routeLabels = network.obs_labels.slice(88, 106).map((l) => l.replace(/^forecast /, ''));
  const forecast = Array.from({ length: 18 }, (_, i) => obs[88 + i]);

  // Calendar: obs[106:110) weekday sin/cos, quarter sin/cos; episode progress
  // lives in the market block (obs[36]).
  const wSin = obs[106], wCos = obs[107];
  let dowFrac = Math.atan2(wSin, wCos) / (Math.PI * 2) * 7;
  if (dowFrac < 0) dowFrac += 7;
  const calendar = {
    dow: Math.floor(dowFrac) % 7,
    frac: dowFrac - Math.floor(dowFrac),
    week: Math.floor(trace.day / 7) + 1,
    progress: clamp01(obs[36]),
  };

  const mask = trace.mask;
  const masked = mask.filter((v) => !v).length;

  // Pathway into the chosen action for the currents view: the 3 h2 units
  // that carry the most weight (real w3 x real h2), same idea already used
  // for the network's edge highlighting.
  const w3row = network.w3[trace.action];
  const path = { h2: w3row.map((w, j) => [Math.abs(w * trace.h2[j]), j]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((q) => q[1]) };

  // Shock: a real port closure this step (obs-derived, same as the old mock's
  // "shock" flag) — used only as a telemetry annotation, not invented.
  const shock = ports.some((p) => p.closed);

  const outcome = trace.outcome || null;
  const stamp = stampFor(trace.step, action, outcome);
  const key = trace.step === 'fleet'
    ? `fleet:${action.kind}`
    : stamp === 'PENDING' ? `pending:${action.kind}`
      : action.kind === 'reject'
        ? (options.some((o) => o.feasible) ? 'rejected:below_floor_or_full' : 'rejected:infeasible')
        : (outcome && outcome.outcome === 'booked') ? `booked:${action.kind}`
          : action.kind === 'accept' ? 'declined' : `counter_declined:${action.kind}`;
  const ok = stamp === 'BOOKED' || trace.step === 'fleet';
  const onchain = !!(outcome && outcome.deal);
  const ledger = (outcome && outcome.seq != null)
    ? { seq: outcome.seq, hash: outcome.hash, prev: outcome.prev_hash, tx: outcome.deal ? outcome.deal.tx_hash : null }
    : null;

  // Pricing card: the bid-price engine's own quote for the option it priced,
  // plus the real acceptance/margin curve for that quote (see curveAt above).
  const quote = pricing ? {
    price: pricing.price,
    offer: pricing.price,
    reason: pricing.reason,
    bid: pricing.bid_price,
    market: pricing.market_rate,
    guard: pricing.list_price,
    curve: pricing.curve,
    opt: chosenOpt,
    disc: pricing.discount_pct,
  } : null;

  // Realised margin over the bid-price floor for the action actually taken —
  // not a P(accept)-weighted expectation (the decision is already made).
  const ev = (trace.step === 'booking' && pricing && action.kind !== 'reject')
    ? (pricing.price - pricing.bid_price) * pricing.teu
    : 0;

  // "Same request, other captains": the backend's own counterfactual pricers
  // (static rate card / greedy / heuristic / heuristic+bid) run on this same
  // request, plus Dock's own PPO row.
  const baselines = (trace.step === 'booking' && pricing) ? [
    ...(trace.counterfactuals || []).map((cf) => ({ key: cf.key, label: cf.label, kind: cf.kind, price: cf.price, ev: cf.margin_usd })),
    { key: 'ppo', label: 'Dock · PPO', kind: action.label.replace('Counter · ', ''), price: pricing.price, ev },
  ] : null;

  // Voyage strip latency: only 4 of the 8 stations carry a real measured
  // number (bid/policy/mask/act) — the rest render without a "· N ms" tag.
  const LAT_KEY = { request: null, forecast: null, bid: 'bid', observe: null, policy: 'policy', mask: 'mask', act: 'act', ledger: null };
  const latency = STAGES.map((s) => {
    const k = LAT_KEY[s.key];
    const v = k && trace.latency_ms ? trace.latency_ms[k] : null;
    return v == null ? null : v;
  });

  return {
    n: trace.n,
    step: trace.n,
    day: trace.day,
    shock,
    type: trace.step,           // 'booking' | 'fleet'
    req,
    options,
    chosenOpt,
    ports,
    fleet,
    inPort: inPortIdx,
    forecast,
    routeLabels,
    calendar,
    obs,
    mask,
    masked,
    probs: trace.probs,
    logits: trace.logits,
    action: trace.action,
    // V(s) is the critic's estimate of discounted *shaped* return (profit/1e4
    // plus bid-price shaping, minus an empty-mile penalty) — not dollars, so it
    // is shown as-is, never converted to a $ figure.
    value: trace.value,
    entropy: trace.entropy,
    h1: trace.h1,
    h2: trace.h2,
    path,
    attr: trace.attribution,
    quote,
    ev,
    baselines,
    latency,
    repoPairs: trace.repo_pairs,
    outcome: { key, ok, stamp },
    onchain,
    ledger,
    explain: explainFor(trace.step, action, req, pricing, outcome, trace.repo_pairs),
  };
}

// ---------------------------------------------------------------- LiveEngine
const MAX_QUEUE = 30;
const POLL_MS = 2500;

export class LiveEngine {
  constructor() {
    this.network = null;
    this.W1 = null; this.W2 = null; this.W3 = null;
    this.queue = [];
    this.lastN = 0;
    this.episodeId = null;
    this._timer = null;
    this._inFlight = false;
  }

  // Fetches the (mostly static) network shape once; does not start polling
  // /live/policy — call start() for that, tied to the page being shown.
  async init() {
    const network = await API.policyNetwork();
    this.network = network;
    this.W1 = network.w1; this.W2 = network.w2; this.W3 = network.w3;
  }

  start() {
    if (this._timer) return;               // idempotent
    this._poll().catch(() => {});
    this._timer = setInterval(() => { this._poll().catch(() => {}); }, POLL_MS);
  }

  async _poll() {
    if (this._inFlight) return;             // no overlapping polls
    this._inFlight = true;
    try {
      const res = await API.livePolicy(20);
      if (res.episode_id && this.episodeId && res.episode_id !== this.episodeId) {
        // a new live world: trace numbering restarts at 1, so the old
        // cursor would never match again and the page would stall forever
        this.queue = [];
        this.lastN = 0;
      }
      this.episodeId = res.episode_id ?? this.episodeId;
      const fresh = (res.decisions || []).filter((t) => t.n > this.lastN).sort((a, b) => a.n - b.n);
      for (const trace of fresh) {
        this.lastN = Math.max(this.lastN, trace.n);
        this.queue.push(toDecision(trace, this.network));
      }
      // bounded: an idle Model page (or a slow tab) must not accumulate an
      // unbounded backlog of stale decisions that then floods in on return
      if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    } finally {
      this._inFlight = false;
    }
  }

  // Prefer a booking-step decision if one is queued; otherwise take whatever
  // is next. Returns null when nothing new has arrived yet.
  next() {
    if (!this.queue.length) return null;
    const bookingIdx = this.queue.findIndex((d) => d.type === 'booking');
    const idx = bookingIdx >= 0 ? bookingIdx : 0;
    return this.queue.splice(idx, 1)[0];
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
