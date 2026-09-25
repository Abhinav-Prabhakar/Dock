/* ============================================================
   MERIDIAN LINE — intake-c · "A DESK OF PAPER SLIPS"
   A stack of small paper slips on the plaster desk — one slip
   per container kind, fanned and tilted. Shared fields live on
   the master waybill strip: two rubber datestamps (origin /
   destination), segment chips, and a departure strip stamped
   as DAY n ± flex tiles. CONFIRM is a sage stamp that slams
   each slip in sequence and files them — one POST per slip.
   ============================================================ */

const API         = location.port === '8399' ? '' : 'http://localhost:8399';
const ORDERS_KEY  = 'ml.orders';
const DASHBOARD   = '../dashboard/';
const MAX_SLIPS   = 6;
const T_PER_TEU   = 11;              /* auto-suggest ≈ 11 t per TEU */

/* ----------------------------- helpers ----------------------------- */
const clamp  = (v, a, b) => v < a ? a : (v > b ? b : v);
const wait   = ms => new Promise(r => setTimeout(r, ms));
const fmt1   = v => (v % 1 ? v.toFixed(1) : String(v));       /* 3 or 3.5 */
const fmtW   = v => v.toFixed(1);
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* -------------------------- port reference -------------------------- */
/* fallback table — GET /ports refreshes it at boot if the API is up   */
let PORTS = [
  { port_id: 'CNSHA', name: 'Shanghai',    lat: 31.2243, lon: 121.4869, berths: 30 },
  { port_id: 'SGSIN', name: 'Singapore',   lat: 1.2644,  lon: 103.8200, berths: 26 },
  { port_id: 'KRPUS', name: 'Busan',       lat: 35.0951, lon: 129.0398, berths: 20 },
  { port_id: 'NLRTM', name: 'Rotterdam',   lat: 51.9480, lon: 4.1420,   berths: 24 },
  { port_id: 'DEHAM', name: 'Hamburg',     lat: 53.5403, lon: 9.9852,   berths: 15 },
  { port_id: 'BEANR', name: 'Antwerp',     lat: 51.2630, lon: 4.4020,   berths: 18 },
  { port_id: 'USLAX', name: 'Los Angeles', lat: 33.7292, lon: -118.197, berths: 24 },
  { port_id: 'USNYC', name: 'New York',    lat: 40.6690, lon: -74.0100, berths: 14 },
];
const port = id => PORTS.find(p => p.port_id === id) || { port_id: id, name: id };

/* servable OD pairs — destination list is filtered by origin */
const OD = {
  CNSHA: ['NLRTM', 'DEHAM', 'BEANR', 'USLAX', 'USNYC', 'SGSIN'],
  SGSIN: ['NLRTM', 'BEANR', 'CNSHA'],
  KRPUS: ['USLAX', 'CNSHA'],
  NLRTM: ['CNSHA', 'SGSIN', 'BEANR'],
  DEHAM: ['CNSHA'],
  BEANR: ['SGSIN'],
  USLAX: ['CNSHA', 'KRPUS'],
  USNYC: ['CNSHA'],
};

/* ------------------------- shared waybill state ------------------------- */
const state = {
  origin: 'SGSIN',
  dest:   'NLRTM',
  segment: 'standard',
  dep:    3,      /* req_dep_day — sim-days, >= 0.5 */
  flex:   2,      /* flex_days  — int, 0 allowed    */
};

