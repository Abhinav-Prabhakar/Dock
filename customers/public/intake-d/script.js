'use strict';
/* ============================================================
   MERIDIAN LINE — intake-d · THE ITINERARY STRIP
   ------------------------------------------------------------
   A boarding-pass strip pinned to the wall. The booking assembles
   left to right along a dashed route spine: ORIGIN datestamp →
   punched cargo-kind circles → stamped departure day-tiles →
   ARRIVAL datestamp. A small sage seal-dot travels the spine and
   stamps each leg's header as that section fills. The stub row
   carries the service-segment ticket punches + the CONFIRM seal.
   Confirm prices one order per cargo kind live (DockAPI.quote) and
   opens the rate-quotation slip (DockOffers.review).
   ============================================================ */

const DASH = '../dashboard/';

/* ----------------------------- helpers ----------------------------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const easeIO = k => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ==================== SERVICE NETWORK ==================== */
/* ports, coordinates and servable lanes come from the backend
   (DockAPI.network()) before the strip paints — nothing embedded */
const PORT_G = {};
/* servable OD pairs — destination lane is filtered by origin */
const PAIRS = {};
const D2R_ = Math.PI / 180;
function nmOf(a, b) {
  const A = PORT_G[a], B = PORT_G[b];
  if (!A || !B) return null;
  const la1 = A.lat * D2R_, la2 = B.lat * D2R_;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin(((B.lon - A.lon) * D2R_) / 2) ** 2;
  return Math.round(3440.065 * 2 * Math.asin(Math.sqrt(h)));
}
const dstFor = oc => (PAIRS[oc] || []).slice();
const servable = (o, d) => (PAIRS[o] || []).includes(d);

async function loadNetwork() {
  const net = await DockAPI.network();
  net.ports.forEach(p => {
    PORT_G[p.port_id] = { n: String(p.name).split('/')[0].trim().toUpperCase(),
                          lat: p.lat, lon: p.lon };
  });
  Object.assign(PAIRS, net.servable);
}

/* ==================== STATE ==================== */
const S = {
  origin: 'SGSIN',
  dest:   'NLRTM',
  kinds:  [{ type: 'dry', teu: 6, wt: 66.0, wset: false }],
  depDay: 3,
  flex:   2,
  segment: 'standard',
  busy:   false,
};
const KIND_ORDER = ['dry', 'reefer', 'hazmat'];
const KIND_NAME  = { dry: 'DRY', reefer: 'REEFER', hazmat: 'HAZMAT' };
const KIND_SHORT = { dry: 'DRY', reefer: 'RFR', hazmat: 'HZ' };
const DAY_TILES  = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const SEGS = [
  { k: 'flexible', t: 'FLEXIBLE' },
  { k: 'standard', t: 'STANDARD' },
  { k: 'urgent',   t: 'URGENT' },
];

/* seeded strip number + tile tilts — same print every load */
const SR = mulberry(20250914);
const STRIP_NO = 2400 + ((SR() * 90) | 0);
const DT_ROT = DAY_TILES.map(() => (SR() * 3.6 - 1.8).toFixed(2) + 'deg');
$('stripNo').textContent = `ITINERARY · STRIP ${STRIP_NO}`;

/* ==================== GLYPHS ==================== */
const GLYPH = {
  dry: `<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="3.4" width="11" height="7.6" rx="1"
      fill="none" stroke="currentColor" stroke-width="1.2"/>
      <path d="M4.6 3.4v7.6M7 3.4v7.6M9.4 3.4v7.6" stroke="currentColor" stroke-width=".7" fill="none"/></svg>`,
  reefer: `<svg viewBox="0 0 14 14" aria-hidden="true"><g stroke="currentColor" stroke-width="1.1"
      stroke-linecap="round" fill="none">
      <path d="M7 1.6v10.8M1.9 4.3l10.2 5.4M1.9 9.7l10.2-5.4"/>
      <path d="M7 1.6l-1.5 1.6M7 1.6l1.5 1.6M7 12.4l-1.5-1.6M7 12.4l1.5-1.6" stroke-width=".9"/></g></svg>`,
  hazmat: `<svg viewBox="0 0 14 14" aria-hidden="true"><g fill="currentColor">
      <ellipse cx="7" cy="4.5" rx="1.8" ry="3"/>
      <ellipse cx="7" cy="4.5" rx="1.8" ry="3" transform="rotate(120 7 7)"/>
      <ellipse cx="7" cy="4.5" rx="1.8" ry="3" transform="rotate(240 7 7)"/>
      <circle cx="7" cy="7" r="1.4" fill="#f4f0e4"/><circle cx="7" cy="7" r=".8"/></g></svg>`,
};

