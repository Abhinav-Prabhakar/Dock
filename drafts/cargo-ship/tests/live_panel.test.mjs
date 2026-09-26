// live.js's dedupe/reset guards on top of /live/events and /live: an
// overlapping poll must not redeliver the same event twice, and an episode
// restart must reset exactly once (not keep re-firing on every poll until
// the snapshot catches up) and notify onReset listeners.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.DOCK_API_BASE = process.env.DOCK_API_BASE || 'http://localhost:8080/api';

const { API } = await import('../js/api.js');
const { live } = await import('../js/live.js');

const realLiveEvents = API.liveEvents;
const realLive = API.live;
const realOrders = API.orders;

function resetLiveInternals() {
  live._afterSeq = 0;
  live._lastSentSeq = 0;
  live._episodeId = null;
  live._snapshot = null;
  live._seededFor = null;
  live.customerReqs.clear();
  live._snapshotInFlight = false;
  live._eventsInFlight = false;
}

test.beforeEach(() => resetLiveInternals());
test.after(() => { API.liveEvents = realLiveEvents; API.live = realLive; API.orders = realOrders; });

test('_pollEvents does not redeliver an event already sent within the same episode', async (t) => {
  t.mock.method(API, 'orders', async () => []);
  t.mock.method(API, 'liveEvents', async () => ({
    episode_id: 'ep-1', next_seq: 3,
    events: [{ type: 'day.summary', seq: 1, day: 1 }, { type: 'day.summary', seq: 2, day: 1 }],
  }));
  const received = [];
  const off = live.onEvents((evs) => received.push(...evs));
  await live._pollEvents();
  assert.equal(received.length, 2);

  // next poll's window overlaps (seq 1/2 again) plus one genuinely new event
  API.liveEvents.mock.mockImplementation(async () => ({
    episode_id: 'ep-1', next_seq: 4,
    events: [
      { type: 'day.summary', seq: 1, day: 1 },
      { type: 'day.summary', seq: 2, day: 1 },
      { type: 'day.summary', seq: 3, day: 1 },
    ],
  }));
  await live._pollEvents();
  assert.equal(received.length, 3, 'only the unseen seq=3 event should be delivered on the second poll');
  off();
});

test('_pollEvents resets exactly once on an episode restart and notifies onReset', async (t) => {
  t.mock.method(API, 'orders', async () => []);
  t.mock.method(API, 'liveEvents', async () => ({
    episode_id: 'ep-old', next_seq: 10, events: [{ type: 'day.summary', seq: 9, day: 5 }],
  }));
  // in the real app _episodeId is first established by _pollSnapshot(),
  // which runs alongside _pollEvents() from start() — simulate that here
  live._episodeId = 'ep-old';
  await live._pollEvents();
  assert.equal(live._episodeId, 'ep-old');
  assert.equal(live._lastSentSeq, 9);

  let resets = 0;
  const off = live.onReset(() => { resets += 1; });

  API.liveEvents.mock.mockImplementation(async () => ({
    episode_id: 'ep-new', next_seq: 1, events: [{ type: 'day.summary', seq: 1, day: 0 }],
  }));
  await live._pollEvents();
  assert.equal(resets, 1, 'the restart should reset exactly once');
  assert.equal(live._episodeId, 'ep-new', 'episode id must update immediately, not wait for the next snapshot poll');
  assert.equal(live._lastSentSeq, 1, 'the seq cursor must not carry over from the old episode');

  // a second poll under the same (new) episode must not reset again
  await live._pollEvents();
  assert.equal(resets, 1, 'no second reset while still in ep-new');
  off();
});

test('_pollSnapshot resets on an episode id change seen via /live', async (t) => {
  t.mock.method(API, 'live', async () => ({ id: 'ep-1', day: 1 }));
  await live._pollSnapshot();
  assert.equal(live._episodeId, 'ep-1');

  let resets = 0;
  const off = live.onReset(() => { resets += 1; });
  API.live.mock.mockImplementation(async () => ({ id: 'ep-2', day: 0 }));
  await live._pollSnapshot();
  assert.equal(resets, 1);
  assert.equal(live._episodeId, 'ep-2');
  off();
});
