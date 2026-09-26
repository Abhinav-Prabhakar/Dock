'use strict';
/* ============================================================
   BOOKING DESK — the customer's LLM assistant
   ------------------------------------------------------------
   A quiet side feature: a mono tag in the corner that unfolds
   into a pinned paper slip. The desk can quote, book and decline
   through the backend (/api/chat/customer → server/assistant.py,
   which calls the same order/quote functions this dashboard
   uses); the LLM key never reaches the browser.

   The conversation lives in sessionStorage so it survives the
   page reload that refreshes the register after a booking.
   Needs shared/api.js (DockAPI) and the dashboard's .paper /
   .lbl / .rule / .chip registers.
   ============================================================ */
(function () {
  const KEY = 'ml.desk';
  const MAX_KEEP = 30;                         // turns kept in the session
  const ORDER_RE = /\bBK-\d{3,6}-[A-Z]{2}\b/g;

  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ log, open: isOpen })); } catch (e) {} };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = load();
  let log = Array.isArray(state.log) ? state.log : [];     // { role, content, actions? , err? }
  let isOpen = !!state.open;
  let busy = false;
  let live = null;                             // the reply being streamed: { content, actions, status }
  let enabled = true;

  /* ---- a tiny, safe markdown subset: paragraphs, - lists, **bold**, `code`, order ids ---- */
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(ORDER_RE, id => `<button type="button" class="oid" data-oid="${id}" title="Show ${id} on the dashboard">${id}</button>`);
  }
  function render(text) {
    const blocks = String(text).trim().split(/\n{2,}/);
    return blocks.map(b => {
      const lines = b.split('\n');
      if (lines.every(l => /^\s*([-•*]|\d+[.)])\s+/.test(l))) {
        return '<ul>' + lines.map(l => `<li>${inline(l.replace(/^\s*([-•*]|\d+[.)])\s+/, ''))}</li>`).join('') + '</ul>';
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }

  /* ---- DOM ---- */
  const tag = document.createElement('button');
  tag.type = 'button';
  tag.className = 'desk-tag';
  tag.setAttribute('aria-haspopup', 'dialog');
  tag.innerHTML = '<span class="dot" aria-hidden="true"></span>BOOKING DESK';

  const desk = document.createElement('section');
  desk.className = 'desk paper';
  desk.setAttribute('role', 'dialog');
  desk.setAttribute('aria-label', 'Booking desk assistant');
  desk.innerHTML = `
    <svg class="desk-pin" viewBox="0 0 16 16" aria-hidden="true">
      <defs><radialGradient id="deskBrass" cx=".38" cy=".3" r=".9">
        <stop offset="0" stop-color="#f3e2ae"/><stop offset=".55" stop-color="#c49a4a"/><stop offset="1" stop-color="#6f5220"/>
      </radialGradient></defs>
      <circle cx="8" cy="9" r="6" fill="rgba(58,48,32,.18)"/>
      <circle cx="8" cy="8" r="5.6" fill="url(#deskBrass)"/>
      <circle cx="6.4" cy="6.2" r="1.5" fill="rgba(255,248,220,.75)"/>
    </svg>
    <header class="desk-head">
      <div>
        <span class="lbl">MERIDIAN LINE · ASSISTANT</span>
        <div class="desk-title">Booking Desk</div>
        <div class="desk-sub">QUOTES · BOOKINGS · ORDER STATUS</div>
      </div>
      <button class="desk-x" type="button" aria-label="Close the booking desk">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
    </header>
    <div class="rule"></div>
    <div class="desk-log" aria-live="polite"></div>
    <div class="rule"></div>
    <form class="desk-form" autocomplete="off">
      <textarea class="desk-in" rows="1" maxlength="1500" placeholder="Ask about an order, or book a shipment…" aria-label="Message the booking desk"></textarea>
      <button class="chip go desk-send" type="submit">SEND&nbsp;→</button>
    </form>
    <div class="desk-foot"><span>QUOTES ARE FREE · NOTHING BOOKS WITHOUT YOUR YES</span><button type="button" class="desk-clear">CLEAR</button></div>`;

  document.body.append(desk, tag);            // tag after desk: `.desk.open ~ .desk-tag` hides it
  const $ = s => desk.querySelector(s);
  const logEl = $('.desk-log'), input = $('.desk-in'), send = $('.desk-send');

  const SUGGEST = [
    'Book 4 TEU of dry cargo, Shanghai → Rotterdam, next week',
    'Where are my containers right now?',
    'Do I have any quotes waiting on me?',
  ];

  function paint() {
    if (!log.length) {
      logEl.innerHTML = `<div class="desk-hello">
          <p><b>Good day.</b> I can price and book shipments on the Meridian fleet, and tell you where every one of your orders stands.</p>
          <div class="desk-sugg">${SUGGEST.map(s => `<button type="button" class="chip ghost" data-s="${esc(s)}">${esc(s.toUpperCase())}</button>`).join('')}</div>
        </div>`;
    } else {
      logEl.innerHTML = log.map(m => {
        const stamps = (m.actions || []).length
          ? `<div class="stamps">${m.actions.map(a => `<span class="stamp ${esc(a.kind)}">${esc(a.text)}</span>`).join('')}</div>` : '';
        const refresh = m.changed ? '<button type="button" class="desk-refresh">REFRESH THE REGISTER →</button>' : '';
        const who = m.role === 'user' ? 'YOU' : m.err ? 'DESK · NOTICE' : 'DESK';
        return `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}${m.err ? ' err' : ''}"><span class="who">${who}</span>${m.role === 'user' ? `<p>${esc(m.content).replace(/\n/g, '<br>')}</p>` : render(m.content)}${stamps}</div>${refresh}`;
      }).join('');
    }
    if (busy && live) {
      const stamps = live.actions.length
        ? `<div class="stamps">${live.actions.map(a => `<span class="stamp ${esc(a.kind)}">${esc(a.text)}</span>`).join('')}</div>` : '';
      const body = live.content
        ? render(live.content)
        : `<span class="desk-typing" aria-label="Typing"><i></i><i></i><i></i></span>${live.status ? `<span class="desk-status">${esc(live.status.toUpperCase())}…</span>` : ''}`;
      logEl.insertAdjacentHTML('beforeend', `<div class="msg bot live"><span class="who">DESK</span>${stamps}${body}</div>`);
    }
    send.disabled = busy || !enabled;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setOpen(v) {
    isOpen = v;
    desk.classList.toggle('open', v);
    tag.setAttribute('aria-expanded', String(v));
    save();
    if (v) { paint(); setTimeout(() => input.focus({ preventScroll: true }), 260); }
    else tag.focus({ preventScroll: true });
  }

  function grow() { input.style.height = 'auto'; input.style.height = Math.min(110, input.scrollHeight) + 'px'; }

  async function ask(text) {
    text = text.trim();
    if (!text || busy || !enabled) return;
    log.push({ role: 'user', content: text });
    input.value = ''; grow();
    busy = true; live = { content: '', actions: [], status: '' };
    paint(); save();
    const history = log.filter(m => !m.err).map(m => ({ role: m.role, content: m.content }));
    // repaint at most once per frame while text streams in
    let queued = false;
    const soon = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } };
    try {
      const r = await DockAPI.chatStream('customer', { messages: history.slice(-16) }, (ev, d) => {
        if (ev === 'delta') live.content += d.text;
        else if (ev === 'reset') live.content = '';
        else if (ev === 'status') live.status = d.text;
        else if (ev === 'action') live.actions.push(d);
        soon();
      });
      log.push({ role: 'assistant', content: r.reply, actions: r.actions || [], changed: !!r.orders_changed });
    } catch (e) {
      log.push({ role: 'assistant', err: true, content: e.status === 503 ? e.message : `The desk couldn't answer just now — ${e.message}` });
    }
    busy = false; live = null;
    log = log.slice(-MAX_KEEP);
    save(); paint();
  }

  /* ---- events ---- */
  tag.addEventListener('click', () => setOpen(true));
  $('.desk-x').addEventListener('click', () => setOpen(false));
  $('.desk-clear').addEventListener('click', () => { if (!busy) { log = []; save(); paint(); } });
  $('.desk-form').addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  desk.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  });
  logEl.addEventListener('click', e => {
    const s = e.target.closest('[data-s]');
    if (s) { ask(s.dataset.s); return; }
    if (e.target.closest('.desk-refresh')) { save(); location.reload(); return; }
    const o = e.target.closest('.oid');
    if (o) {
      // focus the order on the chart/register if this page already has it,
      // otherwise it's new — reload so the register picks it up
      const shown = window.DockDashboard && window.DockDashboard.focus(o.dataset.oid);
      if (!shown) { save(); location.reload(); }
    }
  });

  /* ---- availability: say so plainly if the server has no LLM configured ---- */
  DockAPI.chatStatus().then(s => {
    enabled = !!s.enabled;
    tag.classList.toggle('off', !enabled);
    if (!enabled) {
      tag.title = 'The booking desk is offline (no assistant configured on the server)';
      if (!log.length) log.push({ role: 'assistant', err: true, content: 'The booking desk is offline — the assistant isn\'t configured on the server.' });
    }
    paint();
  }).catch(() => {});

  paint();
  if (isOpen) setOpen(true);
})();