/* ==================== STAMP ART ==================== */
/* circular port datestamp — same register as the ledger stamps:
   outer + double inner rings, sep dots, curved city / role text,
   big serif code, ghost misregistration ring in the other ink.   */
function portStampSVG(u) {
  return `<svg viewBox="0 0 108 108" aria-hidden="true">
    <defs>
      <path id="pcT${u}" d="M 27 55 A 27 27 0 0 1 81 55"/>
      <path id="pcB${u}" d="M 22 55 A 32 32 0 0 0 86 55"/>
    </defs>
    <g class="ps-g" id="psG${u}" filter="url(#stampInk)">
      <circle class="ps-ghost" cx="55.4" cy="54.9" r="44"/>
      <circle class="ps-out" cx="54" cy="54" r="44"/>
      <circle class="ps-in" cx="54" cy="54" r="39"/>
      <circle class="ps-in" cx="54" cy="54" r="21"/>
      <circle class="ps-sep" cx="13" cy="54" r="1.4"/>
      <circle class="ps-sep" cx="95" cy="54" r="1.4"/>
      <text class="ps-city"><textPath href="#pcT${u}" startOffset="50%" text-anchor="middle" id="pcCity${u}">—</textPath></text>
      <text class="ps-role"><textPath href="#pcB${u}" startOffset="50%" text-anchor="middle">${u === 'a' ? 'ORIGIN' : 'DESTINATION'}</textPath></text>
      <text class="ps-code" id="pcCode${u}" x="54" y="52.5" text-anchor="middle">—</text>
      <text class="ps-date" id="pcDate${u}" x="54" y="62" text-anchor="middle">—</text>
    </g>
  </svg>`;
}
/* rectangular check-stamp slammed onto a failing leg */
const holdSVG = () => `<svg viewBox="0 0 62 24" aria-hidden="true">
  <g filter="url(#inkD)" fill="none" stroke="currentColor">
    <rect x="2" y="2.5" width="58" height="19" rx="2" stroke-width="1.7"/>
    <rect x="4.8" y="5.2" width="52.4" height="13.6" rx="1.2" stroke-width=".7" opacity=".8"/>
    <text x="31" y="15.6" text-anchor="middle" stroke="none" fill="currentColor"
      font-family="ui-monospace,SF Mono,Menlo,monospace" font-size="7.4" font-weight="700"
      letter-spacing="2.6">CHECK</text>
  </g></svg>`;
/* sage seal that lands on a completed section header */
const okmSVG = () => `<svg viewBox="0 0 16 16" aria-hidden="true">
  <g filter="url(#stampInk)">
    <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </g></svg>`;
/* stamped note mark — HOLD (terracotta) / FILED (sage) */
const noteStampSVG = (txt, ink) => `<svg viewBox="0 0 58 22" aria-hidden="true">
  <g filter="url(#inkD)" fill="none" stroke="${ink}">
    <rect x="2" y="2.5" width="54" height="17" rx="1.8" stroke-width="1.6"/>
    <rect x="4.6" y="5" width="48.8" height="12" rx="1" stroke-width=".6" opacity=".8"/>
    <text x="29" y="14.4" text-anchor="middle" stroke="none" fill="${ink}"
      font-family="ui-monospace,SF Mono,Menlo,monospace" font-size="6.8" font-weight="700"
      letter-spacing="2.2">${txt}</text>
  </g></svg>`;