/* ------------------------------ cargo kinds ------------------------------ */
const KINDS = {
  dry:    { name: 'DRY',    ink: '#4f4a3c' },
  reefer: { name: 'REEFER', ink: '#4a7f9e' },
  hazmat: { name: 'HAZMAT', ink: '#c98f1f' },
};
const CYCLE = ['dry', 'reefer', 'hazmat'];
const GLYPH = {
  dry:  '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="3" width="9" height="6" rx=".5" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
        '<path d="M3.9 3v6M6 3v6M8.1 3v6" stroke="currentColor" stroke-width=".7" fill="none"/></svg>',
  reefer: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round">' +
        '<path d="M10.16 8.4L1.84 3.6M6 10.8L6 1.2M1.84 8.4L10.16 3.6"/>' +
        '<path d="M8.64 7.52L9.1 8.95M8.64 7.52L10.11 7.21M6 9.05L5 10.16M6 9.05L7 10.16' +
        'M3.36 7.52L1.89 7.21M3.36 7.52L2.9 8.95M3.36 4.47L2.9 3.05M3.36 4.47L1.89 4.79' +
        'M6 2.95L7 1.84M6 2.95L5 1.84M8.64 4.47L10.11 4.79M8.64 4.47L9.1 3.05"/></g></svg>',
  hazmat: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="currentColor">' +
        '<circle cx="6" cy="6" r="1.3"/>' +
        '<path d="M3.65 1.93A4.7 4.7 0 0 1 8.35 1.93L6.95 4.36A1.9 1.9 0 0 0 5.05 4.36Z"/>' +
        '<path d="M10.7 6A4.7 4.7 0 0 1 8.35 10.07L6.95 7.64A1.9 1.9 0 0 0 7.9 6Z"/>' +
        '<path d="M3.65 10.07A4.7 4.7 0 0 1 1.3 6L4.1 6A1.9 1.9 0 0 0 5.05 7.64Z"/></g></svg>',
};
const CHEV_L = '<svg viewBox="0 0 6 10" aria-hidden="true"><path d="M5 1 1 5 5 9"/></svg>';
const CHEV_R = '<svg viewBox="0 0 6 10" aria-hidden="true"><path d="M1 1 5 5 1 9"/></svg>';

/* ------------------------------ DOM refs ------------------------------ */
const slipzone   = document.getElementById('slipzone');
const addBtn     = document.getElementById('addSlip');
const confirmBtn = document.getElementById('confirmBtn');
const noteEl     = document.getElementById('note');
const noteTxt    = document.getElementById('noteTxt');

/* ============================================================
   NUMERAL WIDGET — serif tabular numeral with ghosts; chevron
   steppers, wheel, arrow keys, and vertical drag on the numeral
   ============================================================ */
function makeNum(numEl, chevBtns, cfg) {
  const show = () => {
    const s = cfg.fmt(cfg.value);
    numEl.textContent = s;
    numEl.dataset.t = s;
    numEl.setAttribute('aria-valuenow', cfg.value);
  };
  const set = (v, manual) => {
    v = clamp(Math.round(v / cfg.step) * cfg.step, cfg.min, cfg.max);
    v = +v.toFixed(2);
    if (v === cfg.value) return;
    cfg.value = v;
    show();
    if (cfg.onchange) cfg.onchange(v, !!manual);
  };
  chevBtns.forEach(b => b.addEventListener('click', () => set(cfg.value + (+b.dataset.d) * cfg.step, true)));
  numEl.addEventListener('wheel', e => {
    e.preventDefault();
    set(cfg.value + (e.deltaY < 0 ? 1 : -1) * cfg.step, true);
  }, { passive: false });
  numEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); set(cfg.value + cfg.step, true); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); set(cfg.value - cfg.step, true); }
    if (e.key === 'Home') { e.preventDefault(); set(cfg.min, true); }
    if (e.key === 'End')  { e.preventDefault(); set(cfg.max, true); }
  });
  /* drag the numeral — 12 px of vertical travel per step */
  numEl.addEventListener('pointerdown', e => {
    e.preventDefault();
    numEl.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = cfg.value;
    const mv = ev => set(v0 + Math.round((y0 - ev.clientY) / 12) * cfg.step, true);
    const up = () => {
      numEl.removeEventListener('pointermove', mv);
      numEl.removeEventListener('pointerup', up);
      numEl.removeEventListener('pointercancel', up);
    };
    numEl.addEventListener('pointermove', mv);
    numEl.addEventListener('pointerup', up);
    numEl.addEventListener('pointercancel', up);
  });
  show();
  return { set, show };
}

/* ============================================================
   PORT DATESTAMPS — rubber stamp per endpoint, tap to open the
   servable-port menu, slam re-inks the stamp
   ============================================================ */
