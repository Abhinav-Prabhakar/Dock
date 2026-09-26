import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.DOCK_API_BASE = process.env.DOCK_API_BASE || 'http://localhost:8080/api';

const { loadStats } = await import('../js/pages/statsLive.js');

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function assertNoNaNs(value, path = 'root') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaNs(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaNs(v, `${path}.${k}`);
  } else if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not a finite number: ${value}`);
  }
  // strings/booleans/null are fine; undefined values are caught because
  // Object.entries drops keys whose value is undefined only if absent —
  // an explicit `undefined` property still shows up here as undefined.
  if (value === undefined) assert.fail(`${path} is undefined`);
}

let holdout;

test('loadStats() fetches and shapes the holdout comparison', async () => {
  holdout = await loadStats();
  assert.equal(Object.keys(holdout.policies).length, 5, 'holdout should have 5 policies');
  assertNoNaNs(holdout);
});

test('every policy series is 90 days long', () => {
  for (const model of [holdout]) {
    for (const [key, p] of Object.entries(model.policies)) {
      for (const series of ['cum', 'cumRev', 'daily', 'revenue']) {
        assert.equal(p[series].length, 90, `${model.source}.${key}.${series} should have 90 entries`);
      }
    }
    assert.equal(model.tide.length, 90, `${model.source}.tide should have 90 entries`);
  }
});

test('lift.profit matches summary.lift_vs_static.ppo.profit_usd_pct for holdout', async () => {
  const { API } = await import('../js/api.js');
  const summary = await API.compare('summary');
  assert.equal(holdout.lift.profit, summary.lift_vs_static.ppo.profit_usd_pct);
});

test('ports: 8 entries with lat/lon', () => {
  for (const model of [holdout]) {
    assert.equal(model.ports.length, 8);
    for (const p of model.ports) {
      assert.ok(isFiniteNum(p.lat) && isFiniteNum(p.lon), `${p.code} should have numeric lat/lon`);
    }
  }
});

test('fleet: 4 vessels with util in [0,1]', () => {
  for (const model of [holdout]) {
    assert.equal(model.loops.length, 4);
    for (const l of model.loops) {
      assert.ok(l.util >= 0 && l.util <= 1, `${l.vessel} util ${l.util} should be in [0,1]`);
    }
  }
});

test('funnel stages are monotonic non-increasing where defined (req >= quoted >= booked)', () => {
  for (const model of [holdout]) {
    for (const s of model.funnel) {
      assert.ok(s.req >= s.quoted, `${model.source}.${s.key}: req (${s.req}) >= quoted (${s.quoted})`);
      assert.ok(s.quoted >= s.booked, `${model.source}.${s.key}: quoted (${s.quoted}) >= booked (${s.booked})`);
    }
  }
});

test('fleet segShares sums to 1 (or is null with no bookings) and matches the event aggregation', async () => {
  // Build the model from a single frozen snapshot of raw payloads (rather than
  // re-fetching events separately) so this assertion can't race the live sim,
  // which keeps emitting new booking.decision events between fetches.
  const { API } = await import('../js/api.js');
  const { toStatsModel } = await import('../js/pages/statsLive.js');
  const [summary, timeline, meta, ports, vessels, live] = await Promise.all([
    API.compare('summary'), API.compare('timeline'), API.compare('meta'), API.ports(), API.vessels(), API.live(),
  ]);
  const eventsResp = await API.liveEvents(0, 'booking.decision,delivery.confirmed', 1000);
  const raw = { summary, timeline, meta, ports, vessels, live, events: eventsResp.events };
  const model = toStatsModel(raw);
  const bookingEvents = raw.events.filter((e) => e.type === 'booking.decision');

  for (const l of model.loops) {
    const segBookedTEU = { flexible: 0, standard: 0, urgent: 0 };
    let teuMoved = 0, revBooked = 0;
    for (const e of bookingEvents) {
      if (e.vessel_id !== l.vessel || e.outcome !== 'booked') continue;
      if (e.segment in segBookedTEU) segBookedTEU[e.segment] += e.teu || 0;
      teuMoved += e.teu || 0;
      revBooked += e.price || 0;
    }
    const total = Object.values(segBookedTEU).reduce((a, b) => a + b, 0);
    if (total === 0) {
      assert.equal(l.segShares, null, `${l.vessel} should have null segShares with no booked events`);
    } else {
      const sum = Object.values(l.segShares).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${l.vessel} segShares should sum to 1, got ${sum}`);
      for (const key of Object.keys(segBookedTEU)) {
        assert.ok(Math.abs(l.segShares[key] - segBookedTEU[key] / total) < 1e-9, `${l.vessel}.${key} share mismatch`);
      }
    }

    // teuMoved / ratePerTEU (fleet map line weight + fleet-card "Rate $/TEU")
    // come from the same real booked events, grouped by vessel_id.
    assert.equal(l.teuMoved, teuMoved, `${l.vessel} teuMoved should match booked-event aggregation`);
    if (teuMoved === 0) {
      assert.equal(l.ratePerTEU, null, `${l.vessel} should have null ratePerTEU with no booked events`);
    } else {
      assert.ok(Math.abs(l.ratePerTEU - revBooked / teuMoved) < 1e-9, `${l.vessel} ratePerTEU mismatch`);
    }
  }
});

test('outcome counts sum to the number of decisions considered', () => {
  for (const model of [holdout]) {
    const sum = model.outcomes.reduce((a, o) => a + o.n, 0);
    assert.equal(sum, model.requests, `${model.source}: outcome counts should sum to requests`);
  }
});

test('the scenario label comes from the export metadata (no hard-coded seed count)', async () => {
  const { API } = await import('../js/api.js');
  const meta = await API.compare('meta');
  assert.equal(holdout.scenario.label, `Holdout · ${meta.scenarios.length} unseen scenarios × ${meta.episodes} seeds`);
  assert.equal(holdout.scenario.shock, undefined, 'the shock replay is gone');
});
