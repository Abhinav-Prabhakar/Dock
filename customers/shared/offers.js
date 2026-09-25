'use strict';
/* ============================================================
   DockOffers — the rate-quotation slip
   ------------------------------------------------------------
   Shows what the live simulation offered for each order (one
   order per cargo kind), lets the customer accept one offer or
   decline, and stamps the result. Self-contained so any intake
   design can use it:

     <link rel="stylesheet" href="…/shared/offers.css">
     <script src="…/shared/api.js"></script>
     <script src="…/shared/offers.js"></script>

     const results = await Promise.all(bodies.map(DockAPI.quote));
     const orders  = await DockOffers.review(results);   // after "Continue"

   Each result is POST /orders' response: { order, offers[],
   recommendation }. Resolves with the final order records.
   ============================================================ */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const usd = v => '$' + Math.round(v).toLocaleString('en-US');

  const KIND = {
    accept:      'As requested',
    flex_window: 'Flexible sailing',
    alt_hub:     'Alternate port',
    split:       'Split shipment',
  };
  const WHY = {
    market_uplift:         "Priced to today's market on this lane",
    bid_price_floor:       'At our cost of carrying it on this voyage',
    competitiveness_guard: 'Capped at a competitive market rate',
  };

  function offerRow(o) {
    const pct = o.discount_pct ? ` −${Math.round(o.discount_pct * 100)}%` : '';
    const why = o.pricing && WHY[o.pricing.reason];
    return `
      <li class="dq-offer${o.recommended ? ' rec' : ''}" data-offer="${esc(o.id)}">
        <div class="dq-kind">${esc(KIND[o.kind] || o.kind)}${esc(pct)}
          ${o.recommended ? '<span class="dq-pick">Carrier’s pick</span>' : ''}</div>
        <p class="dq-sum">${esc(o.summary)}</p>
        <div class="dq-fig">
          <span class="dq-price" data-t="${esc(usd(o.price_per_teu))}">${esc(usd(o.price_per_teu))}</span>
          <span class="dq-unit">/ TEU</span>
          <span class="dq-total">${esc(usd(o.total_usd))} total</span>
        </div>
        ${why ? `<div class="dq-why">${esc(why)}</div>` : ''}
        <button class="dq-btn dq-accept" type="button">Accept</button>
      </li>`;
  }

  function orderBlock(r) {
    const o = r.order;
    const head = `
      <div class="dq-ohead">
        <b class="dq-oid">${esc(o.id)}</b>
        <span class="dq-route">${esc(o.origin)} → ${esc(o.dest)}</span>
        <span class="dq-cargo">${esc(o.teu)} TEU · ${esc((o.cargo_type || '').toUpperCase())}</span>
        <span class="dq-stamp" hidden></span>
      </div>`;
    const offers = r.offers || [];
    const body = offers.length
      ? `<ol class="dq-offers">${offers.map(offerRow).join('')}</ol>
         <div class="dq-actions"><button class="dq-btn ghost dq-decline" type="button">Decline all</button></div>`
      : `<p class="dq-none">${esc((r.recommendation && r.recommendation.label) ||
           'No sailing in this window clears the cost of the space.')}</p>`;
    return `<article class="dq-order" data-order="${esc(o.id)}">${head}${body}
              <p class="dq-msg" role="status" hidden></p></article>`;
  }

  function stamp(el, text, tone) {
    const s = el.querySelector('.dq-stamp');
    s.textContent = text;
    s.className = `dq-stamp ${tone}`;
    s.hidden = false;
    el.classList.add('done');
    el.querySelectorAll('button').forEach(b => { b.disabled = true; });
  }

  function review(results, opts = {}) {
    const api = opts.api || window.DockAPI;
    const state = new Map(results.map(r => [r.order.id, r.order]));
    const open = new Set(results.filter(r => (r.offers || []).length).map(r => r.order.id));

    const veil = document.createElement('div');
    veil.className = 'dq-veil';
    veil.innerHTML = `
      <section class="dq-slip" role="dialog" aria-modal="true" aria-labelledby="dq-title">
        <header class="dq-head">
          <div class="dq-eyebrow">Meridian Line · Rate quotation</div>
          <h2 class="dq-title" id="dq-title">Your quote</h2>
          <p class="dq-sub">Priced live against the fleet’s current bookings · valid for 15 minutes</p>
        </header>
        <div class="dq-orders">${results.map(orderBlock).join('')}</div>
        <footer class="dq-foot">
          <span class="dq-note"></span>
          <button class="dq-btn go dq-continue" type="button">Continue to dashboard →</button>
        </footer>
      </section>`;
    document.body.appendChild(veil);
    requestAnimationFrame(() => veil.classList.add('on'));

    results.forEach(r => {
      if (!(r.offers || []).length) stamp(veil.querySelector(`[data-order="${r.order.id}"]`), 'No offer', 'terra');
    });
    const note = veil.querySelector('.dq-note');
    const sync = () => {
      note.textContent = open.size
        ? `${open.size} order${open.size > 1 ? 's' : ''} awaiting your decision`
        : 'All set';
    };
    sync();

    const fail = (el, err) => {
      const m = el.querySelector('.dq-msg');
      m.textContent = err.message;
      m.hidden = false;
      el.querySelectorAll('button').forEach(b => { b.disabled = false; });
    };

    veil.addEventListener('click', async e => {
      const el = e.target.closest('.dq-order');
      if (!el || el.classList.contains('done')) return;
      const id = el.dataset.order;
      if (e.target.closest('.dq-accept')) {
        const row = e.target.closest('.dq-offer');
        el.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
          const res = await api.accept(id, row.dataset.offer);
          state.set(id, res.order);
          row.classList.add('chosen');
          stamp(el, 'Confirmed', 'sage');
          open.delete(id);
        } catch (err) {
          fail(el, err);
          if (err.status === 409) { stamp(el, 'Expired', 'terra'); open.delete(id); }
        }
      } else if (e.target.closest('.dq-decline')) {
        el.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
          const res = await api.decline(id);
          state.set(id, res.order);
          stamp(el, 'Declined', 'terra');
          open.delete(id);
        } catch (err) { fail(el, err); }
      }
      sync();
    });

    return new Promise(resolve => {
      veil.querySelector('.dq-continue').addEventListener('click', () => {
        veil.classList.remove('on');
        setTimeout(() => veil.remove(), 260);
        resolve([...state.values()]);   // undecided orders stay QUOTED on the dashboard
      });
    });
  }

  window.DockOffers = { review };
})();
