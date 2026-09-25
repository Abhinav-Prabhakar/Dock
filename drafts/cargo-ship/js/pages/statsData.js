// Mock data for the Statistics page. Shaped after backend.md (summary / timeline / offers vocabulary)
// but fully synthetic and seeded — swap `buildStats` for the real API later.
import { mulberry32, gauss } from './page.js';

export const POLICIES = [
  { key: 'ppo',           label: 'Dock · PPO',        color: '#1d7fe0', hull: '#1d4f86' },
  { key: 'heuristic_bid', label: 'Heuristic + bid',   color: '#2c8a8e', hull: '#2a5f62' },
  { key: 'heuristic',     label: 'Heuristic',         color: '#c9a42a', hull: '#7a6420' },
  { key: 'greedy',        label: 'Greedy',            color: '#e27820', hull: '#8a4a16' },
  { key: 'static',        label: 'Static rate card',  color: '#8e3226', hull: '#5a2219' },
];

export const SCENARIOS = {
  baseline:  { label: 'Baseline',  finals: { static: 16.9, greedy: 20.1, heuristic: 20.7, heuristic_bid: 21.5, ppo: 23.6 }, shock: null, drift: 0 },
  volatile:  { label: 'Volatile shocks', finals: { static: 17.0, greedy: 22.0, heuristic: 23.2, heuristic_bid: 24.7, ppo: 25.9 },
               shock: { port: 'NLRTM', lo: 42, hi: 63, text: 'Rotterdam closure · weeks 7–9' }, drift: 0 },
  depressed: { label: 'Depressed demand', finals: { static: -5.2, greedy: 6.5, heuristic: 9.0, heuristic_bid: 8.5, ppo: 8.3 }, shock: null, drift: -0.45 },
};

const COST = { static: 13.8, greedy: 15.9, heuristic: 15.1, heuristic_bid: 14.6, ppo: 14.2 };           // $M / 90 d
const RESILIENCE = { static: 0.05, greedy: 0.25, heuristic: 0.35, heuristic_bid: 0.45, ppo: 0.62 };
const KPI = {
  revPerTEU:  { static: 1180, greedy: 1105, heuristic: 1262, heuristic_bid: 1318, ppo: 1392 },
  util:       { static: 0.71, greedy: 0.88, heuristic: 0.84, heuristic_bid: 0.83, ppo: 0.86 },
  co2:        { static: 1.42, greedy: 1.51, heuristic: 1.38, heuristic_bid: 1.35, ppo: 1.21 },
  counterWin: { static: 0,    greedy: 0,    heuristic: 0.41, heuristic_bid: 0.46, ppo: 0.58 },
  empty:      { static: 9.8,  greedy: 8.9,  heuristic: 7.1,  heuristic_bid: 6.8,  ppo: 4.9 },         // M TEU-nm / 90 d
};

// Pacific-centred longitudes so the rotation reads Europe → Asia → Americas left to right.
export const PORTS = [
  { code: 'NLRTM', name: 'Rotterdam',   lon: 4.4,   lat: 51.9 },
  { code: 'BEANR', name: 'Antwerp',     lon: 4.4,   lat: 51.2 },
  { code: 'DEHAM', name: 'Hamburg',     lon: 10.0,  lat: 53.5 },
  { code: 'SGSIN', name: 'Singapore',   lon: 103.8, lat: 1.3 },
  { code: 'CNSHA', name: 'Shanghai',    lon: 121.5, lat: 31.2 },
  { code: 'KRPUS', name: 'Busan',       lon: 129.0, lat: 35.1 },
  { code: 'USLAX', name: 'Los Angeles', lon: 241.8, lat: 33.7 },
  { code: 'USNYC', name: 'New York',    lon: 286.0, lat: 40.7 },
];

