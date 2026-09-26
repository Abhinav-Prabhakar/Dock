// Operations copilot — a small LLM chat on the stowage screen (side feature).
// Collapsed it's a single cream-glass pill above the timeline dock; expanded
// it's an .lpanel in the same light "paper" grammar as the rest of the screen
// (micro-labels, ink text, solid-ink primary, blue for the operator's own
// accent). Answers come from /api/chat/operator (server/assistant.py): a
// read-only agent over the live stowage, fleet, bookings and strategy data.
// The key stays on the server; the conversation lives in sessionStorage.
import { API } from './api.js';

const KEY = 'dock.copilot';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Minimal, safe markdown: paragraphs, "-" / "1." lists, **bold**, `code`.
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
}
export function renderReply(text) {
  return String(text).trim().split(/\n{2,}/).map((b) => {
    const lines = b.split('\n');
    const item = /^\s*([-•*]|\d+[.)])\s+/;
    if (lines.every((l) => item.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(item, ''))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

const ICON = {
  spark: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>',
  close: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export class Copilot {
  // root: the stowage screen's .stow-ui; getContext() -> { vessel_id, vessel_name, row }
  constructor(root, getContext) {
    this.getContext = getContext;
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch (e) { /* private mode */ }
    this.log = Array.isArray(saved.log) ? saved.log : [];
    this.busy = false;
    this.enabled = true;

    const el = document.createElement('div');
    el.className = 'copilot';
    el.innerHTML = `
      <button class="cp-pill lpanel" type="button" aria-haspopup="dialog" title="Ask the operations copilot">
        ${ICON.spark}<span>Copilot</span><kbd>/</kbd>
      </button>
      <section class="cp-panel lpanel" role="dialog" aria-label="Operations copilot" hidden>
        <div class="cp-head">
          <span class="cp-title">${ICON.spark}Copilot</span>
          <span class="cp-ctx" data-k="ctx"></span>
          <button class="cp-x" type="button" title="Close (Esc)" aria-label="Close the copilot">${ICON.close}</button>
        </div>
        <div class="cp-log" aria-live="polite"></div>
        <form class="cp-form" autocomplete="off">
          <textarea rows="1" maxlength="1500" placeholder="Ask about this ship, the fleet or bookings…" aria-label="Message the copilot"></textarea>
          <button class="cp-send" type="submit" title="Send (Enter)" aria-label="Send">${ICON.send}</button>
        </form>
        <div class="cp-foot"><span>Read-only · live simulation data</span><button type="button" data-a="clear">Clear</button></div>
      </section>`;
    root.appendChild(el);
    this.el = el;
    this.pill = el.querySelector('.cp-pill');
    this.panel = el.querySelector('.cp-panel');
    this.logEl = el.querySelector('.cp-log');
    this.input = el.querySelector('textarea');
    this.sendBtn = el.querySelector('.cp-send');

    this.pill.onclick = () => this.open();
    el.querySelector('.cp-x').onclick = () => this.close();
    el.querySelector('[data-a="clear"]').onclick = () => { if (!this.busy) { this.log = []; this.save(); this.paint(); } };
    el.querySelector('.cp-form').onsubmit = (e) => { e.preventDefault(); this.ask(this.input.value); };
    this.input.addEventListener('input', () => this.grow());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.ask(this.input.value); }
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
    });
    this.logEl.addEventListener('click', (e) => { const s = e.target.closest('[data-s]'); if (s) this.ask(s.dataset.s); });
    // Esc inside the panel closes the copilot, not the stowage screen
    this.panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
    // "/" opens the copilot while the stowage screen is up (never while typing elsewhere)
    window.addEventListener('keydown', (e) => {
      if (e.key !== '/' || !root.closest('.stowage.active') || this.isOpen) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      e.preventDefault(); this.open();
    });

    API.chatStatus().then((s) => {
      this.enabled = !!s.enabled;
      this.pill.classList.toggle('off', !this.enabled);
      if (!this.enabled) this.pill.title = 'Copilot offline — no assistant configured on the server';
      this.paint();
    }).catch(() => {});
    this.paint();
    if (saved.open) this.open(false);
  }

  get isOpen() { return !this.panel.hidden; }

  save() {
    try { sessionStorage.setItem(KEY, JSON.stringify({ log: this.log.slice(-30), open: this.isOpen })); } catch (e) { /* ignore */ }
  }

  // sit just above the timeline dock, whatever height it has at this viewport
  place() {
    const dock = this.el.parentElement.querySelector('.stow-dock');
    const h = dock ? dock.getBoundingClientRect().height : 150;
    this.el.style.setProperty('--dock-h', `${Math.round(h)}px`);
  }

  open(focus = true) {
    this.place();
    this.panel.hidden = false;
    this.el.classList.add('open');
    requestAnimationFrame(() => this.panel.classList.add('in'));
    this.paint();
    this.save();
    if (focus) setTimeout(() => this.input.focus({ preventScroll: true }), 200);
  }

  close() {
    this.panel.classList.remove('in');
    this.el.classList.remove('open');
    setTimeout(() => { if (!this.el.classList.contains('open')) this.panel.hidden = true; this.save(); }, 220);
    this.pill.focus({ preventScroll: true });
  }

  grow() { const t = this.input; t.style.height = 'auto'; t.style.height = `${Math.min(96, t.scrollHeight)}px`; }

  paint() {
    const ctx = this.getContext();
    this.el.querySelector('[data-k="ctx"]').textContent = [ctx.vessel_name || ctx.vessel_id, ctx.row != null ? `row ${String(ctx.row).padStart(2, '0')}` : null].filter(Boolean).join(' · ');
    if (!this.log.length) {
      const sugg = ['Summarise what is aboard this ship', 'Which port discharges the most here next?', 'How is the pricing policy doing today?'];
      this.logEl.innerHTML = `<div class="cp-hello">
          <p>${this.enabled ? 'Ask about stowage, the fleet, bookings or pricing — answers come from the live simulation.' : 'The copilot is offline: no assistant is configured on the server.'}</p>
          ${this.enabled ? `<div class="cp-sugg">${sugg.map((s) => `<button type="button" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
        </div>`;
    } else {
      this.logEl.innerHTML = this.log.map((m) => m.role === 'user'
        ? `<div class="cp-msg me">${esc(m.content).replace(/\n/g, '<br>')}</div>`
        : `<div class="cp-msg bot${m.err ? ' err' : ''}">${m.err ? esc(m.content) : renderReply(m.content)}</div>`).join('');
    }
    if (this.busy && this.live) {
      const l = this.live;
      const body = l.content ? renderReply(l.content)
        : `<span class="cp-typing" aria-label="Thinking"><i></i><i></i><i></i></span>${l.status ? `<span class="cp-status">${esc(l.status)}…</span>` : ''}`;
      this.logEl.insertAdjacentHTML('beforeend', `<div class="cp-msg bot live">${body}</div>`);
    }
    this.sendBtn.disabled = this.busy || !this.enabled;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  async ask(text) {
    text = text.trim();
    if (!text || this.busy || !this.enabled) return;
    this.log.push({ role: 'user', content: text });
    this.input.value = ''; this.grow();
    this.busy = true; this.live = { content: '', status: '' };
    this.paint(); this.save();
    const ctx = this.getContext();
    const messages = this.log.filter((m) => !m.err).slice(-16).map((m) => ({ role: m.role, content: m.content }));
    let queued = false;                           // repaint at most once per frame while streaming
    const soon = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; this.paint(); }); } };
    try {
      const r = await API.chatStream({ messages, context: { vessel_id: ctx.vessel_id, row: ctx.row } }, (ev, d) => {
        if (ev === 'delta') this.live.content += d.text;
        else if (ev === 'reset') this.live.content = '';
        else if (ev === 'status') this.live.status = d.text;
        soon();
      });
      this.log.push({ role: 'assistant', content: r.reply });
    } catch (e) {
      this.log.push({ role: 'assistant', err: true, content: e.status === 503 ? e.message : `Copilot unavailable — ${e.message}` });
    }
    this.busy = false; this.live = null;
    this.log = this.log.slice(-30);
    this.save(); this.paint();
  }
}