/* the big CONFIRM seal */
const confirmSVG = label => `<svg viewBox="0 0 126 48" aria-hidden="true">
  <g class="cs-g" id="csG" filter="url(#stampInk)">
    <rect x="5" y="7" width="116" height="34" rx="3" fill="none" stroke="currentColor" stroke-width="2.2"/>
    <rect x="9" y="11" width="108" height="26" rx="1.8" fill="none" stroke="currentColor" stroke-width=".8" opacity=".85"/>
    <text x="63" y="27.5" text-anchor="middle" font-family="ui-monospace,SF Mono,Menlo,monospace"
      font-size="9.4" font-weight="700" letter-spacing="3" fill="currentColor">${label}</text>
    <text x="63" y="35" text-anchor="middle" font-family="ui-monospace,SF Mono,Menlo,monospace"
      font-size="4.6" font-weight="700" letter-spacing="1.3" fill="currentColor" opacity=".85">MERIDIAN LINE · STRIP ${STRIP_NO}</text>
  </g></svg>`;

/* ==================== DOM ==================== */
const journeyEl = $('journey'), spineEl = $('spine'), spine2 = $('spine2');
const stampA = $('stampA'), stampB = $('stampB');
const punchRow = $('punchRow'), dayRow = $('dayRow');
const flexNum = $('flexNum'), flexVal = $('flexVal');
const segRow = $('segRow'), ledgEl = $('ledg');
const confirmBtn = $('confirmBtn'), noteEl = $('note'), popEl = $('pop');
const LEGS = { a: $('legA'), b: $('legB'), c: $('legC'), d: $('legD') };

stampA.innerHTML = portStampSVG('a');
stampB.innerHTML = portStampSVG('b');
confirmBtn.innerHTML = confirmSVG('CONFIRM');
document.querySelectorAll('.okm').forEach(el => { el.innerHTML = okmSVG(); });
Object.values(LEGS).forEach(leg => {
  const h = document.createElement('span');
  h.className = 'hold'; h.setAttribute('aria-hidden', 'true');
  h.innerHTML = holdSVG();
  leg.appendChild(h);
});

/* ==================== THE SPINE + SEAL DOT ==================== */
/* One dashed sage leg runs the length of the strip behind the
   stamps, punches and tiles; a faint terracotta alternate arc
   floats above it like the badge's hub map. The seal-dot rides
   the line and stamps each leg's header as that leg fills.      */
let GATES = { a: 0, b: 0, c: 0, d: 0 };
let spY = 0, dotRAF = 0, dotX = 0;

function layoutSpine() {
  const jr = journeyEl.getBoundingClientRect();
  const aR = stampA.getBoundingClientRect();
  const dR = stampB.getBoundingClientRect();
  const lane = LEGS.a.querySelector('.lane').getBoundingClientRect();
  spY = lane.top + lane.height / 2 - jr.top;
  /* the route kisses the stamp rings, never crosses the ink */
  const x0 = aR.left + aR.width - jr.left - 5;
  const x4 = dR.left - jr.left + 5;
  /* gates sit on the perforation seams — the dot stays visible */
  const perfs = journeyEl.querySelectorAll('.perf');
  const pcx = p => { const r = p.getBoundingClientRect(); return r.left + r.width / 2 - jr.left; };
  GATES = { a: x0, b: pcx(perfs[1]), c: pcx(perfs[2]), d: x4 };
  const W = jr.width, H = jr.height;
  const dx = x4 - x0;
  spineEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  spineEl.innerHTML = `
    <defs><marker id="spMk" viewBox="0 0 6 6" refX="5" refY="3"
      markerWidth="4.4" markerHeight="4.4" orient="auto">
      <path d="M0 .5 L5.6 3 L0 5.5 z" fill="#3a5a44"/></marker></defs>
    <path class="sp-alt" d="M ${x0} ${spY} C ${x0 + dx * .3} ${spY - 46}, ${x4 - dx * .3} ${spY - 46}, ${x4} ${spY}"/>
    <path class="sp-route" id="spRoute" d="M ${x0} ${spY} H ${x4}" marker-end="url(#spMk)"/>`;
  spine2.setAttribute('viewBox', `0 0 ${W} ${H}`);
  spine2.innerHTML = `<g id="spDotG"><circle class="sp-halo" r="6.6"/><circle class="sp-dot" r="3.6"/></g>`;
  dotSet(dotX || x0);
  if (!dotX) dotX = x0;
}
function dotSet(x) {
  const g = $('spDotG');
  if (g) g.setAttribute('transform', `translate(${x} ${spY})`);
}
/* ease the seal-dot along the line; stamps cb on arrival */
function dotTo(x, cb) {
  cancelAnimationFrame(dotRAF);
  const from = dotX, dist = Math.abs(x - from);
  const dur = 260 + dist * 1.1;
  const t0 = performance.now();
  const step = now => {
    const k = Math.min((now - t0) / dur, 1);
    dotX = from + (x - from) * easeIO(k);
    dotSet(dotX);
    if (k < 1) dotRAF = requestAnimationFrame(step);
    else { dotRAF = 0; if (cb) cb(); }
  };
  dotRAF = requestAnimationFrame(step);
}
function spineFlick() {
  const r = $('spRoute');
  if (!r) return;
  r.classList.remove('sp-run');
  void r.getBoundingClientRect();
  r.classList.add('sp-run');
}

