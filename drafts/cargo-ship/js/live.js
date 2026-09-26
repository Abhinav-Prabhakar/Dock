// Small shared poller for the live episode. No mock data, no cached fallback:
// a failed request just flips the status to {ok:false, message} and callers
// show that explicitly. Pure ES module (besides the DOM-free `fetch` calls in
// api.js), so `describeEvent` can be unit-tested in isolation.
import { API } from './api.js';

export const CUSTOMER_EVENT_TYPES = [
  'booking.decision', 'order.quoted', 'order.accepted', 'order.declined',
  'settlement.deal_registered', 'settlement.departure_recorded',
  'settlement.delivery_recorded', 'settlement.settled',
].join(',');
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
    this._resetListeners = new Set();
    this._started = false;
    // request_id -> order_id for customer bookings; settlement events carry only request_id.
    this.customerReqs = new Map();
    this._seededFor = null;
    this._lastSentSeq = 0;
    this._snapshotInFlight = false;
    this._eventsInFlight = false;
  }

  get snapshot() { return this._snapshot; }

  _resetEpisode() {
    this._afterSeq = 0;
    this._lastSentSeq = 0;
    this.customerReqs.clear();
    this._seededFor = null;
    this._resetListeners.forEach((fn) => fn());
  }

  onSnapshot(fn) {
    this._snapshotListeners.add(fn);
    if (this._snapshot) fn(this._snapshot);
    return () => this._snapshotListeners.delete(fn);
  }

  onEvents(fn) {
    this._eventListeners.add(fn);
    return () => this._eventListeners.delete(fn);
  }

  // Fired when a new live episode is detected — callers should drop any
  // state they built from the previous episode's events (e.g. the bookings
  // panel's item list) rather than mix it with the new one's.
  onReset(fn) {
    this._resetListeners.add(fn);
    return () => this._resetListeners.delete(fn);
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
    if (this._snapshotInFlight) return;    // a slow poll must not overlap the next tick
    this._snapshotInFlight = true;
    try {
      const snap = await API.live();
      if (this._episodeId && snap.id !== this._episodeId) this._resetEpisode();
      this._episodeId = snap.id;
      this._snapshot = snap;
      this._snapshotListeners.forEach((fn) => fn(snap));
      this._setStatus({ ok: true });
    } catch (e) {
      this._setStatus({ ok: false, message: e.message });
    } finally {
      this._snapshotInFlight = false;
    }
  }

  async _pollEvents() {
    if (this._eventsInFlight) return;
    this._eventsInFlight = true;
    try {
      // /live/events returns only the latest `limit` matches, so an order quoted
      // before this page opened is learned from /orders, not from the feed.
      const res = await API.liveEvents(this._afterSeq, CUSTOMER_EVENT_TYPES, 1000);
      const restarted = this._episodeId && res.episode_id && res.episode_id !== this._episodeId;
      if (restarted) {
        this._resetEpisode();
        // set immediately (not just on the next snapshot poll, up to
        // SNAPSHOT_INTERVAL_MS away) so this check doesn't keep firing —
        // and re-resetting, and re-seeding from /orders — on every events
        // poll until the snapshot poll catches up
        this._episodeId = res.episode_id;
      }
      if (res.episode_id && this._seededFor !== res.episode_id) {
        seedCustomers(await API.orders(), res.episode_id, this.customerReqs);
        this._seededFor = res.episode_id;
      }
      if (!restarted) this._afterSeq = res.next_seq ?? this._afterSeq;
      // belt-and-suspenders dedupe on top of the after_seq cursor: never
      // hand a listener the same event twice within this episode
      const fresh = (res.events || [])
        .filter((ev) => ev.seq == null || ev.seq > this._lastSentSeq);
      for (const ev of fresh) if (ev.seq != null) this._lastSentSeq = Math.max(this._lastSentSeq, ev.seq);
      if (fresh.length) this._eventListeners.forEach((fn) => fn(fresh));
      this._setStatus({ ok: true });
    } catch (e) {
      this._setStatus({ ok: false, message: e.message });
    } finally {
      this._eventsInFlight = false;
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

// Pure: remember which sim request ids are customer orders, so settlement.*
// events (request_id only) can be matched to them. order.quoted comes first;
// a counter-offer's settlement.deal_registered lands before the customer's
// booking.decision, so booking.decision alone would miss it.
export function seedCustomers(orders, episodeId, reqs) {
  for (const o of orders || []) {
    if (o.episode_id === episodeId && o.request_id != null) reqs.set(String(o.request_id), o.id);
  }
}

export function trackCustomer(ev, reqs) {
  const customer = ev.type === 'order.quoted'
    || (ev.type === 'booking.decision' && ev.source === 'customer');
  if (customer && ev.request_id != null && ev.order_id) {
    reqs.set(String(ev.request_id), ev.order_id);
  }
}

const SETTLEMENT_STEP = {
  'settlement.deal_registered': 'deal registered',
  'settlement.departure_recorded': 'departed',
  'settlement.delivery_recorded': 'delivered',
  'settlement.settled': 'settled',
};

// Pure: turn one /live/events entry into what the bookings panel shows.
// { day, text, customer, tone, card } — tone is 'booked'|'rejected'|'declined'|'order';
// text is the one-line summary, card the same facts split out for the panel's
// row layout: { title, route: [origin, dest] | null, meta, status, price }.
const perTeu = (v) => (v == null ? null : `$${Math.round(v).toLocaleString()}`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Settlement events for requests not in `reqs` (simulated cargo) return null.
export function describeEvent(ev, reqs = new Map()) {
  if (ev.type in SETTLEMENT_STEP) {
    const orderId = ev.request_id != null ? reqs.get(String(ev.request_id)) : undefined;
    if (!orderId) return null;
    const bits = [`${orderId} ${SETTLEMENT_STEP[ev.type]}`];
    if (ev.type === 'settlement.deal_registered' && ev.kind) bits.push(ev.kind);
    if (ev.type === 'settlement.settled') {
      if (ev.outcome) bits.push(ev.outcome);
      if (ev.amount_usd != null) bits.push(`$${Math.round(ev.amount_usd).toLocaleString()}`);
    }
    const settled = ev.type === 'settlement.settled';
    return {
      day: Math.floor(ev.day ?? 0), text: bits.join(' · '), customer: true, tone: 'order',
      card: {
        title: orderId, route: null, status: cap(SETTLEMENT_STEP[ev.type]),
        meta: settled ? (ev.outcome || '').replace(/_/g, ' ') : (ev.kind || '').replace(/_/g, ' '),
        price: settled && ev.amount_usd != null ? `$${Math.round(ev.amount_usd).toLocaleString()}` : null, unit: null,
      },
    };
  }
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
    const rowPrice = ev.price != null ? ev.price : ev.quoted;
    const meta = [ev.teu != null ? `${ev.teu} TEU` : null, ev.segment, tone === 'booked' && ev.kind && ev.kind !== 'accept' ? ev.kind.replace(/_/g, ' ') : null].filter(Boolean).join(' · ');
    return {
      day, text: bits.join(' · '), customer, tone,
      card: {
        title: customer && ev.order_id ? ev.order_id : null,
        route: ev.origin && ev.dest ? [ev.origin, ev.dest] : null,
        // a rejected request carries price 0 — no rate was offered, so show none
        meta, status: cap(tone), price: rowPrice > 0 ? perTeu(rowPrice) : null, unit: '/TEU',
      },
    };
  }
  if (ev.type === 'order.quoted') {
    const n = Array.isArray(ev.offers) ? ev.offers.length : 0;
    return {
      day, text: `${ev.order_id} quoted · ${n} offer${n === 1 ? '' : 's'}`, customer: true, tone: 'order',
      card: { title: ev.order_id, route: null, meta: `${n} offer${n === 1 ? '' : 's'}`, status: 'Quoted', price: null, unit: null },
    };
  }
  if (ev.type === 'order.accepted') {
    const bits = [`${ev.order_id} accepted`];
    if (ev.kind) bits.push(ev.kind);
    const price = money(ev.price_per_teu);
    if (price) bits.push(price);
    return {
      day, text: bits.join(' · '), customer: true, tone: 'order',
      card: { title: ev.order_id, route: null, meta: (ev.kind || '').replace(/_/g, ' '), status: 'Accepted', price: perTeu(ev.price_per_teu), unit: '/TEU' },
    };
  }
  if (ev.type === 'order.declined') {
    return {
      day, text: `${ev.order_id} declined`, customer: true, tone: 'order',
      card: { title: ev.order_id, route: null, meta: '', status: 'Declined', price: null, unit: null },
    };
  }
  return { day, text: ev.type, customer: false, tone: 'order', card: { title: ev.type, route: null, meta: '', status: '', price: null, unit: null } };
}
