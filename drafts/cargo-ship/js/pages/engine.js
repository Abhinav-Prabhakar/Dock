// Mock of the backend decision engine (MaskablePPO over CargoFleetEnv), shaped after backend.md:
//   obs: 112-d = request/market 12 · 4 voyage options × 8 · 8 ports × 3 · 4 vessels × 4 · 18 forecast slots
//        · calendar 6 · flags 4
//   actions: Discrete(44) = 12 booking + 16 speed (4 vessels × 12/14/16/18 kt) + 16 reposition (8 pairs × 75/150 TEU)
//   action_masks() gate booking steps vs fleet steps and infeasible options.
// Nothing here is the real model — it produces plausible, internally consistent decisions for the UI.
import { mulberry32, gauss, clamp } from './page.js';

export const PORTS = ['CNSHA', 'SGSIN', 'KRPUS', 'NLRTM', 'DEHAM', 'BEANR', 'USLAX', 'USNYC'];
export const VESSELS = [
  { id: 'VES1', name: 'Pacific Aurora', cap: 8000, reefer: 560 },
  { id: 'VES2', name: 'Meridian Star', cap: 5500, reefer: 380 },
  { id: 'VES3', name: 'Atlantic Pioneer', cap: 4000, reefer: 280 },
  { id: 'VES4', name: 'Coral Empress', cap: 2500, reefer: 200 },
];
const ROUTES = [
  { o: 'CNSHA', d: 'NLRTM', v: 0, rate: 1120, legs: ['CNSHA', 'SGSIN', 'NLRTM'], alt: 'BEANR' },
  { o: 'CNSHA', d: 'DEHAM', v: 0, rate: 1180, legs: ['CNSHA', 'SGSIN', 'NLRTM', 'DEHAM'], alt: 'NLRTM' },
  { o: 'SGSIN', d: 'BEANR', v: 0, rate: 980, legs: ['SGSIN', 'BEANR'], alt: 'NLRTM' },
  { o: 'CNSHA', d: 'USLAX', v: 1, rate: 1540, legs: ['CNSHA', 'KRPUS', 'USLAX'], alt: null },
  { o: 'KRPUS', d: 'USLAX', v: 1, rate: 1460, legs: ['KRPUS', 'USLAX'], alt: null },
  { o: 'CNSHA', d: 'USNYC', v: 2, rate: 2080, legs: ['CNSHA', 'USNYC'], alt: null },
  { o: 'SGSIN', d: 'NLRTM', v: 3, rate: 940, legs: ['SGSIN', 'NLRTM'], alt: 'BEANR' },
  { o: 'NLRTM', d: 'SGSIN', v: 3, rate: 610, legs: ['NLRTM', 'SGSIN'], alt: null },
];
export const REPO_PAIRS = [['NLRTM', 'CNSHA'], ['USLAX', 'CNSHA'], ['USNYC', 'CNSHA'], ['DEHAM', 'SGSIN'], ['BEANR', 'SGSIN'], ['USLAX', 'KRPUS'], ['SGSIN', 'CNSHA'], ['NLRTM', 'SGSIN']];
const SEG = { flexible: { mult: 1.0, counter: 0.74 }, standard: { mult: 1.08, counter: 0.5 }, urgent: { mult: 1.38, counter: 0.16 } };

export const ACTIONS = [
  { group: 'book', kind: 'reject', label: 'Reject', short: 'REJ' },
  { group: 'book', kind: 'accept', label: 'Accept as requested', short: 'ACC' },
  ...[5, 10, 15, 20].map((p) => ({ group: 'book', kind: 'flex_window', disc: p / 100, label: `Counter · flex window −${p}%`, short: `FX${p}` })),
  ...[5, 10, 15].map((p) => ({ group: 'book', kind: 'alt_hub', disc: p / 100, label: `Counter · alt hub −${p}%`, short: `AH${p}` })),
  ...[[50, 50], [60, 40], [70, 30]].map(([a, b]) => ({ group: 'book', kind: 'split', ratio: a / 100, label: `Counter · split ${a}/${b}`, short: `SP${a}` })),
  ...VESSELS.flatMap((v, i) => [12, 14, 16, 18].map((kt) => ({ group: 'speed', kind: 'speed', vessel: i, kt, label: `${v.id} → ${kt} kn`, short: `${kt}` }))),
  ...REPO_PAIRS.flatMap(([a, b], p) => [75, 150].map((teu) => ({ group: 'repo', kind: 'reposition', pair: p, teu, label: `Reposition ${teu} TEU ${a} → ${b}`, short: `${teu}` }))),
];
ACTIONS.forEach((a, i) => (a.i = i));

