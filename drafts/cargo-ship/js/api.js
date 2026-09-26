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
  compare:       (name) => api(`/compare/${name}`),   // summary | timeline | offers | shock | meta
};
