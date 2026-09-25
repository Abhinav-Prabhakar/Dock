'use strict';
/* ============================================================
   MERIDIAN LINE — WAYBILL DESK (intake variant A)
   ------------------------------------------------------------
   the waybill is a cream paper form pinned to the wall. every
   keystroke RE-INKS the laminated credential hanging beside it:
   port datestamps slam in re-inked, the barcode re-seeds from a
   hash of the whole form, stats flicker with misregistration
   ghosts. confirm is a sage rubber stamp that slams down.
   ============================================================ */

const API = location.port === '8399' ? '' : 'http://localhost:8399';
const ORDERS_KEY = 'ml.orders';
const DASH = '../dashboard/';
const forceNew = new URLSearchParams(location.search).has('new');

const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const $ = id => document.getElementById(id);
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
/* stable string hash → barcode seed */
function hashStr(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/* update a misregistration-ghost numeral: text + data-t together */
function setG(el, txt) { el.textContent = txt; el.dataset.t = txt; }

/* -------------------- ports & servable lanes -------------------- */
const FALLBACK = [
  { port_id: 'CNSHA', name: 'Shanghai' },
  { port_id: 'SGSIN', name: 'Singapore' },
  { port_id: 'KRPUS', name: 'Busan' },
  { port_id: 'NLRTM', name: 'Rotterdam' },
  { port_id: 'DEHAM', name: 'Hamburg' },
  { port_id: 'BEANR', name: 'Antwerp' },
  { port_id: 'USLAX', name: 'Los Angeles/Long Beach' },
  { port_id: 'USNYC', name: 'New York/New Jersey' },
];
const SERVABLE = {
  CNSHA: ['NLRTM', 'DEHAM', 'BEANR', 'USLAX', 'USNYC', 'SGSIN'],
  SGSIN: ['NLRTM', 'BEANR', 'CNSHA'],
  KRPUS: ['USLAX', 'CNSHA'],
  NLRTM: ['CNSHA', 'SGSIN', 'BEANR'],
  DEHAM: ['CNSHA'],
  BEANR: ['SGSIN'],
  USLAX: ['CNSHA', 'KRPUS'],
  USNYC: ['CNSHA'],
};
const code3 = id => id.slice(2);          // SGSIN → SIN (UN/LOCODE tail)
const portName = id => (PORT_MAP[id] || id).toUpperCase();
let PORT_MAP = {};
FALLBACK.forEach(p => { PORT_MAP[p.port_id] = p.name; });
let PORT_LIST = FALLBACK.map(p => p.port_id);

/* -------------------- form state -------------------- */
const MAX_KINDS = 4;
const BUCKETS = [{ l: 'S', v: 2 }, { l: 'M', v: 8 }, { l: 'L', v: 20 }];
const S = {
  origin: 'SGSIN',
  dest: 'NLRTM',
  kinds: [],
  segment: 'standard',
  dep: 3,
  flex: 2,
};

/* cargo glyphs — hand-drawn, recolored via currentColor */
const CARGO = {
  dry: { t: 'DRY',
    ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="2.7" fill="currentColor"/></svg>' },
  hazmat: { t: 'HAZMAT',
    ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="currentColor">' +
        '<circle cx="6" cy="6" r="1.3"/>' +
        '<path d="M3.65 1.93A4.7 4.7 0 0 1 8.35 1.93L6.95 4.36A1.9 1.9 0 0 0 5.05 4.36Z"/>' +
        '<path d="M10.7 6A4.7 4.7 0 0 1 8.35 10.07L6.95 7.64A1.9 1.9 0 0 0 7.9 6Z"/>' +
        '<path d="M3.65 10.07A4.7 4.7 0 0 1 1.3 6L4.1 6A1.9 1.9 0 0 0 5.05 7.64Z"/></g></svg>' },
  reefer: { t: 'REEFER',
    ic: '<svg viewBox="0 0 12 12" aria-hidden="true"><g fill="none" stroke="currentColor"' +
        ' stroke-width="1.1" stroke-linecap="round">' +
        '<path d="M10.16 8.4L1.84 3.6M6 10.8L6 1.2M1.84 8.4L10.16 3.6"/>' +
        '<path d="M8.64 7.52L9.1 8.95M8.64 7.52L10.11 7.21M6 9.05L5 10.16M6 9.05L7 10.16' +
        'M3.36 7.52L1.89 7.21M3.36 7.52L2.9 8.95M3.36 4.47L2.9 3.05M3.36 4.47L1.89 4.79' +
        'M6 2.95L7 1.84M6 2.95L5 1.84M8.64 4.47L10.11 4.79M8.64 4.47L9.1 3.05"/></g></svg>' },
};
const CARGO_CYCLE = ['dry', 'hazmat', 'reefer'];
const KIND_PAINT = ['#c96a2a', '#e9e5d7', '#8f918a', '#2f5b7e'];   // paint order, first four

const CHEV_L = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1 5 5 9 1" transform="rotate(90 5 3)"/></svg>';
const CHEV_R = '<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1 5 5 9 1" transform="rotate(-90 5 3)"/></svg>';

/* ==================== CUSTOMER GATE ==================== */
/* demo variant — never auto-redirects; a non-empty ledger just
   earns a "→ DASHBOARD" chip in the header.                    */
(async () => {
  if (forceNew) return;
  let has = null;
  try {
    const r = await fetch(`${API}/orders`);
    if (r.ok) {
      const list = await r.json();
      has = Array.isArray(list) && list.length > 0;
      try { localStorage.setItem(ORDERS_KEY, JSON.stringify(list)); } catch (e) {}
    }
  } catch (e) { /* offline — check the cache */ }
  if (has === null) {
    try { has = (JSON.parse(localStorage.getItem(ORDERS_KEY)) || []).length > 0; }
    catch (e) { has = false; }
  }
  if (has) $('dashChip').hidden = false;
})();

/* ==================== PORT SELECTS ==================== */
const selO = $('selOrigin'), selD = $('selDest');

async function loadPorts() {
  try {
    const r = await fetch(`${API}/ports`);
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list) && list.length) {
        PORT_LIST = list.map(p => p.port_id);
        PORT_MAP = {};
        list.forEach(p => { PORT_MAP[p.port_id] = p.name; });
      }
    }
  } catch (e) { /* fallback stands */ }
  if (!PORT_LIST.length) PORT_LIST = FALLBACK.map(p => p.port_id);
  if (PORT_MAP[PORT_LIST[0]] === undefined) FALLBACK.forEach(p => { if (!PORT_MAP[p.port_id]) PORT_MAP[p.port_id] = p.name; });
  fillOrigin();
  fillDest();
  reink({ origin: true, dest: true });
}