export const OBS_BLOCKS = [
  { key: 'req',   label: 'Request & market', from: 0,   to: 12,  color: '#7cc4ff' },
  { key: 'opt',   label: 'Voyage options',   from: 12,  to: 44,  color: '#5fe39a' },
  { key: 'port',  label: 'Ports',            from: 44,  to: 68,  color: '#ffc35a' },
  { key: 'ves',   label: 'Vessels',          from: 68,  to: 84,  color: '#c99bff' },
  { key: 'fc',    label: 'Forecast',         from: 84,  to: 102, color: '#4fd1c5' },
  { key: 'cal',   label: 'Calendar',         from: 102, to: 108, color: '#9fb0c0' },
  { key: 'flag',  label: 'Flags',            from: 108, to: 112, color: '#ff8a7a' },
];
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

const H1 = 28, H2 = 28;
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
export const pAccept = (price, mu, sigma = 0.24) => 1 - 0.5 * (1 + erf(Math.log(Math.max(1, price) / mu) / (sigma * Math.SQRT2)));
const hex = (R, n = 64) => Array.from({ length: n }, () => '0123456789abcdef'[(R() * 16) | 0]).join('');

export class MockEngine {
  constructor(seed = 20260925) {
    this.R = mulberry32(seed);
    const W = mulberry32(99);
    // fixed "weights" for the displayed slice of the trunk (28 of 256 units per layer)
    this.W1 = Array.from({ length: H1 }, () => Array.from({ length: 112 }, () => (W() < 0.12 ? gauss(W) * 0.9 : gauss(W) * 0.05)));
    this.W2 = Array.from({ length: H2 }, () => Array.from({ length: H1 }, () => (W() < 0.3 ? gauss(W) * 0.8 : gauss(W) * 0.05)));
    this.W3 = Array.from({ length: 44 }, () => Array.from({ length: H2 }, () => (W() < 0.25 ? gauss(W) * 0.8 : gauss(W) * 0.04)));
    this.b1 = Array.from({ length: H1 }, () => gauss(W) * 0.1);
    this.b2 = Array.from({ length: H2 }, () => gauss(W) * 0.1);
    this.step = 1840;
    this.day = 37.2;
    this.value = 18.4e6;
    this.fill = VESSELS.map(() => 0.55 + this.R() * 0.3);
    this.speed = [16, 16, 16, 14];
    this.empties = PORTS.map(() => Math.round(150 + this.R() * 1400));
    this.cong = PORTS.map(() => 0.2 + this.R() * 0.55);
    this.fc = Array.from({ length: 18 }, (_, i) => 0.45 + 0.3 * Math.sin(i * 0.8) + this.R() * 0.2);
    this.ledgerTip = hex(this.R);
  }