const stampA = document.getElementById('stampA');
const stampB = document.getElementById('stampB');
const menuA  = document.getElementById('menuA');
const menuB  = document.getElementById('menuB');

function stampSVG(p, role, uid) {
  const name = String(p.name || p.port_id).toUpperCase();
  const sub  = p.berths ? `${p.berths} BERTHS` : 'PORT OF CALL';
  return `<svg viewBox="0 0 92 92" aria-hidden="true">
    <defs>
      <path id="pc${uid}" d="M 24 46 A 22 22 0 0 1 68 46"/>
      <path id="pr${uid}" d="M 20 46 A 26 26 0 0 0 72 46"/>
    </defs>
    <g filter="url(#stampInk)">
      <circle class="st-ghost" cx="47.2" cy="45.4" r="38"/>
      <circle class="st-out" cx="46" cy="46" r="38"/>
      <circle class="st-in"  cx="46" cy="46" r="34"/>
      <circle class="st-in"  cx="46" cy="46" r="21"/>
      <circle class="st-sep" cx="24.4" cy="46" r="1.2"/>
      <circle class="st-sep" cx="67.6" cy="46" r="1.2"/>
      <text class="st-city"><textPath href="#pc${uid}" startOffset="50%" text-anchor="middle">${name}</textPath></text>
      <text class="st-role"><textPath href="#pr${uid}" startOffset="50%" text-anchor="middle">${role}</textPath></text>
      <text class="st-code" x="46" y="49.5" text-anchor="middle">${p.port_id}</text>
      <text class="st-sub"  x="46" y="60"   text-anchor="middle">${sub}</text>
    </g>
  </svg>`;
}

function inkStamp(btn, p, role, uid, label) {
  btn.innerHTML = stampSVG(p, role, uid);
  btn.setAttribute('aria-label',
    `${role === 'ORIGIN' ? 'Origin' : 'Destination'} port — ${p.name} ${p.port_id}. Activate to change.`);
  /* slam — lift off, re-inked stamp presses back down */
  btn.classList.remove('slam');
  void btn.offsetWidth;
  btn.classList.add('slam');
}

function renderStamps() {
  stampA.innerHTML = stampSVG(port(state.origin), 'ORIGIN', 'a');
  stampB.innerHTML = stampSVG(port(state.dest),   'DESTINATION', 'b');
  stampA.setAttribute('aria-label', `Origin port — ${port(state.origin).name} ${state.origin}. Activate to change.`);
  stampB.setAttribute('aria-label', `Destination port — ${port(state.dest).name} ${state.dest}. Activate to change.`);
}

/* port menus — a little paper chit pinned under each stamp */
function fillMenu(menu, ids, cur, onPick) {
  menu.innerHTML = '';
  ids.forEach(id => {
    const p = port(id);
    const b = document.createElement('button');
    b.className = 'pm-row' + (id === cur ? ' cur' : '');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', id === cur ? 'true' : 'false');
    b.innerHTML = `<span class="pm-code">${id}</span><span class="pm-name">${String(p.name).toUpperCase()}</span>`;
    b.addEventListener('click', () => { onPick(id); closeMenus(); });
    menu.appendChild(b);
  });
}
function closeMenus() { menuA.hidden = true; menuB.hidden = true; }

stampA.addEventListener('click', e => {
  e.stopPropagation();
  const open = menuA.hidden;
  closeMenus();
  if (open) {
    fillMenu(menuA, PORTS.map(p => p.port_id), state.origin, setOrigin);
    menuA.hidden = false;
  }
});
stampB.addEventListener('click', e => {
  e.stopPropagation();
  const open = menuB.hidden;
  closeMenus();
  if (open) {
    fillMenu(menuB, OD[state.origin] || [], state.dest, setDest);
    menuB.hidden = false;
  }
});
window.addEventListener('pointerdown', e => {
  if (!menuA.hidden && !menuA.contains(e.target) && !stampA.contains(e.target)) closeMenus();
  if (!menuB.hidden && !menuB.contains(e.target) && !stampB.contains(e.target)) closeMenus();
});
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