/* ==================== SECTION COMPLETION ==================== */
const okmOf = k => LEGS[k].querySelector('.okm');
function legDone(k) {
  if (k === 'a') return !!PORT_G[S.origin];
  if (k === 'b') return S.kinds.length >= 1 &&
    S.kinds.every(kk => kk.teu >= 1 && kk.wt > 0);
  if (k === 'c') return S.depDay != null && S.depDay >= 0.5 &&
    Number.isInteger(S.flex) && S.flex >= 0;
  if (k === 'd') return servable(S.origin, S.dest);
  return false;
}
/* stamp / un-stamp a header seal (slam replays each time) */
function stampLeg(k) {
  const okm = okmOf(k), leg = LEGS[k], done = legDone(k);
  leg.classList.toggle('done', done);
  if (done) {
    okm.classList.remove('on');
    void okm.offsetWidth;
    okm.classList.add('on');
  } else okm.classList.remove('on');
}
function refreshDone() { Object.keys(LEGS).forEach(k => LEGS[k].classList.toggle('done', legDone(k))); }
function clearHolds() {
  Object.values(LEGS).forEach(l => l.querySelector('.hold').classList.remove('on'));
  segRow.querySelectorAll('.seg').forEach(s => s.classList.remove('err'));
}
function holdLeg(k) {
  const h = LEGS[k].querySelector('.hold');
  h.classList.remove('on');
  void h.offsetWidth;
  h.classList.add('on');
}
/* the shared "this section changed" pulse — dot rides out, header re-stamps */
function touch(k) {
  clearHolds(); hideNote();
  refreshDone(); layoutSpine(); ledger();
  dotTo(GATES[k], () => stampLeg(k));
}

/* ==================== NOTE ==================== */
function showNote(kind, stampTxt, msg) {
  noteEl.className = `note on ${kind}`;
  noteEl.innerHTML =
    `<span class="n-stamp">${noteStampSVG(stampTxt, kind === 'sage' ? '#3a5a44' : '#b96f4b')}</span>` +
    `<span class="n-t">${esc(msg)}</span>`;
}
function hideNote() { noteEl.className = 'note'; }