  next() {
    const R = this.R;
    this.step += 1 + Math.floor(R() * 3);
    this.day += 0.15 + R() * 0.25;
    const shock = this.day > 42 && this.day < 63;
    // drift the world a little
    this.cong = this.cong.map((c, i) => clamp(c + (R() - 0.5) * 0.08 + (shock && PORTS[i] === 'NLRTM' ? 0.2 : 0), 0.05, 0.98));
    this.fill = this.fill.map((f) => clamp(f + (R() - 0.45) * 0.03, 0.3, 0.97));
    this.fc = this.fc.map((f) => clamp(f + (R() - 0.5) * 0.08, 0.1, 1));
    const fleetStep = this.step % 4 === 0 || R() < 0.12;
    const d = fleetStep ? this.fleetDecision(shock) : this.bookingDecision(shock);
    d.step = this.step; d.day = this.day; d.shock = shock;
    d.ports = PORTS.map((code, i) => ({ code, congestion: this.cong[i], empties: this.empties[i], closed: shock && code === 'NLRTM' }));
    d.fleet = VESSELS.map((v, i) => ({ ...v, fill: this.fill[i], speed: this.speed[i], inPort: d.inPort === i }));
    d.forecast = this.fc.slice();
    d.calendar = { dow: Math.floor(this.day) % 7, week: Math.floor(this.day / 7) + 1, frac: this.day % 1 };
    this.buildObs(d);
    this.forward(d);
    const prevTip = this.ledgerTip;
    this.ledgerTip = hex(R);
    d.ledger = { seq: this.step * 3 + 11, hash: this.ledgerTip, prev: prevTip, tx: d.onchain ? hex(R) : null };
    d.latency = STAGES.map((s) => +(({ request: 0.3, forecast: 0.4, bid: 1.2, observe: 0.2, policy: 0.9, mask: 0.05, act: 0.04, ledger: 3.1 })[s.key] * (0.7 + R() * 0.6)).toFixed(2));
    this.value += (d.ev || 0) * 0.6 + gauss(R) * 4e4;
    d.value = this.value;
    return d;
  }

