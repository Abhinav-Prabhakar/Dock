// Tests for the live-data stowage adapter and the bookings-panel event
// formatter. Hits the REAL running backend (no mocks) — start it first, or
// point DOCK_API_BASE at wherever it's listening.
//
//   cd /Users/sudheer/Desktop/Dock && node --test drafts/cargo-ship/tests/
//
// fromLive.js and live.js are plain ES modules (no three.js import), so they
// can be loaded directly in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.DOCK_API_BASE = process.env.DOCK_API_BASE || 'http://localhost:8080/api';

const { API } = await import('../js/api.js');
const { layoutFromStowage } = await import('../js/stowage/fromLive.js');
const { describeEvent, trackCustomer, seedCustomers, CUSTOMER_EVENT_TYPES, live } = await import('../js/live.js');

/* ------------------------------------------------------------------ synthetic ship fixture */

// A stand-in for `cargo.bays` (== `ship.layout.bays`) that doesn't require
// importing ship.js/cargo.js (both pull in three.js, which Node can't load).
// 20 physical bays (SHIP.layout's bay count), deck tiers 6-10, hold rows
// narrowing towards the keel — shaped like the real hull without depending
// on it.
const HOLD_TIERS = 9;
const ROW_PITCH = 2.463;

function makeRows(rowCount) {
  const rows = [{ row: 0, z: 0 }];
  for (let i = 0; i < Math.floor((rowCount - 1) / 2); i++) {
    rows.push({ row: 2 * i + 1, z: (i + 1) * ROW_PITCH });
    rows.push({ row: 2 * i + 2, z: -(i + 1) * ROW_PITCH });
  }
  return rows.sort((a, b) => a.z - b.z);
}

function makeBays(P = 20) {
  const rows = makeRows(9); // 9 rows per bay, same set everywhere for simplicity
  const byAbsZ = [...rows].sort((a, b) => Math.abs(a.z) - Math.abs(b.z) || a.row - b.row);
  const bays = [];
  for (let k = 0; k < P; k++) {
    const tiers = 6 + (k % 5); // 6..10
    const holdRows = [];
    for (let i = 0; i < HOLD_TIERS; i++) {
      // narrower near the keel (i=0) than near the tank top (i=HOLD_TIERS-1)
      const allowed = Math.min(rows.length, 3 + Math.round((i * (rows.length - 3)) / (HOLD_TIERS - 1)));
      holdRows.push(new Set(byAbsZ.slice(0, allowed).map((r) => r.row)));
    }
    bays.push({
      index: k, bay: 4 * k + 2, foreBay20: 4 * k + 1, aftBay20: 4 * k + 3,
      tiers, rows, rowCount: rows.length, holdRows,
    });
  }
  return bays;
}

/* ------------------------------------------------------------------ layoutFromStowage against the real API */