/* ==================== PORT STAMPS ==================== */
const pc = (u, part) => $('pc' + part + (u === 'a' ? 'a' : 'b'));
function voyageDays() {
  const nm = nmOf(S.origin, S.dest);
  return nm == null ? null : Math.max(8, Math.round(nm / 450));
}
function applyStamp(u) {
  const code = u === 'a' ? S.origin : S.dest;
  const p = PORT_G[code] || { n: code };
  pc(u, 'Code').textContent = code;
  pc(u, 'City').textContent = p.n;
  const btn = u === 'a' ? stampA : stampB;
  btn.setAttribute('aria-label',
    `${u === 'a' ? 'Origin' : 'Destination'} port — ${p.n} ${code}. Activate to change.`);
  if (u === 'a') {
    pc(u, 'Date').textContent = S.depDay != null ? `ETD D+${S.depDay}` : 'ETD —';
  } else {
    const d = voyageDays();
    pc(u, 'Date').textContent =
      d != null && S.depDay != null ? `ETA D+${S.depDay + d}` : (d != null ? `≈ ${d} DAYS` : '—');
  }
}
function slamStamp(u) {
  const g = $('psG' + u);
  g.classList.remove('slam');
  void g.getBoundingClientRect();
  g.classList.add('slam');
  setTimeout(() => applyStamp(u), 150);      // swap the ink mid-slam
}
stampA.addEventListener('click', () => {
  const src = Object.keys(PAIRS);
  S.origin = src[(src.indexOf(S.origin) + 1) % src.length];
  if (!servable(S.origin, S.dest)) {
    S.dest = dstFor(S.origin)[0];
    slamStamp('b');                          /* dest lane re-inks to a servable port */
  }
  slamStamp('a');
  spineFlick(); touch('a');
});
stampB.addEventListener('click', () => {
  const dst = dstFor(S.origin);
  S.dest = dst[(dst.indexOf(S.dest) + 1) % dst.length];
  slamStamp('b');
  spineFlick(); touch('d');
});

/* ==================== CARGO PUNCHES ==================== */
function renderPunches() {
  punchRow.innerHTML = S.kinds.map((k, i) => `
    <button class="pk" type="button" data-cargo="${k.type}" data-i="${i}"
      aria-label="${KIND_NAME[k.type]} cargo — ${k.teu} TEU, ${k.wt.toFixed(1)} tonnes. Activate to edit.">
      <i class="pk-hole"></i>
      <span class="pk-ic">${GLYPH[k.type]}</span>
      <b class="pk-n" data-t="×${k.teu}">×${k.teu}</b>
      <i class="pk-w">${k.wt.toFixed(1)} T</i>
    </button>`).join('') +
    (S.kinds.length < KIND_ORDER.length ? `
    <button class="pk pk-add" type="button" data-i="-1" aria-label="Add a cargo kind">
      <b class="pk-plus">+</b><i class="pk-cap">KIND</i>
    </button>` : '');
  punchRow.querySelectorAll('.pk').forEach(b =>
    b.addEventListener('click', () => openPop(+b.dataset.i, b)));
  layoutSpine();
}