  bookingDecision(shock) {
    const R = this.R;
    const route = ROUTES[Math.floor(R() * ROUTES.length)];
    const segKey = R() < 0.42 ? 'flexible' : R() < 0.65 ? 'standard' : 'urgent';
    const cargo = R() < 0.8 ? 'dry' : R() < 0.6 ? 'reefer' : 'hazmat';
    const teu = Math.max(1, Math.min(120, Math.round(Math.exp(Math.log(15.7) + gauss(R) * 0.7))));
    const reqDep = this.day + 3 + R() * 11;
    const flex = segKey === 'flexible' ? 3 + Math.round(R() * 4) : segKey === 'standard' ? 1 + Math.round(R()) : 0;
    const market = route.rate * (1 + (shock ? 0.18 : 0) + gauss(R) * 0.05);
    const seg = SEG[segKey];
    const mu = market * seg.mult;
    const req = { id: 40000 + this.step, origin: route.o, dest: route.d, teu, segment: segKey, cargo, reqDep, flex, market, mu };
    const vIdx = route.v;
    const mkOpt = (k, dep, dest, tight) => {
      const legs = [];
      const stops = route.legs.slice(0, -1);
      if (stops[stops.length - 1] !== dest) stops.push(dest);
      let bid = 0;
      for (let j = 0; j < stops.length - 1; j++) {
        const cap = VESSELS[vIdx].cap * 0.45 * 0.88;
        const remaining = Math.max(0, cap * (1 - this.fill[vIdx]) * (0.6 + R() * 0.8) * (tight ? 0.35 : 1));
        const expected = remaining * clamp((0.25 + R() * 0.7) * (shock ? 1.3 : 1) * this.fc[(j * 5 + k) % 18] * 1.4, 0.05, 1.6);
        const pressure = expected / Math.max(1, remaining);
        const legMarket = market / (stops.length - 1);
        const legBid = legMarket * clamp(0.9 * Math.pow(pressure, 1.5), 0.02, 1.25);
        bid += legBid;
        legs.push({ from: stops[j], to: stops[j + 1], remaining, expected, pressure, market: legMarket, bid: legBid });
      }
      const room = Math.min(...legs.map((l) => l.remaining));
      let reason = null;
      if (room < teu) reason = 'no capacity on leg';
      else if (cargo === 'hazmat' && R() < 0.3) reason = 'hazmat bay cap (2/bay)';
      else if (cargo === 'reefer' && R() < 0.25) reason = 'reefer plugs full';
      return { k, vessel: VESSELS[vIdx], dep, dest, legs, bid, room, feasible: !reason, reason };
    };
    const tight0 = R() < 0.3;
    const options = [
      mkOpt(0, reqDep + gauss(R) * 0.6, route.d, tight0),
      mkOpt(1, reqDep + 7 + gauss(R) * 0.6, route.d, false),
      route.alt ? mkOpt(2, reqDep + gauss(R) * 0.8, route.alt, false) : { k: 2, vessel: VESSELS[vIdx], dep: reqDep, dest: '—', legs: [], bid: 0, room: 0, feasible: false, reason: 'no partner hub' },
      mkOpt(3, reqDep + 14 + gauss(R), route.d, false),
    ];
    // price each option: argmax P(accept)·(price − bid), guarded vs market
    const quote = (opt) => {
      let best = { p: opt.bid, m: -Infinity };
      for (let p = Math.max(50, opt.bid * 0.9); p < mu * 2.2; p += mu / 160) {
        const m = pAccept(p, mu) * (p - opt.bid);
        if (m > best.m) best = { p, m };
      }
      const guard = mu * 1.12;
      let price = best.p, reason = 'market_uplift';
      if (price > guard) { price = guard; reason = 'competitiveness_guard'; }
      else if (price < opt.bid * 1.12) reason = 'bid_price_floor';
      return { price, reason, guard, bid: opt.bid, market, mu, pA: pAccept(price, mu) };
    };
    options.forEach((o) => (o.quote = o.legs.length ? quote(o) : null));

    const mask = ACTIONS.map((a) => {
      if (a.group !== 'book') return false;
      if (a.kind === 'reject') return true;
      if (a.kind === 'accept') return options[0].feasible;
      if (a.kind === 'flex_window') return options[1].feasible && (segKey !== 'urgent' || a.disc >= 0.15);
      if (a.kind === 'alt_hub') return options[2].feasible;
      if (a.kind === 'split') return teu >= 20 && options[1].feasible && options[0].room >= teu * (1 - a.ratio);
      return false;
    });
    const ev = ACTIONS.map((a, i) => {
      if (!mask[i]) return -Infinity;
      if (a.kind === 'reject') return 0;
      if (a.kind === 'accept') { const q = options[0].quote; return q.pA * (q.price - q.bid) * teu; }
      const o = a.kind === 'flex_window' ? options[1] : a.kind === 'alt_hub' ? options[2] : options[1];
      const q = o.quote;
      if (a.kind === 'split') {
        const q0 = options[0].quote;
        return seg.counter * 0.8 * ((1 - a.ratio) * (q0.price - q0.bid) + a.ratio * (q.price * 0.95 - q.bid)) * teu;
      }
      const pc = clamp(seg.counter * (1 + a.disc * 3) * (a.kind === 'alt_hub' ? 0.8 : 1), 0, 0.95);
      return pc * (q.price * (1 - a.disc) - q.bid) * teu;
    });
    const logits = ev.map((v) => (v === -Infinity ? -Infinity : v / Math.max(2500, teu * 160) + gauss(R) * 0.25));
    const d = { type: 'booking', req, options, mask, logits, ev };
    this.pick(d);
    const a = ACTIONS[d.action];
    const optFor = a.kind === 'alt_hub' ? options[2] : a.kind === 'flex_window' || a.kind === 'split' ? options[1] : options[0];
    const q = optFor.quote || options[0].quote || { price: 0, bid: 0, market, mu, guard: mu * 1.12, pA: 0, reason: 'bid_price_floor' };
    const offer = a.kind === 'reject' ? null : q.price * (1 - (a.disc || 0));
    const pOk = a.kind === 'accept' ? q.pA : a.kind === 'reject' ? 0 : clamp(seg.counter * (1 + (a.disc || 0) * 3), 0, 0.95);
    const booked = a.kind !== 'reject' && R() < pOk;
    d.quote = { ...q, offer, opt: optFor.k, disc: a.disc || 0 };
    d.ev = Math.max(0, ev[d.action]);
    d.outcome = a.kind === 'reject'
      ? { key: options.every((o) => !o.feasible) ? 'rejected:infeasible' : 'rejected:below_floor_or_full', ok: false, stamp: 'REJECTED' }
      : booked ? { key: `booked:${a.kind}`, ok: true, stamp: 'BOOKED' } : { key: a.kind === 'accept' ? 'declined' : `counter_declined:${a.kind}`, ok: false, stamp: 'DECLINED' };
    d.onchain = booked && a.kind !== 'accept';
    d.explain = a.kind === 'reject'
      ? `Every voyage option is ${options.some((o) => o.feasible) ? 'priced below its opportunity cost' : 'stowage-infeasible'} — holding ${VESSELS[vIdx].id} capacity for higher-value demand forecast next week.`
      : `Bid price ${VESSELS[vIdx].id} legs [${optFor.legs.map((_, j) => j).join(', ')}]: $${Math.round(q.bid)}/TEU · market $${Math.round(market)} · ${segKey} uplift ×${seg.mult.toFixed(2)} → quote $${Math.round(offer)}/TEU (${q.reason.replace(/_/g, ' ')}).`;
    d.baselines = this.baselines(d);
    d.attr = this.attribution(d);
    return d;
  }