async function checkVessel(vesselId) {
  const stow = await API.stowage(vesselId);
  const bays = makeBays(20);
  const { specs, summary } = layoutFromStowage(stow, bays, HOLD_TIERS);

  const byBay = new Map(bays.map((b) => [b.bay, b]));
  const byFore = new Map(bays.map((b) => [b.foreBay20, b]));
  const byAft = new Map(bays.map((b) => [b.aftBay20, b]));

  const used = new Set(); // "bayIndex:half:row:tier"
  const totalCapPerBay = new Map(); // physical bay index -> cap_j (TEU)
  const teuPerBay = new Map();
  const stacks = new Map(); // "bayIndex:row" -> [{tier, dischargeCall}]

  for (const spec of specs) {
    let bay, half, teu;
    if (spec.type === '20') {
      if (byFore.has(spec.bay)) { bay = byFore.get(spec.bay); half = 'fore'; }
      else if (byAft.has(spec.bay)) { bay = byAft.get(spec.bay); half = 'aft'; }
      else assert.fail(`20' spec used bay number ${spec.bay}, which is not a fore/aft 20' slot`);
      teu = 1;
    } else {
      assert.ok(byBay.has(spec.bay), `40'/40HC spec used bay number ${spec.bay}, which is not a 40' bay`);
      bay = byBay.get(spec.bay);
      half = 'both';
      teu = 2;
      assert.ok(['40', '40HC'].includes(spec.type));
    }

    // row/tier valid for this bay
    if (spec.tier >= 82) {
      assert.ok(spec.tier <= 80 + bay.tiers * 2, `deck tier ${spec.tier} exceeds bay ${bay.bay}'s ${bay.tiers} tiers`);
      assert.ok(bay.rows.some((r) => r.row === spec.row), `row ${spec.row} does not exist in bay ${bay.bay}`);
    } else {
      const i = spec.tier / 2 - 1;
      assert.ok(i >= 0 && i < HOLD_TIERS, `hold tier ${spec.tier} out of range`);
      assert.ok(bay.holdRows[i].has(spec.row), `row ${spec.row} not valid at hold tier ${spec.tier} of bay ${bay.bay}`);
    }

    // no cell half used twice
    const halves = half === 'both' ? ['fore', 'aft'] : [half];
    for (const h of halves) {
      const key = `${bay.index}:${h}:${spec.row}:${spec.tier}`;
      assert.ok(!used.has(key), `cell ${key} used twice`);
      used.add(key);
    }

    // category mapping
    if (spec.category === 'imdg') assert.notEqual(spec.pod, undefined);
    assert.ok(['dry', 'reefer', 'imdg'].includes(spec.category), `unexpected category ${spec.category}`);

    teuPerBay.set(bay.index, (teuPerBay.get(bay.index) || 0) + teu);

    // stack ordering: collect for the (bay,row) monotonicity check below
    const skey = `${bay.index}:${spec.row}`;
    if (!stacks.has(skey)) stacks.set(skey, []);
    stacks.get(skey).push({ tier: spec.tier, dischargeCall: spec._dischargeCall });
  }

  // capacity per physical bay (used for the shownTEU-vs-fill cross check)
  for (const bay of bays) {
    const holdCells = bay.holdRows.reduce((s, set) => s + set.size, 0);
    const deckCells = bay.tiers * bay.rows.length;
    totalCapPerBay.set(bay.index, 2 * (holdCells + deckCells));
  }

  // per-stack discharge ordering never increases going up (bottom = latest discharge)
  for (const [skey, placements] of stacks) {
    placements.sort((a, b) => a.tier - b.tier);
    for (let i = 1; i < placements.length; i++) {
      assert.ok(
        placements[i].dischargeCall <= placements[i - 1].dischargeCall,
        `stack ${skey}: discharge_call increased going up (tier ${placements[i - 1].tier}->${placements[i].tier}: ${placements[i - 1].dischargeCall} -> ${placements[i].dischargeCall})`,
      );
    }
  }

  // shownTEU equals the sum of placed TEU
  const sumTeu = [...teuPerBay.values()].reduce((a, b) => a + b, 0);
  assert.equal(summary.shownTEU, sumTeu, 'summary.shownTEU must equal the sum of placed TEU');

  // shownTEU per physical bay is within +-2 TEU of round(f_j * cap_j)
  const P = bays.length, B = stow.bays.length;
  const groups = Array.from({ length: P }, () => []);
  for (let b = 0; b < B; b++) groups[Math.min(P - 1, Math.floor((b * P) / B))].push(b);
  for (let j = 0; j < P; j++) {
    const mapped = groups[j];
    if (mapped.length === 0) continue;
    let count = 0;
    for (const b of mapped) count += (stow.bays[b].aboard || []).length;
    const f = count / (mapped.length * stow.bay_height);
    const cap = totalCapPerBay.get(j);
    // Capped at `count`: a real container is never drawn twice, so on a
    // small vessel (whose real per-group count is far below this fixture
    // hull's own capacity) the shown TEU tracks the real unit count, not
    // the naive fill-fraction projection onto this hull's larger capacity.
    const expected = Math.min(Math.round(f * cap), count);
    const got = teuPerBay.get(j) || 0;
    assert.ok(Math.abs(got - expected) <= 2,
      `physical bay ${j}: shown ${got} TEU vs expected ~${expected} TEU (cap ${cap}, real units ${count})`);
  }

  assert.equal(summary.aboardTEU, stow.aboard_teu);
  return { stow, specs, summary };
}

test('layoutFromStowage: VES1 real stowage maps cleanly onto the physical hull', async () => {
  await checkVessel('VES1');
});

test('layoutFromStowage: VES4 real stowage maps cleanly onto the physical hull', async () => {
  await checkVessel('VES4');
});

