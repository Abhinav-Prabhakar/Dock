'use strict';
/* ============================================================
   MERIDIAN LINE — CUSTOMER FLEET (merged dashboard)
   ------------------------------------------------------------
   The waybill register and the credential wall share the left
   pane, switched by the top-bar toggle. The right column is the
   pinned tracking chart at near-full viewport height (maplibre-gl
   on a fully inline style — no tiles, no keys — dateline-safe
   great-circle routes, vessel markers, seeded soundings, compass
   rose and a pinned detail note), with the serif fleet counters
   pinned under the views. Clicking a row, badge, route or vessel
   selects the same order everywhere.

   Data is live: DockAPI.orders() / DockAPI.ports() (shared/api.js,
   the Dock backend). No cache and no embedded fallback: if the API
   is unreachable the page says so. QUOTED orders reopen the
   rate-quotation slip (shared/offers.js) to accept or decline.
   ============================================================ */

/* ----------------------------- helpers ----------------------------- */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => n.toLocaleString('en-US');
const fmtUSD = n => 'USD ' + num(n || 0);

/* ============================== API ============================== */
/* all backend access goes through window.DockAPI (../shared/api.js) */
const MABR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

/* --------------------------- port gazetteer --------------------------- */
let PORTS = {};
const portOf = c => PORTS[c] || { city: c || '—', lon: 0, lat: 0 };

/* status registry — stage drives milestones, ink drives stamps/routes */
const ST = {
  'PENDING REVIEW': { short: 'REVIEW',    stage: 0, ink: 'terra' },
  'QUOTED':         { short: 'QUOTED',    stage: 0, ink: 'terra' },
  'NO OFFER':       { short: 'NO OFFER',  stage: 0, ink: 'faint' },
  'DECLINED':       { short: 'DECLINED',  stage: 0, ink: 'faint' },
  'EXPIRED':        { short: 'EXPIRED',   stage: 0, ink: 'faint' },
  'CONFIRMED':      { short: 'CONFIRMED', stage: 1, ink: 'ink'   },
  'LOADING':        { short: 'LOADING',   stage: 2, ink: 'ink'   },
  'IN TRANSIT':     { short: 'TRANSIT',   stage: 3, ink: 'sage'  },
  'AT PORT':        { short: 'AT PORT',   stage: 4, ink: 'sage'  },
  'DELIVERED':      { short: 'DELIVERED', stage: 5, ink: 'faint' },
};
const stOf = o => ST[(o.status || '').toUpperCase()] || ST['CONFIRMED'];
const ATTN = new Set(['PENDING REVIEW', 'QUOTED']);
const ST_INK = {
  'PENDING REVIEW': '#b96f4b',
  'QUOTED':         '#b96f4b',
  'NO OFFER':       '#908d81',
  'DECLINED':       '#908d81',
  'EXPIRED':        '#908d81',
  'CONFIRMED':      '#3a5a44',
  'LOADING':        '#3a5a44',
  'IN TRANSIT':     '#3a5a44',
  'AT PORT':        '#3a5a44',
  'DELIVERED':      '#908d81',
};
const MILESTONES = ['FILED', 'REVIEWED', 'LOADED', 'SAILED', 'ARRIVED', 'DELIVERED'];

let orders = [];
let newestId = null;

/* normalise an API order row to the display
   shape: origin/dest + one cargo_type → from/to + types[]; req_dep_day ±
   flex_days → window/eta strings expressed in sim days */
const CARGO_CANON = { dry: 'dry', haz: 'hazmat', hazmat: 'hazmat',
                      reef: 'reefer', reefer: 'reefer' };

function normalize(o, i) {
  o.from   = o.origin || o.from;
  o.to     = o.dest   || o.to;
  o.status = (o.status || 'CONFIRMED').toUpperCase();
  o.teu    = o.teu || (o.types || []).reduce((s, t) => s + (t.units || 0), 0) || 1;

  const kgPer = o.weight_t ? (o.weight_t * 1000) / o.teu : 2400;
  o.types = (Array.isArray(o.types) && o.types.length ? o.types
           : [{ cargo: o.cargo_type || 'dry', kg: Math.round(kgPer), units: o.teu }])
      .map(t => ({ cargo: CARGO_CANON[t.cargo] || 'dry',
                   kg: t.kg || 2400, units: t.units || 1 }));

  if (o.created && o.created < 1e12) o.created *= 1000;   // unix s → ms
  o.created  = o.created || Date.now();
  o.progress = clamp(o.progress || 0, 0, 1);
  // vessel/voyage/eta exist only once an offer is accepted — never invented
  o.vessel   = o.vessel ? 'MV ' + String(o.vessel).toUpperCase() : null;
  o.voyage   = o.voyage || null;
  o.price    = o.price_usd != null ? o.price_usd : o.price;
  o.ocean    = o.ocean || OCEAN_OF[o.from] || '—';

  /* scheduling — sim-day window/eta when the API row carries them */
  if (o.req_dep_day != null) {
    const lo = Math.max(0, Math.round(o.req_dep_day - (o.flex_days || 0)));
    const hi = Math.round(o.req_dep_day + (o.flex_days || 0));
    o.window  = o.window || (lo === hi ? `DAY ${hi}` : `D+${lo} → D+${hi}`);
    o._etaDay = o.req_dep_day + daysOf(o);
  }
  o.eta = o.eta || 'TBC';
  return o;
}

/* ocean of loading, for the register's vessel sub-line */
const OCEAN_OF = {
  CNSHA: 'E. CHINA SEA', SGSIN: 'SINGAPORE STR.', KRPUS: 'KOREA STR.',
  NLRTM: 'NORTH SEA', DEHAM: 'ELBE', BEANR: 'SCHELDT',
  USLAX: 'SAN PEDRO BAY', USNYC: 'NY HARBOR',
};

/* ------------------------- derived figures ------------------------- */
const units = o => (o.types || []).reduce((s, t) => s + (t.units || 0), 0);
const grossKg = o => (o.types || []).reduce((s, t) => s + (t.kg || 0) * (t.units || 0), 0);
const CARGO_NAME = { dry: 'DRY', hazmat: 'HAZMAT', reefer: 'REEFER' };

/* eta 'DD MON' or 'D+n' → days from sim-day 0 (today), else null */
function etaDays(eta, o) {
  const d = /^D\+(\d+)$/.exec(eta || '');
  if (d) return Math.max(0, Math.round(+d[1] - (o && o._simDay || 0)));
  const m = /^(\d{1,2})\s+([A-Z]{3})$/.exec(eta || '');
  if (!m) return null;
  const mo = MABR.indexOf(m[2]);
  if (mo < 0) return null;
  const now = new Date();
  let dd = new Date(now.getFullYear(), mo, +m[1]);
  if (dd < new Date(now.getFullYear(), now.getMonth(), now.getDate()))
    dd = new Date(now.getFullYear() + 1, mo, +m[1]);
  return Math.round((dd - now) / 864e5);
}