function fillOrigin() {
  selO.innerHTML = PORT_LIST.map(id =>
    `<option value="${id}"${id === S.origin ? ' selected' : ''}>${id} · ${portName(id)}</option>`).join('');
}
function fillDest() {
  const lanes = SERVABLE[S.origin] || [];
  if (!lanes.includes(S.dest)) S.dest = lanes[0] || '';
  selD.innerHTML = lanes.map(id =>
    `<option value="${id}"${id === S.dest ? ' selected' : ''}>${id} · ${portName(id)}</option>`).join('');
}
selO.addEventListener('change', () => {
  S.origin = selO.value;
  const prev = S.dest;
  fillDest();
  reink({ origin: true, dest: prev !== S.dest });
  clearBad();
});
selD.addEventListener('change', () => {
  S.dest = selD.value;
  reink({ dest: true });
  clearBad();
});

/* ==================== CONSIGNMENT LINES ==================== */
const kindsEl = $('kinds');
const addBtn = $('addKind');

function buildKind(idx) {
  const el = document.createElement('div');
  el.className = 'kind';
  el.dataset.i = idx;

  const k = S.kinds[idx];
  el.innerHTML =
    `<span class="k-ln">LINE ${idx + 1}</span>` +
    `<button class="k-cargo" type="button" data-cargo="${k.cargo}"></button>` +
    `<div class="k-teu">
       <div class="btq">${BUCKETS.map(b => `<button type="button" data-v="${b.v}"${b.v === k.teu ? ' class="on"' : ''}>${b.l}·${b.v}</button>`).join('')}</div>
       <div class="fld">
         <div class="stepper st-h">
           <button class="sbtn" type="button" data-d="-1" aria-label="fewer TEU">${CHEV_L}</button>
           <div class="sval kteu" tabindex="0" role="spinbutton" aria-valuemin="1" aria-valuemax="99"
                aria-valuenow="${k.teu}" aria-label="TEU quantity" title="scroll or arrow keys">${k.teu}</div>
           <button class="sbtn" type="button" data-d="1" aria-label="more TEU">${CHEV_R}</button>
         </div>
       </div>
     </div>` +
    `<div class="k-wt">
       <div class="fld">
         <div class="wt-in">
           <input class="kwt" type="number" min="0" step="0.5" value="${k.weight.toFixed(1)}"
                  aria-label="gross weight in tonnes" />
           <span class="u">T</span>
         </div>
         <div class="wt-hint">≈ 11 T PER TEU · HAND-ADJUSTED</div>
       </div>
     </div>` +
    `<button class="k-del" type="button" aria-label="remove line">✕</button>`;

  const cargoBtn = el.querySelector('.k-cargo');
  const paintCargo = () => {
    cargoBtn.dataset.cargo = k.cargo;
    cargoBtn.innerHTML = `<span class="cg-ic">${CARGO[k.cargo].ic}</span>`;
    cargoBtn.title = `CARGO — ${CARGO[k.cargo].t} · CLICK TO CHANGE`;
    cargoBtn.setAttribute('aria-label', `cargo type ${CARGO[k.cargo].t.toLowerCase()}, click to change`);
  };
  cargoBtn.addEventListener('click', () => {
    k.cargo = CARGO_CYCLE[(CARGO_CYCLE.indexOf(k.cargo) + 1) % CARGO_CYCLE.length];
    paintCargo();
    reink({ kick: true });
    clearBad();
  });
  paintCargo();

  /* TEU — buckets + stepper; weight follows at 11 t/TEU unless inked by hand */
  const teuVal = el.querySelector('.kteu');
  const btq = [...el.querySelectorAll('.btq button')];
  const wtIn = el.querySelector('.kwt');
  const paintTeu = () => {
    teuVal.textContent = k.teu;
    teuVal.setAttribute('aria-valuenow', k.teu);
    btq.forEach(b => b.classList.toggle('on', +b.dataset.v === k.teu));
  };
  const setTeu = v => {
    k.teu = clamp(Math.round(v), 1, 99);
    if (!k.manual) { k.weight = +(k.teu * 11).toFixed(1); wtIn.value = k.weight.toFixed(1); }
    paintTeu();
    reink();
    clearBad();
  };
  btq.forEach(b => b.addEventListener('click', () => setTeu(+b.dataset.v)));
  el.querySelectorAll('.k-teu .sbtn').forEach(b =>
    b.addEventListener('click', () => setTeu(k.teu + (+b.dataset.d))));
  teuVal.addEventListener('wheel', e => { e.preventDefault(); setTeu(k.teu + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  teuVal.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setTeu(k.teu + 1); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setTeu(k.teu - 1); e.preventDefault(); }
  });

  wtIn.addEventListener('input', () => {
    const v = parseFloat(wtIn.value);
    k.manual = true;
    k.weight = isNaN(v) ? 0 : v;
    reink();
    clearBad();
  });

  el.querySelector('.k-del').addEventListener('click', () => {
    if (S.kinds.length <= 1) return;
    S.kinds.splice(S.kinds.indexOf(k), 1);
    el.remove();
    renumber();
    reink({ kick: true });
  });
  return el;
}

