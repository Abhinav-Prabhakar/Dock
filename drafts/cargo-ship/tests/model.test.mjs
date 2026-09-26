import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.DOCK_API_BASE = process.env.DOCK_API_BASE || 'http://localhost:8080/api';

const { API } = await import('../js/api.js');
const { actionsFromNetwork, toDecision, curveAt } = await import('../js/pages/liveDecision.js');

const ALLOWED_STAMPS = ['BOOKED', 'DECLINED', 'REJECTED', 'ENGINE ORDER', 'REPOSITION', 'HOLD'];

function assertAllFinite(value, path = 'root') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
  } else if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not a finite number: ${value}`);
  }
}

let network, decisions;

test('fetch the real network slice', async () => {
  network = await API.policyNetwork();
  assert.equal(network.layers[0], 112);
  assert.equal(network.layers[3], 44);
  assert.equal(network.obs_labels.length, 112);
  assert.equal(network.action_labels.length, 44);
  assert.equal(network.w1.length, 28);
  assert.equal(network.w1[0].length, 112);
  assert.equal(network.w2.length, 28);
  assert.equal(network.w3.length, 44);
});

test('actionsFromNetwork returns 44 descriptors with correct groups', () => {
  const actions = actionsFromNetwork(network);
  assert.equal(actions.length, 44);
  const book = actions.filter((a) => a.group === 'book');
  const speed = actions.filter((a) => a.group === 'speed');
  const repo = actions.filter((a) => a.group === 'repo');
  assert.equal(book.length, 12);
  assert.equal(speed.length, 16);
  assert.equal(repo.length, 16);
  assert.equal(actions[0].kind, 'reject');
  assert.equal(actions[1].kind, 'accept');
  assert.ok(actions.slice(2, 6).every((a) => a.kind === 'flex_window'));
  assert.ok(actions.slice(6, 9).every((a) => a.kind === 'alt_hub'));
  assert.ok(actions.slice(9, 12).every((a) => a.kind === 'split'));
  assert.ok(speed.every((a) => a.kind === 'speed' && [12, 14, 16, 18].includes(a.kt)));
  assert.ok(repo.every((a) => a.kind === 'reposition' && [75, 150].includes(a.teu)));
  // every action carries the network's own label
  actions.forEach((a, i) => assert.equal(a.label, network.action_labels[i]));
});

test('fetch a batch of real live decisions', async () => {
  const res = await API.livePolicy(60);
  assert.ok(Array.isArray(res.decisions) && res.decisions.length > 0, 'expected at least one live decision');
  decisions = res.decisions;
});

test('toDecision shapes every fetched decision correctly', () => {
  for (const trace of decisions) {
    const d = toDecision(trace, network);

    assert.equal(d.obs.length, 112, `decision ${trace.n}: obs length`);
    assert.equal(d.probs.length, 44, `decision ${trace.n}: probs length`);
    assert.equal(d.mask.length, 44, `decision ${trace.n}: mask length`);
    assert.equal(d.logits.length, 44, `decision ${trace.n}: logits length`);

    // probs sum to ~1 over legal actions, 0 on masked actions
    let legalSum = 0;
    d.probs.forEach((p, i) => {
      if (d.mask[i]) legalSum += p;
      else assert.equal(p, 0, `decision ${trace.n}: probs[${i}] should be 0 when masked`);
    });
    assert.ok(Math.abs(legalSum - 1) < 1e-2, `decision ${trace.n}: legal probs sum to ${legalSum}, expected ~1`);

    // the chosen action must be legal
    assert.ok(d.mask[d.action], `decision ${trace.n}: chosen action ${d.action} should be legal`);

    assert.ok(d.options.length <= 4, `decision ${trace.n}: at most 4 options`);
    assert.equal(d.ports.length, 8, `decision ${trace.n}: 8 ports`);
    assert.equal(d.fleet.length, 4, `decision ${trace.n}: 4 vessels`);
    assert.equal(d.forecast.length, 18, `decision ${trace.n}: 18 forecast values`);

    assert.ok(ALLOWED_STAMPS.includes(d.outcome.stamp), `decision ${trace.n}: stamp '${d.outcome.stamp}' should be an allowed value`);

    // No bid <= list check: the guard can cap the list price below the
    // floor and the simulator still books it if the customer's WTP clears.
    if (trace.step === 'booking' && trace.pricing) {
      const p = trace.pricing;
      assert.ok([p.bid_price, p.list_price, p.price].every(Number.isFinite), `decision ${trace.n}: pricing not finite`);
      assert.ok(p.bid_price >= 0 && p.list_price > 0 && p.price > 0 && p.price <= p.list_price + 0.01,
        `decision ${trace.n}: pricing bid ${p.bid_price} / list ${p.list_price} / price ${p.price}`);
    }

    assertAllFinite(d.obs, `decision ${trace.n}.obs`);
    assertAllFinite(d.probs, `decision ${trace.n}.probs`);
    assertAllFinite(d.mask.map((v) => (v ? 1 : 0)), `decision ${trace.n}.mask`);
    d.logits.forEach((v, i) => { if (v != null) assertAllFinite(v, `decision ${trace.n}.logits[${i}]`); });
    assertAllFinite(d.h1, `decision ${trace.n}.h1`);
    assertAllFinite(d.h2, `decision ${trace.n}.h2`);
    assertAllFinite(d.value, `decision ${trace.n}.value`);
    assertAllFinite(d.entropy, `decision ${trace.n}.entropy`);
    assertAllFinite(d.forecast, `decision ${trace.n}.forecast`);
    assertAllFinite(d.day, `decision ${trace.n}.day`);

    // the original page's exact shape: a fixed 4-slot options array (booking
    // steps) with the vessel/leg fields drawOptions() reads, a curve-based
    // quote, "same request, other captains" baselines with the PPO row, and
    // an 8-long latency array (voyage strip stations).
    assert.equal(d.latency.length, 8, `decision ${trace.n}: latency has 8 stations`);
    d.latency.forEach((v) => { if (v != null) assert.ok(Number.isFinite(v) && v >= 0, `decision ${trace.n}: latency values are non-negative numbers or null`); });

    if (trace.step === 'booking') {
      assert.equal(d.options.length, 4, `decision ${trace.n}: booking step always has the 4-slot options layout`);
      d.options.forEach((o, k) => {
        assert.equal(o.k, k, `decision ${trace.n}: option slot ${k} keeps its index`);
        assert.ok('vessel' in o && 'id' in o.vessel, `decision ${trace.n}: option ${k} carries a vessel id`);
        assert.ok(Array.isArray(o.legs), `decision ${trace.n}: option ${k} carries a legs array`);
        o.legs.forEach((l, j) => {
          assert.ok(typeof l.from === 'string' && typeof l.to === 'string', `decision ${trace.n}: option ${k} leg ${j} has real from/to ports`);
          assert.ok(Number.isFinite(l.pressure), `decision ${trace.n}: option ${k} leg ${j} has a finite pressure`);
          assert.ok(Number.isFinite(l.remaining), `decision ${trace.n}: option ${k} leg ${j} has finite remaining TEU`);
        });
      });

      if (trace.pricing) {
        assert.ok(d.quote, `decision ${trace.n}: pricing present => quote built`);
        assert.ok(Array.isArray(d.quote.curve) && d.quote.curve.length > 0, `decision ${trace.n}: quote carries the real acceptance/margin curve`);
        d.quote.curve.forEach((row, i) => {
          assert.equal(row.length, 3, `decision ${trace.n}: curve row ${i} is [price, pAccept, margin]`);
          assertAllFinite(row, `decision ${trace.n}.quote.curve[${i}]`);
        });
        // curveAt interpolates within the curve's own bounds
        const mid = curveAt(d.quote.curve, d.quote.curve[Math.floor(d.quote.curve.length / 2)][0]);
        assert.ok(mid.pAccept >= 0 && mid.pAccept <= 1, `decision ${trace.n}: curveAt returns a valid P(accept)`);

        assert.ok(Array.isArray(d.baselines), `decision ${trace.n}: baselines built when pricing is present`);
        const ppo = d.baselines.find((b) => b.key === 'ppo');
        assert.ok(ppo, `decision ${trace.n}: baselines include the Dock · PPO row`);
        assert.equal(ppo.label, 'Dock · PPO');
        assert.equal(ppo.price, trace.pricing.price, `decision ${trace.n}: ppo row prices at the real quote`);
        const expectedEv = (trace.pricing.price - trace.pricing.bid_price) * trace.pricing.teu;
        assert.ok(Math.abs(ppo.ev - expectedEv) < 1e-6, `decision ${trace.n}: ppo row ev is (price - bid_price) * teu`);
        (trace.counterfactuals || []).forEach((cf) => {
          const row = d.baselines.find((b) => b.key === cf.key);
          assert.ok(row, `decision ${trace.n}: counterfactual ${cf.key} carried through to baselines`);
          assert.equal(row.ev, cf.margin_usd, `decision ${trace.n}: baseline ${cf.key} ev is the real margin_usd`);
        });
      }
    } else {
      assert.equal(d.options.length, 0, `decision ${trace.n}: fleet step has no voyage options`);
    }
  }
});
