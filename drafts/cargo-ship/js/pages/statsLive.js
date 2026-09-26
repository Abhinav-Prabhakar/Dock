// Live data adapter for the Statistics page. Fetches from the running Dock backend
// (via the shared API client) and reshapes the response into exactly the object
// shape stats.js's drawing code expects (the shape the old seeded mock used to
// return from its buildStats() function). No mock, sample, random or invented
// data, and no fallbacks: a failed fetch rejects and the page renders an
// explicit "Statistics unavailable" state.
import { API } from '../api.js';

// Policy identity + palette (colour/hull are drawing choices, not data).
export const POLICIES = [
  { key: 'ppo',           label: 'Dock · PPO',        color: '#1d7fe0', hull: '#1d4f86' },
  { key: 'heuristic_bid', label: 'Heuristic + bid',   color: '#2c8a8e', hull: '#2a5f62' },
  { key: 'heuristic',     label: 'Heuristic',         color: '#c9a42a', hull: '#7a6420' },
  { key: 'greedy',        label: 'Greedy',            color: '#e27820', hull: '#8a4a16' },
  { key: 'static',        label: 'Static rate card',  color: '#8e3226', hull: '#5a2219' },
];

// Outcome taxonomy for the booking funnel / yard, derived from live
// booking.decision events (see classifyOutcome below). The live world's
// reject reasons include the heuristic policy's own "below_floor_or_full"
// note (backend/baselines/heuristics.py), which is the real-data match for
// the old mock's "Below bid floor" bucket, plus several other policy-level
// reject reasons (no_alt_hub, no_voyage_option, departure_outside_flex,
// no_second_option — backend/simulator/world.py) that the mock never
// modelled; those fall into "Rejected by policy".
export const OUTCOMES = [
  { key: 'booked:accept',       label: 'Accepted',          color: '#1d7fe0' },
  { key: 'booked:flex_window',  label: 'Flex window',       color: '#4f9fe6' },
  { key: 'booked:alt_hub',      label: 'Alt hub',            color: '#63c28a' },
  { key: 'booked:split',        label: 'Split',              color: '#a98ee6' },
  { key: 'counter_declined',    label: 'Counter declined',  color: '#e2a520' },
  { key: 'declined',            label: 'Walked at quote',   color: '#d8d0bf' },
  { key: 'rejected:below_floor', label: 'Below bid floor',   color: '#b35b12' },
  { key: 'rejected:infeasible', label: 'Stowage infeasible', color: '#8e3226' },
  { key: 'rejected:policy',     label: 'Rejected by policy', color: '#6a4b8e' },
];

export const SEGMENTS = [
  { key: 'flexible', label: 'Flexible' },
  { key: 'standard', label: 'Standard' },
  { key: 'urgent',   label: 'Urgent' },
];

// Vessel-loop waypoint geometry for the rotation map (sea-lane shape only —
// pure map-drawing decoration, not a data source). Keyed by vessel_id so it
// can be paired with the real /api/vessels + live snapshot figures.
const LOOP_GEOM = {
  VES1: { color: '#1d7fe0', lane: ['CNSHA', [118, 22], [109, 10], 'SGSIN', [95, 6], [80, 5.5], [60, 13], [44, 12.5], [38, 20], [32.5, 30.5], [20, 34], [5, 37.5], [-6, 36], [-10.5, 40], [-8, 46], [-3, 49.2], 'BEANR', 'NLRTM', 'DEHAM'] },
  VES2: { color: '#2c8a8e', lane: ['CNSHA', 'KRPUS', [150, 42], [180, 45], [210, 42], 'USLAX'] },
  VES3: { color: '#c9a42a', lane: ['CNSHA', [140, 26], [180, 18], [230, 12], [262, 8], [279.5, 9], [284, 18], [289, 30], 'USNYC'] },
  VES4: { color: '#e27820', lane: ['SGSIN', [80, 5], [58, 14], [43, 12], [36, 24], [32.5, 31], [14, 35], [-5.8, 35.9], [-9.5, 42], [-4, 48.8], 'NLRTM', 'BEANR'] },
};

const COUNTER_KINDS = ['flex_window', 'alt_hub', 'split'];
// Pacific-centred longitude shift so the rotation reads Europe -> Asia -> Americas
// left to right, matching the old mock's map projection.
const shiftLon = (lon) => (lon < -16 ? lon + 360 : lon);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hasQuote = (e) => (e.price != null && e.price > 0) || e.quoted != null;
const isCountered = (e) => COUNTER_KINDS.includes(e.kind);