function setOrigin(id) {
  state.origin = id;
  inkStamp(stampA, port(id), 'ORIGIN', 'a');
  /* keep the pair servable — re-ink destination if the lane closed */
  if (!(OD[id] || []).includes(state.dest)) {
    state.dest = OD[id][0];
    inkStamp(stampB, port(state.dest), 'DESTINATION', 'b');
  }
}
function setDest(id) {
  state.dest = id;
  inkStamp(stampB, port(id), 'DESTINATION', 'b');
}

/* ============================================================
   SEGMENT CHIPS + DEPARTURE STRIP
   ============================================================ */
const segCap = document.getElementById('segCap');
const SEG_CAP = {
  flexible: 'BOOKED SPACE · WIDEST DEPARTURE TOLERANCE',
  standard: 'BOOKED SPACE · BEST AVAILABLE SAILING',
  urgent:   'PRIORITY MANIFEST · NEXT SAILING OUT',
};
document.querySelectorAll('.seg-chip').forEach(c => c.addEventListener('click', () => {
  document.querySelectorAll('.seg-chip').forEach(x => {
    x.classList.toggle('on', x === c);
    x.setAttribute('aria-checked', x === c ? 'true' : 'false');
  });
  state.segment = c.dataset.seg;
  segCap.textContent = SEG_CAP[state.segment];
  if (state.segment === 'urgent') flexNum.set(0);   /* urgent defaults flex_days 0 */
}));

/* departure tiles — DAY n ± flex */
const depCfg  = { value: state.dep,  min: 0.5, max: 60, step: 0.5, fmt: fmt1,
                  onchange: v => { state.dep = v;  document.getElementById('tileDay').classList.remove('err'); } };
const flexCfg = { value: state.flex, min: 0,   max: 14, step: 1,   fmt: v => String(v),
                  onchange: v => { state.flex = v; } };
const dayNum  = makeNum(document.getElementById('depDay'),
                        [...document.querySelectorAll('#tileDay .hbtn')], depCfg);
const flexNum = makeNum(document.getElementById('depFlex'),
                        [...document.querySelectorAll('#tileFlex .hbtn')], flexCfg);

/* ============================================================
   THE SLIP STACK — one paper slip per container kind
   ============================================================ */
let slips = [];
let filing = false;

function slipSeedRot(idx) {
  const r = mulberry(7000 + idx * 61);
  return { rot: (r() - .5) * 6.4, dy: r() * 9 };
}

function drawSlipBar(canvas, idx) {
  const x = canvas.getContext('2d');
  const r = mulberry(9000 + idx * 37);
  x.clearRect(0, 0, canvas.width, canvas.height);
  x.fillStyle = '#2a2721';
  let px = 1;
  while (px < canvas.width - 3) {
    const w = 1 + ((r() * 2) | 0);
    if (r() < 0.68) x.fillRect(px, 0, w, canvas.height - 2);
    px += w + 1;
  }
}

function nextKind() {
  const used = new Set(slips.map(s => s.kind));
  return CYCLE.find(k => !used.has(k)) || 'dry';
}

