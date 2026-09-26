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

  /* POST + text/event-stream: calls onEvent(event, data) for every event and
     resolves with the `done` payload (rejects on `error` / network failure).
     EventSource can't POST, so the stream is read by hand. */
  async function stream(path, data, onEvent) {
    let r;
    try {
      r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    } catch (e) {
      throw Object.assign(new Error('Cannot reach the Dock booking service.'), { status: 0 });
    }
    if (!r.ok || !r.body) {
      let d = null; try { d = (await r.json()).detail; } catch (e) {}
      throw Object.assign(new Error(typeof d === 'string' ? d : `Request failed (HTTP ${r.status})`), { status: r.status });
    }
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = '', done = null;
    for (;;) {
      const { value, done: end } = await rd.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', payload = null;
        block.split('\n').forEach(l => {
          if (l.startsWith('event: ')) ev = l.slice(7);
          else if (l.startsWith('data: ')) payload = JSON.parse(l.slice(6));
        });
        if (ev === 'error') throw Object.assign(new Error(payload.detail), { status: payload.status });
        if (ev === 'done') done = payload;
        else onEvent(ev, payload);
      }
    }
    if (!done) throw Object.assign(new Error('The reply was cut off.'), { status: 0 });
    return done;
  }

  const post = (path, data) =>
    call(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });

  /* port_id → flag emoji — anywhere a port is named on the customer site */
  const PORT_FLAGS = {
    CNSHA: '🇨🇳', SGSIN: '🇸🇬', KRPUS: '🇰🇷',
    NLRTM: '🇳🇱', DEHAM: '🇩🇪', BEANR: '🇧🇪',
    USLAX: '🇺🇸', USNYC: '🇺🇸',
  };

  window.DockAPI = {
    base: BASE,
    portFlag: id => PORT_FLAGS[String(id || '').toUpperCase()] || '',
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
    /* the booking-desk assistant (server-side LLM agent with order tools):
       { messages: [{role, content}] } -> { reply, actions[], orders_changed } */
    chat:       (audience, body) => post(`/chat/${encodeURIComponent(audience)}`, body),
    chatStatus: () => call('/chat/status'),
    /* streamed variant: onEvent('delta'|'reset'|'status'|'action', data) */
    chatStream: (audience, body, onEvent) => stream(`/chat/${encodeURIComponent(audience)}/stream`, body, onEvent),
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