// Vessel loops as sea-lane waypoints [lon, lat] (port codes are resolved to coordinates).
export const LOOPS = [
  { vessel: 'VES1', name: 'Pacific Aurora',   color: '#1d7fe0', teu: 8000, reefer: 560, age: 4,  draft: 14.5, burn: 118,
    lane: ['CNSHA', [118, 22], [109, 10], 'SGSIN', [95, 6], [80, 5.5], [60, 13], [44, 12.5], [38, 20], [32.5, 30.5], [20, 34], [5, 37.5], [-6, 36], [-10.5, 40], [-8, 46], [-3, 49.2], 'BEANR', 'NLRTM', 'DEHAM'] },
  { vessel: 'VES2', name: 'Meridian Star',    color: '#2c8a8e', teu: 5500, reefer: 380, age: 8,  draft: 13.0, burn: 90,
    lane: ['CNSHA', 'KRPUS', [150, 42], [180, 45], [210, 42], 'USLAX'] },
  { vessel: 'VES3', name: 'Atlantic Pioneer', color: '#c9a42a', teu: 4000, reefer: 280, age: 12, draft: 12.0, burn: 74,
    lane: ['CNSHA', [140, 26], [180, 18], [230, 12], [262, 8], [279.5, 9], [284, 18], [289, 30], 'USNYC'] },
  { vessel: 'VES4', name: 'Coral Empress',    color: '#e27820', teu: 2500, reefer: 200, age: 17, draft: 10.5, burn: 50,
    lane: ['SGSIN', [80, 5], [58, 14], [43, 12], [36, 24], [32.5, 31], [14, 35], [-5.8, 35.9], [-9.5, 42], [-4, 48.8], 'NLRTM', 'BEANR'] },
];

export const OUTCOMES = [
  { key: 'booked:accept',        label: 'Accepted',          color: '#1d7fe0' },
  { key: 'booked:flex_window',   label: 'Flex window',       color: '#4f9fe6' },
  { key: 'booked:alt_hub',       label: 'Alt hub',           color: '#63c28a' },
  { key: 'booked:split',         label: 'Split',             color: '#a98ee6' },
  { key: 'counter_declined',     label: 'Counter declined',  color: '#e2a520' },
  { key: 'declined',             label: 'Walked at quote',   color: '#d8d0bf' },
  { key: 'rejected:below_floor', label: 'Below bid floor',   color: '#b35b12' },
  { key: 'rejected:infeasible',  label: 'Stowage infeasible', color: '#8e3226' },
];

export const SEGMENTS = [
  { key: 'flexible', label: 'Flexible', wtp: 1.0 },
  { key: 'standard', label: 'Standard', wtp: 1.08 },
  { key: 'urgent',   label: 'Urgent',   wtp: 1.38 },
];