function addSlip(kind, animate) {
  if (slips.length >= MAX_SLIPS || filing) return;
  const s = {
    kind: kind || nextKind(),
    teu:  8,
    wt:   8 * T_PER_TEU,
    wtAuto: true,
    el:   document.createElement('article'),
  };
  const idx = slips.length;
  const { rot, dy } = slipSeedRot(idx);
  s.el.className = 'slip' + (animate ? ' in' : '');
  s.el.dataset.kind = s.kind;
  s.el.style.setProperty('--rot', rot.toFixed(2) + 'deg');
  s.el.style.setProperty('--dy', dy.toFixed(1) + 'px');
  s.el.innerHTML = `
    <div class="slip-top">
      <span class="slip-no">SLIP</span>
      <button class="slip-x" type="button" aria-label="remove this slip">×</button>
    </div>
    <button class="kind-stamp" type="button">
      <span class="kg">${GLYPH[s.kind]}</span>
      <span class="kind-name">${KINDS[s.kind].name}</span>
    </button>
    <div class="slip-fields">
      <div class="fld f-teu">
        <div class="f-lbl">TEU</div>
        <div class="num-wrap">
          <button class="hbtn" data-d="-1" type="button" aria-label="fewer TEU">${CHEV_L}</button>
          <b class="gnum sval sv-teu" tabindex="0" role="spinbutton"
             aria-valuemin="1" aria-valuemax="99" aria-label="TEU count">8</b>
          <button class="hbtn" data-d="1" type="button" aria-label="more TEU">${CHEV_R}</button>
        </div>
        <div class="f-hint">20′ EQUIVALENT UNITS</div>
      </div>
      <div class="fld f-wt">
        <div class="f-lbl">WEIGHT · T</div>
        <div class="num-wrap">
          <button class="hbtn" data-d="-1" type="button" aria-label="lighter">${CHEV_L}</button>
          <b class="gnum sval sv-wt" tabindex="0" role="spinbutton"
             aria-valuemin="0.5" aria-valuemax="2000" aria-label="total tonnes">88.0</b>
          <button class="hbtn" data-d="1" type="button" aria-label="heavier">${CHEV_R}</button>
        </div>
        <div class="f-hint f-hint-w">≈ 11 T / TEU · AUTO</div>
      </div>
    </div>
    <div class="slip-bar">
      <canvas width="52" height="10" aria-hidden="true"></canvas>
      <span class="slip-bar-cap">MLSU 2481 ${String(10 + idx).padStart(3, '0')}</span>
    </div>
    <div class="slip-check" aria-hidden="true">CHECK</div>
    <div class="slip-filed" aria-hidden="true">FILED</div>`;

  /* cargo-kind stamp — tap cycles DRY → REEFER → HAZMAT */
  const kbtn = s.el.querySelector('.kind-stamp');
  const inkKind = () => {
    s.el.dataset.kind = s.kind;
    kbtn.innerHTML = `<span class="kg">${GLYPH[s.kind]}</span><span class="kind-name">${KINDS[s.kind].name}</span>`;
    kbtn.setAttribute('aria-label', `Cargo kind — ${KINDS[s.kind].name}. Activate to change.`);
    kbtn.classList.remove('pop'); void kbtn.offsetWidth; kbtn.classList.add('pop');
    s.el.classList.remove('err');
  };
  kbtn.addEventListener('click', () => {
    s.kind = CYCLE[(CYCLE.indexOf(s.kind) + 1) % CYCLE.length];
    inkKind();
  });
  inkKind();   /* ink the stamp + label it */

  /* TEU — 1..99, drives the auto weight ≈ 11 t/TEU */
  s.teuNum = makeNum(s.el.querySelector('.sv-teu'),
                     [...s.el.querySelectorAll('.f-teu .hbtn')], {
    value: s.teu, min: 1, max: 99, step: 1, fmt: v => String(v),
    onchange: v => {
      s.teu = v;
      if (s.wtAuto) s.wtNum.set(v * T_PER_TEU, false);
      s.el.querySelector('.f-teu').classList.remove('err');
      s.el.classList.remove('err');
      updateTotals();
    },
  });
  /* WEIGHT — tonnes across the slip's TEU, editable */
  s.wtNum = makeNum(s.el.querySelector('.sv-wt'),
                    [...s.el.querySelectorAll('.f-wt .hbtn')], {
    value: s.wt, min: 0.5, max: 2000, step: 0.5, fmt: fmtW,
    onchange: (v, manual) => {
      s.wt = v;
      if (manual) {
        s.wtAuto = false;
        s.el.querySelector('.f-hint-w').textContent = 'MANUAL · TONNES';
      }
      s.el.querySelector('.f-wt').classList.remove('err');
      s.el.classList.remove('err');
      updateTotals();
    },
  });

  s.el.querySelector('.slip-x').addEventListener('click', () => removeSlip(s));
  drawSlipBar(s.el.querySelector('canvas'), idx);

  slips.push(s);
  slipzone.appendChild(s.el);
  renumber();
  updateTotals();
  refreshAdd();
}