/* ---------------- the stamped popover ---------------- */
let popIdx = -1;
function closePop() { popEl.hidden = true; popEl.classList.remove('open'); popIdx = -1; }
function popStepper(unit, val, min, max, step, fmt) {
  /* .stepper register: chevrons + wheel on the numeral + arrows */
  return `<div class="stepper">
    <button class="sbtn" type="button" data-d="1" aria-label="raise ${unit}">
      <svg viewBox="0 0 10 6"><path d="M1 5 5 1 9 5"/></svg></button>
    <div class="sval sv-${unit === 'teu' ? 'teu' : 'wt'}" tabindex="0" role="spinbutton"
         data-min="${min}" data-max="${max}" data-step="${step}"
         aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${val}"
         aria-label="${unit === 'teu' ? 'TEU' : 'tonnes'}">${fmt(val)}${unit === 'wt' ? '<span class="u">T</span>' : ''}</div>
    <button class="sbtn" type="button" data-d="-1" aria-label="lower ${unit}">
      <svg viewBox="0 0 10 6"><path d="M1 1 5 5 9 1"/></svg></button>
    <div class="sunit">${unit === 'teu' ? 'TEU' : 'TONNES'}</div>
  </div>`;
}
function wireStepper(stepperEl, get, set, fmt) {
  const sval = stepperEl.querySelector('.sval');
  const min = +sval.dataset.min, max = +sval.dataset.max, step = +sval.dataset.step;
  const paint = () => {
    sval.innerHTML = fmt(get()) + (stepperEl.dataset.unit === 'wt' ? '<span class="u">T</span>' : '');
    sval.setAttribute('aria-valuenow', get());
  };
  stepperEl.querySelectorAll('.sbtn').forEach(b =>
    b.addEventListener('click', () => { set(clamp(get() + step * (+b.dataset.d), min, max)); paint(); }));
  sval.addEventListener('wheel', e => {
    e.preventDefault();
    set(clamp(get() + (e.deltaY < 0 ? step : -step), min, max)); paint();
  }, { passive: false });
  sval.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp')   { set(clamp(get() + step, min, max)); paint(); e.preventDefault(); }
    if (e.key === 'ArrowDown') { set(clamp(get() - step, min, max)); paint(); e.preventDefault(); }
  });
  return paint;
}
function openPop(i, anchor) {
  if (i < 0) {                                   /* the + slot: draft a kind */
    const free = KIND_ORDER.find(t => !S.kinds.some(k => k.type === t)) || 'dry';
    S.kinds.push({ type: free, teu: 6, wt: 66.0, wset: false });
    i = S.kinds.length - 1;
  }
  renderPunches();                               /* re-ink discs (keeps edits live) */
  anchor = punchRow.querySelector(`[data-i="${i}"]`) || anchor;
  popIdx = i;
  const k = S.kinds[i];
  const used = new Set(S.kinds.map((kk, j) => j === i ? null : kk.type));
  popEl.innerHTML = `
    <div class="pop-h">CARGO · KIND ${i + 1}<button class="pop-x" type="button" aria-label="close">✕</button></div>
    <div class="kinds">${KIND_ORDER.map(t => `
      <button class="kc ${t === k.type ? 'sel' : ''}" type="button" data-k="${t}"
        ${used.has(t) ? 'disabled' : ''} aria-label="${KIND_NAME[t]}${used.has(t) ? ' — already punched' : ''}"
        title="${KIND_NAME[t]}">${GLYPH[t]}<small>${KIND_SHORT[t]}</small></button>`).join('')}
    </div>
    <div class="pop-steps">
      ${popStepper('teu', k.teu, 1, 99, 1, v => `<b class="gnum" data-t="${v}">${v}</b>`)}
      ${popStepper('wt', k.wt, 0.5, 600, 0.5, v => `<b class="gnum" data-t="${v.toFixed(1)}">${v.toFixed(1)}</b>`)}
    </div>
    <div class="pop-f">
      <button class="btn ghost" type="button" data-rm>✕ REMOVE</button>
      <button class="btn go" type="button" data-ok>✓ STAMPED</button>
    </div>`;
  popEl.hidden = false;
  popEl.classList.remove('open'); void popEl.offsetWidth; popEl.classList.add('open');

  /* position beside the punch, clamped to the viewport */
  const r = anchor.getBoundingClientRect();
  const pw = 236, ph = popEl.offsetHeight;
  let x = r.left + r.width / 2 - pw / 2;
  x = clamp(x, 8, window.innerWidth - pw - 8);
  let y = r.bottom + 10;
  if (y + ph > window.innerHeight - 10) y = r.top - ph - 10;
  popEl.style.left = x + 'px'; popEl.style.top = y + 'px';

  popEl.querySelector('.pop-x').addEventListener('click', commitPop);
  popEl.querySelector('[data-ok]').addEventListener('click', commitPop);
  popEl.querySelector('[data-rm]').addEventListener('click', () => {
    S.kinds.splice(popIdx, 1);
    closePop(); renderPunches(); touch('b');
  });
  popEl.querySelectorAll('.kc').forEach(c => c.addEventListener('click', () => {
    k.type = c.dataset.k;
    popEl.querySelectorAll('.kc').forEach(cc => cc.classList.toggle('sel', cc === c));
  }));
  const steps = popEl.querySelectorAll('.stepper');
  steps[0].dataset.unit = 'teu'; steps[1].dataset.unit = 'wt';
  const paintWt = wireStepper(steps[1], () => k.wt,
    v => { k.wt = +(+v).toFixed(1); k.wset = true; },
    v => `<b class="gnum" data-t="${v.toFixed(1)}">${v.toFixed(1)}</b>`);
  wireStepper(steps[0], () => k.teu, v => {
    k.teu = Math.round(v);
    if (!k.wset) { k.wt = +(k.teu * 11).toFixed(1); paintWt(); }   /* ~11 t/TEU suggestion */
  }, v => `<b class="gnum" data-t="${v}">${v}</b>`);
}
function commitPop() { closePop(); renderPunches(); touch('b'); }
document.addEventListener('pointerdown', e => {
  if (popIdx < 0) return;
  if (popEl.contains(e.target) || punchRow.contains(e.target)) return;
  commitPop();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && popIdx >= 0) commitPop(); });