  fleetDecision(shock) {
    const R = this.R;
    const inPort = Math.floor(R() * 4);
    const mask = ACTIONS.map((a) => {
      if (a.group === 'book') return false;
      if (a.kind === 'speed') return a.vessel !== inPort && !(a.vessel === 3 && a.kt === 16);
      const [o] = REPO_PAIRS[a.pair];
      return this.empties[PORTS.indexOf(o)] >= a.teu * 1.4 && !(shock && o === 'NLRTM');
    });
    const ev = ACTIONS.map((a, i) => {
      if (!mask[i]) return -Infinity;
      if (a.kind === 'speed') {
        const v = VESSELS[a.vessel], urgency = this.fill[a.vessel] * (shock ? 1.3 : 1);
        return (urgency * 42000 * (a.kt - 12) / 6) - v.cap * 0.004 * Math.pow(a.kt / 16, 3) * 600;
      }
      const [o, dst] = REPO_PAIRS[a.pair];
      const surplus = this.empties[PORTS.indexOf(o)] - this.empties[PORTS.indexOf(dst)];
      return surplus * 22 * (a.teu / 150) - a.teu * 95;
    });
    const logits = ev.map((v) => (v === -Infinity ? -Infinity : v / 9000 + gauss(R) * 0.3));
    const d = { type: 'fleet', inPort, mask, logits, ev, req: null, options: [] };
    this.pick(d);
    const a = ACTIONS[d.action];
    if (a.kind === 'speed') this.speed[a.vessel] = a.kt;
    else { const [o, dst] = REPO_PAIRS[a.pair]; this.empties[PORTS.indexOf(o)] -= a.teu; this.empties[PORTS.indexOf(dst)] += a.teu; }
    d.ev = Math.max(0, ev[d.action]);
    d.outcome = { key: `fleet:${a.kind}`, ok: true, stamp: a.kind === 'speed' ? 'ENGINE ORDER' : 'REPOSITION' };
    d.explain = a.kind === 'speed'
      ? `${VESSELS[a.vessel].name} to ${a.kt} kn — fuel ∝ v³ traded against ${Math.round(this.fill[a.vessel] * 100)}% booked cargo and downstream berth windows. ${VESSELS[inPort].id} is alongside, so its speed orders are masked.`
      : `Move ${a.teu} empty TEU ${REPO_PAIRS[a.pair][0]} → ${REPO_PAIRS[a.pair][1]}: surplus where exports are thin, shortage where the forecaster expects bookings.`;
    d.quote = null;
    d.onchain = false;
    d.baselines = null;
    d.attr = this.attribution(d);
    return d;
  }

  pick(d) {
    const valid = d.logits.filter((v) => v !== -Infinity);
    const m = Math.max(...valid);
    const ex = d.logits.map((v) => (v === -Infinity ? 0 : Math.exp(v - m)));
    const s = ex.reduce((a, b) => a + b, 0);
    d.probs = ex.map((v) => v / s);
    d.action = d.probs.indexOf(Math.max(...d.probs));
    d.entropy = -d.probs.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
    d.masked = d.mask.filter((v) => !v).length;
  }

