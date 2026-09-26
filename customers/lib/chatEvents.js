/* ============================================================
   chatEvents — pure decision logic shared by the Booking Desk
   ------------------------------------------------------------
   The Booking Desk (public/dashboard/desk.js, a classic script
   kept imperative on purpose) streams SSE events from
   POST /api/chat/customer/stream and, on certain outcomes, must
   trigger an orders refetch instead of a full page reload. This
   module holds that decision as plain, dependency-free functions
   so it can be unit-tested directly; desk.js mirrors the same
   rule (see the comment there) since it runs as a global script,
   not an ES module.
   ============================================================ */

const ORDER_RE = /\bBK-\d{3,6}-[A-Z]{2}\b/g;

/** Should a `done` payload from /chat/customer/stream trigger an orders refetch? */
export function doneTriggersRefetch(done) {
  return !!(done && done.orders_changed);
}

/** Should a single mid-stream SSE event (quote/booked/declined) trigger one? */
export function actionTriggersRefetch(eventName) {
  return eventName === 'action';
}

/** Reduce a full event/done pair into a single decision + any order ids the reply mentions. */
export function evaluateStreamOutcome({ events = [], done = null } = {}) {
  const actioned = events.some(e => actionTriggersRefetch(e.event));
  const changed = doneTriggersRefetch(done);
  const ids = new Set();
  events.forEach(e => {
    if (e.event === 'action' && e.data && e.data.order_id) ids.add(e.data.order_id);
  });
  if (done && typeof done.reply === 'string') {
    for (const m of done.reply.matchAll(ORDER_RE)) ids.add(m[0]);
  }
  return {
    shouldRefetch: actioned || changed,
    orderIds: [...ids],
  };
}

/** Extract order ids (BK-####-XX) referenced in free text, in first-seen order. */
export function extractOrderIds(text) {
  const ids = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(ORDER_RE)) {
    if (!seen.has(m[0])) { seen.add(m[0]); ids.push(m[0]); }
  }
  return ids;
}