/* ==================== DEPARTURE DAY-TILES ==================== */
function renderDays() {
  dayRow.innerHTML = DAY_TILES.map((v, i) => {
    const sel = S.depDay === v;
    const lab = v === 0.5 ? '½' : String(v);
    const aria = v === 0.5 ? 'half a day' : `${v} days`;
    return `<button class="dt ${sel ? 'sel' : ''}" type="button" data-v="${v}"
      style="--dt-rot:${DT_ROT[i]}" aria-pressed="${sel}"
      aria-label="Departure in ${aria}"><i>${lab}</i><small>${v === 0.5 ? '12H' : 'DAY'}</small></button>`;
  }).join('');
  dayRow.querySelectorAll('.dt').forEach(b => b.addEventListener('click', () => {
    S.depDay = +b.dataset.v;
    dayRow.querySelectorAll('.dt').forEach(t => {
      const on = t === b;
      t.classList.toggle('sel', on);
      t.setAttribute('aria-pressed', on);
    });
    applyStamp('a'); applyStamp('b');            /* ETD / ETA re-ink */
    touch('c');
  }));
}

/* ==================== FLEX STEPPER ==================== */
function setFlex(v, silent) {
  S.flex = clamp(Math.round(v), 0, 9);
  flexNum.textContent = S.flex;
  flexNum.dataset.t = S.flex;
  flexVal.setAttribute('aria-valuenow', S.flex);
  if (!silent) touch('c');
}
$('flexStep').querySelectorAll('.fsb').forEach(b =>
  b.addEventListener('click', () => setFlex(S.flex + (+b.dataset.d))));
flexVal.addEventListener('wheel', e => {
  e.preventDefault(); setFlex(S.flex + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });
flexVal.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setFlex(S.flex + 1); e.preventDefault(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setFlex(S.flex - 1); e.preventDefault(); }
});

/* ==================== SEGMENT PUNCHES ==================== */
function renderSeg() {
  segRow.innerHTML = SEGS.map(s => `
    <button class="seg ${s.k} ${S.segment === s.k ? 'sel' : ''}" type="button"
      role="radio" aria-checked="${S.segment === s.k}" data-k="${s.k}">
      <i class="ph"></i>${s.t}</button>`).join('');
  segRow.querySelectorAll('.seg').forEach(b => b.addEventListener('click', () => {
    S.segment = b.dataset.k;
    if (S.segment === 'urgent') setFlex(0, true);   /* urgent sails on fixed day */
    clearHolds(); hideNote();
    renderSeg(); ledger();
  }));
}

/* ==================== LEDGER ==================== */
function ledger() {
  const nm = nmOf(S.origin, S.dest);
  const d = voyageDays();
  const teu = S.kinds.reduce((a, k) => a + k.teu, 0);
  const wt = S.kinds.reduce((a, k) => a + k.wt, 0);
  ledgEl.textContent =
    `≈ ${nm == null ? '—' : nm.toLocaleString('en-US')} NM · ${d == null ? '—' : d} DAYS` +
    ` · Σ ${teu} TEU · ${wt.toFixed(1)} T · ${S.segment.toUpperCase()}`;
}