function renumber() {
  [...kindsEl.querySelectorAll('.kind')].forEach((el, i) => {
    el.dataset.i = i;
    el.querySelector('.k-ln').textContent = 'LINE ' + (i + 1);
    el.style.setProperty('--cc', KIND_PAINT[i]);
    el.querySelector('.k-del').style.visibility = S.kinds.length <= 1 ? 'hidden' : 'visible';
  });
  addBtn.disabled = S.kinds.length >= MAX_KINDS;
  addBtn.textContent = S.kinds.length >= MAX_KINDS ? '— WAYBILL FULL' : '+ ADD COMMODITY LINE';
}

function addKind() {
  if (S.kinds.length >= MAX_KINDS) return;
  const teu = BUCKETS[1].v;
  S.kinds.push({ cargo: 'dry', teu, weight: +(teu * 11).toFixed(1), manual: false });
  const el = buildKind(S.kinds.length - 1);
  el.style.setProperty('--cc', KIND_PAINT[S.kinds.length - 1]);
  kindsEl.appendChild(el);
  renumber();
  reink({ kick: true });
}
addBtn.addEventListener('click', addKind);

/* ==================== SEGMENT & SCHEDULE ==================== */
document.querySelectorAll('.seg').forEach(b => {
  b.addEventListener('click', () => {
    S.segment = b.dataset.seg;
    if (S.segment === 'urgent') S.flex = 0;
    document.querySelectorAll('.seg').forEach(x => {
      const on = x.dataset.seg === S.segment;
      x.classList.toggle('on', on);
      x.setAttribute('aria-checked', on);
    });
    paintSched();
    reink({ kick: true });
    clearBad();
  });
});

