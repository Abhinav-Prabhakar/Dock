import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOrdersStore } from '../lib/ordersStore.js';

function mockFetch(sequence) {
  let i = 0;
  return vi.fn(async () => {
    const next = sequence[Math.min(i, sequence.length - 1)];
    i++;
    if (next.error) throw new Error(next.error);
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.body,
    };
  });
}

describe('ordersStore', () => {
  it('starts in a loading state with no orders', () => {
    const store = createOrdersStore(mockFetch([{ body: [] }]));
    expect(store.getState()).toEqual({ orders: [], loading: true, error: null, lastFetch: 0 });
  });

  it('refetch() populates orders and flips loading off', async () => {
    const orders = [{ id: 'BK-1000-TC' }, { id: 'BK-1001-TC' }];
    const store = createOrdersStore(mockFetch([{ body: orders }]));
    const state = await store.refetch();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.orders).toEqual(orders);
    expect(store.getState().orders).toEqual(orders);
  });

  it('notifies subscribers on every refetch', async () => {
    const store = createOrdersStore(mockFetch([{ body: [{ id: 'A' }] }, { body: [{ id: 'A' }, { id: 'B' }] }]));
    const seen = [];
    store.subscribe(s => seen.push(s.orders.length));
    await store.refetch();
    await store.refetch();
    expect(seen).toEqual([1, 2]);
  });

  it('unsubscribe stops further notifications', async () => {
    const store = createOrdersStore(mockFetch([{ body: [] }, { body: [{ id: 'A' }] }]));
    const seen = [];
    const unsub = store.subscribe(s => seen.push(s));
    await store.refetch();
    unsub();
    await store.refetch();
    expect(seen.length).toBe(1);
  });

  it('a failed refetch sets error and keeps loading false without throwing', async () => {
    const store = createOrdersStore(mockFetch([{ error: 'network down' }]));
    const state = await store.refetch();
    expect(state.loading).toBe(false);
    expect(state.error).toMatch(/network down/);
  });

  it('a non-2xx response becomes a readable error, not a thrown rejection', async () => {
    const store = createOrdersStore(mockFetch([{ ok: false, status: 503, body: null }]));
    const state = await store.refetch();
    expect(state.error).toMatch(/503/);
  });

  it('new order ids appearing between refetches are detectable by the caller', async () => {
    const store = createOrdersStore(mockFetch([
      { body: [{ id: 'BK-1-TC' }] },
      { body: [{ id: 'BK-1-TC' }, { id: 'BK-2-TC' }] },
    ]));
    await store.refetch();
    const before = new Set(store.getState().orders.map(o => o.id));
    await store.refetch();
    const after = store.getState().orders.map(o => o.id);
    const added = after.filter(id => !before.has(id));
    expect(added).toEqual(['BK-2-TC']);
  });

  it('startPolling schedules refetch on an interval and stopPolling cancels it', async () => {
    vi.useFakeTimers();
    const fetchImpl = mockFetch([{ body: [] }, { body: [{ id: 'A' }] }, { body: [{ id: 'A' }, { id: 'B' }] }]);
    const store = createOrdersStore(fetchImpl);
    await store.refetch(); // baseline call so we can count polling calls cleanly
    const callsBefore = fetchImpl.mock.calls.length;
    store.startPolling(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl.mock.calls.length).toBe(callsBefore + 1);
    store.stopPolling();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl.mock.calls.length).toBe(callsBefore + 1);
    vi.useRealTimers();
  });
});