/* ==================== CONFIRM ==================== */
function validate() {
  const bad = [];
  if (!PORT_G[S.origin]) bad.push(['a', 'TAP TO SET AN ORIGIN PORT']);
  if (PORT_G[S.origin] && !servable(S.origin, S.dest))
    bad.push(['d', `NO SERVICE ${S.origin} → ${S.dest}`]);
  if (!S.kinds.length) bad.push(['b', 'PUNCH AT LEAST ONE CARGO KIND']);
  else {
    const bi = S.kinds.findIndex(k => !(k.teu >= 1) || !(k.wt > 0));
    if (bi >= 0) bad.push(['b', `KIND ${bi + 1} — TEU ≥ 1 · TONNES > 0`]);
  }
  if (S.depDay == null || S.depDay < 0.5) bad.push(['c', 'STAMP A DEPARTURE DAY ≥ 0.5']);
  else if (!Number.isInteger(S.flex) || S.flex < 0 || S.flex > 9)
    bad.push(['c', 'FLEX DAYS 0–9']);
  if (!S.segment) bad.push(['seg', 'PUNCH A SERVICE SEGMENT']);
  return bad;
}
async function confirm() {
  if (S.busy) return;
  const g = $('csG');
  g.classList.remove('slam'); void g.getBoundingClientRect(); g.classList.add('slam');
  clearHolds(); hideNote();
  const bad = validate();
  if (bad.length) {
    bad.forEach(([k]) => {
      if (k === 'seg') segRow.querySelectorAll('.seg').forEach(s => s.classList.add('err'));
      else holdLeg(k);
    });
    showNote('terra', 'HOLD', bad.map(b => b[1]).join(' · '));
    return;
  }
  S.busy = true;
  confirmBtn.innerHTML = confirmSVG('PRICING…');
  const bodies = S.kinds.map(k => ({
    origin: S.origin, dest: S.dest,
    teu: k.teu, weight_t: k.wt, cargo_type: k.type,
    segment: S.segment, req_dep_day: S.depDay, flex_days: S.flex,
  }));
  let results;
  try {
    results = await Promise.all(bodies.map(DockAPI.quote));
  } catch (e) {
    /* nothing is filed offline — hold the strip and say why */
    showNote('terra', 'HOLD', `${e.status ? e.status + ' — ' : ''}${String(e.message).toUpperCase()}`);
    if (e.status === 422) holdLeg('b');
    S.busy = false;
    confirmBtn.innerHTML = confirmSVG('CONFIRM');
    return;
  }
  const final = await DockOffers.review(results);
  const booked = final.filter(o => ['CONFIRMED', 'LOADING'].includes(o.status)).map(o => o.id);
  confirmBtn.innerHTML = confirmSVG(booked.length ? '✓ BOOKED' : 'CLOSED');
  const gg = $('csG'); gg.classList.add('slam');
  showNote('sage', booked.length ? 'BOOKED' : 'QUOTED',
           `${(booked.length ? booked : final.map(o => o.id)).join(' · ')} — ON THE BOARD`);
  setTimeout(() => { location.href = DASH; }, 1100);
}
confirmBtn.addEventListener('click', confirm);

/* ==================== INIT ==================== */
async function boot() {
  try {
    await loadNetwork();
  } catch (e) {
    showNote('terra', 'OFFLINE', `BOOKING SERVICE UNAVAILABLE — ${String(e.message).toUpperCase()}`);
    confirmBtn.disabled = true;
    return;
  }
  applyStamp('a'); applyStamp('b');
  renderPunches(); renderDays(); renderSeg(); setFlex(2, true);
  layoutSpine(); refreshDone(); ledger();
}
boot();

/* intro: the seal-dot rides the strip once, stamping each leg —
   chained so no travel ever cancels a stamp mid-flight          */
(function intro() {
  dotX = GATES.a; dotSet(dotX);
  const legs = ['b', 'c', 'd'];
  const hop = i => {
    if (i >= legs.length) return;
    setTimeout(() => dotTo(GATES[legs[i]], () => {
      stampLeg(legs[i]);
      hop(i + 1);
    }), i === 0 ? 550 : 380);
  };
  setTimeout(() => { stampLeg('a'); hop(0); }, 480);
})();

let rzRAF = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(rzRAF);
  rzRAF = requestAnimationFrame(() => { layoutSpine(); });
});