test('layoutFromStowage: empty aboard list produces no specs', () => {
  const bays = makeBays(5);
  const stow = {
    aboard_teu: 0, bay_height: 100,
    bays: Array.from({ length: 8 }, () => ({ aboard: [] })),
  };
  const { specs, summary } = layoutFromStowage(stow, bays, HOLD_TIERS);
  assert.deepEqual(specs, []);
  assert.equal(summary.shownTEU, 0);
  assert.equal(summary.fill, 0);
});

test('layoutFromStowage: a matching pair becomes one 40\' box; a mismatched pair becomes two 20\'s', () => {
  const bays = makeBays(1);
  const mkUnit = (discharge, cargo_type, weight_t, discharge_call = 5) => ({ discharge, discharge_call, board: 'CNSHA', weight_t, cargo_type });
  // enough units to fill bay 0 fully with matching pairs -> all 40'/40HC
  const bay = bays[0];
  const holdCells = bay.holdRows.reduce((s, set) => s + set.size, 0);
  const deckCells = bay.tiers * bay.rows.length;
  const capTeu = 2 * (holdCells + deckCells);
  const matching = Array.from({ length: capTeu }, () => mkUnit('NLRTM', 'dry', 12));
  const stow1 = { aboard_teu: capTeu, bay_height: capTeu, bays: [{ aboard: matching }] };
  const { specs: specsMatched } = layoutFromStowage(stow1, bays, HOLD_TIERS);
  assert.ok(specsMatched.length > 0);
  assert.ok(specsMatched.every((s) => s.type === '40' || s.type === '40HC'));

  // alternating discharge ports -> every pair mismatches -> all 20's
  const mismatched = Array.from({ length: capTeu }, (_, i) => mkUnit(i % 2 ? 'NLRTM' : 'DEHAM', 'dry', 12));
  const stow2 = { aboard_teu: capTeu, bay_height: capTeu, bays: [{ aboard: mismatched }] };
  const { specs: specsMismatched } = layoutFromStowage(stow2, bays, HOLD_TIERS);
  assert.ok(specsMismatched.length > 0);
  assert.ok(specsMismatched.every((s) => s.type === '20'));
});

test('layoutFromStowage: reefer pairs become 40HC, hazmat maps to imdg category', () => {
  const bays = makeBays(1);
  const bay = bays[0];
  const holdCells = bay.holdRows.reduce((s, set) => s + set.size, 0);
  const deckCells = bay.tiers * bay.rows.length;
  const cap = 2 * (holdCells + deckCells);
  const mkUnit = (discharge, cargo_type, weight_t) => ({ discharge, discharge_call: 5, board: 'CNSHA', weight_t, cargo_type });
  const units = [
    mkUnit('NLRTM', 'reefer', 10), mkUnit('NLRTM', 'reefer', 10),
    mkUnit('DEHAM', 'hazmat', 15), mkUnit('DEHAM', 'hazmat', 15),
  ];
  // bay_height == cap makes f = units.length/cap, so T = round(f*cap) == units.length
  // regardless of how large this fixture bay's own capacity is.
  const stow = { aboard_teu: 4, bay_height: cap, bays: [{ aboard: units }] };
  const { specs } = layoutFromStowage(stow, bays, HOLD_TIERS);
  assert.equal(specs.length, 2);
  const reefer = specs.find((s) => s.pod === 'NLRTM');
  const hazmat = specs.find((s) => s.pod === 'DEHAM');
  assert.equal(reefer.type, '40HC');
  assert.equal(reefer.category, 'reefer');
  assert.equal(hazmat.category, 'imdg');
});

