/* ============================================================
   ordersStore — the one piece of "live" client state in the port
   ------------------------------------------------------------
   A tiny framework-agnostic store (subscribe/getState/refetch)
   that owns the orders list fetched from /api/orders. The
   dashboard's imperative chart/register/wall code (dashboard's
   script.js, kept as-is per the port plan) subscribes to it and
   repaints in place; the Booking Desk chat (desk.js) calls
   refetch() instead of reloading the page when an order is
   quoted, booked or declined.

   Framework-agnostic on purpose: it has no React/DOM dependency
   (only `fetch`), so it is directly unit-testable with Vitest and
   directly usable from a plain <script> via window.DockOrdersStore
   (see components/StoreBootstrap.js).
   ============================================================ */

function apiBase() {
  if (typeof window === 'undefined' || !window.location) return '/api';
  return window.location.port === '8399' ? '' : '/api';
}

function freshState() {
  return { orders: [], loading: true, error: null, lastFetch: 0 };
}

export function createOrdersStore(fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  let state = freshState();
  const listeners = new Set();

  function emit() {
    listeners.forEach(fn => { try { fn(state); } catch (e) { /* listener's problem */ } });
  }

  function getState() { return state; }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function refetch() {
    if (!doFetch) throw new Error('No fetch implementation available');
    try {
      const res = await doFetch(apiBase() + '/orders', {
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      const orders = await res.json();
      state = { orders: Array.isArray(orders) ? orders : [], loading: false, error: null, lastFetch: Date.now() };
    } catch (e) {
      state = { ...state, loading: false, error: (e && e.message) || String(e) };
    }
    emit();
    return state;
  }

  let pollTimer = null;
  function startPolling(intervalMs = 15000) {
    stopPolling();
    if (typeof setInterval !== 'function') return null;
    pollTimer = setInterval(() => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (!hidden) refetch();
    }, intervalMs);
    return pollTimer;
  }
  function stopPolling() {
    if (pollTimer != null && typeof clearInterval === 'function') clearInterval(pollTimer);
    pollTimer = null;
  }

  function reset() {
    state = freshState();
    listeners.clear();
    stopPolling();
  }

  return { getState, subscribe, refetch, startPolling, stopPolling, reset };
}

/* the one store the app actually uses at runtime (client-side singleton) */
export const ordersStore = createOrdersStore();
