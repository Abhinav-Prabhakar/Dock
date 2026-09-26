// Strategy comparison dialog, opened from the profit card's ▲ lift badge.
// Shows the five booking/pricing strategies the backend evaluates head to head
// (/api/compare/summary + /meta: same simulator seeds for every strategy) so
// the headline profit is read against what simpler algorithms earn on the
// identical demand. Numbers are the export's own pre-aggregated means/stds —
// nothing here is recomputed except ratios between those means.
import { API } from './api.js';
import { POLICIES } from './pages/statsLive.js';

// What each strategy does (backend/baselines/heuristics.py, rl/).
const ABOUT = {
  static:        'Flat weekly rate card, accept or reject — how the industry prices today.',
  greedy:        'Accepts anything that fits and clears a cost floor; simple counters.',
  heuristic:     'Greedy plus flex-window / alt-hub / split counter-offers and speed control.',
  heuristic_bid: 'Rule-based heuristic priced off the bid-price (opportunity cost) engine.',
  ppo:           'Reinforcement-learning policy (PPO) trained on the fleet simulator.',
};

const usd = (v) => `$${(v / 1e6).toFixed(1)}M`;
const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);
const signed = (p) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);
const arrow = (p) => (p == null ? '' : p >= 0 ? '▲' : '▼');

// Pure: summary + meta -> rows sorted by mean profit, plus ours-vs-each lifts.
export function strategyModel(summary, meta) {
  const P = summary?.policies || {};
  const rows = POLICIES.filter((p) => P[p.key]).map((p) => {
    const s = P[p.key];
    return {
      ...p, about: ABOUT[p.key] || '',
      profit: s.profit_usd.mean, sd: s.profit_usd.std,
      util: s.utilization.mean, rpt: s.revenue_per_teu.mean, co2: s.co2_per_teu.mean,
      accepted: s.accepted.mean, teu: s.teu_booked.mean,
    };
  }).sort((a, b) => b.profit - a.profit);
  const ours = rows.find((r) => r.key === 'ppo');
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  const lift = (k) => (ours && by[k] ? pct(ours.profit, by[k].profit) : null);
  const bestRule = rows.filter((r) => r.key.startsWith('heuristic')).sort((a, b) => b.profit - a.profit)[0];
  return {
    rows, ours,
    headline: [
      { label: 'vs static rate card', p: lift('static') },
      { label: 'vs simple greedy', p: lift('greedy') },
      { label: `vs best rule-based (${bestRule?.label ?? '—'})`, p: bestRule ? lift(bestRule.key) : null },
    ],
    meta: {
      episodes: meta?.episodes, days: meta?.horizon_days,
      scenarios: (meta?.scenarios || []).join(', '),
    },
  };
}

export class StrategyDialog {
  constructor(root) {
    this.root = root;
    root.addEventListener('click', (e) => { if (e.target === root || e.target.closest('[data-close]')) this.close(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) this.close(); });
  }

  get isOpen() { return this.root.classList.contains('open'); }

  async open() {
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('open'));
    this.render('<p class="sd-note">Loading the head-to-head evaluation…</p>');
    try {
      const [summary, meta] = await Promise.all([API.compare('summary'), API.compare('meta')]);
      this.render(this.body(strategyModel(summary, meta)));
    } catch (e) {
      this.render(`<p class="sd-note unavailable">Strategy comparison unavailable — ${e.message}</p>`);
    }
  }

  close() {
    this.root.classList.remove('open');
    setTimeout(() => { if (!this.isOpen) this.root.hidden = true; }, 250);
  }

  render(inner) {
    this.root.innerHTML = `<div class="sd panel" role="dialog" aria-modal="true" aria-labelledby="sd-title">
      <div class="panel-head"><span id="sd-title">Strategy comparison</span><button class="icon-btn" data-close title="Close">×</button></div>
      <div class="sd-body">${inner}</div></div>`;
  }

  body(m) {
    const max = Math.max(...m.rows.map((r) => r.profit + r.sd));
    const x = (v) => `${Math.max(0, (v / max) * 100).toFixed(2)}%`;
    const ctx = [m.meta.episodes && `${m.meta.episodes} episodes`, m.meta.days && `${m.meta.days} days each`, m.meta.scenarios].filter(Boolean).join(' · ');
    const hero = m.headline.map((h) => `<div class="sd-lift ${h.p != null && h.p < 0 ? 'neg' : ''}">
        <span>${arrow(h.p)} ${signed(h.p)}</span><label>${h.label}</label></div>`).join('');
    const bars = m.rows.map((r) => `<div class="sd-row${r.key === 'ppo' ? ' ours' : ''}">
        <div class="sd-name"><i style="background:${r.color}"></i><b>${r.label}</b><small>${r.about}</small></div>
        <div class="sd-track">
          <div class="sd-bar" style="width:${x(r.profit)};background:${r.color}"></div>
          <div class="sd-err" style="left:${x(r.profit - r.sd)};width:calc(${x(r.profit + r.sd)} - ${x(r.profit - r.sd)})"></div>
        </div>
        <div class="sd-val">${usd(r.profit)}<small>± ${usd(r.sd)}</small></div>
      </div>`).join('');
    const cell = (r, v, best) => `<td class="${best ? 'best' : ''}">${v}</td>`;
    const top = (f, dir = 1) => m.rows.reduce((a, b) => (f(b) * dir > f(a) * dir ? b : a)).key;
    const bestUtil = top((r) => r.util), bestRpt = top((r) => r.rpt), bestCo2 = top((r) => r.co2, -1);
    const table = `<table class="sd-table">
      <thead><tr><th>Strategy</th><th>Profit vs static</th><th>Utilisation</th><th>Revenue / TEU</th><th>CO₂ / TEU</th><th>Bookings</th></tr></thead>
      <tbody>${m.rows.map((r) => {
        const s = m.rows.find((q) => q.key === 'static');
        return `<tr class="${r.key === 'ppo' ? 'ours' : ''}"><td><i style="background:${r.color}"></i>${r.label}</td>
          ${cell(r, r.key === 'static' ? 'baseline' : signed(pct(r.profit, s?.profit)))}
          ${cell(r, `${Math.round(r.util * 100)}%`, r.key === bestUtil)}
          ${cell(r, `$${Math.round(r.rpt).toLocaleString()}`, r.key === bestRpt)}
          ${cell(r, `${r.co2.toFixed(2)} t`, r.key === bestCo2)}
          ${cell(r, Math.round(r.accepted).toLocaleString())}</tr>`;
      }).join('')}</tbody></table>`;
    return `
      <p class="sd-lead">Profit of the <b>Dock RL policy</b> against simpler strategies, each run on <b>identical</b> demand${ctx ? ` <span class="mut">(${ctx})</span>` : ''}.</p>
      <div class="sd-lifts">${hero}</div>
      <div class="field-label">Mean profit per episode</div>
      <div class="sd-bars">${bars}</div>
      <div class="field-label">Operating metrics</div>
      ${table}
      <p class="sd-note">Bars show the mean; the whisker spans ±1 standard deviation across episodes. With only ${m.meta.episodes ?? 'a few'} episodes, gaps smaller than a whisker are within run-to-run noise.</p>`;
  }
}