test('layoutFromStowage: a real container is never drawn more than once, even on a tiny vessel', () => {
  // A small vessel's real per-bay-group capacity is far smaller than this
  // fixture hull's; f * cap would exceed the number of real units aboard.
  // The chosen behavior (per explicit product decision) is to show that
  // group emptier, not to fabricate repeated containers.
  const bays = makeBays(20);
  const mkUnit = (i) => ({ discharge: i % 2 ? 'NLRTM' : 'DEHAM', discharge_call: 5, board: 'CNSHA', weight_t: 12, cargo_type: 'dry' });
  const units = Array.from({ length: 3 }, (_, i) => mkUnit(i));
  // bay_height tiny relative to this fixture's own per-group capacity, and
  // only one real backend bay mapped across many fixture bays, so f * cap
  // for the mapped group would be far larger than the 3 real units aboard.
  const stow = { aboard_teu: 3, bay_height: 3, bays: [{ aboard: units }, ...Array.from({ length: 19 }, () => ({ aboard: [] }))] };
  const { specs, summary } = layoutFromStowage(stow, bays, HOLD_TIERS);

  // count physical TEU slots actually consumed: 20' = 1, 40'/40HC = 2
  const drawnTeu = specs.reduce((n, s) => n + (s.type === '20' ? 1 : 2), 0);
  assert.ok(drawnTeu <= units.length, `drew ${drawnTeu} TEU worth of containers from only ${units.length} real units aboard`);
  assert.ok(summary.shownTEU <= units.length);
});

/* ------------------------------------------------------------------ describeEvent */

test('describeEvent: real events from /live/events with the panel\'s own type filter', async () => {
  const res = await API.liveEvents(0, CUSTOMER_EVENT_TYPES, 1000);
  assert.ok(Array.isArray(res.events));
  const reqs = new Map();
  for (const ev of res.events) {
    trackCustomer(ev, reqs);
    const d = describeEvent(ev, reqs);
    if (ev.type.startsWith('settlement.')) {
      const known = ev.request_id != null && reqs.has(String(ev.request_id));
      assert.equal(d === null, !known, `${ev.type} for request ${ev.request_id}`);
      if (!d) continue;
    }
    assert.equal(typeof d.day, 'number');
    assert.equal(typeof d.text, 'string');
    assert.ok(d.text.length > 0);
    assert.equal(typeof d.customer, 'boolean');
    assert.ok(['booked', 'rejected', 'declined', 'order'].includes(d.tone));
    if (ev.type === 'booking.decision') {
      assert.equal(d.customer, ev.source === 'customer');
      if (ev.outcome === 'booked') assert.equal(d.tone, 'booked');
      if (ev.outcome === 'declined' || ev.outcome === 'counter_declined') assert.equal(d.tone, 'declined');
    } else {
      assert.equal(d.customer, true);
      assert.equal(d.tone, 'order');
    }
  }
});