const depEl = $('depVal'), flexEl = $('flexVal');
function paintSched() {
  depEl.textContent = S.dep.toFixed(1);
  depEl.setAttribute('aria-valuenow', S.dep);
  flexEl.textContent = S.flex;
  flexEl.setAttribute('aria-valuenow', S.flex);
}
function setDep(v) { S.dep = clamp(Math.round(v * 2) / 2, 0.5, 60); paintSched(); reink(); clearBad(); }
function setFlex(v) { S.flex = clamp(Math.round(v), 0, 14); paintSched(); reink(); clearBad(); }
document.querySelectorAll('.st-h .sbtn[data-k]').forEach(b => {
  b.addEventListener('click', () => {
    if (b.dataset.k === 'dep') setDep(S.dep + (+b.dataset.d));
    else setFlex(S.flex + (+b.dataset.d));
  });
});
depEl.addEventListener('wheel', e => { e.preventDefault(); setDep(S.dep + (e.deltaY < 0 ? 0.5 : -0.5)); }, { passive: false });
flexEl.addEventListener('wheel', e => { e.preventDefault(); setFlex(S.flex + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
depEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setDep(S.dep + 0.5); e.preventDefault(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setDep(S.dep - 0.5); e.preventDefault(); }
});
flexEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setFlex(S.flex + 1); e.preventDefault(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setFlex(S.flex - 1); e.preventDefault(); }
});
document.querySelector('.seg[data-seg="standard"]').classList.add('on');
paintSched();

/* ==================== RE-INK THE CREDENTIAL ==================== */
const credHang = $('credHang');
let kickTimer = null;
/* force a style flush so a re-added animation class replays */
function reflow(el) {
  if (el.getBBox) { try { el.getBBox(); return; } catch (e) {} }
  void el.offsetWidth;
}
function kick() {
  credHang.classList.remove('kick');
  reflow(credHang);
  credHang.classList.add('kick');
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => credHang.classList.remove('kick'), 600);
}

function slamStamp(g) {
  g.classList.remove('slam');
  reflow(g);
  requestAnimationFrame(() => g.classList.add('slam'));
}

function drawBarcode(seed) {
  const c = $('bcode'), x = c.getContext('2d');
  const r = mulberry(seed);
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = '#16181d';
  let px = 4;
  while (px < c.width - 6) {
    const w = 1 + ((r() * 3) | 0);
    if (r() < 0.74) x.fillRect(px, 1, w, c.height - 4);
    px += w + 1 + (r() < 0.4 ? 1 : 0);
  }
  x.fillRect(2, 1, 1, c.height - 1);
  x.fillRect(c.width - 3, 1, 1, c.height - 1);
  /* caption digits straight from the seed — the barcode really re-seeds */
  const cap = (seed % 100000000).toString().padStart(8, '0');
  $('bcodeCap').textContent = cap.slice(0, 4) + ' ' + cap.slice(4);
}

function reink(chg = {}) {
  const totTeu = S.kinds.reduce((s, k) => s + k.teu, 0);
  const totWt = S.kinds.reduce((s, k) => s + k.weight, 0);
  const n = S.kinds.length;

  /* waybill footer totals */
  setG($('totTeu'), totTeu + ' TEU');
  setG($('totWt'), totWt.toFixed(1) + ' T');
  setG($('totOrd'), String(n));

  /* card identity rows */
  $('cRoute').textContent = `${portName(S.origin)} → ${portName(S.dest)}`;
  $('cSeg').textContent = S.segment.toUpperCase();
  $('cLines').textContent = n + (n === 1 ? ' LINE' : ' LINES');
  $('cDept').textContent = `FCL · ${S.segment.toUpperCase()} TIER`;

  /* port stamps */
  if (chg.origin) {
    $('cCityO').textContent = portName(S.origin);
    $('cCodeO').textContent = code3(S.origin);
    $('cDateO').textContent = S.origin;
    slamStamp($('stampO'));
  }
  if (chg.dest) {
    $('cCityD').textContent = portName(S.dest);
    $('cCodeD').textContent = code3(S.dest);
    $('cDateD').textContent = S.dest;
    slamStamp($('stampD'));
  }
  if (chg.origin || chg.dest) {
    const leg = $('cLeg');
    leg.classList.remove('pp-run');
    reflow(leg);
    leg.classList.add('pp-run');
    kick();
  }

  /* stats */
  setG($('sTeu'), String(totTeu));
  $('sTeuSub').textContent = totTeu === 1 ? 'TEU' : 'TEU';
  setG($('sWt'), totWt.toFixed(1));
  setG($('sDep'), 'D' + S.dep.toFixed(1));
  $('sDepSub').textContent = S.flex === 0 ? 'FIXED DAY' : '± ' + S.flex + ' DAYS';

  /* cargo chips — one disc per consignment line */
  $('cCargo').innerHTML = S.kinds.map(k =>
    `<span class="chip" data-cargo="${k.cargo}">${CARGO[k.cargo].ic}</span>`).join('');

  /* microtext + barcode re-seed from the whole form */
  const seedStr = `${S.origin}${S.dest}|${S.kinds.map(k => k.cargo[0] + k.teu + 'x' + k.weight).join(',')}|${S.segment}|${S.dep}|${S.flex}`;
  const seed = hashStr(seedStr);
  drawBarcode(seed);
  $('cMicro').textContent =
    `MERIDIAN LINE · WAYBILL WB-1047-Q2 · SEED ${String(seed % 100000).padStart(5, '0')} · ` +
    `${S.origin}→${S.dest} · VERIFY AT OPS.MERIDIANLINE.COM · MERIDIAN LINE · WAYBILL WB-1047-Q2 ·`;

  if (chg.kick) kick();
}