// Cumulative series -> day-to-day differences (first day's delta is against a
// zero baseline, matching how the sim accumulates from day 0).
function toDaily(rows, key) {
  let prev = 0;
  return rows.map((r) => { const v = r[key]; const d = v - prev; prev = v; return d; });
}

function classifyOutcome(e) {
  if (e.outcome === 'booked') return `booked:${e.kind}`;
  if (e.outcome === 'counter_declined') return 'counter_declined';
  if (e.outcome === 'declined' || e.outcome === 'price_reject') return 'declined';
  if (e.outcome === 'rejected') {
    if (e.reason === 'infeasible') return 'rejected:infeasible';
    if (e.reason === 'below_floor_or_full') return 'rejected:below_floor';
    return 'rejected:policy';
  }
  return null;
}

function buildPolicies(raw) {
  const policies = {};
  for (const pd of POLICIES) {
    const tl = raw.timeline.policies[pd.key];
    const sp = raw.summary.policies[pd.key];
    if (!tl || !sp) continue;
    const cum = tl.map((r) => r.cum_profit);
    const cumRev = tl.map((r) => r.cum_revenue);
    policies[pd.key] = {
      ...pd,
      cum, cumRev,
      daily: toDaily(tl, 'cum_profit'),
      revenue: toDaily(tl, 'cum_revenue'),
      profit: cum[cum.length - 1],
      revTotal: cumRev[cumRev.length - 1],
      revPerTEU: sp.revenue_per_teu.mean,
      teu: sp.teu_booked.mean,
      util: sp.utilization.mean,
      co2: sp.co2_per_teu.mean,
      counterWin: sp.counter_win_rate.mean,
      empty: sp.empty_teu_nm.mean,
      fuel: sp.fuel_tonnes.mean,
    };
  }
  const order = POLICIES.filter((pd) => policies[pd.key]).map((pd) => pd.key);
  return { policies, order };
}

function buildLift(raw) {
  const l = raw.summary.lift_vs_static.ppo;
  return { profit: l.profit_usd_pct, rpt: l.revenue_per_teu_pct, util: l.utilization_pp };
}

// The compass of demand is "TEU by destination" (matching the old mock):
// each booking.decision event carries both an origin and a dest port, and
// dest is what the mock's petal chart meant by demand.
function buildPorts(raw, bookingEvents) {
  const perPort = {};
  for (const p of raw.ports) perPort[p.port_id] = { requested: 0, booked: 0 };
  for (const e of bookingEvents) {
    const agg = perPort[e.dest];
    if (!agg) continue;
    agg.requested += e.teu || 0;
    if (e.outcome === 'booked') agg.booked += e.teu || 0;
  }
  const empties = raw.live.empties || {};
  return raw.ports.map((p) => {
    const agg = perPort[p.port_id];
    return {
      code: p.port_id,
      name: p.name,
      lon: shiftLon(p.lon),
      lat: p.lat,
      congestion: p.base_congestion,
      dwell: p.mean_dwell_days * 24,
      empties: empties[p.port_id] ?? 0,
      requested: agg.requested,
      booked: agg.booked,
      throughput: agg.booked,
    };
  });
}

