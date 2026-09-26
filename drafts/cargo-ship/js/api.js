// The operator console's one backend client. Always same-origin: nginx serves
// this site at / and proxies the API at /api (docker compose). No mock data,
// no cached fallback — a failed call rejects with the API's own message, and
// the caller shows an explicit "unavailable" state.
//
// Pure ES module with no DOM use, so the data adapters built on it can be
// unit-tested in Node (set globalThis.DOCK_API_BASE to an absolute URL there).

const base = () => globalThis.DOCK_API_BASE ?? '/api';

export async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(base() + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
  } catch (e) {
    throw Object.assign(new Error('Cannot reach the Dock backend.'), { status: 0 });
  }
  let body = null;
  try { body = await r.json(); } catch (e) { /* empty / non-JSON */ }
  if (!r.ok) {
    const d = body && body.detail;
    const msg = typeof d === 'string' ? d
      : Array.isArray(d) ? d.map((x) => x.msg || JSON.stringify(x)).join('; ')
      : `Request failed (HTTP ${r.status})`;
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return body;
}

// POST + text/event-stream (EventSource can't POST): onEvent(event, data) per
// event; resolves with the `done` payload, rejects on `error`.
export async function stream(path, data, onEvent) {
  let r;
  try {
    r = await fetch(base() + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  } catch (e) {
    throw Object.assign(new Error('Cannot reach the Dock backend.'), { status: 0 });
  }
  if (!r.ok || !r.body) {
    let d = null; try { d = (await r.json()).detail; } catch (e) { /* non-JSON */ }
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
      for (const l of block.split('\n')) {
        if (l.startsWith('event: ')) ev = l.slice(7);
        else if (l.startsWith('data: ')) payload = JSON.parse(l.slice(6));
      }
      if (ev === 'error') throw Object.assign(new Error(payload.detail), { status: payload.status });
      if (ev === 'done') done = payload; else onEvent(ev, payload);
    }
  }
  if (!done) throw Object.assign(new Error('The reply was cut off.'), { status: 0 });
  return done;
}

export const API = {
  live:          () => api('/live'),
  liveEvents:    (afterSeq = 0, types = null, limit = 200) =>
    api(`/live/events?after_seq=${afterSeq}&limit=${limit}${types ? `&types=${encodeURIComponent(types)}` : ''}`),
  livePolicy:    (limit = 20) => api(`/live/policy?limit=${limit}`),
  policyNetwork: () => api('/live/policy/network'),
  stowage:       (vesselId) => api(`/live/vessels/${encodeURIComponent(vesselId)}/stowage`),
  vessels:       () => api('/vessels'),
  ports:         () => api('/ports'),
  routes:        () => api('/routes'),
  orders:        () => api('/orders'),
  compare:       (name) => api(`/compare/${name}`),   // summary | timeline | offers | meta
  // operations copilot (server-side LLM agent, read-only tools): -> { reply, actions[] }
  chat:          (body) => api('/chat/operator', { method: 'POST', body: JSON.stringify(body) }),
  chatStatus:    () => api('/chat/status'),
  chatStream:    (body, onEvent) => stream('/chat/operator/stream', body, onEvent),
};