const fmtDate = ms => {
  const d = new Date(ms || Date.now());
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MABR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/* --------------------- hand-drawn glyph registries --------------------- */
/* small stroke icons — cargo chips, detail rows, milestone dots */
const IC = {
  dry:  '<svg viewBox="0 0 12 12"><rect x="1.6" y="3" width="8.8" height="6" fill="none" stroke="currentColor" stroke-width="1"/>' +
        '<path d="M4.4 3v6M7.6 3v6" stroke="currentColor" stroke-width=".6" fill="none"/></svg>',
  hazmat:'<svg viewBox="0 0 12 12"><g fill="currentColor">' +
        '<circle cx="6" cy="6" r="1.3"/>' +
        '<path d="M3.65 1.93A4.7 4.7 0 0 1 8.35 1.93L6.95 4.36A1.9 1.9 0 0 0 5.05 4.36Z"/>' +
        '<path d="M10.7 6A4.7 4.7 0 0 1 8.35 10.07L6.95 7.64A1.9 1.9 0 0 0 7.9 6Z"/>' +
        '<path d="M3.65 10.07A4.7 4.7 0 0 1 1.3 6L4.1 6A1.9 1.9 0 0 0 5.05 7.64Z"/></g></svg>',
  reefer:'<svg viewBox="0 0 12 12"><g fill="none" stroke="currentColor"' +
        ' stroke-width="1.1" stroke-linecap="round">' +
        '<path d="M10.16 8.4L1.84 3.6M6 10.8L6 1.2M1.84 8.4L10.16 3.6"/>' +
        '<path d="M8.64 7.52L9.1 8.95M8.64 7.52L10.11 7.21M6 9.05L5 10.16M6 9.05L7 10.16' +
        'M3.36 7.52L1.89 7.21M3.36 7.52L2.9 8.95M3.36 4.47L2.9 3.05M3.36 4.47L1.89 4.79' +
        'M6 2.95L7 1.84M6 2.95L5 1.84M8.64 4.47L10.11 4.79M8.64 4.47L9.1 3.05"/></g></svg>',
  flag: '<svg viewBox="0 0 12 12"><path d="M3.2 10.6V2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' +
        '<path d="M3.2 2.2h5.9l-1.7 1.9 1.7 1.9H3.2z" fill="currentColor"/></svg>',
  check:'<svg viewBox="0 0 12 12"><path d="M2 6.5 4.8 9.1 10 3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ship: '<svg viewBox="0 0 24 14"><path d="M1.8 8.8h17.2l-2.4 3H4.2z" fill="currentColor"/>' +
        '<rect x="3.6" y="4.6" width="2" height="4.2" fill="currentColor"/>' +
        '<rect x="7" y="5.6" width="3" height="3.2" fill="currentColor"/>' +
        '<rect x="10.6" y="5.6" width="3" height="3.2" fill="currentColor" opacity=".72"/>' +
        '<rect x="14.2" y="5.6" width="3" height="3.2" fill="currentColor" opacity=".5"/>' +
        '<path d="M21.4 9.8l2 1M20.8 11.4l2.4.5" stroke="currentColor" stroke-width=".8" fill="none" stroke-linecap="round"/></svg>',
  anchor:'<svg viewBox="0 0 12 12"><circle cx="6" cy="2.3" r="1.35" fill="none" stroke="currentColor" stroke-width="1"/>' +
        '<path d="M6 3.7v5.9M3.3 6h5.4M2.5 7.5c.2 1.8 1.7 2.7 3.5 2.7s3.3-.9 3.5-2.7M2.5 7.5l-.95-.9M2.5 7.5l1.05-.75M9.5 7.5l.95-.9M9.5 7.5l-1.05-.75"' +
        ' fill="none" stroke="currentColor" stroke-width=".95" stroke-linecap="round"/></svg>',
  cal:  '<svg viewBox="0 0 12 12"><rect x="1.6" y="2.4" width="8.8" height="8" rx=".8" fill="none" stroke="currentColor" stroke-width="1"/>' +
        '<path d="M1.6 4.9h8.8M4.1 1.4v2M7.9 1.4v2" stroke="currentColor" stroke-width="1" fill="none" stroke-linecap="round"/></svg>',
  gauge:'<svg viewBox="0 0 12 12"><path d="M1.7 9.7a5 5 0 0 1 8.6 0" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>' +
        '<path d="M6 9.5 8.4 5.6" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><circle cx="6" cy="9.5" r=".95" fill="currentColor"/></svg>',
};
const CARGO_IC = {
  dry: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="3" width="9" height="6" rx=".5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M3.9 3v6M6 3v6M8.1 3v6" stroke="currentColor" stroke-width=".7" fill="none"/></svg>',
  hazmat: IC.hazmat.replace('<svg ', '<svg aria-hidden="true" '),
  reefer: IC.reefer.replace('<svg ', '<svg aria-hidden="true" '),
};
const CARGO_ICON = { dry: IC.dry, hazmat: IC.hazmat, reefer: IC.reefer };
const MILE_ICONS = [IC.flag, IC.check, IC.dry, IC.ship, IC.anchor, IC.check];

/* milestone stamp icons for the ledger sheet (drawn in a 34 viewBox) */
const MS_IC = [
  '<path d="M3.4 1.8h3.4L9.4 4.4v6h-6z"/><path d="M6.6 1.9v2.7h2.8"/>',
  '<path d="M2.6 6.5l2.5 2.7 4.3-5.6"/>',
  '<rect x="1.6" y="3.4" width="8.8" height="5.2" rx=".5"/><path d="M4 3.4v5.2M6 3.4v5.2M8 3.4v5.2"/>',
  '<path d="M1.7 6.9h8.6l-1.4 2.4H3z"/><path d="M3 6.9V4.7h1.9v2.2M5.8 6.9V5.4h1.9v1.5"/>',
  '<circle cx="6" cy="2.1" r=".9"/><path d="M6 3v6.9M3.7 4.7h4.6"/><path d="M2.9 7.6c0 1.8 1.4 2.9 3.1 2.9s3.1-1.1 3.1-2.9M2.9 7.6l-.8.8M9.1 7.6l.8.8"/>',
  '<path d="M3.2 1.6v8.8"/><path d="M3.2 2.2h5.6l-1.5 1.9 1.5 1.9H3.2"/>',
];

/* little freighter glyph — east-pointing hull, rotate by heading */
function shipGlyph() {
  return '<path d="M-9 1.2 H 8 L 5.6 4.6 H -6.9 Z" fill="#2f2b24"/>' +
    '<rect x="-8.4" y="-3.8" width="2.5" height="5" fill="#ece4cd" stroke="rgba(22,18,10,.35)" stroke-width=".35"/>' +
    '<rect x="-8" y="-5" width="1.7" height="1.3" fill="#b96f4b"/>' +
    '<rect x="-4.9" y="-2.1" width="3.4" height="3.3" fill="#3a5a44" stroke="rgba(22,18,10,.35)" stroke-width=".3"/>' +
    '<rect x="-1.1" y="-2.1" width="3.4" height="3.3" fill="#b96f4b" stroke="rgba(22,18,10,.35)" stroke-width=".3"/>' +
    '<rect x="2.7" y="-2.1" width="3.4" height="3.3" fill="#a8843e" stroke="rgba(22,18,10,.35)" stroke-width=".3"/>' +
    '<path d="M-10.2 6h-3.4M-8.4 7.4h-4.8" stroke="rgba(58,90,68,.35)" stroke-width=".7" fill="none"/>';
}

/* ==================== GEO MATH — great circles ==================== */
const D2R = Math.PI / 180;
function nmBetween(a, b) {
  const la1 = a.lat * D2R, la2 = b.lat * D2R;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin(((b.lon - a.lon) * D2R) / 2) ** 2;
  return Math.round(3440.065 * 2 * Math.asin(Math.sqrt(h)));
}
const daysOf = o => Math.max(8, Math.round(nmBetween(portOf(o.from), portOf(o.to)) / 450));

/* ~n interpolated points on the shortest great-circle arc; lons UNWRAPPED
   (continuous across the antimeridian) so callers can split where needed */
function gcArc(a, b, n = 42) {
  const la1 = a.lat * D2R, lo1 = a.lon * D2R;
  const la2 = b.lat * D2R, lo2 = b.lon * D2R;
  const x1 = Math.cos(la1) * Math.cos(lo1), y1 = Math.cos(la1) * Math.sin(lo1), z1 = Math.sin(la1);
  const x2 = Math.cos(la2) * Math.cos(lo2), y2 = Math.cos(la2) * Math.sin(lo2), z2 = Math.sin(la2);
  const ang = Math.acos(clamp(x1 * x2 + y1 * y2 + z1 * z2, -1, 1)) || 1e-6;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const f = Math.sin((1 - t) * ang) / Math.sin(ang);
    const g = Math.sin(t * ang) / Math.sin(ang);
    const x = f * x1 + g * x2, y = f * y1 + g * y2, z = f * z1 + g * z2;
    pts.push([Math.atan2(y, x) / D2R, Math.asin(clamp(z, -1, 1)) / D2R]);
  }
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][0] - pts[i - 1][0] > 180)  pts[i][0] -= 360;
    while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  }
  return pts;
}
const normLon = l => ((l + 180) % 360 + 360) % 360 - 180;
/* split an unwrapped polyline into MultiLineString parts at the seam */
function splitAntimeridian(pts) {
  const parts = [[ [normLon(pts[0][0]), pts[0][1]] ]];
  for (let i = 1; i < pts.length; i++) {
    const nl = normLon(pts[i][0]);
    const prev = parts[parts.length - 1];
    const pl = prev[prev.length - 1][0];
    if (Math.abs(nl - pl) > 180) {
      const k = (180 * Math.sign(pts[i - 1][0]) - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      const lc = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k;
      prev.push([180 * Math.sign(pts[i - 1][0]), lc]);
      parts.push([[-180 * Math.sign(pts[i - 1][0]), lc], [nl, pts[i][1]]]);
    } else {
      prev.push([nl, pts[i][1]]);
    }
  }
  return parts;
}
function arcPos(pts, t) {
  const i = clamp(t, 0, 1) * (pts.length - 1);
  const k = i | 0, f = i - k;
  const a = pts[k], b = pts[Math.min(k + 1, pts.length - 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
function arcHeading(pts, t) {
  const a = arcPos(pts, Math.max(0, t - 0.01)), b = arcPos(pts, Math.min(1, t + 0.01));
  const sec = 1 / Math.cos(clamp((a[1] + b[1]) / 2, -80, 80) * D2R);
  return Math.atan2(-(b[1] - a[1]) * sec, b[0] - a[0]) * 57.29578;
}
/* where the ship sits on its arc, by status */
const vesselT = o =>
  o.status === 'DELIVERED' ? 1 :
  o.status === 'IN TRANSIT' || o.status === 'AT PORT' ? clamp(o.progress || 0.5, 0.04, 0.97) :
  o.status === 'LOADING' ? 0.02 : 0;

/* seeded depth soundings — the speckled numerals of a real routing chart,
   scattered across the world ocean, clear of the ports themselves */
const SOUNDINGS = (() => {
  const r = mulberry(11407);
  const pts = [];
  while (pts.length < 34) {
    const lon = -175 + r() * 350;
    const lat = -5 + r() * 62;
    if (Object.values(PORTS).some(p =>
      Math.hypot((p.lon - lon), (p.lat - lat) * 1.4) < 8)) continue;
    pts.push({ lon, lat, n: 24 + Math.round(r() * 420) });
  }
  return pts;
})();

/* ============================ LEDGER VIEW ============================ */
const ledgerEl = document.getElementById('ledger');
const rngRow = mulberry(9377);

function stampSVG(text, ink, rot) {
  return `<svg class="stamp" viewBox="0 0 100 26" style="--st-ink:${ink}" aria-hidden="true">
    <g transform="rotate(${rot.toFixed(2)} 50 13)" filter="url(#stampInk)">
      <rect x="4" y="4" width="92" height="18" rx="2.2" class="st-o"/>
      <rect x="6.8" y="6.8" width="86.4" height="12.4" rx="1.2" class="st-i"/>
      <text x="50" y="15.6" text-anchor="middle" class="st-t">${esc(text)}</text>
    </g></svg>`;
}

function routeGlyph() {
  return '<svg width="20" height="6" viewBox="0 0 20 6" aria-hidden="true">' +
    '<path d="M.5 3 H15" stroke="#8f8a78" stroke-width=".9" stroke-dasharray="2.4 2" fill="none"/>' +
    '<path d="M13.6 1.3 L18.4 3 L13.6 4.7 Z" fill="#3a5a44"/></svg>';
}

/* seeded 8×3 vessel-bay stack, palette inks — shared by ledger + badges */
function stackSVG(seed, cls) {
  const r = mulberry(seed);
  const inks = ['#3a5a44', '#b96f4b', '#a8843e', '#ddd5bd', '#45423a'];
  const w = 6.6, h = 5.4, gx = 1.1, gy = 1.3;
  let s = '';
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 8; i++) {
      const x = i * (w + gx), y = j * (h + gy);
      s += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w}" height="${h}"` +
           ` fill="${inks[(r() * inks.length) | 0]}" stroke="rgba(28,22,12,.30)" stroke-width=".4"/>` +
           `<path d="M${(x + w / 2).toFixed(2)} ${(y + .7).toFixed(2)}v${(h - 1.4).toFixed(2)}"` +
           ` stroke="rgba(20,14,6,.20)" stroke-width=".5" fill="none"/>`;
    }
  return `<svg class="${cls}" viewBox="0 0 60.5 18.8" preserveAspectRatio="xMinYMid meet" aria-hidden="true"><g>${s}</g></svg>`;
}

/* quadratic bezier point — for the sheet's sagging route strip */
function bez(p0, p1, p2, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
          u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

function buildOrder(o, idx) {
  const st = o.status;
  const ink = ST_INK[st] || '#3a5a44';
  const rot = -2.4 + rngRow() * 4.8;
  const teu = o.teu || units(o) || 1;
  const types = (o.types && o.types.length ? o.types : [{ cargo: 'dry', kg: 0, units: teu }]);
  const gross = grossKg(o) / 1000;
  const knownPair = PORTS[o.from] && PORTS[o.to];
  const nm = knownPair ? nmBetween(portOf(o.from), portOf(o.to)) : 0;
  const days = Math.max(8, Math.round(nm / 450));
  const mi = stOf(o).stage;
  const prog = clamp(o.progress !== undefined ? o.progress : mi / 5, 0, 1);
  const cnt = {};
  types.forEach(t => { cnt[t.cargo] = (cnt[t.cargo] || 0) + (t.units || 0); });
  const tipTxt = ['dry', 'reefer', 'hazmat'].filter(k => cnt[k])
    .map(k => `${CARGO_NAME[k]} ×${cnt[k]}`).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  /* route strip — sagging dashed leg, freighter at progress */
  const P0 = [20, 18], P1 = [140, 40], P2 = [260, 18];
  const st_ = clamp(prog, 0.06, 0.96);
  const [sx, sy] = bez(P0, P1, P2, st_);
  const [qx, qy] = bez(P0, P1, P2, Math.min(st_ + 0.02, 1));
  const hd = Math.atan2(qy - sy, qx - sx) * 57.29578;
  const routeStrip =
    `<svg class="rt-svg" viewBox="0 0 280 46" aria-hidden="true">
      <defs><marker id="rtm${idx}" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4.4" markerHeight="4.4" orient="auto">
        <path d="M0 .5 L5.6 3 L0 5.5 z" fill="#3a5a44"/></marker></defs>
      <text x="20" y="9.5" text-anchor="start" class="rt-p">${esc(o.from)} · ${esc(portOf(o.from).city)}</text>
      <text x="260" y="9.5" text-anchor="end" class="rt-p">${esc(o.to)} · ${esc(portOf(o.to).city)}</text>
      <path d="M20 18 Q140 40 260 18" fill="none" stroke="#3a5a44" stroke-width="1.1"
            stroke-dasharray="3.4 3" marker-end="url(#rtm${idx})"/>
      <circle cx="20" cy="18" r="3.4" fill="#f6f1e0" stroke="#3a5a44" stroke-width="1"/>
      <circle cx="260" cy="18" r="3.4" fill="#f6f1e0" stroke="#3a5a44" stroke-width="1"/>
      <circle cx="260" cy="18" r="1.5" fill="#b96f4b"/>
      <g transform="translate(${sx.toFixed(1)} ${(sy - 3.4).toFixed(1)}) rotate(${hd.toFixed(1)})">${shipGlyph()}</g>
    </svg>`;

  /* milestone stamp timeline */
  const miles = MILESTONES.map((m, k) => {
    const done = k <= mi;
    const now = k === mi && st !== 'DELIVERED';
    const mr = (-3 + mulberry(idx * 131 + k * 17 + 7)() * 6).toFixed(1);
    const rings = done
      ? `<g transform="rotate(${mr} 17 17)" filter="url(#mildInk)">
           <circle class="ms-ring-o" cx="17" cy="17" r="14.6"/>
           <circle class="ms-ring-i" cx="17" cy="17" r="11.7"/>
           <g transform="translate(11.2 11.2)" class="ms-ic">${MS_IC[k]}</g></g>`
      : `<g><circle class="ms-ring-o" cx="17" cy="17" r="14.6"/>
           <g transform="translate(11.2 11.2)" class="ms-ic">${MS_IC[k]}</g></g>`;
    return `<div class="mile${done ? ' done' : ''}${now ? ' now' : ''}">
      <svg class="ms" viewBox="0 0 34 34" aria-hidden="true">${rings}</svg>
      <span class="ms-cap">${m}</span></div>`;
  }).join('');

  const li = document.createElement('li');
  li.className = 'order rvl';
  li.dataset.oid = o.id;
  li.dataset.ink = ATTN.has(st) ? 'terra' : (st === 'DELIVERED' ? 'faint' : 'sage');
  li.innerHTML =
    `<button class="lrow" type="button" aria-expanded="false" aria-controls="sheet-${idx}"
       aria-label="${esc(o.id)} — ${esc(portOf(o.from).city)} to ${esc(portOf(o.to).city)}, ${st.toLowerCase()}">
      <span class="c-id"><b class="g" data-t="${esc(o.id)}">${esc(o.id)}</b><i>FILED ${fmtDate(o.created)}</i></span>
      <span class="c-route">${esc(o.from)}${routeGlyph()}${esc(o.to)}</span>
      <span class="c-cons"><b class="teu g" data-t="${teu}">${teu}</b><span class="tu">TEU</span>
        <span class="chips">${types.slice(0, 3).map(t => `<i class="cg" data-cargo="${esc(t.cargo)}" aria-hidden="true">${CARGO_IC[t.cargo] || CARGO_IC.dry}</i>`).join('')}</span></span>
      <span class="c-vessel"><b>${esc(o.vessel || '— AWAITING VESSEL')}</b><i>${esc(o.voyage || '—')} · ${esc(o.ocean || portOf(o.from).city.slice(0, 3))}</i></span>
      <span class="c-eta"><b class="g" data-t="${esc(o.eta || 'TBC')}">${esc(o.eta || 'TBC')}</b><i>${esc(o.window || '—')}</i></span>
      <span class="c-stamp">${stampSVG(st, ink, rot)}</span>
    </button>
    <div class="sheet" id="sheet-${idx}"><div class="sheet-clip"><div class="sheet-in">
      <div class="sh-l">
        <div class="sh-h">PASSAGE</div>
        <div class="sh-b">${routeStrip}
          <div class="rt-cap">${knownPair ? `≈ ${num(nm)} NM · ${days} DAYS AT SEA · ` : ''}${Math.round(prog * 100)}% COMPLETE</div>
        </div>
        <div class="sh-h">MILESTONES</div>
        <div class="sh-b"><div class="miles">${miles}</div></div>
      </div>
      <div class="sh-r">
        <div class="sh-h">CONSIGNMENT</div>
        <div class="consig consig-hot" tabindex="0"
             aria-label="${teu} TEU — ${esc(tipTxt.replace(/&nbsp;/g, ' ').replace(/·/g, ',').replace(/×/g, 'x').toLowerCase())}">
          <b class="consig-num g" data-t="${teu}">${teu}</b>
          <span class="consig-side">${stackSVG(idx * 991 + 2477, 'consig-stack')}<i class="consig-cap">TEU COMMITTED</i></span>
          <div class="tip" aria-hidden="true">${tipTxt}</div>
        </div>
        <div class="lrows">
          <div class="r"><span>Voyage</span><b>${esc(o.voyage || '—')}</b></div>
          <div class="r"><span>Window</span><b>${esc(o.window || '—')}</b></div>
          <div class="r"><span>Gross</span><b>${gross.toFixed(1)} T</b></div>
          <div class="r"><span>Rate</span><b class="g" data-t="${o.price != null ? fmtUSD(o.price) : '—'}">${o.price != null ? fmtUSD(o.price) : '—'}</b></div>
          <div class="r"><span>Filed</span><b>${fmtDate(o.created)}</b></div>
          <div class="r"><span>ETA</span><b>${esc(o.eta || 'TBC')} · ${esc(portOf(o.to).city)}</b></div>
        </div>
        ${st === 'QUOTED' ? `<button class="review-quote" type="button" data-review="${esc(o.id)}">Review quote →</button>` : ''}
      </div>
    </div></div></div>`;

  const rq = li.querySelector('[data-review]');
  if (rq) rq.addEventListener('click', e => { e.stopPropagation(); reviewQuote(o.id); });
  const btn = li.querySelector('.lrow');
  btn.addEventListener('click', () => {
    const open = li.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
    select(o.id);
  });
  o._li = li;
  return li;
}

/* ====================== CREDENTIAL WALL VIEW ====================== */
const wall = document.getElementById('wall');

const MARK = color => `<svg class="mark" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.6" y="5" width="14.8" height="10" rx="1.1" fill="none" stroke="${color}" stroke-width="1.4"/><path d="M6.2 5v10M9.8 5v10M13.4 5v10M16.2 6.4v7.2" stroke="${color}" stroke-width=".9" fill="none"/></svg>`;

const GROMMET =
  `<svg class="grom" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r="11" fill="url(#gmBrass)"/>
    <circle cx="13" cy="13" r="11" fill="none" stroke="rgba(48,32,8,.42)" stroke-width=".7"/>
    <circle cx="13" cy="13" r="9.2" fill="none" stroke="rgba(255,248,220,.4)" stroke-width=".7"/>
    <circle cx="13" cy="13" r="7.1" fill="url(#gmHole)"/>
    <circle cx="13" cy="13" r="7.1" fill="none" stroke="rgba(20,12,4,.5)" stroke-width="1.3"/>
    <path d="M8 17.5 A7.1 7.1 0 0 0 18 17.5" fill="none" stroke="rgba(255,255,255,.4)" stroke-width=".8"/>
  </svg>`;

const RING =
  `<svg class="ring" viewBox="0 0 30 24" aria-hidden="true">
    <circle cx="15" cy="14" r="7.6" fill="none" stroke="url(#rBrass)" stroke-width="3"/>
    <circle cx="15" cy="14" r="9.3" fill="none" stroke="rgba(48,32,8,.30)" stroke-width=".5"/>
    <circle cx="15" cy="14" r="5.8" fill="none" stroke="rgba(48,32,8,.22)" stroke-width=".5"/>
    <path d="M9.6 9.4 A7.6 7.6 0 0 1 19.4 7.2" fill="none" stroke="rgba(255,248,220,.6)" stroke-width="1"/>
  </svg>`;

const GUILLOCHE =
  `<svg class="guil" viewBox="0 0 320 200" aria-hidden="true">
    <g fill="none" stroke="#7f9a82" stroke-width="0.45" opacity="0.55">
      <ellipse cx="160" cy="100" rx="158" ry="55"/>
      <ellipse cx="160" cy="100" rx="158" ry="55" transform="rotate(15 160 100)"/>
      <ellipse cx="160" cy="100" rx="158" ry="55" transform="rotate(30 160 100)"/>
      <ellipse cx="160" cy="100" rx="158" ry="55" transform="rotate(45 160 100)"/>
      <ellipse cx="160" cy="100" rx="158" ry="55" transform="rotate(60 160 100)"/>
      <ellipse cx="160" cy="100" rx="158" ry="55" transform="rotate(75 160 100)"/>
      <ellipse cx="160" cy="100" rx="136" ry="76" transform="rotate(8 160 100)"/>
      <ellipse cx="160" cy="100" rx="136" ry="76" transform="rotate(30 160 100)"/>
      <ellipse cx="160" cy="100" rx="136" ry="76" transform="rotate(52 160 100)"/>
      <ellipse cx="160" cy="100" rx="136" ry="76" transform="rotate(74 160 100)"/>
    </g>
  </svg>`;

const BGRAIN = '<svg class="grain" aria-hidden="true"><rect width="100%" height="100%" filter="url(#grainF)"/></svg>';

const BAND_MARK =
  `<svg class="band-mark" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2.6" y="5" width="14.8" height="10" rx="1.1" fill="none" stroke="rgba(240,238,228,.7)" stroke-width="1.3"/>
    <path d="M6.2 5v10M9.8 5v10M13.4 5v10" stroke="rgba(240,238,228,.7)" stroke-width=".8" fill="none"/>
  </svg>`;

const NEW_STAMP =
  `<svg class="newst" viewBox="0 0 60 36" aria-hidden="true">
    <g filter="url(#inkD)">
      <rect class="nr" x="3" y="4" width="54" height="28" rx="3" stroke-width="1.7"/>
      <rect class="nr" x="6.5" y="7.5" width="47" height="21" rx="1.4" stroke-width=".7"/>
      <text x="30" y="23.5" text-anchor="middle">NEW</text>
    </g>
  </svg>`;

/* peg + short braided cord stub hanging above each badge */
const PEGCORD =
  `<svg class="pegcord" viewBox="0 0 40 40" aria-hidden="true">
    <path d="M20 9 C 19.2 17, 20.8 25, 20 33" fill="none" stroke="#5a4128" stroke-width="3" stroke-linecap="round"/>
    <path d="M19.4 10 C 18.8 17, 20.2 24, 19.6 31.5" fill="none" stroke="rgba(255,224,180,.3)" stroke-width="1" stroke-linecap="round"/>
    <path d="M18.6 13.5h2.8M18.4 18.5h3.2M18.6 23.5h2.8M18.9 28.4h2.4" stroke="rgba(20,10,4,.4)" stroke-width=".8"/>
    <circle cx="20" cy="6.5" r="4.2" fill="url(#gmBrass)"/>
    <circle cx="20" cy="6.5" r="4.2" fill="none" stroke="rgba(48,32,8,.42)" stroke-width=".7"/>
    <circle cx="20" cy="6.5" r="1.5" fill="#7a5a24"/>
    <rect x="18.6" y="6.1" width="2.8" height=".8" rx=".4" fill="#3c2c10" transform="rotate(-24 20 6.5)"/>
  </svg>`;

/* seeded canvas barcode (same register as the booking credential) */
function drawBar(cv, seed) {
  const x = cv.getContext('2d'), r = mulberry(seed);
  x.clearRect(0, 0, cv.width, cv.height);
  x.fillStyle = '#16181d';
  let px = 3;
  while (px < cv.width - 5) {
    const w = 1 + ((r() * 3) | 0);
    if (r() < 0.74) x.fillRect(px, 1, w, cv.height - 6);
    px += w + 1 + (r() < 0.4 ? 1 : 0);
  }
  x.fillRect(1.5, 1, 1, cv.height - 3);
  x.fillRect(cv.width - 2.5, 1, 1, cv.height - 3);
}

const idSeed = o => (parseInt(String(o.id).replace(/\D/g, ''), 10) || 1) * 7919 + 2481;
const arrow = `<svg viewBox="0 0 15 8" aria-hidden="true"><path d="M.5 4H11" fill="none" stroke="#3a5a44" stroke-width="1" stroke-dasharray="2.4 1.8"/><path d="M9 1.4L13.5 4 9 6.6z" fill="#3a5a44"/></svg>`;

/* mini hub-route strip — booked leg, alternate arc, progress dot */
function rtSVG(o, prog) {
  const p = clamp(prog || 0, 0, 1);
  const dot = (p > 0 && p < 1)
    ? `<circle cx="${(12 + 196 * p).toFixed(1)}" cy="27" r="2.6" fill="#b96f4b" stroke="#f6f1e0" stroke-width=".9"/>` : '';
  return `<svg class="rts" viewBox="0 0 224 46">
    <path d="M12 27 C 60 8, 164 8, 208 25" fill="none" stroke="#b96f4b" stroke-width=".9" stroke-dasharray="2.6 3" opacity=".7"/>
    <path d="M12 27 H 203" fill="none" stroke="#3a5a44" stroke-width="1" stroke-dasharray="3.4 3"/>
    <path d="M203 27 L 211 27" fill="none" stroke="#3a5a44" stroke-width="1"/>
    <path d="M206 24 L 213 27 L 206 30 Z" fill="#3a5a44"/>
    <circle cx="112" cy="27" r="3" fill="#f6f1e0" stroke="#3a5a44" stroke-width="1"/>
    <circle cx="12"  cy="27" r="3.8" fill="none" stroke="#3a5a44" stroke-width="1"/>
    <circle cx="12"  cy="27" r="1.7" fill="#3a5a44"/>
    <circle cx="212" cy="27" r="3.8" fill="none" stroke="#3a5a44" stroke-width="1"/>
    <circle cx="212" cy="27" r="1.7" fill="#b96f4b"/>
    ${dot}
    <text class="hp" x="12"  y="40" text-anchor="middle">${esc(o.from)}</text>
    <text class="hp" x="112" y="40" text-anchor="middle">${esc(o.voyage || '')}</text>
    <text class="hp hp-alt" x="212" y="40" text-anchor="middle">${esc(o.to)}</text>
  </svg>`;
}

function badgeHTML(o, isNew) {
  const attn = ATTN.has(o.status);
  const from = portOf(o.from);
  const to = portOf(o.to);
  const seed = idSeed(o);
  const tilt = (mulberry(seed + 7)() * 3.4 - 1.7).toFixed(2);
  const pct = Math.round((o.progress || 0) * 100);
  const band = attn ? 'band attn' : 'band';
  const bandTxt = o.status === 'IN TRANSIT' ? `${o.status} · ${pct}%` : `${o.status}${o.eta && o.eta !== 'TBC' ? ' · ' + o.eta : ''}`;
  const tag = o.status.length > 12 ? o.status.replace(' REVIEW', '') : o.status;

  return `<div class="hook rvl" data-oid="${esc(o.id)}" style="--tilt:${tilt}deg; --swayd:${(mulberry(seed + 13)() * -9).toFixed(1)}s">
    ${PEGCORD}
    <button class="badge" type="button" data-id="${esc(o.id)}"
      aria-label="Booking ${esc(o.id)} — ${esc(from.city)} to ${esc(to.city)}, ${esc(o.status)}. Open manifest.">
      <span class="edge" aria-hidden="true"></span>
      <span class="face">
        ${GROMMET}${RING}${GUILLOCHE}
        <span class="bhead">
          ${MARK('#3a5a44')}
          <span class="b-org">MERIDIAN LINE<span>PACIFIC FREIGHT</span></span>
          <span class="tag${attn ? ' attn' : ''}">${esc(tag)}</span>
        </span>
        <span class="rule"></span>
        <span class="bid g" data-t="${esc(o.id)}">${esc(o.id)}</span>
        <span class="ports">${esc(o.from)}${arrow}<span class="pto">${esc(o.to)}</span></span>
        <span class="pcity">${esc(from.city)} → ${esc(to.city)}</span>
        <span class="brows">
          <span class="r"><span>VOYAGE</span><b>${esc(o.voyage || '—')}</b></span>
          <span class="r"><span>WINDOW</span><b>${esc(o.window || '—')}</b></span>
          <span class="r"><span>VESSEL</span><b>${esc(String(o.vessel || '—').replace('MV ', ''))}</b></span>
        </span>
        <span class="rt" aria-hidden="true">${rtSVG(o, pct / 100)}</span>
        <span class="micro">MERIDIAN LINE · BOOKING ${esc(o.id)} · VERIFY AT OPS.MERIDIANLINE.COM · MERIDIAN LINE · BOOKING ${esc(o.id)} · VERIFY AT</span>
        <span class="art">
          ${stackSVG(seed, 'stack')}
          <span class="barc-wrap"><canvas class="barc" width="88" height="24" data-seed="${seed}"></canvas><span class="bcap">${String(o.id).replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}</span></span>
        </span>
        <span class="${band}"><i class="dot"></i><span class="band-t">${esc(bandTxt)}</span>${BAND_MARK}</span>
        ${BGRAIN}
        ${isNew ? NEW_STAMP : ''}
      </span>
      <span class="lam" aria-hidden="true"></span>
    </button>
  </div>`;
}

/* ===================== MANIFEST SHEET (overlay) ===================== */
const msheetWrap = document.getElementById('msheet');
const msheetCard = document.getElementById('msheetCard');
let lastFocus = null;

function mRouteSVG(o) {
  const from = portOf(o.from);
  const to = portOf(o.to);
  const uid = String(o.id).replace(/\W/g, '');
  const nm = (PORTS[o.from] && PORTS[o.to]) ? nmBetween(portOf(o.from), portOf(o.to)) : null;
  const days = nm == null ? null : Math.max(8, Math.round(nm / 450));
  const legs = nm == null ? 'ROUTE DISTANCE ON FILE' : `≈ ${num(Math.round(nm))} NM · ${days} DAYS AT 450 NM/DAY` +
    (o.status === 'IN TRANSIT' ? ` · ${Math.round(o.progress * 100)}% COMPLETE` : '');
  const depTxt = o.window || `D+${Math.round(o.req_dep_day || 0)}`;
  return `<div class="msh-map">
    <svg viewBox="0 0 320 112" aria-hidden="true">
      <defs>
        <marker id="smk${uid}" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4.4" markerHeight="4.4" orient="auto">
          <path d="M0 .5 L5.6 3 L0 5.5 z" fill="#3a5a44"/>
        </marker>
        <path id="saA${uid}" d="M 30 55 A 22 22 0 0 1 74 55"/>
        <path id="saB${uid}" d="M 25 55 A 27 27 0 0 0 79 55"/>
        <path id="sbA${uid}" d="M 246 55 A 22 22 0 0 1 290 55"/>
        <path id="sbB${uid}" d="M 241 55 A 27 27 0 0 0 295 55"/>
      </defs>
      <path class="sm-alt" d="M 92 40 C 122 16 198 16 228 40"/>
      <path class="sm-route" id="smRoute" d="M 92 48 Q 160 84 228 48" marker-end="url(#smk${uid})"/>
      <g class="sm-stamp sm-org" filter="url(#inkD)">
        <circle class="sm-ghost" cx="53.4" cy="54.6" r="30"/>
        <circle class="sm-ring-out" cx="52" cy="55" r="30"/>
        <circle class="sm-ring-in" cx="52" cy="55" r="26.5"/>
        <circle class="sm-ring-in" cx="52" cy="55" r="15"/>
        <circle class="sm-sep" cx="31" cy="55" r="1.1"/>
        <circle class="sm-sep" cx="73" cy="55" r="1.1"/>
        <text class="sm-city"><textPath href="#saA${uid}" startOffset="50%" text-anchor="middle">${esc(from.city)}</textPath></text>
        <text class="sm-role"><textPath href="#saB${uid}" startOffset="50%" text-anchor="middle">ORIGIN</textPath></text>
        <text class="sm-code" x="52" y="52.5" text-anchor="middle">${esc(o.from)}</text>
        <text class="sm-date" x="52" y="61.5" text-anchor="middle">${esc(depTxt)}</text>
      </g>
      <g class="sm-stamp sm-dest" filter="url(#inkD)">
        <circle class="sm-ghost" cx="269.4" cy="54.6" r="30"/>
        <circle class="sm-ring-out" cx="268" cy="55" r="30"/>
        <circle class="sm-ring-in" cx="268" cy="55" r="26.5"/>
        <circle class="sm-ring-in" cx="268" cy="55" r="15"/>
        <circle class="sm-sep" cx="247" cy="55" r="1.1"/>
        <circle class="sm-sep" cx="289" cy="55" r="1.1"/>
        <text class="sm-city"><textPath href="#sbA${uid}" startOffset="50%" text-anchor="middle">${esc(to.city)}</textPath></text>
        <text class="sm-role"><textPath href="#sbB${uid}" startOffset="50%" text-anchor="middle">DESTINATION</textPath></text>
        <text class="sm-code" x="268" y="52.5" text-anchor="middle">${esc(o.to)}</text>
        <text class="sm-date" x="268" y="61.5" text-anchor="middle">${esc(o.voyage || '')}</text>
      </g>
      <text class="sm-dist" x="160" y="102" text-anchor="middle">${legs}</text>
      <g id="smShip"><g class="sm-ship">
        <path d="M-8.6 1.2 H 7.4 L 5.2 4.4 H -6.6 Z" fill="#2f2b24"/>
        <path d="M-8.6 1.2 H 7.4" stroke="rgba(240,235,215,.5)" stroke-width=".6" fill="none"/>
        <rect x="-8" y="-3.6" width="2.4" height="4.8" fill="#ece4cd" stroke="rgba(22,18,10,.3)" stroke-width=".3"/>
        <rect x="-7.6" y="-4.7" width="1.6" height="1.2" fill="#b96f4b"/>
        <rect x="-4.6" y="-2" width="3.2" height="3.2" fill="#3a5a44" stroke="rgba(22,18,10,.3)" stroke-width=".3"/>
        <rect x="-1" y="-2" width="3.2" height="3.2" fill="#b96f4b" stroke="rgba(22,18,10,.3)" stroke-width=".3"/>
        <rect x="2.6" y="-2" width="3.2" height="3.2" fill="#a8843e" stroke="rgba(22,18,10,.3)" stroke-width=".3"/>
        <path d="M-9.8 5.8h-3.2M-8 7.2h-4.6" stroke="rgba(58,90,68,.35)" stroke-width=".7" fill="none"/>
      </g></g>
    </svg>
  </div>`;
}

function timelineHTML(o) {
  const cur = stOf(o).stage;
  return `<div class="tl" aria-label="Shipment milestones">` + MILESTONES.map((m, i) => {
    const cls = i < cur ? 'done' : (i === cur ? (o.status === 'DELIVERED' ? 'done' : 'now') : '');
    return `<span class="tms ${cls}"><i class="tms-bar"></i><i class="tms-dot">${MILE_ICONS[i]}</i><i class="tms-lb">${m}</i></span>`;
  }).join('') + `</div>`;
}

function cargoHTML(o) {
  const u = units(o);
  const tip = (o.types || []).map(t =>
    `${CARGO_NAME[t.cargo] || 'DRY'} ×${t.units} · ${((t.kg * t.units) / 1000).toFixed(1)}T`).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  const chips = (o.types || []).map(t =>
    `<span class="mchip ${esc(t.cargo)}"><i class="mchip-ic">${CARGO_ICON[t.cargo] || IC.dry}</i><b>${CARGO_NAME[t.cargo] || 'DRY'} ×${t.units}</b><i>${((t.kg * t.units) / 1000).toFixed(1)} T</i></span>`
  ).join('');
  const seg = o.segment ? ` · ${o.segment.toUpperCase()}` : '';
  return `<div class="csum tip-anchor" tabindex="0"
      aria-label="${u} containers — ${(o.types || []).map(t => `${(CARGO_NAME[t.cargo] || 'DRY').toLowerCase()} ${t.units}`).join(', ')}">
      <span class="cnum g" data-t="${u}">${u}</span>
      <span class="lbl">CONTAINERS${esc(seg)} · HOVER FOR BREAKDOWN</span>
      <span class="tip" aria-hidden="true">${tip || 'NO CARGO LISTED'}</span>
    </div>
    <div class="cargo">${chips}</div>`;
}

function openManifest(o) {
  if (!o) return;
  lastFocus = document.activeElement;
  const attn = ATTN.has(o.status);
  const from = portOf(o.from);
  const to = portOf(o.to);
  msheetCard.innerHTML = `
    <div class="msh-head">
      <span class="msh-eyebrow">MERIDIAN LINE · ${esc(o.id)}</span>
      <span class="msh-tag${attn ? ' attn' : ''}">${esc(o.status)}</span>
      <button class="msh-x" type="button" data-close aria-label="Close manifest">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8"/></svg>
      </button>
    </div>
    <div class="msh-rule"></div>
    <div class="msh-title">
      <span class="msh-id g" data-t="${esc(o.id)}">${esc(o.id)}</span>
      <span class="msh-ports">${esc(o.from)} — ${esc(o.to)}</span>
      <span class="msh-route-note">${esc(from.city)} → ${esc(to.city)} · FCL · ${esc(o.voyage || '')}</span>
    </div>
    ${mRouteSVG(o)}
    ${timelineHTML(o)}
    <div class="mrows">
      <div class="mrow"><span class="lk">VOYAGE</span><span class="lv">${esc(o.voyage || '—')}</span></div>
      <div class="mrow"><span class="lk">VESSEL</span><span class="lv">${esc(o.vessel || '—')}</span></div>
      <div class="mrow"><span class="lk">DEPARTURE WINDOW</span><span class="lv">${esc(o.window || '—')} · FLEX ±${o.flex_days || 0}D</span></div>
      <div class="mrow"><span class="lk">GROSS WEIGHT</span><span class="lv serif">${(grossKg(o) / 1000).toFixed(1)}<i>T</i></span></div>
      <div class="mrow"><span class="lk">SEGMENT</span><span class="lv">${esc((o.segment || '—').toUpperCase())}</span></div>
      <div class="mrow"><span class="lk">REQUEST PRICE</span><span class="lv serif"><span class="g" data-t="${o.price != null ? fmtUSD(o.price) : '—'}">${o.price != null ? fmtUSD(o.price) : '—'}</span></span></div>
      <div class="mrow"><span class="lk">ETA ${esc(o.to)}</span><span class="lv serif"><span class="g" data-t="${esc(o.eta || '—')}">${esc(o.eta || '—')}</span></span></div>
    </div>
    ${cargoHTML(o)}
    <div class="msh-micro">MERIDIAN LINE · BOOKING ${esc(o.id)} · VERIFY AT OPS.MERIDIANLINE.COM · DOCUMENT-ONLY MANIFEST · MERIDIAN LINE · BOOKING ${esc(o.id)}</div>`;
  msheetWrap.hidden = false;

  /* park the freighter on the booked leg at progress */
  const path = msheetCard.querySelector('#smRoute'), ship = msheetCard.querySelector('#smShip');
  if (path && ship && path.getTotalLength) {
    const L = path.getTotalLength();
    const t = o.status === 'DELIVERED' ? 1 : (o.status === 'AT PORT' ? .97 : clamp(o.progress || 0, .02, .97));
    const p = path.getPointAtLength(L * t), p2 = path.getPointAtLength(Math.min(L, L * t + 1));
    const hd = Math.atan2(p2.y - p.y, p2.x - p.x) * 180 / Math.PI;
    ship.setAttribute('transform', `translate(${p.x} ${p.y - 2}) rotate(${hd})`);
  }
  msheetCard.querySelector('.msh-x').focus();
}
function closeManifest() {
  msheetWrap.hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
msheetWrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeManifest(); });

/* ==================== SELECTION — views ↔ chart ==================== */
let selId = null;
let map = null;
const vmarks = {};

function select(id, fromMap) {
  selId = id;
  const o = orders.find(x => x.id === id);
  orders.forEach(x => {
    if (x._li) x._li.classList.toggle('sel', x.id === id);
    if (x._hook) x._hook.classList.toggle('sel', x.id === id);
  });
  Object.values(vmarks).forEach(v => {
    const sel = v.oid === id;
    v.el.classList.toggle('sel', sel);
    v.el.classList.toggle('dim', !!selId && !sel);
    v.rotEl.style.transform = `rotate(${v.deg}deg) scale(${sel ? 1.25 : 1})`;
  });
  refreshRoutes();
  if (o) {
    fillDetail(o);
    if (o._li && !document.getElementById('viewLedger').hidden)
      o._li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    panToOrder(o);
  }
}
function deselect() {
  selId = null;
  orders.forEach(x => {
    if (x._li) x._li.classList.remove('sel');
    if (x._hook) x._hook.classList.remove('sel');
  });
  Object.values(vmarks).forEach(v => {
    v.el.classList.remove('sel', 'dim');
    v.rotEl.style.transform = `rotate(${v.deg}deg) scale(1)`;
  });
  document.getElementById('dcard').classList.remove('on');
  refreshRoutes();
}

/* gently pan the chart so a selected route sits in view */
function panToOrder(o) {
  if (!map || !o._mid) return;
  const b = map.getBounds();
  const w = b.getWest(), e = b.getEast();
  const mid = o._mid;
  let lon = mid[0];
  const c = map.getCenter().lng;
  while (lon - c > 180) lon -= 360;
  while (lon - c < -180) lon += 360;
  const inside = lon > w + (e - w) * 0.14 && lon < e - (e - w) * 0.14 &&
                 mid[1] > b.getSouth() + 4 && mid[1] < b.getNorth() - 4;
  if (!inside) map.easeTo({ center: [lon, mid[1]], duration: 900 });
}

/* ==================== MAPLIBRE CHART ==================== */
const routeOrders = () => orders.filter(o => o._segs);
const routesSource = () => ({
  type: 'FeatureCollection',
  features: routeOrders().map(o => ({
    type: 'Feature',
    properties: {
      oid: o.id,
      sel:  o.id === selId ? 1 : 0,
      dim:  selId && o.id !== selId ? 1 : 0,
      att:  ATTN.has(o.status) ? 1 : 0,
      fin:  o.status === 'DELIVERED' ? 1 : 0,
    },
    geometry: { type: 'MultiLineString', coordinates: o._segs },
  })),
});
const doneSource = () => ({
  type: 'FeatureCollection',
  features: routeOrders().filter(o => o._vt > 0).map(o => ({
    type: 'Feature',
    properties: { oid: o.id, sel: o.id === selId ? 1 : 0, dim: selId && o.id !== selId ? 1 : 0 },
    geometry: { type: 'MultiLineString', coordinates: o._done },
  })),
});
const gratSource = () => {
  const lines = [];
  for (let lon = -180; lon <= 180; lon += 20) {
    const pts = [];
    for (let lat = -80; lat <= 80; lat += 4) pts.push([lon, lat]);
    lines.push(pts);
  }
  for (let lat = -80; lat <= 80; lat += 20) {
    if (lat === 0 || Math.abs(lat) === 80) continue;
    lines.push([[-180, lat], [180, lat]]);
  }
  lines.push([[-180, 0], [180, 0]]);
  return { type: 'FeatureCollection',
           features: [{ type: 'Feature', properties: {},
                        geometry: { type: 'MultiLineString', coordinates: lines } }] };
};
const portsSource = () => ({
  type: 'FeatureCollection',
  features: Object.entries(PORTS).map(([code, p]) => ({
    type: 'Feature',
    properties: { code },
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  })),
});

function chartStyle(land) {
  return {
    version: 8,
    name: 'meridian-chart',
    sources: Object.assign(
      land ? { land: { type: 'geojson', data: land } } : {},
      { grat:  { type: 'geojson', data: gratSource() },
        routes:{ type: 'geojson', data: routesSource() },
        done:  { type: 'geojson', data: doneSource() },
        ports: { type: 'geojson', data: portsSource() } }),
    layers: [
      { id: 'ocean', type: 'background',
        paint: { 'background-color': '#f4f0e4' } },
      ...(land ? [
        { id: 'land', type: 'fill', source: 'land',
          paint: { 'fill-color': '#e4ddc8', 'fill-opacity': 0.92 } },
        { id: 'coast', type: 'line', source: 'land',
          paint: { 'line-color': 'rgba(69,66,58,.55)', 'line-width': 0.55 } },
      ] : []),
      { id: 'grat', type: 'line', source: 'grat',
        paint: { 'line-color': '#908d81', 'line-width': 0.45,
                 'line-opacity': 0.34, 'line-dasharray': [1.4, 3.4] } },
      { id: 'done', type: 'line', source: 'done',
        paint: {
          'line-color': '#3a5a44',
          'line-width': ['case', ['==', ['get', 'sel'], 1], 2.4, 1.3],
          'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.16, 0.6],
        } },
      { id: 'routes-casing', type: 'line', source: 'routes',
        filter: ['==', ['get', 'sel'], 1],
        paint: { 'line-color': 'rgba(58,90,68,.16)', 'line-width': 7 } },
      { id: 'routes', type: 'line', source: 'routes',
        paint: {
          'line-color': ['case',
            ['==', ['get', 'att'], 1], '#b96f4b',
            ['==', ['get', 'fin'], 1], '#908d81',
            '#3a5a44'],
          'line-width': ['case', ['==', ['get', 'sel'], 1], 2.2, 1.05],
          'line-opacity': ['case',
            ['==', ['get', 'dim'], 1], 0.22,
            ['==', ['get', 'fin'], 1], 0.4, 0.85],
          'line-dasharray': [3.4, 2.8],
        } },
      { id: 'routes-hit', type: 'line', source: 'routes',
        paint: { 'line-color': '#000', 'line-width': 15, 'line-opacity': 0 } },
      { id: 'ports-ring', type: 'circle', source: 'ports',
        paint: { 'circle-radius': 6.4, 'circle-color': 'rgba(244,240,228,0)',
                 'circle-stroke-color': 'rgba(58,90,68,.5)', 'circle-stroke-width': 0.9 } },
      { id: 'ports', type: 'circle', source: 'ports',
        paint: { 'circle-radius': 3.4, 'circle-color': '#f6f1e0',
                 'circle-stroke-color': '#3a5a44', 'circle-stroke-width': 1.2 } },
    ],
  };
}

/* repaint route features on either renderer after selection changes */
function refreshRoutes() {
  if (map && map.getSource('routes')) {
    map.getSource('routes').setData(routesSource());
    map.getSource('done').setData(doneSource());
  }
  paintFB();
}

function vesselElement(o) {
  const el = document.createElement('div');
  el.className = 'vmark';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label',
    `Vessel ${o.vessel || 'not yet assigned'}, order ${o.id}, ${Math.round((o._vt || 0) * 100)} percent of voyage`);
  const rot = document.createElement('span');
  rot.style.cssText = 'display:flex;transform-origin:50% 50%;transition:transform .25s ease;';
  rot.innerHTML = `<svg class="vship" viewBox="0 0 24 14" aria-hidden="true">${IC.ship.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>`;
  rot.style.transform = `rotate(${o._vhd.toFixed(1)}deg)`;
  const lab = document.createElement('div');
  lab.className = 'vlab';
  lab.textContent = o.voyage;
  el.appendChild(rot);
  el.appendChild(lab);
  el.addEventListener('click', e => { e.stopPropagation(); select(o.id, true); });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(o.id, true); }
  });
  return { el, rot, deg: o._vhd };
}