  baselines(d) {
    const o0 = d.options[0], q0 = o0.quote, teu = d.req.teu;
    const ev = (price, bid, p) => p * (price - bid) * teu;
    const out = [];
    const rate = d.req.market * 0.95;
    out.push({ key: 'static', label: 'Static rate card', kind: o0.feasible ? 'Accept' : 'Reject', price: o0.feasible ? rate : null, ev: o0.feasible ? ev(rate, q0.bid, pAccept(rate, d.req.mu)) : 0 });
    out.push({ key: 'greedy', label: 'Greedy', kind: o0.feasible ? 'Accept' : 'Reject', price: o0.feasible ? d.req.market : null, ev: o0.feasible ? ev(d.req.market, q0.bid, pAccept(d.req.market, d.req.mu)) : 0 });
    const h = o0.feasible ? { kind: 'Accept', price: d.req.mu, p: pAccept(d.req.mu, d.req.mu), bid: q0.bid }
      : d.options[1].feasible ? { kind: 'Flex −10%', price: d.options[1].quote.price * 0.9, p: SEG[d.req.segment].counter * 1.3, bid: d.options[1].quote.bid } : { kind: 'Reject', price: null };
    out.push({ key: 'heuristic', label: 'Heuristic', kind: h.kind, price: h.price, ev: h.price ? ev(h.price, h.bid, h.p) : 0 });
    out.push({ key: 'ppo', label: 'Dock · PPO', kind: ACTIONS[d.action].label.replace('Counter · ', ''), price: d.quote.offer, ev: d.ev });
    return out;
  }

  buildObs(d) {
    const o = new Float32Array(112);
    const R = this.R;
    if (d.req) {
      const r = d.req;
      o.set([r.teu / 60, r.segment === 'flexible', r.segment === 'standard', r.segment === 'urgent', r.cargo === 'dry', r.cargo === 'reefer', r.cargo === 'hazmat',
        (r.reqDep - d.day) / 14, r.flex / 7, r.market / 2000, this.fill[d.options[0].vessel ? VESSELS.indexOf(d.options[0].vessel) : 0], 1].map(Number), 0);
      d.options.forEach((op, k) => {
        const p = op.legs.length ? Math.max(...op.legs.map((l) => l.pressure)) : 0;
        o.set([op.feasible ? 1 : 0, (op.dep - d.day) / 21, op.bid / 2000, op.room / 2000, op.legs.length / 4, p, op.legs.length ? 0.4 + R() * 0.4 : 0, k === 2 ? 1 : 0], 12 + k * 8);
      });
    } else {
      for (let i = 0; i < 44; i++) o[i] = i < 12 ? 0 : (R() - 0.5) * 0.1;
    }
    PORTS.forEach((_, i) => o.set([this.cong[i], this.empties[i] / 2000, d.shock && PORTS[i] === 'NLRTM' ? 1 : 0], 44 + i * 3));
    VESSELS.forEach((_, i) => o.set([this.fill[i], this.speed[i] / 18, (Math.sin(this.day * 0.3 + i) + 1) / 2, ((this.day * 0.7 + i * 3) % 10) / 10], 68 + i * 4));
    o.set(this.fc, 84);
    const dw = (this.day % 7) / 7 * Math.PI * 2, wk = (this.day / 90) * Math.PI * 2;
    o.set([Math.sin(dw), Math.cos(dw), Math.sin(wk), Math.cos(wk), 0.6, 1 - this.day / 90], 102);
    o.set([d.shock ? 1 : 0, this.day > 70 ? 1 : 0, d.type === 'booking' ? 1 : 0, d.mask.filter(Boolean).length / 44], 108);
    d.obs = o;
  }

