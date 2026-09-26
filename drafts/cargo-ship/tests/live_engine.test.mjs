// LiveFeed (the Model page's data source): history ordering, outcome
// updates on re-poll, episode resets and error reporting — against a real
// network slice and a real decision shape fetched once from the live stack,
// then replayed through a monkeypatched API.livePolicy so the episode / n /
// outcome sequence is controlled.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.DOCK_API_BASE = process.env.DOCK_API_BASE || 'http://localhost:8080/api';

const { API } = await import('../js/api.js');
const { LiveFeed } = await import('../js/pages/liveDecision.js');

const realLivePolicy = API.livePolicy;
let network, bookingTemplate;

const withN = (t, n, extra = {}) => ({ ...t, n, ...extra });
const batch = (episode_id, decisions, day = 5) => ({ episode_id, policy: 'ppo', day, decisions });

function feedWith(responses) {
  const feed = new LiveFeed();
  feed.network = network;                  // skip init()'s fetch — reuse the real slice
  let i = 0;
  API.livePolicy = async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return feed;
}

test('LiveFeed: real network + a real booking decision from the live stack', async () => {
  network = await API.policyNetwork();
  const res = await realLivePolicy(60);
  bookingTemplate = res.decisions.find((d) => d.step === 'booking' && d.request);
  assert.ok(bookingTemplate, 'need at least one real booking decision to clone');
});

test('LiveFeed keeps decisions newest-first and exposes episode/day/policy', async (t) => {
  t.after(() => { API.livePolicy = realLivePolicy; });
  const feed = feedWith([batch('ep1', [withN(bookingTemplate, 3), withN(bookingTemplate, 7), withN(bookingTemplate, 5)], 12.5)]);
  let events = 0;
  feed.onChange(() => events++);
  await feed.poll();
  assert.deepEqual(feed.decisions.map((d) => d.n), [7, 5, 3]);
  assert.equal(feed.episodeId, 'ep1');
  assert.equal(feed.day, 12.5);
  assert.equal(feed.policy, 'ppo');
  assert.equal(events, 1);
  assert.equal(feed.byN(5).n, 5);
  assert.equal(feed.byN(99), null);
});

test('LiveFeed: a PENDING decision picks up its real outcome on a later poll', async (t) => {
  t.after(() => { API.livePolicy = realLivePolicy; });
  const accept = { ...bookingTemplate, action: 1, mask: bookingTemplate.mask.map((v, i) => v || i === 1) };
  const pending = withN(accept, 10, { outcome: null });
  const settled = withN(accept, 10, { outcome: { outcome: 'booked', kind: 'accept', price: 500, seq: 42, hash: '0xabc', prev_hash: '0xdef' } });
  const feed = feedWith([batch('ep1', [pending]), batch('ep1', [settled])]);
  await feed.poll();
  assert.equal(feed.byN(10).outcome.stamp, 'PENDING');
  assert.equal(feed.byN(10).ledger, null);
  await feed.poll();
  assert.equal(feed.byN(10).outcome.stamp, 'BOOKED', 're-poll must refresh the outcome of an already-seen decision');
  assert.equal(feed.byN(10).ledger.seq, 42);
});

test('LiveFeed signals a reset when the live episode changes', async (t) => {
  t.after(() => { API.livePolicy = realLivePolicy; });
  const feed = feedWith([batch('ep1', [withN(bookingTemplate, 40)]), batch('ep2', [withN(bookingTemplate, 1)])]);
  const resets = [];
  feed.onChange(({ reset }) => resets.push(reset));
  await feed.poll();
  await feed.poll();
  assert.deepEqual(resets, [false, true]);
  assert.deepEqual(feed.decisions.map((d) => d.n), [1], 'the old episode’s decisions are dropped');
});

test('LiveFeed reports errors and keeps the last good decisions', async (t) => {
  t.after(() => { API.livePolicy = realLivePolicy; });
  const feed = feedWith([batch('ep1', [withN(bookingTemplate, 8)]), Object.assign(new Error('backend down'), { status: 0 })]);
  await feed.poll();
  await feed.poll();
  assert.equal(feed.error, 'backend down');
  assert.deepEqual(feed.decisions.map((d) => d.n), [8]);
});

test('LiveFeed.stop() clears the poll timer; start() is idempotent', async (t) => {
  t.after(() => { API.livePolicy = realLivePolicy; });
  const feed = feedWith([batch('ep1', [withN(bookingTemplate, 1)])]);
  feed.start();
  const timer = feed._timer;
  feed.start();
  assert.equal(feed._timer, timer);
  feed.stop();
  assert.equal(feed._timer, null);
});

test('toDecision passes through what the inspector reads (customer flag, option ETA, timings)', async (t) => {
  t.after(() => { API.livePolicy = realLivePolicy; });
  const feed = feedWith([batch('ep1', [withN(bookingTemplate, 2, { request: { ...bookingTemplate.request, customer: true } })])]);
  await feed.poll();
  const d = feed.byN(2);
  assert.equal(d.req.customer, true);
  const real = d.options.filter((o) => o.vessel.id !== '—');
  assert.ok(real.length > 0);
  real.forEach((o) => assert.ok(o.eta == null || Number.isFinite(o.eta)));
  assert.equal(typeof d.timings, 'object');
  Object.values(d.timings).forEach((v) => assert.ok(Number.isFinite(v) && v >= 0));
});