const PLAB_OFF = {
  CNSHA: [40, -14], SGSIN: [36, 20], KRPUS: [38, -14],
  NLRTM: [38, -14], DEHAM: [38, -14], BEANR: [-38, 14],
  USLAX: [-38, 18], USNYC: [-38, -16],
};

function initGL(land) {
  map = new maplibregl.Map({
    container: 'map',
    style: chartStyle(land),
    center: [40, 30],
    zoom: 1.2,
    minZoom: 0.8,
    maxZoom: 8,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  if (map.scrollZoom && map.scrollZoom.setWheelZoomRate)
    map.scrollZoom.setWheelZoomRate(1 / 240);

  /* chart framing — fit every route's unwrapped arc. Must run AFTER
     'load': on an unloaded map fitBounds can be overridden by the
     constructor's center/zoom and silently no-op. */
  const fitChart = () => {
    let lo = Infinity, hi = -Infinity, la0 = 90, la1 = -90;
    routeOrders().forEach(o => o._arc.forEach(p => {
      const l = p[0] < 0 ? p[0] + 360 : p[0];
      lo = Math.min(lo, l); hi = Math.max(hi, l);
      la0 = Math.min(la0, p[1]); la1 = Math.max(la1, p[1]);
    }));
    if (!isFinite(lo)) return;
    let l0 = lo - 14, l1 = hi + 14;
    if (l1 - l0 > 340) { l0 = -178; l1 = 182; }
    map.fitBounds(
      [[l0 > 180 ? l0 - 360 : l0, Math.max(-55, la0 - 12)],
       [l1 > 180 ? l1 - 360 : l1, Math.min(80, la1 + 14)]],
      { padding: 24, maxZoom: 2.4, duration: 0 });
  };

  map.on('load', () => {
    fitChart();
    /* vessel markers — where steel is moving or staged */
    routeOrders().forEach(o => {
      if (!(o._vt > 0 && o._vt < 1)) return;
      const v = vesselElement(o);
      const mk = new maplibregl.Marker({ element: v.el, anchor: 'center' })
        .setLngLat(o._vpos).addTo(map);
      vmarks[o.id] = { oid: o.id, el: v.el, rotEl: v.rot, deg: o._vhd, mk };
    });

    /* port lettering */
    Object.entries(PORTS).forEach(([code, p]) => {
      const el = document.createElement('div');
      el.className = 'plab';
      el.innerHTML = `<b>${code}</b><i>${p.city}</i>`;
      new maplibregl.Marker({ element: el, anchor: 'center', offset: PLAB_OFF[code] || [30, 0] })
        .setLngLat([p.lon, p.lat]).addTo(map);
    });

    /* seeded depth soundings pinned into the ocean */
    SOUNDINGS.forEach(s => {
      const el = document.createElement('div');
      el.className = 'snd';
      el.textContent = s.n;
      new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([s.lon, s.lat]).addTo(map);
    });

    refreshRoutes();
    map.on('click', 'routes-hit', e => {
      if (e.features && e.features.length) select(e.features[0].properties.oid, true);
    });
    map.on('mouseenter', 'routes-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'routes-hit', () => { map.getCanvas().style.cursor = ''; });
  });

  /* if gl never reaches 'load' (worker/CDN weirdness), fall back */
  let loaded = false;
  map.on('load', () => { loaded = true; });
  setTimeout(() => {
    if (!loaded) { try { map.remove(); map = null; } catch (e) {} renderFallback(); }
  }, 5000);
  window.addEventListener('resize', () => { try { if (map) map.resize(); } catch (e) {} });
}

/* ==================== STATIC FALLBACK CHART ==================== */
/* plate carrée centred at 170°E — Pacific front and centre, the
   Atlantic split at both neatline edges */
const FB_W = 1200, FB_H = 620, FB_C = 170;
const fbX = lon => ((lon - FB_C + 540) % 360) / 360 * FB_W;
const fbY = lat => (75 - lat) / 150 * FB_H;

function fbPath(segs) {
  return segs.map(seg =>
    'M' + seg.map(p => `${fbX(p[0]).toFixed(1)} ${fbY(p[1]).toFixed(1)}`).join(' L')
  ).join(' ');
}

function renderFallback() {
  const host = document.getElementById('map');
  if (!host || host.querySelector('.fbmap')) return;
  map = null;
  fetch('world.geo.json')
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(g => drawFB(host, g))
    .catch(() => drawFB(host, null));
}

function drawFB(host, land) {
  let s = `<svg class="fbmap" viewBox="0 0 ${FB_W} ${FB_H}" preserveAspectRatio="xMidYMid slice">`;
  s += `<rect width="${FB_W}" height="${FB_H}" fill="#f4f0e4"/>`;

  let gd = '';
  for (let lon = -180; lon <= 180; lon += 20) gd += `M${fbX(lon)} 0V${FB_H}`;
  for (let lat = -60; lat <= 60; lat += 20) gd += `M0 ${fbY(lat)}H${FB_W}`;
  s += `<path d="${gd}" fill="none" stroke="#908d81" stroke-width=".5" stroke-dasharray="1.5 4" opacity=".35"/>`;

  if (land) {
    let ld = '';
    const polys = [];
    land.features.forEach(f => {
      const g = f.geometry;
      (g.type === 'Polygon' ? [g.coordinates] : g.coordinates || []).forEach(poly => polys.push(poly[0]));
    });
    polys.forEach(ring => {
      let run = '';
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[Math.max(0, i - 1)];
        const x = fbX(p[0]), y = fbY(p[1]);
        if (i === 0 || Math.abs(fbX(p[0]) - fbX(q[0])) > FB_W / 2) run += `M${x.toFixed(1)} ${y.toFixed(1)}`;
        else run += `L${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      ld += run + 'Z';
    });
    s += `<path d="${ld}" fill="#e4ddc8" stroke="rgba(69,66,58,.55)" stroke-width=".7"/>`;
  }

  routeOrders().forEach(o => {
    const ink = stOf(o).ink;
    const col = ink === 'terra' ? '#b96f4b' : ink === 'faint' ? '#908d81' : '#3a5a44';
    s += `<path class="fbr" data-oid="${esc(o.id)}" d="${fbPath(o._segs)}" fill="none"
      stroke="${col}" stroke-width="1.4" stroke-dasharray="4 3.4" opacity=".85"/>`;
    if (o._vt > 0)
      s += `<path class="fbd" data-oid="${esc(o.id)}" d="${fbPath(o._done)}" fill="none"
        stroke="#3a5a44" stroke-width="1.6" opacity=".6"/>`;
    s += `<path class="fbh" data-oid="${esc(o.id)}" d="${fbPath(o._segs)}" fill="none"
      stroke="rgba(0,0,0,0)" stroke-width="16" pointer-events="stroke"/>`;
  });

  Object.entries(PORTS).forEach(([code, p]) => {
    const x = fbX(p.lon), y = fbY(p.lat);
    s += `<circle cx="${x}" cy="${y}" r="6.4" fill="none" stroke="rgba(58,90,68,.5)" stroke-width="1"/>` +
         `<circle cx="${x}" cy="${y}" r="3.2" fill="#f6f1e0" stroke="#3a5a44" stroke-width="1.2"/>` +
         `<text x="${x + 10}" y="${y - 6}" font-family="ui-monospace,SF Mono,Menlo,monospace"
            font-size="8" font-weight="700" letter-spacing="1.6" fill="#1d1a14">${code}</text>` +
         `<text x="${x + 10}" y="${y + 2.5}" font-family="ui-monospace,SF Mono,Menlo,monospace"
            font-size="4.6" font-weight="600" letter-spacing="1" fill="#908d81">${p.city}</text>`;
  });

  SOUNDINGS.forEach(sd => {
    s += `<text x="${fbX(sd.lon).toFixed(1)}" y="${fbY(sd.lat).toFixed(1)}" text-anchor="middle"
      font-family="ui-monospace,SF Mono,Menlo,monospace" font-size="6" letter-spacing=".5"
      fill="#45423a" opacity=".42">${sd.n}</text>`;
  });

  routeOrders().forEach(o => {
    if (!(o._vt > 0 && o._vt < 1)) return;
    const x = fbX(o._vpos[0]), y = fbY(o._vpos[1]);
    s += `<g class="fbv" data-oid="${esc(o.id)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
         `<circle r="11" fill="rgba(244,240,228,.0)"/>` +
         `<circle class="fbvring" r="13" fill="rgba(244,240,228,.55)" stroke="rgba(58,90,68,.6)" stroke-width="1" opacity="0"/>` +
         `<g transform="rotate(${o._vhd.toFixed(0)}) scale(1.35) translate(-12 -7)">${IC.ship
           .replace('<svg viewBox="0 0 24 14">', '')
           .replace('</svg>', '')
           .replaceAll('currentColor', '#45423a')}</g>` +
         `<text y="16" text-anchor="middle" font-family="ui-monospace,SF Mono,Menlo,monospace"
            font-size="5.4" font-weight="700" letter-spacing="1" fill="#45423a">${o.voyage}</text></g>`;
  });

  s += '</svg>';
  host.innerHTML = s;
  paintFB();
  host.querySelectorAll('[data-oid]').forEach(el =>
    el.addEventListener('click', () => select(el.dataset.oid, true)));
}

function paintFB() {
  const host = document.getElementById('map');
  if (!host || !host.querySelector('.fbmap')) return;
  orders.forEach(o => {
    const sel = o.id === selId, dim = selId && !sel;
    const r = host.querySelector(`.fbr[data-oid="${CSS.escape(o.id)}"]`);
    const d = host.querySelector(`.fbd[data-oid="${CSS.escape(o.id)}"]`);
    const v = host.querySelector(`.fbv[data-oid="${CSS.escape(o.id)}"]`);
    if (r) {
      r.setAttribute('stroke-width', sel ? 2.6 : 1.4);
      r.setAttribute('opacity', dim ? 0.22 : 0.9);
    }
    if (d) d.setAttribute('opacity', dim ? 0.12 : sel ? 0.95 : 0.6);
    if (v) {
      v.setAttribute('opacity', dim ? 0.35 : 1);
      const ring = v.querySelector('.fbvring');
      if (ring) ring.setAttribute('opacity', sel ? 1 : 0);
    }
  });
}

/* ==================== DETAIL CARD ==================== */
const dcard = document.getElementById('dcard');
document.getElementById('dClose').addEventListener('click', deselect);

/* distressed rubber status stamp */
function dstampSVG(o) {
  const st = stOf(o);
  const ink = st.ink === 'terra' ? '#b96f4b' : st.ink === 'sage' ? '#3a5a44' :
              st.ink === 'faint' ? '#908d81' : '#45423a';
  const ghost = st.ink === 'terra' ? '#3a5a44' : '#b96f4b';
  const mid = o.progress > 0 && o.progress < 1
    ? Math.round(o.progress * 100) + '%'
    : (o.progress >= 1 ? '✓' : '—');
  return `<defs>
      <filter id="dstamp" x="-15%" y="-15%" width="130%" height="130%">
        <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="7" result="n"/>
        <feColorMatrix in="n" type="matrix"
          values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 6 -1.4" result="spek"/>
        <feComposite in="SourceGraphic" in2="spek" operator="in"/>
      </filter>
      <path id="dArcT" d="M 23 48 A 25 25 0 0 1 73 48"/>
      <path id="dArcB" d="M 20 48 A 28 28 0 0 0 76 48"/>
    </defs>
    <g filter="url(#dstamp)">
      <circle cx="49" cy="49" r="40" fill="none" stroke="${ghost}" stroke-width="2.2" opacity=".14"/>
      <circle cx="48" cy="48" r="40" fill="none" stroke="${ink}" stroke-width="2.2"/>
      <circle cx="48" cy="48" r="35.5" fill="none" stroke="${ink}" stroke-width=".8" opacity=".85"/>
      <circle cx="48" cy="48" r="19" fill="none" stroke="${ink}" stroke-width=".8" opacity=".85"/>
      <circle cx="11.5" cy="48" r="1.3" fill="${ink}" opacity=".85"/>
      <circle cx="84.5" cy="48" r="1.3" fill="${ink}" opacity=".85"/>
      <text font-family="ui-monospace,SF Mono,Menlo,monospace" font-size="7.6" font-weight="700"
        letter-spacing="2.2" fill="${ink}">
        <textPath href="#dArcT" startOffset="50%" text-anchor="middle">${st.short}</textPath></text>
      <text font-family="ui-monospace,SF Mono,Menlo,monospace" font-size="6" font-weight="700"
        letter-spacing="1.6" fill="${ink}" opacity=".88">
        <textPath href="#dArcB" startOffset="50%" text-anchor="middle">MERIDIAN LINE</textPath></text>
      <text x="48" y="52" text-anchor="middle" font-family="Georgia,serif" font-size="14"
        font-weight="700" fill="${ink}">${mid}</text>
      <text x="48" y="61" text-anchor="middle" font-family="ui-monospace,SF Mono,Menlo,monospace"
        font-size="5" font-weight="700" letter-spacing="1" fill="${ink}" opacity=".85">OF VOYAGE</text>
    </g>`;
}

function fillDetail(o) {
  const st = stOf(o);
  const dId = document.getElementById('dId');
  dId.textContent = dId.dataset.t = o.id;
  document.getElementById('dFrom').textContent = o.from;
  document.getElementById('dTo').textContent = o.to;
  document.getElementById('dCities').textContent =
    `${portOf(o.from).city} — ${portOf(o.to).city}`;
  document.getElementById('dStamp').innerHTML = dstampSVG(o);

  document.getElementById('dMiles').innerHTML = MILESTONES.map((m, i) => {
    const cls = i < st.stage ? 'done' : i === st.stage ? 'now' : '';
    return `<span class="dms ${cls}">
      <span class="dms-d" aria-hidden="true">${MILE_ICONS[i]}</span>
      <span class="dms-l">${m}</span></span>`;
  }).join('');

  const totalKg = grossKg(o);
  const chips = (o.types || []).map(t =>
    `<span class="dmc" data-cg="${esc(t.cargo)}">${CARGO_ICON[t.cargo] || IC.dry}×${t.units}</span>`).join('');
  document.getElementById('dManChips').innerHTML = chips +
    `<span class="dmc">${o.teu} TEU</span>`;
  document.getElementById('dTip').textContent =
    (o.types || []).map(t => `${CARGO_NAME[t.cargo] || 'DRY'} ×${t.units}`).join('  ·  ') +
    `  ·  ${(totalKg / 1000).toFixed(1)} T TOTAL`;
  const etaD = etaDays(o.eta, o);

  document.getElementById('dRows').innerHTML =
    `<div class="r"><span>${IC.ship}VESSEL</span><b class="mono">${esc(o.vessel || '— AWAITING VESSEL')}</b></div>
     <div class="r"><span>${IC.flag}VOYAGE</span><b class="mono">${esc(o.voyage || '—')}</b></div>
     <div class="r"><span>${IC.cal}WINDOW</span><b>${esc(o.window || '—')}</b></div>
     <div class="r"><span>${IC.anchor}ETA</span><b>${esc(o.eta)}${etaD !== null && o.status !== 'DELIVERED' ? ` · IN ${etaD}D` : ''}</b></div>
     <div class="r"><span>${IC.gauge}PRICE</span><b class="d-num" data-t="${o.price != null ? fmtUSD(o.price).replace('USD ', '$ ') : '—'}">${o.price != null ? fmtUSD(o.price).replace('USD ', '$ ') : '—'}</b></div>`;

  dcard.classList.add('on');
}

/* ==================== VIEW SWITCH ==================== */
const viewLedger = document.getElementById('viewLedger');
const viewCreds = document.getElementById('viewCreds');
const vLedger = document.getElementById('vLedger');
const vCreds = document.getElementById('vCreds');

function setView(v) {
  const creds = v === 'creds';
  viewLedger.hidden = creds;
  viewCreds.hidden = !creds;
  vLedger.classList.toggle('on', !creds);
  vCreds.classList.toggle('on', creds);
  vLedger.setAttribute('aria-pressed', String(!creds));
  vCreds.setAttribute('aria-pressed', String(creds));
  try { localStorage.setItem('ml.view', v); } catch (e) {}
  if (map) setTimeout(() => { try { map.resize(); } catch (e) {} }, 60);
}
vLedger.addEventListener('click', () => setView('ledger'));
vCreds.addEventListener('click', () => setView('creds'));
let initialView = 'ledger';
try { initialView = localStorage.getItem('ml.view') === 'creds' ? 'creds' : 'ledger'; } catch (e) {}
setView(initialView);

/* ==================== CHART DRESSING ==================== */
/* faint compass rose, generated so the tick ring stays honest */
(function rose() {
  const host = document.getElementById('rose');
  if (!host) return;
  let s = '<circle cx="60" cy="60" r="45" fill="none" stroke="#45423a" stroke-width=".9"/>' +
          '<circle cx="60" cy="60" r="38" fill="none" stroke="#45423a" stroke-width=".45"/>';
  for (let i = 0; i < 32; i++) {
    const a = i * 11.25 * Math.PI / 180;
    const r1 = i % 4 === 0 ? 40 : 42.4, r2 = 45;
    s += `<path d="M${(60 + Math.sin(a) * r1).toFixed(1)} ${(60 - Math.cos(a) * r1).toFixed(1)}` +
         `L${(60 + Math.sin(a) * r2).toFixed(1)} ${(60 - Math.cos(a) * r2).toFixed(1)}"` +
         ` stroke="#45423a" stroke-width="${i % 8 === 0 ? 1 : .5}" fill="none"/>`;
  }
  const kite = (r, w, fill) => {
    let p = '';
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const tx = 60 + Math.sin(a) * r, ty = 60 - Math.cos(a) * r;
      const lx = 60 + Math.sin(a - Math.PI / 2) * w, ly = 60 - Math.cos(a - Math.PI / 2) * w;
      const rx = 60 + Math.sin(a + Math.PI / 2) * w, ry = 60 - Math.cos(a + Math.PI / 2) * w;
      p += `<path d="M60 60 L${lx.toFixed(1)} ${ly.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} Z" fill="${fill}"/>` +
           `<path d="M60 60 L${rx.toFixed(1)} ${ry.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} Z" fill="none" stroke="${fill}" stroke-width=".7"/>`;
    }
    return p;
  };
  s += kite(34, 3.6, 'rgba(185,111,75,.85)');
  for (let i = 0; i < 4; i++) {
    const a = (i * 90 + 45) * Math.PI / 180;
    const tx = 60 + Math.sin(a) * 22, ty = 60 - Math.cos(a) * 22;
    const lx = 60 + Math.sin(a - Math.PI / 2) * 2.4, ly = 60 - Math.cos(a - Math.PI / 2) * 2.4;
    const rx = 60 + Math.sin(a + Math.PI / 2) * 2.4, ry = 60 - Math.cos(a + Math.PI / 2) * 2.4;
    s += `<path d="M60 60 L${lx.toFixed(1)} ${ly.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} L${rx.toFixed(1)} ${ry.toFixed(1)} Z"
      fill="none" stroke="rgba(58,90,68,.8)" stroke-width=".7"/>`;
  }
  s += '<circle cx="60" cy="60" r="5.5" fill="#f8f4e7" stroke="#45423a" stroke-width=".9"/>' +
       '<circle cx="60" cy="60" r="1.6" fill="#45423a"/>' +
       '<text x="60" y="9.5" text-anchor="middle" font-family="ui-monospace,SF Mono,Menlo,monospace"' +
       ' font-size="8" font-weight="700" letter-spacing="1" fill="#1d1a14">N</text>';
  host.innerHTML = s;
})();

/* chart correction date */
(function dressing() {
  const d = new Date();
  const cd = document.getElementById('ctDate');
  if (cd) cd.textContent = `CORRECTED TO ${d.getDate()} ${MABR[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
})();

/* Escape — collapse sheets, close the manifest, release the selection */
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!msheetWrap.hidden) { closeManifest(); return; }
  document.querySelectorAll('.order.open').forEach(li => {
    li.classList.remove('open');
    li.querySelector('.lrow').setAttribute('aria-expanded', 'false');
  });
  if (selId) deselect();
});

/* ============================== BOOT ============================== */
(async function boot() {
  /* 1 · reference data + orders, live from the API (no fallback) */
  let pRecs = [];
  let ords = [];
  try {
    [pRecs, ords] = await Promise.all([DockAPI.ports(), DockAPI.orders()]);
  } catch (e) {
    apiDown(e);
  }
  pRecs.forEach(p => {
    const id = p.port_id || p.id;
    PORTS[id] = { city: String(p.name || id).toUpperCase(), lon: p.lon, lat: p.lat };
  });
  orders = (ords || []).map((o, i) => normalize(o, i)).filter(o => o.from && o.to);
  orders.sort((a, b) => (b.created || 0) - (a.created || 0));
  newestId = orders[0] && orders[0].id;

  /* 2 · derived chart geometry per order */
  orders.forEach(o => {
    if (!PORTS[o.from] || !PORTS[o.to]) return;
    o._arc  = gcArc(PORTS[o.from], PORTS[o.to], 42);
    o._segs = splitAntimeridian(o._arc);
    o._vt   = vesselT(o);
    o._done = splitAntimeridian(o._arc.slice(0, Math.max(2, Math.round(o._vt * 42) + 1)));
    const vp = arcPos(o._arc, o._vt);
    o._vpos = [normLon(vp[0]), vp[1]];
    o._vhd  = arcHeading(o._arc, o._vt);
    const md = arcPos(o._arc, 0.5);
    o._mid  = [normLon(md[0]), md[1]];
  });

  /* 3 · fleet totals — serif counters */
  (function totals() {
    const afloat = orders.filter(o => o.status === 'IN TRANSIT')
      .reduce((s, o) => s + (o.teu || 0), 0);
    const active = orders.filter(o => o.status !== 'DELIVERED').length;
    const dys = orders.map(daysOf);
    const avg = dys.length ? Math.round(dys.reduce((a, b) => a + b, 0) / dys.length) : 0;
    const set = (id, v) => { const el = document.getElementById(id); el.textContent = v; el.dataset.t = v; };
    set('totTeu', afloat);
    set('totOrd', active);
    set('totDays', avg);
  })();

  /* 4 · the register */
  orders.forEach((o, i) => ledgerEl.appendChild(buildOrder(o, i)));
  document.getElementById('regCount').textContent = `${orders.length} ENTRIES`;
  document.getElementById('regTeu').textContent =
    `${orders.reduce((s, o) => s + (o.teu || 0), 0)} TEU COMMITTED`;
  document.getElementById('regDate').textContent = fmtDate(Date.now());

  /* 5 · the credential wall */
  document.getElementById('wallCount').textContent = `${orders.length} BADGES`;
  wall.innerHTML = orders.map(o => badgeHTML(o, o.id === newestId)).join('');
  wall.querySelectorAll('canvas.barc').forEach(cv => drawBar(cv, +cv.dataset.seed + 314));
  wall.querySelectorAll('.badge').forEach(b =>
    b.addEventListener('click', () => {
      const o = orders.find(x => x.id === b.dataset.id);
      if (!o) return;
      select(o.id);
      openManifest(o);
    }));
  orders.forEach(o => {
    const h = wall.querySelector(`.hook[data-oid="${CSS.escape(o.id)}"]`);
    if (h) o._hook = h;
  });

  /* 6 · the chart — land overlay optional, GL preferred, SVG fallback */
  let land = null;
  try {
    const r = await fetch('world.geo.json');
    if (r.ok) land = await r.json();
  } catch (e) {}
  if (window.maplibregl) {
    try { initGL(land); } catch (e) { renderFallback(); }
  } else {
    renderFallback();
  }

  /* 7 · reveal cascade, then auto-select the first live consignment */
  const els = [...document.querySelectorAll('.rvl')];
  els.forEach((el, i) => setTimeout(() => el.classList.add('on'), 120 + i * 55));
  const first = orders.find(o => o.status === 'IN TRANSIT') || orders[0];
  if (first) setTimeout(() => select(first.id), 900);
})();

/* ============================ LIVE DATA ============================ */
/* API unreachable: say so on the page instead of showing stale data */
function apiDown(err) {
  const b = document.createElement('div');
  b.className = 'api-down';
  b.setAttribute('role', 'alert');
  b.textContent = `Booking service unavailable — ${err.message} Orders can't be shown until it's back.`;
  document.body.appendChild(b);
}

/* QUOTED order -> the rate-quotation slip, then reload with the outcome */
async function reviewQuote(id) {
  try {
    const o = await DockAPI.order(id);
    await DockOffers.review([{ order: o, offers: (o.offers || []).filter(f => f.status === 'open') }]);
  } catch (e) {
    alert(`Couldn't open this quote: ${e.message}`);
  }
  location.reload();
}