  forward(d) {
    const relu = (v) => Math.max(0, v);
    const h1 = this.W1.map((w, j) => Math.tanh(relu(w.reduce((a, wi, i) => a + wi * d.obs[i], this.b1[j]))));
    const h2 = this.W2.map((w, j) => Math.tanh(relu(w.reduce((a, wi, i) => a + wi * h1[i], this.b2[j]) + 0.2)));
    d.h1 = h1; d.h2 = h2;
    // strongest displayed pathways into the chosen action (for the current streams)
    d.path = { h2: this.W3[d.action].map((w, j) => [w * h2[j], j]).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).slice(0, 3).map((q) => q[1]) };
  }

  // Integrated-gradients-style attribution (mocked): named obs features with signed weight toward the action.
  attribution(d) {
    const R = this.R, a = ACTIONS[d.action];
    const f = [];
    const add = (idx, label, w) => f.push({ idx, label, w });
    if (d.type === 'booking') {
      const o0 = d.options[0], pr = o0.legs.length ? Math.max(...o0.legs.map((l) => l.pressure)) : 0;
      const vi = VESSELS.indexOf(o0.vessel);
      add(12 + 2, 'opt0 · bid price', a.kind === 'accept' ? -0.3 - pr * 0.3 : 0.4 + pr * 0.3);
      add(12 + 5, 'opt0 · leg pressure', a.kind === 'reject' || a.kind === 'flex_window' ? 0.5 + pr * 0.2 : -0.35);
      add(1 + ['flexible', 'standard', 'urgent'].indexOf(d.req.segment), `segment = ${d.req.segment}`, d.req.segment === 'urgent' ? (a.kind === 'accept' ? 0.62 : -0.4) : a.kind === 'accept' ? 0.1 : 0.45);
      add(12, 'opt0 · feasible', o0.feasible ? (a.kind === 'accept' ? 0.55 : -0.2) : 0.7);
      add(20, 'opt1 · feasible', d.options[1].feasible ? (a.kind === 'flex_window' ? 0.58 : 0.12) : -0.25);
      add(9, 'market rate', a.kind === 'reject' ? -0.3 : 0.34);
      add(84 + ((ROUTES.findIndex((r) => r.o === d.req.origin && r.d === d.req.dest) * 2) % 18), 'forecast · OD wk+1', a.kind === 'reject' ? 0.48 : -0.22);
      add(68 + vi * 4, `${o0.vessel.id} · fill`, a.kind === 'accept' ? -0.2 : 0.3);
      add(0, 'request TEU', d.req.teu > 30 ? (a.kind === 'split' ? 0.6 : -0.18) : 0.08);
      add(44 + PORTS.indexOf(d.req.dest) * 3, `${d.req.dest} · congestion`, this.cong[PORTS.indexOf(d.req.dest)] > 0.7 ? 0.35 : -0.08);
    } else if (a.kind === 'speed') {
      add(68 + a.vessel * 4, `${VESSELS[a.vessel].id} · fill`, 0.55);
      add(68 + a.vessel * 4 + 1, `${VESSELS[a.vessel].id} · speed`, -0.3);
      add(68 + a.vessel * 4 + 3, `${VESSELS[a.vessel].id} · ETA slack`, 0.4);
      add(108, 'shock flag', d.shock ? 0.5 : -0.05);
      add(84 + a.vessel * 3, 'forecast · lane wk+1', 0.32);
      add(44 + 3 * 3, 'NLRTM · congestion', -0.28);
      add(104, 'week (sin)', 0.12);
    } else {
      const [o, dst] = REPO_PAIRS[a.pair];
      add(44 + PORTS.indexOf(o) * 3 + 1, `${o} · empties`, 0.66);
      add(44 + PORTS.indexOf(dst) * 3 + 1, `${dst} · empties`, -0.52);
      add(84 + a.pair * 2, `forecast · ${dst} exports`, 0.44);
      add(44 + PORTS.indexOf(o) * 3, `${o} · congestion`, 0.2);
      add(110, 'fleet step flag', 0.15);
    }
    f.forEach((q) => (q.w *= 0.85 + R() * 0.3));
    return f.sort((x, y) => Math.abs(y.w) - Math.abs(x.w)).slice(0, 8);
  }
}
