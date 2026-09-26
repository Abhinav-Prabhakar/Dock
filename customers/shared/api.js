'use strict';
/* ============================================================
   DockAPI — the one backend client every customer page uses
   ------------------------------------------------------------
   Same-origin, always: behind nginx (docker compose, :8080) the
   API lives at /api; when the backend serves this site itself
   (:8399/customers) it lives at the root. There is no offline
   mode and no cached/mock data — if the API is down, calls
   reject and the page says so.

   Load with a classic <script src="…/shared/api.js"> before the
   page script; exposes window.DockAPI.
   ============================================================ */
(function () {
  const BASE = location.port === '8399' ? '' : '/api';

  async function call(path, opts = {}) {
    let r;
    try {
      r = await fetch(BASE + path, {
        ...opts,
        headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      });
    } catch (e) {
      throw Object.assign(new Error('Cannot reach the Dock booking service.'), { status: 0 });
    }
    let body = null;
    try { body = await r.json(); } catch (e) { /* 204 / non-JSON */ }
    if (!r.ok) {
      const d = body && body.detail;
      const msg = typeof d === 'string' ? d
        : Array.isArray(d) ? d.map(x => x.msg || JSON.stringify(x)).join('; ')
        : `Request failed (HTTP ${r.status})`;
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return body;
  }

  const post = (path, data) =>
    call(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });

  window.DockAPI = {
    base: BASE,
    ports:   () => call('/ports'),
    routes:  () => call('/routes'),
    orders:  () => call('/orders'),
    order:   id => call(`/orders/${encodeURIComponent(id)}`),
    /* price a request against the live simulation:
       -> { order, offers[], recommendation } */
    quote:   body => post('/orders', body),
    accept:  (orderId, offerId) => post(`/orders/${encodeURIComponent(orderId)}/accept`, { offer_id: offerId }),
    decline: orderId => post(`/orders/${encodeURIComponent(orderId)}/decline`),
    live:    () => call('/live'),
    /* the service network: ports + servable lanes, straight from the
       backend calibration (/ports, /routes) -> { ports[], servable{} } */
    network: async () => {
      const [ports, routes] = await Promise.all([call('/ports'), call('/routes')]);
      const servable = {};
      routes.forEach(r => { (servable[r.origin] = servable[r.origin] || []).push(r.dest); });
      return { ports, servable };
    },
  };
})();