function removeSlip(s) {
  if (filing || slips.length <= 1) return;
  slips = slips.filter(x => x !== s);
  s.el.classList.add('out');                 /* the slip lifts away */
  s.el.addEventListener('transitionend', () => s.el.remove(), { once: true });
  setTimeout(() => s.el.isConnected && s.el.remove(), 600);
  renumber();
  updateTotals();
  refreshAdd();
}

function renumber() {
  slips.forEach((s, i) => {
    s.el.querySelector('.slip-no').textContent = 'SLIP ' + String(i + 1).padStart(2, '0');
    s.el.querySelector('.slip-x').style.visibility = slips.length > 1 ? 'visible' : 'hidden';
  });
}

function refreshAdd() {
  const full = slips.length >= MAX_SLIPS;
  addBtn.disabled = full;
  addBtn.textContent = full ? '— DESK FULL · SIX SLIPS' : '+ ADD SLIP';
}
addBtn.addEventListener('click', () => addSlip(null, true));

/* --------------------- running total — serif, ghosted --------------------- */
const totTeu = document.getElementById('totTeu');
const totWt  = document.getElementById('totWt');
const totSlips = document.getElementById('totSlips');
const totSlipsU = document.getElementById('totSlipsU');
function setG(el, s) { el.textContent = s; el.dataset.t = s; }
function updateTotals() {
  setG(totTeu, String(slips.reduce((a, s) => a + s.teu, 0)));
  setG(totWt, fmtW(slips.reduce((a, s) => a + s.wt, 0)));
  setG(totSlips, String(slips.length));
  totSlipsU.textContent = slips.length === 1 ? 'SLIP' : 'SLIPS';
}

/* ============================================================
   STAMPED NOTE — validation summary / 422 detail
   ============================================================ */
let noteTimer = 0;
function showNote(txt, sticky) {
  noteEl.hidden = false;
  noteTxt.textContent = txt;
  clearTimeout(noteTimer);
  if (!sticky) noteTimer = setTimeout(() => { noteEl.hidden = true; }, 4200);
}
function hideNote() { noteEl.hidden = true; }

/* ============================================================
   VALIDATION — mark the offending slip/field in terracotta
   ============================================================ */
function validate() {
  const problems = [];
  slips.forEach((s, i) => {
    let bad = false;
    if (!(s.teu >= 1)) { s.el.querySelector('.f-teu').classList.add('err'); bad = true; }
    if (!(s.wt > 0))   { s.el.querySelector('.f-wt').classList.add('err');  bad = true; }
    if (bad) {
      s.el.classList.add('err');
      problems.push(`SLIP ${i + 1} — TEU ≥ 1 AND WEIGHT > 0 REQUIRED`);
    }
  });
  if (!(state.dep >= 0.5)) {
    document.getElementById('tileDay').classList.add('err');
    problems.push('DEPARTURE — DAY MUST BE ≥ 0.5');
  }
  if (!(OD[state.origin] || []).includes(state.dest)) {
    problems.push(`NO SERVABLE PAIR ${state.origin} → ${state.dest}`);
  }
  return problems;
}

/* ============================================================
   CONFIRM — the sage stamp slams each slip in sequence, posts
   one order per slip, then files the whole stack away
   ============================================================ */
function orderBody(s) {
  return {
    origin:      state.origin,
    dest:        state.dest,
    teu:         s.teu,
    weight_t:    +s.wt.toFixed(2),
    cargo_type:  s.kind,
    segment:     state.segment,
    req_dep_day: +state.dep.toFixed(2),
    flex_days:   state.flex,
  };
}

async function postOrder(body) {
  const r = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.detail || `HTTP ${r.status}`); e.detail = j.detail; e.status = r.status; throw e; }
  return j;
}