function buildLoops(raw, bookingEvents) {
  const live = Object.fromEntries((raw.live.vessels || []).map((v) => [v.vessel_id, v]));
  return raw.vessels.map((v) => {
    const geom = LOOP_GEOM[v.vessel_id] || { color: '#8e3226', lane: [] };
    const lv = live[v.vessel_id] || {};
    const speed = lv.speed_kt ?? v.service_speed_kt;
    const util = v.capacity_teu ? clamp01((lv.onboard_teu || 0) / v.capacity_teu) : 0;
    const fuelDay = v.fuel_a_tpd + v.fuel_b_tpd * Math.pow(speed, 3);

    // Real per-vessel cargo mix: booked TEU by segment, from recent live
    // booking.decision events for this vessel_id. No split is claimed
    // (segShares stays null) until this vessel has at least one booking.
    const segBookedTEU = Object.fromEntries(SEGMENTS.map((s) => [s.key, 0]));
    for (const e of bookingEvents) {
      if (e.vessel_id !== v.vessel_id || e.outcome !== 'booked') continue;
      if (e.segment in segBookedTEU) segBookedTEU[e.segment] += e.teu || 0;
    }
    const totalBooked = Object.values(segBookedTEU).reduce((a, b) => a + b, 0);
    const segShares = totalBooked > 0
      ? Object.fromEntries(SEGMENTS.map((s) => [s.key, segBookedTEU[s.key] / totalBooked]))
      : null;

    // Real TEU moved + average booked rate for this vessel, from the same
    // recent booking.decision events (outcome 'booked', grouped by
    // vessel_id). ratePerTEU is null with no bookings yet — the fleet card
    // shows "—" rather than inventing a figure.
    let teuMoved = 0, revBooked = 0;
    for (const e of bookingEvents) {
      if (e.vessel_id !== v.vessel_id || e.outcome !== 'booked') continue;
      teuMoved += e.teu || 0;
      revBooked += e.price || 0;
    }
    const ratePerTEU = teuMoved > 0 ? revBooked / teuMoved : null;

    return {
      vessel: v.vessel_id, name: v.name, color: geom.color, lane: geom.lane,
      teu: v.capacity_teu, age: v.age_years, draft: v.draft_m,
      speed, util, fuelDay, co2Day: fuelDay * 3.15,
      segBookedTEU, segShares, teuMoved, ratePerTEU,
    };
  });
}

function buildFunnelAndOutcomes(bookingEvents, deliveredTotal) {
  const funnel = SEGMENTS.map((s) => {
    const segEvents = bookingEvents.filter((e) => e.segment === s.key);
    return {
      ...s,
      req: segEvents.length,
      quoted: segEvents.filter(hasQuote).length,
      countered: segEvents.filter(isCountered).length,
      booked: segEvents.filter((e) => e.outcome === 'booked').length,
    };
  });
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o.key, 0]));
  for (const e of bookingEvents) {
    const key = classifyOutcome(e);
    if (key && key in counts) counts[key]++;
  }
  const outcomes = OUTCOMES.map((o) => ({ ...o, n: counts[o.key] }));
  return { funnel, outcomes, deliveredTotal };
}

// Pure: raw API payloads -> the exact model shape stats.js draws from.
export function toStatsModel(raw) {
  const { policies, order } = buildPolicies(raw);
  const lift = buildLift(raw);
  const bookingEvents = raw.events.filter((e) => e.type === 'booking.decision');
  const deliveredTotal = raw.events.filter((e) => e.type === 'delivery.confirmed').length;
  const ports = buildPorts(raw, bookingEvents);
  const loops = buildLoops(raw, bookingEvents);
  const { funnel, outcomes } = buildFunnelAndOutcomes(bookingEvents, deliveredTotal);
  const requests = bookingEvents.length;
  const customerDecisions = bookingEvents.filter((e) => e.source === 'customer').length;
  const lead = policies.ppo;

  // label straight from the export's provenance, never hard-coded
  const nScen = (raw.meta.scenarios || []).length;
  const scenario = { label: `Holdout · ${nScen} unseen scenario${nScen === 1 ? '' : 's'} × ${raw.meta.episodes} seeds` };

  const tide = lead.revenue.map((v, i) => ({ day: i + 1, ppo: v, stat: policies.static.revenue[i] }));

  return {
    scenario, days: lead.cum.length,
    policies, order, lift,
    ports, loops, funnel, outcomes, deliveredTotal,
    requests, customerDecisions,
    tide,
    headline: { revenue: lead.revTotal, profit: lead.profit, teu: lead.teu, requests, vessels: raw.vessels.length, ports: raw.ports.length },
    meta: { generated_at: raw.meta.generated_at, episodes: raw.meta.episodes },
  };
}

// The holdout comparison (the only source; the shock replay was removed).
export async function loadStats() {
  const [summary, timeline, meta, ports, vessels, live] = await Promise.all([
    API.compare('summary'), API.compare('timeline'), API.compare('meta'), API.ports(), API.vessels(), API.live(),
  ]);
  const eventsResp = await API.liveEvents(0, 'booking.decision,delivery.confirmed', 1000);
  const raw = { summary, timeline, meta, ports, vessels, live, events: eventsResp.events };
  return toStatsModel(raw);
}
