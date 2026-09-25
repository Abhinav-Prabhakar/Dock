// Small shared poller for the live episode. No mock data, no cached fallback:
// a failed request just flips the status to {ok:false, message} and callers
// show that explicitly. Pure ES module (besides the DOM-free `fetch` calls in
// api.js), so `describeEvent` can be unit-tested in isolation.
import { API } from './api.js';

const CUSTOMER_EVENT_TYPES = 'booking.decision,order.quoted,order.accepted,order.declined';
const SNAPSHOT_INTERVAL_MS = 3000;
const EVENTS_INTERVAL_MS = 2000;

function sameStatus(a, b) {
  if (!a || !b) return false;
  return a.ok === b.ok && a.message === b.message;
}

class Live {
  constructor() {
    this._snapshot = null;
    this._episodeId = null;
    this._afterSeq = 0;
    this._status = null;
    this._snapshotListeners = new Set();
    this._eventListeners = new Set();
    this._statusListeners = new Set();
    this._started = false;
  }

  get snapshot() { return this._snapshot; }

  onSnapshot(fn) {
    this._snapshotListeners.add(fn);
    if (this._snapshot) fn(this._snapshot);
    return () => this._snapshotListeners.delete(fn);
  }

  onEvents(fn) {
    this._eventListeners.add(fn);
    return () => this._eventListeners.delete(fn);
  }

  onStatus(fn) {
    this._statusListeners.add(fn);
    if (this._status) fn(this._status);
    return () => this._statusListeners.delete(fn);
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._pollSnapshot();
    this._pollEvents();
    setInterval(() => this._pollSnapshot(), SNAPSHOT_INTERVAL_MS);
    setInterval(() => this._pollEvents(), EVENTS_INTERVAL_MS);
  }

  async _pollSnapshot() {
    try {
      const snap = await API.live();
      if (this._episodeId && snap.id !== this._episodeId) this._afterSeq = 0;
      this._episodeId = snap.id;
      this._snapshot = snap;
      this._snapshotListeners.forEach((fn) => fn(snap));
      this._setStatus({ ok: true });
    } catch (e) {
      this._setStatus({ ok: false, message: e.message });
    }
  }

  async _pollEvents() {
    try {
      const res = await API.liveEvents(this._afterSeq, CUSTOMER_EVENT_TYPES, 200);
      if (this._episodeId && res.episode_id && res.episode_id !== this._episodeId) {
        this._afterSeq = 0;
      } else {
        this._afterSeq = res.next_seq ?? this._afterSeq;
      }
      if (res.events && res.events.length) this._eventListeners.forEach((fn) => fn(res.events));
      this._setStatus({ ok: true });
    } catch (e) {
      this._setStatus({ ok: false, message: e.message });
    }
  }

  _setStatus(s) {
    if (sameStatus(this._status, s)) return;
    this._status = s;
    this._statusListeners.forEach((fn) => fn(s));
  }
}

export const live = new Live();

/* ------------------------------------------------------------------ describeEvent */

const money = (v) => (v == null ? null : `$${Math.round(v).toLocaleString()}/TEU`);

// Pure: turn one /live/events entry into what the bookings panel shows.
// { day, text, customer, tone } — tone is 'booked'|'rejected'|'declined'|'order'.
export function describeEvent(ev) {
  const day = Math.floor(ev.day ?? 0);
  if (ev.type === 'booking.decision') {
    const customer = ev.source === 'customer';
    const bits = [];
    if (ev.origin && ev.dest) bits.push(`${ev.origin}→${ev.dest}`);
    if (ev.teu != null) bits.push(`${ev.teu} TEU`);
    if (ev.segment) bits.push(ev.segment);
    let tone = 'rejected';
    if (ev.outcome === 'booked') tone = 'booked';
    else if (ev.outcome === 'declined' || ev.outcome === 'counter_declined') tone = 'declined';
    bits.push(tone === 'booked' ? `booked${ev.kind ? ` · ${ev.kind}` : ''}` : tone === 'declined' ? 'declined' : 'rejected');
    const price = money(ev.price != null ? ev.price : ev.quoted);
    if (price) bits.push(price);
    return { day, text: bits.join(' · '), customer, tone };
  }
  if (ev.type === 'order.quoted') {
    const n = Array.isArray(ev.offers) ? ev.offers.length : 0;
    return { day, text: `${ev.order_id} quoted · ${n} offer${n === 1 ? '' : 's'}`, customer: true, tone: 'order' };
  }
  if (ev.type === 'order.accepted') {
    const bits = [`${ev.order_id} accepted`];
    if (ev.kind) bits.push(ev.kind);
    const price = money(ev.price_per_teu);
    if (price) bits.push(price);
    return { day, text: bits.join(' · '), customer: true, tone: 'order' };
  }
  if (ev.type === 'order.declined') {
    return { day, text: `${ev.order_id} declined`, customer: true, tone: 'order' };
  }
  return { day, text: ev.type, customer: false, tone: 'order' };
}
