// LiveEngine's episode-change handling and queue cap, against a real network
// slice and a real decision shape (fetched once), then replayed through a
// monkeypatched API.livePolicy so the episode/n sequence is controlled.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.DOCK_API_BASE = process.env.DOCK_API_BASE || 'http://localhost:8080/api';

const { API } = await import('../js/api.js');
const { LiveEngine } = await import('../js/pages/liveDecision.js');

const realLivePolicy = API.livePolicy;

function cloneWithN(template, n) {
  return { ...template, n };
}

function batch(episodeId, decisions) {
  return { episode_id: episodeId, decisions };
}

test('LiveEngine: template decision + network fetched from the live stack', async () => {
  const network = await API.policyNetwork();
  const res = await realLivePolicy(1);
  assert.ok(res.decisions.length > 0, 'need at least one real decision to clone for the fakes below');
  globalThis.__DOCK_TEST_NETWORK__ = network;
  globalThis.__DOCK_TEST_TRACE__ = res.decisions[0];
});

test('LiveEngine caps its queue rather than growing without bound', async (t) => {
  const network = globalThis.__DOCK_TEST_NETWORK__;
  const template = globalThis.__DOCK_TEST_TRACE__;
  const engine = new LiveEngine();
  engine.network = network;         // skip init()'s network fetch — reuse the real one
  engine.W1 = network.w1; engine.W2 = network.w2; engine.W3 = network.w3;

  const fifty = Array.from({ length: 50 }, (_, i) => cloneWithN(template, i + 1));
  t.mock.method(API, 'livePolicy', async () => batch('ep-cap', fifty));
  await engine._poll();

  assert.ok(engine.queue.length <= 30, `queue should be capped, got ${engine.queue.length}`);
  assert.equal(engine.lastN, 50, 'lastN advances to the newest decision seen');
  // the cap keeps the newest decisions, not the oldest
  assert.equal(engine.queue[engine.queue.length - 1].n, 50);
});

test('LiveEngine only queues decisions newer than lastN on a later poll', async (t) => {
  const network = globalThis.__DOCK_TEST_NETWORK__;
  const template = globalThis.__DOCK_TEST_TRACE__;
  const engine = new LiveEngine();
  engine.network = network;
  engine.W1 = network.w1; engine.W2 = network.w2; engine.W3 = network.w3;

  const first = [cloneWithN(template, 1), cloneWithN(template, 2)];
  t.mock.method(API, 'livePolicy', async () => batch('ep-a', first));
  await engine._poll();
  assert.equal(engine.queue.length, 2);
  assert.equal(engine.lastN, 2);

  // same episode, the API returns a window that overlaps what we've seen
  // (limit=20 style tail) plus one new decision — only n=3 should be added
  API.livePolicy.mock.mockImplementation(async () =>
    batch('ep-a', [cloneWithN(template, 1), cloneWithN(template, 2), cloneWithN(template, 3)]));
  await engine._poll();
  assert.equal(engine.queue.length, 3, 'no duplicate for n=1/2, exactly one new for n=3');
  assert.equal(engine.lastN, 3);
});

test('LiveEngine resets its queue and cursor when the episode id changes', async (t) => {
  const network = globalThis.__DOCK_TEST_NETWORK__;
  const template = globalThis.__DOCK_TEST_TRACE__;
  const engine = new LiveEngine();
  engine.network = network;
  engine.W1 = network.w1; engine.W2 = network.w2; engine.W3 = network.w3;

  t.mock.method(API, 'livePolicy', async () => batch('ep-old', [cloneWithN(template, 40)]));
  await engine._poll();
  assert.equal(engine.lastN, 40);
  assert.equal(engine.queue.length, 1);

  // a world restart: trace numbering starts over at 1 under a new episode id
  API.livePolicy.mock.mockImplementation(async () => batch('ep-new', [cloneWithN(template, 1)]));
  await engine._poll();
  assert.equal(engine.episodeId, 'ep-new');
  assert.equal(engine.lastN, 1, 'the old cursor must not survive — n=1 would never exceed lastN=40 otherwise');
  assert.equal(engine.queue.length, 1);
  assert.equal(engine.queue[0].n, 1);
});

test('LiveEngine.next() prefers a queued booking-step decision', async () => {
  const network = globalThis.__DOCK_TEST_NETWORK__;
  const template = globalThis.__DOCK_TEST_TRACE__;
  const engine = new LiveEngine();
  engine.network = network;
  engine.W1 = network.w1; engine.W2 = network.w2; engine.W3 = network.w3;
  engine.queue = [
    { ...cloneWithN(template, 1), type: 'fleet' },
    { ...cloneWithN(template, 2), type: 'booking' },
  ];
  const d = engine.next();
  assert.equal(d.type, 'booking');
  assert.equal(engine.queue.length, 1);
});

test('LiveEngine.stop() clears the poll timer', async () => {
  const network = globalThis.__DOCK_TEST_NETWORK__;
  const engine = new LiveEngine();
  engine.network = network;
  engine.start();
  assert.ok(engine._timer, 'start() should set a timer');
  engine.stop();
  assert.equal(engine._timer, null);
});

test.after(() => { API.livePolicy = realLivePolicy; });