/* ==================== VALIDATION ==================== */
function clearBad() {
  document.querySelectorAll('.fld.bad').forEach(f => f.classList.remove('bad'));
  $('wbErr').hidden = true;
}
function note(txt) {
  $('wbErrTxt').textContent = txt;
  $('wbErr').hidden = false;
}
function validate() {
  clearBad();
  let ok = true;
  const lanes = SERVABLE[S.origin] || [];
  if (!lanes.includes(S.dest)) { $('fOrigin').classList.add('bad'); $('fDest').classList.add('bad'); ok = false; }
  if (!(S.dep >= 0.5)) { $('fDep').classList.add('bad'); ok = false; }
  if (!(S.flex >= 0)) { $('fFlex').classList.add('bad'); ok = false; }
  [...kindsEl.querySelectorAll('.kind')].forEach((el, i) => {
    const k = S.kinds[i];
    if (!(k.teu >= 1)) { el.querySelector('.k-teu .fld').classList.add('bad'); ok = false; }
    if (!(k.weight > 0)) { el.querySelector('.k-wt .fld').classList.add('bad'); ok = false; }
  });
  if (!ok) note('WAYBILL INCOMPLETE — CORRECT THE MARKED FIELDS');
  return ok;
}

/* ==================== FILE THE BOOKING ==================== */
const confirmBtn = $('confirmBtn');
confirmBtn.addEventListener('click', async () => {
  if (confirmBtn.disabled) return;
  if (!validate()) return;

  confirmBtn.classList.remove('slam');
  void confirmBtn.offsetWidth;
  confirmBtn.classList.add('slam');
  confirmBtn.disabled = true;

  const bodies = S.kinds.map(k => ({
    origin: S.origin,
    dest: S.dest,
    teu: k.teu,
    weight_t: +k.weight.toFixed(2),
    cargo_type: k.cargo,
    segment: S.segment,
    req_dep_day: +S.dep.toFixed(2),
    flex_days: S.flex,
  }));

  try {
    const created = await Promise.all(bodies.map(b =>
      fetch(`${API}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      }).then(async r => {
        if (!r.ok) {
          let detail = 'HTTP ' + r.status;
          try { const j = await r.json(); if (j && j.detail) detail = j.detail; } catch (e) {}
          throw { api: true, detail };
        }
        return r.json();
      })));
    try {
      const cache = JSON.parse(localStorage.getItem(ORDERS_KEY)) || [];
      localStorage.setItem(ORDERS_KEY, JSON.stringify(created.concat(cache)));
    } catch (e) {}
    fileAway();
  } catch (err) {
    if (err && err.api) {
      /* 422 & friends — stamp the clerk's note, let them fix it */
      note(String(err.detail).toUpperCase());
      confirmBtn.disabled = false;
    } else {
      /* API unreachable — mirror into the local ledger, still file */
      try {
        const orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || [];
        bodies.forEach((b, i) => orders.push({
          id: 'BK-' + (2500 + orders.length + i) + '-WB',
          status: 'PENDING REVIEW',
          ...b,
          progress: 0, created: Date.now() / 1000,
        }));
        localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
      } catch (e) {}
      fileAway();
    }
  }
});

function fileAway() {
  $('filedStamp').classList.add('landed');
  $('cStatus').textContent = 'FILED';
  $('bandT').innerHTML = 'BOOKING REQUEST&nbsp;&nbsp;—&nbsp;&nbsp;FILED';
  kick();
  setTimeout(() => { location.href = DASH; }, 1150);
}

/* ==================== BOOT ==================== */
addKind();          // first consignment line
renumber();
reink({ origin: true, dest: true });
loadPorts();