export function buildStats(scenarioKey = 'volatile', days = 90) {
  const sc = SCENARIOS[scenarioKey];
  const R = mulberry32(scenarioKey.length * 977 + 13);
  const H = 90;
  const k = days / H;
  const policies = {};
  for (const p of POLICIES) {
    const w = [];
    const phase = R() * 7;
    for (let d = 0; d < H; d++) {
      let v = 1 + 0.2 * Math.sin((2 * Math.PI * (d + phase)) / 7) + 0.1 * gauss(R);
      v *= 1 + sc.drift * (d / H);
      if (sc.shock && d >= sc.shock.lo && d <= sc.shock.hi) v *= RESILIENCE[p.key] + (1 - RESILIENCE[p.key]) * 0.1;
      w.push(Math.max(0.05, v));
    }
    const sum = w.reduce((a, b) => a + b, 0);
    const final = sc.finals[p.key] * 1e6;
    const daily = w.map((v) => (v / sum) * final);
    const costDay = (COST[p.key] * 1e6) / H;
    const revenue = daily.map((v, d) => v + costDay * (1 + 0.06 * Math.sin(d * 0.9 + phase)));
    let cp = 0, cr = 0;
    const cum = daily.map((v) => (cp += v));
    const cumRev = revenue.map((v) => (cr += v));
    const scen = scenarioKey === 'depressed' ? 0.78 : scenarioKey === 'baseline' ? 0.96 : 1;
    const revTot = cumRev[days - 1];
    const rpt = KPI.revPerTEU[p.key] * scen;
    policies[p.key] = {
      ...p, daily, revenue, cum, cumRev,
      profit: cum[days - 1], revTotal: revTot,
      revPerTEU: rpt, teu: revTot / rpt,
      util: KPI.util[p.key] * (scenarioKey === 'depressed' ? 0.8 : 1),
      co2: KPI.co2[p.key] * (scenarioKey === 'depressed' ? 1.12 : 1),
      counterWin: KPI.counterWin[p.key],
      empty: KPI.empty[p.key] * 1e6 * k,
      fuel: (COST[p.key] * 0.52 * 1e6 * k) / 600,
    };
  }
  const lead = policies.ppo, base = policies.static;
  const lift = (a, b) => (Math.abs(b) < 1 ? null : ((a - b) / Math.abs(b)) * 100);

  const ports = PORTS.map((p, i) => {
    const t = (0.4 + R() * 0.6) * (p.code === 'CNSHA' ? 1.6 : p.code === 'SGSIN' ? 1.3 : 1) * 42000 * k;
    const shocked = sc.shock?.port === p.code;
    return { ...p, throughput: t, congestion: shocked ? 0.94 : 0.2 + R() * 0.55, empties: Math.round((200 + R() * 1800) * (i % 3 === 0 ? 1.4 : 0.8)),
      dwell: 18 + R() * 40, requested: t * (1.3 + R() * 0.5), booked: t, shocked };
  });

  const loops = LOOPS.map((l, i) => {
    const util = Math.min(0.97, lead.util * (0.9 + R() * 0.16));
    const speed = [15.2, 16.4, 17.1, 13.6][i];
    return { ...l, util, speed, fuelDay: l.burn * Math.pow(speed / 16, 3) * 0.85 + l.burn * 0.15, co2Day: 0, teuMoved: l.teu * util * (days / 30),
      margin: 180 + R() * 260 };
  });
  loops.forEach((l) => (l.co2Day = l.fuelDay * 3.15));

  const requests = Math.round(lead.teu / 15.7 / 0.62);
  const funnel = SEGMENTS.map((s, i) => {
    const req = Math.round(requests * [0.42, 0.38, 0.2][i]);
    const quoted = Math.round(req * (0.93 - i * 0.02));
    const countered = Math.round(quoted * [0.44, 0.3, 0.12][i]);
    const booked = Math.round(quoted * [0.58, 0.64, 0.71][i] * (scenarioKey === 'depressed' ? 0.86 : 1));
    const delivered = Math.round(booked * (0.985 - R() * 0.02));
    return { ...s, req, quoted, countered, booked, delivered };
  });

  const mix = [0.41, 0.14, 0.06, 0.02, 0.08, 0.13, 0.09, 0.07].map((v) => v * (0.85 + R() * 0.3));
  const ms = mix.reduce((a, b) => a + b, 0);
  const outcomes = OUTCOMES.map((o, i) => ({ ...o, n: Math.round((mix[i] / ms) * requests) }));

  const tod = Array.from({ length: days }, (_, d) => ({ day: d + 1, ppo: lead.revenue[d], stat: base.revenue[d] }));

  return {
    scenario: sc, scenarioKey, days, policies, order: POLICIES.map((p) => p.key),
    lift: { profit: lift(lead.profit, base.profit), rpt: lift(lead.revPerTEU, base.revPerTEU), util: (lead.util - base.util) * 100 },
    ports, loops, funnel, outcomes, requests, tide: tod,
    headline: { revenue: lead.revTotal, profit: lead.profit, teu: lead.teu, requests, vessels: 4, ports: PORTS.length },
  };
}