test('describeEvent: synthetic events cover booked/rejected/declined/order tones', () => {
  const booked = describeEvent({
    type: 'booking.decision', day: 12.4, outcome: 'booked', kind: 'accept',
    origin: 'CNSHA', dest: 'NLRTM', teu: 6, segment: 'standard', price: 649.8, source: 'customer', order_id: 'BK-1',
  });
  assert.equal(booked.day, 12);
  assert.equal(booked.customer, true);
  assert.equal(booked.tone, 'booked');
  assert.match(booked.text, /CNSHA/);
  assert.match(booked.text, /booked/);
  assert.match(booked.text, /\$650\/TEU/);

  const rejected = describeEvent({
    type: 'booking.decision', day: 3, outcome: 'rejected', origin: 'USLAX', dest: 'CNSHA', teu: 4, segment: 'flexible',
  });
  assert.equal(rejected.customer, false);
  assert.equal(rejected.tone, 'rejected');

  const declined = describeEvent({
    type: 'booking.decision', day: 3, outcome: 'declined', origin: 'USLAX', dest: 'CNSHA', teu: 4, segment: 'flexible', source: 'customer',
  });
  assert.equal(declined.customer, true);
  assert.equal(declined.tone, 'declined');

  const quoted = describeEvent({ type: 'order.quoted', day: 5, order_id: 'BK-2422-TC', offers: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(quoted.text, 'BK-2422-TC quoted · 2 offers');
  assert.equal(quoted.tone, 'order');
  assert.equal(quoted.customer, true);

  const accepted = describeEvent({ type: 'order.accepted', day: 5, order_id: 'BK-2422-TC', kind: 'accept', price_per_teu: 700.4 });
  assert.match(accepted.text, /BK-2422-TC accepted/);
  assert.match(accepted.text, /\$700\/TEU/);

  const declinedOrder = describeEvent({ type: 'order.declined', day: 5, order_id: 'BK-2422-TC' });
  assert.equal(declinedOrder.text, 'BK-2422-TC declined');
  assert.equal(declinedOrder.tone, 'order');
});

const SETTLEMENT_EVENTS = (rid) => [
  { type: 'settlement.deal_registered', day: 5.2, request_id: rid, deal_id: 'd1', kind: 'flex_window' },
  { type: 'settlement.departure_recorded', day: 9.1, request_id: rid, deal_id: 'd1', actual_day: 9.1 },
  { type: 'settlement.delivery_recorded', day: 31.6, request_id: rid, deal_id: 'd1', actual_day: 31.6 },
  { type: 'settlement.settled', day: 31.6, request_id: rid, deal_id: 'd1', outcome: 'settled_full', amount_usd: 9313.26, tx_hash: '0xabc' },
];

test('describeEvent: settlement lines only for customer requests (matched on request_id)', () => {
  const reqs = new Map();
  // order.quoted (always first) and the customer's booking.decision carry request_id + order_id
  trackCustomer({ type: 'order.quoted', request_id: 4242, order_id: 'BK-2490-TC', offers: [] }, reqs);
  trackCustomer({ type: 'booking.decision', source: 'customer', request_id: 4243, order_id: 'BK-2491-TC', outcome: 'booked' }, reqs);
  trackCustomer({ type: 'booking.decision', request_id: 7, outcome: 'booked' }, reqs);   // simulated cargo
  assert.deepEqual([...reqs], [['4242', 'BK-2490-TC'], ['4243', 'BK-2491-TC']]);

  const lines = SETTLEMENT_EVENTS(4242).map((ev) => describeEvent(ev, reqs));
  assert.deepEqual(lines.map((l) => l.text), [
    'BK-2490-TC deal registered · flex_window',
    'BK-2490-TC departed',
    'BK-2490-TC delivered',
    'BK-2490-TC settled · settled_full · $9,313',
  ]);
  assert.ok(lines.every((l) => l.customer && l.tone === 'order'));
  assert.deepEqual(lines.map((l) => l.day), [5, 9, 31, 31]);

  // string request ids match too
  assert.equal(describeEvent({ ...SETTLEMENT_EVENTS('4242')[3] }, reqs).text, lines[3].text);
  // simulated deals and unknown requests produce no line
  for (const ev of [...SETTLEMENT_EVENTS(7), ...SETTLEMENT_EVENTS(999)]) assert.equal(describeEvent(ev, reqs), null);
  assert.equal(describeEvent(SETTLEMENT_EVENTS(4242)[0]), null);   // no map -> nothing known
});

test('live poller filter includes every settlement step; episode change forgets customer requests', () => {
  for (const t of ['booking.decision', 'order.quoted', 'order.accepted', 'order.declined',
    'settlement.deal_registered', 'settlement.departure_recorded', 'settlement.delivery_recorded', 'settlement.settled']) {
    assert.ok(CUSTOMER_EVENT_TYPES.split(',').includes(t), t);
  }
  live.customerReqs.set('1', 'BK-1');
  live._afterSeq = 50;
  live._seededFor = 'ep-old';
  live._resetEpisode();
  assert.equal(live.customerReqs.size, 0);
  assert.equal(live._afterSeq, 0);
  assert.equal(live._seededFor, null);
});

test('seedCustomers: orders quoted before the page opened, current episode only', () => {
  const reqs = new Map();
  seedCustomers([
    { id: 'BK-1', episode_id: 'ep-live', request_id: 11 },
    { id: 'BK-2', episode_id: 'ep-old', request_id: 12 },
    { id: 'BK-3', episode_id: 'ep-live', request_id: null },
  ], 'ep-live', reqs);
  assert.deepEqual([...reqs], [['11', 'BK-1']]);
  assert.equal(describeEvent({ type: 'settlement.settled', day: 40, request_id: 11, outcome: 'refunded', amount_usd: 0 }, reqs).text,
    'BK-1 settled · refunded · $0');
});

test('seedCustomers: real /orders rows for the live episode carry request ids', async () => {
  const [snap, orders] = await Promise.all([API.live(), API.orders()]);
  const reqs = new Map();
  seedCustomers(orders, snap.id, reqs);
  const mine = orders.filter((o) => o.episode_id === snap.id && o.request_id != null);
  assert.equal(reqs.size, new Set(mine.map((o) => String(o.request_id))).size);
  for (const o of mine) assert.equal(reqs.get(String(o.request_id)), o.id);
});