function mirrorOrders(bodies) {
  try {
    const cache = JSON.parse(localStorage.getItem(ORDERS_KEY)) || [];
    const stamped = bodies.map((b, i) => ({
      id: `BK-${2400 + cache.length + i}-TC`,
      status: 'PENDING REVIEW',
      created: Date.now() / 1000,
      progress: 0,
      vessel: null, voyage: null, eta: null, price_usd: null,
      ...b,
    }));
    localStorage.setItem(ORDERS_KEY, JSON.stringify(stamped.concat(cache)));
  } catch (e) { /* cache unavailable — still redirect */ }
}

async function confirmAll() {
  if (filing) return;
  const problems = validate();
  if (problems.length) {
    showNote(problems.join('   ·   '));
    return;
  }
  hideNote();
  filing = true;
  confirmBtn.disabled = true;
  addBtn.disabled = true;
  slipzone.style.pointerEvents = 'none';
  confirmBtn.classList.remove('slam'); void confirmBtn.offsetWidth;
  confirmBtn.classList.add('slam');

  const bodies = slips.map(orderBody);
  const results = [];
  let firstDetail = '';

  /* one POST per slip — the stamp slams slip by slip */
  for (let i = 0; i < slips.length; i++) {
    const s = slips[i];
    await wait(i === 0 ? 320 : 420);
    s.el.classList.add('stamped');              /* sage FILED stamp slams on */
    try {
      const j = await postOrder(bodies[i]);
      results.push({ ok: true, order: j });
      s.el.querySelector('.slip-filed').textContent = 'FILED · ' + (j.id || 'OK');
      try {                                        /* keep the cache fresh */
        const cache = JSON.parse(localStorage.getItem(ORDERS_KEY)) || [];
        localStorage.setItem(ORDERS_KEY, JSON.stringify([j].concat(cache)));
      } catch (e) {}
    } catch (e) {
      results.push({ ok: false, err: e });
      if (!firstDetail) firstDetail = e.detail || e.message || 'SERVICE UNREACHABLE';
      s.el.querySelector('.slip-filed').textContent = 'RETURNED';
      s.el.querySelector('.slip-filed').style.borderColor = 'var(--terra)';
      s.el.querySelector('.slip-filed').style.color = 'var(--terra)';
    }
  }

  const failed = results.filter(r => !r.ok);
  if (!failed.length) {
    /* file the stack — each slip lifts off the desk in turn */
    await wait(420);
    slips.forEach((s, i) => setTimeout(() => s.el.classList.add('away'), i * 110));
    await wait(650 + slips.length * 110);
    location.href = DASHBOARD;
    return;
  }

  /* API failure — mirror into the local store, surface the detail
     as a stamped note, then still hand off to the dashboard */
  mirrorOrders(bodies);
  showNote((firstDetail || 'SERVICE UNREACHABLE') + '   ·   MIRRORED TO LOCAL MANIFEST — FILING ANYWAY', true);
  await wait(3200);
  location.href = DASHBOARD;
}
confirmBtn.addEventListener('click', confirmAll);

/* ============================================================
   DRESSING — seeded waybill barcode, live port table
   ============================================================ */
(function drawWbBarcode() {
  const c = document.getElementById('wbBarcode');
  if (!c) return;
  const x = c.getContext('2d'), r = mulberry(24810314);
  x.fillStyle = '#1d1a14';
  let px = 3;
  while (px < c.width - 5) {
    const w = 1 + ((r() * 3) | 0);
    if (r() < 0.72) x.fillRect(px, 1, w, c.height - 4);
    px += w + 1 + (r() < 0.4 ? 1 : 0);
  }
  x.fillRect(1, 0, 1, c.height); x.fillRect(c.width - 2, 0, 1, c.height);
})();

/* refresh the port table from the API — stamps re-ink with real names */
fetch(`${API}/ports`).then(r => r.ok ? r.json() : Promise.reject())
  .then(list => { if (Array.isArray(list) && list.length) { PORTS = list; renderStamps(); } })
  .catch(() => { /* fallback table stays */ });

/* ============================================================
   BOOT — one slip lands on the desk, stamps already inked
   ============================================================ */
renderStamps();
addSlip('dry', false);
setTimeout(() => addSlip('reefer', true), 500);   /* a second slip slides in */
