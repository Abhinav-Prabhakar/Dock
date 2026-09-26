// Central configuration for the vessel, cargo system and environment.
// Everything is in metres / seconds. Ship-local frame: +X = bow (forward), +Y = up, +Z = starboard.
// y = 0 is the design waterline.

// The four vessels the backend simulates (backend/data/calibration.py VESSELS),
// each with its own hull, bay layout, superstructure and hydrostatics so the
// 3D ship, stowage drawings and loading calculator all match the selected
// vessel's real class. Dimensions follow typical ships of each size:
//   VES1  8,000 TEU  (the original 366 m model hull, kept as-is)
//   VES2  5,500 TEU  post-Panamax, 277 × 40 m
//   VES3  4,000 TEU  Panamax, 260 × 32.2 m (13 rows on deck — the old lock limit)
//   VES4  2,500 TEU  feeder-max, 208 × 30 m
// Draughts equal the backend's draft_m; reefer plugs equal its reefer_plugs.
//
// Layout: bays listed bow -> stern. 'bay' = one 40' bay (two 20' slots);
// tiers = max on-deck tiers for that bay (visibility line / stack weight limits).
// super: superstructure sizes (m) — tower/casing heights above the main deck,
// widths across the ship, funnel height and radius, and funnel style:
//   'round' (VES1) · 'twin' side-by-side stacks (VES2) · 'raked' tall funnel
//   leaning aft (VES3) · 'square' (VES4).
// { type: 'crane', length } reserves a gap between bays for a pedestal deck
// crane (a geared ship — VES4 works ports without shore gantries).
const bays = (...tiers) => tiers.map((t) => ({ type: 'bay', tiers: t }));

export const VESSELS = {
  VES1: {
    id: 'VES1', name: 'PACIFIC AURORA', port: 'MONROVIA', imo: 'IMO 9876543', livery: 'magenta',
    L: 366,          // length overall
    B: 51,           // moulded beam
    D: 30.2,         // moulded depth (keel -> main deck)
    T: 14.5,         // design draught
    bilgeRadius: 2.6,
    forecastle: 30,  // clear foredeck length from the stem to the first bay
    layout: [
      ...bays(6, 7, 8, 8, 9, 9, 9),
      { type: 'house', length: 15 },
      ...bays(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10),
      { type: 'casing', length: 13 },
      ...bays(9, 8, 7),
    ],
    maxRows: 20,
    holdTiers: 9,    // logical below-deck tiers (02..18), not rendered while hatches are closed
    super: { towerH: 38, baseW: 44, towerW: 30, casingH: 20, casingW: 28, funnelH: 13, funnelR: 7.2, funnel: 'round' },
    hydro: {
      summerDraft: 16.0, tankTop: 2.2, reeferPlugs: 560,
      lightship: [
        { name: 'Hull steel',        w: 30500, x0: -178, x1: 178, vcg: 14.2, shape: 'hull' },
        { name: 'Machinery',         w: 3800,  x0: -152, x1: -122, vcg: 8.5 },
        { name: 'Accommodation',     w: 2300,  house: true, vcg: 38 },
        { name: 'Casing & funnel',   w: 900,   casing: true, vcg: 40 },
        { name: 'Hatches & lashing', w: 1900,  x0: -168, x1: 152, vcg: 32 },
      ],
      consumables: [
        { name: 'Heavy fuel oil',   w: 6200, x0: -112, x1: -38, vcg: 4.5 },
        { name: 'MGO, FW & stores', w: 1700, x0: -158, x1: -126, vcg: 11 },
        { name: 'Ballast water',    w: 2400, x0: -150, x1: 150, vcg: 1.4 },
      ],
    },
  },
  // Post-Panamax, single island: accommodation over the engine room with the
  // funnel casing directly behind it and three bays aft (x: house -36..-50,
  // casing -50..-62, aft bays -62..-104).
  VES2: {
    id: 'VES2', name: 'MERIDIAN STAR', port: 'MAJURO', imo: 'IMO 9512207', livery: 'blue',
    L: 277, B: 40, D: 24.3, T: 13.0, bilgeRadius: 2.2, forecastle: 22,
    layout: [
      ...bays(6, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8),
      { type: 'house', length: 14 },
      { type: 'casing', length: 12 },
      ...bays(8, 7, 6),
    ],
    maxRows: 16, holdTiers: 7,
    super: { towerH: 32, baseW: 34, towerW: 24, casingH: 16, casingW: 22, funnelH: 11, funnelR: 6.0, funnel: 'twin' },
    hydro: {
      summerDraft: 14.0, tankTop: 2.0, reeferPlugs: 380,
      lightship: [
        { name: 'Hull steel',        w: 14500, x0: -136, x1: 136, vcg: 11.4, shape: 'hull' },
        { name: 'Machinery',         w: 2300,  x0: -66, x1: -40, vcg: 6.8 },
        { name: 'Accommodation',     w: 1400,  house: true, vcg: 30.5 },
        { name: 'Casing & funnel',   w: 600,   casing: true, vcg: 32 },
        { name: 'Hatches & lashing', w: 1000,  x0: -104, x1: 116, vcg: 26 },
      ],
      consumables: [
        { name: 'Heavy fuel oil',   w: 4300, x0: -36, x1: 20, vcg: 3.6 },
        { name: 'MGO, FW & stores', w: 1200, x0: -104, x1: -70, vcg: 8.8 },
        { name: 'Ballast water',    w: 1800, x0: -115, x1: 115, vcg: 1.2 },
      ],
    },
  },
  // Panamax: 32.2 m beam (13 rows on deck at most), a classic all-aft
  // island with one bay behind it and a tall raked funnel.
  // x: house -70.7..-83.7, casing -83.7..-94.7, aft bay -94.7..-108.6.
  VES3: {
    id: 'VES3', name: 'ATLANTIC PIONEER', port: 'LIMASSOL', imo: 'IMO 9301844', livery: 'black',
    L: 260, B: 32.2, D: 19.3, T: 12.0, bilgeRadius: 1.9, forecastle: 20,
    layout: [
      ...bays(5, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7),
      { type: 'house', length: 13 },
      { type: 'casing', length: 11 },
      ...bays(6),
    ],
    maxRows: 13, holdTiers: 6,
    super: { towerH: 31, baseW: 27, towerW: 20, casingH: 13, casingW: 18, funnelH: 14, funnelR: 5.2, funnel: 'raked' },
    hydro: {
      summerDraft: 12.6, tankTop: 1.8, reeferPlugs: 280,
      lightship: [
        { name: 'Hull steel',        w: 10400, x0: -128, x1: 128, vcg: 9.1, shape: 'hull' },
        { name: 'Machinery',         w: 1700,  x0: -96, x1: -72, vcg: 5.4 },
        { name: 'Accommodation',     w: 1100,  house: true, vcg: 24.5 },
        { name: 'Casing & funnel',   w: 450,   casing: true, vcg: 25.5 },
        { name: 'Hatches & lashing', w: 700,   x0: -108, x1: 110, vcg: 21 },
      ],
      consumables: [
        { name: 'Heavy fuel oil',   w: 3400, x0: -70, x1: -10, vcg: 2.9 },
        { name: 'MGO, FW & stores', w: 950,  x0: -110, x1: -97, vcg: 7 },
        { name: 'Ballast water',    w: 1400, x0: -110, x1: 110, vcg: 1.0 },
      ],
    },
  },
  // Geared feeder-max: short and full-bodied, 11 rows on deck, two pedestal
  // cranes between the hatches, one bay aft of the island.
  // x: house -47.1..-59.1, casing -59.1..-69.1, aft bay -69.1..-83.
  VES4: {
    id: 'VES4', name: 'CORAL EMPRESS', port: 'VALLETTA', imo: 'IMO 9188302', livery: 'coral',
    L: 208, B: 30, D: 16.8, T: 10.5, bilgeRadius: 1.7, forecastle: 18,
    layout: [
      ...bays(6, 6, 7),
      { type: 'crane', length: 4 },
      ...bays(7, 7, 7),
      { type: 'crane', length: 4 },
      ...bays(7, 7, 7),
      { type: 'house', length: 12 },
      { type: 'casing', length: 10 },
      ...bays(6),
    ],
    maxRows: 12, holdTiers: 5,
    super: { towerH: 27, baseW: 24, towerW: 17, casingH: 11, casingW: 16, funnelH: 8.5, funnelR: 4.4, funnel: 'square' },
    hydro: {
      summerDraft: 11.2, tankTop: 1.6, reeferPlugs: 200,
      lightship: [
        { name: 'Hull steel',        w: 6900, x0: -102, x1: 102, vcg: 7.9, shape: 'hull' },
        { name: 'Machinery',         w: 1100, x0: -70, x1: -50, vcg: 4.7 },
        { name: 'Deck cranes',       w: 360,  x0: -6, x1: 45, vcg: 26 },  // pedestals at x 42.3 and -3.4
        { name: 'Accommodation',     w: 800,  house: true, vcg: 21 },
        { name: 'Casing & funnel',   w: 300,  casing: true, vcg: 22 },
        { name: 'Hatches & lashing', w: 450,  x0: -83, x1: 86, vcg: 18.5 },
      ],
      consumables: [
        { name: 'Heavy fuel oil',   w: 2200, x0: -47, x1: 0, vcg: 2.5 },
        { name: 'MGO, FW & stores', w: 650,  x0: -84, x1: -71, vcg: 6 },
        { name: 'Ballast water',    w: 1000, x0: -88, x1: 88, vcg: 0.9 },
      ],
    },
  },
};
export const DEFAULT_VESSEL = 'VES1';

// The active vessel is fixed for the page's lifetime (every hull-derived
// module computes its geometry once at import), chosen by ?vessel=VESn.
// Switching vessels reloads the console with the new id — see main.js.
const requested = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('vessel') : null;
export const VESSEL_ID = requested in VESSELS ? requested : DEFAULT_VESSEL;
const V = VESSELS[VESSEL_ID];

export const SHIP = {
  ...V,
  bayPitch: 13.9,        // 40' slot + lashing bridge
  rowPitch: 2.463,       // container width + cell gap
  hatchHeight: 2.35,     // coaming + hatch cover above main deck
};

export const CONTAINER_TYPES = {
  '20':   { length: 6.058,  height: 2.591, teu: 1, tare: 2.25, maxGross: 30.48, label: "20' GP" },
  '40':   { length: 12.192, height: 2.591, teu: 2, tare: 3.75, maxGross: 30.48, label: "40' GP" },
  '40HC': { length: 12.192, height: 2.896, teu: 2, tare: 3.95, maxGross: 30.48, label: "40' HC" },
};
export const CONTAINER_WIDTH = 2.438;

// Cargo categories (drive checks, colour modes and reefer power).
export const CATEGORIES = {
  dry:    { label: 'Dry',    color: '#8f99a3' },
  reefer: { label: 'Reefer', color: '#e9f3ff' },
  imdg:   { label: 'IMDG',   color: '#ff7a2f' },
  empty:  { label: 'Empty',  color: '#d8d0bf' },
};

// Ports of discharge on the rotation (backend `/api/ports`).
export const PORTS = [
  { code: 'CNSHA', name: 'Shanghai',    color: '#4f9fe6' },
  { code: 'SGSIN', name: 'Singapore',   color: '#f0913a' },
  { code: 'KRPUS', name: 'Busan',       color: '#d0506a' },
  { code: 'NLRTM', name: 'Rotterdam',   color: '#63c28a' },
  { code: 'DEHAM', name: 'Hamburg',     color: '#a98ee6' },
  { code: 'BEANR', name: 'Antwerp',     color: '#c9a42a' },
  { code: 'USLAX', name: 'Los Angeles', color: '#2c8a8e' },
  { code: 'USNYC', name: 'New York',    color: '#b52d34' },
];

// Hydrostatic / structural constants: shared physics plus the active vessel's
// own draught marks, weight groups and limits (VESSELS[*].hydro).
export const HYDRO = {
  rho: 1.025,              // t/m^3 sea water
  holdTierPitch: 2.9,      // cell-guide slot height in the holds, m
  freeSurface: 0.3,        // free-surface GM correction, m
  reeferKW: 6.5,           // average power draw per reefer, kW
  deckStackLimit: 140,     // t per 40' deck stack (lashing limit)
  holdStackLimit: 250,     // t per 40' hold stack (tank-top limit)
  visibilityLimit: Math.min(2 * SHIP.L, 500), // SOLAS V/22 blind sector ahead of the bow, m
  ...V.hydro,              // summerDraft, tankTop, reeferPlugs, lightship, consumables
};

// Shipping-line style box colours (linear-ish sRGB hex) with relative frequency.
export const CONTAINER_PALETTE = [
  { color: '#c43a7a', w: 7 },  // magenta
  { color: '#8e3226', w: 8 },  // oxide red
  { color: '#a8442e', w: 5 },  // brick
  { color: '#1f3f6d', w: 6 },  // navy
  { color: '#3f7fb7', w: 5 },  // mid blue
  { color: '#6aa6cc', w: 4 },  // light blue
  { color: '#c9cac6', w: 5 },  // light grey
  { color: '#e7e4da', w: 3 },  // white
  { color: '#6b6f72', w: 3 },  // dark grey
  { color: '#2f6a42', w: 3 },  // green
  { color: '#d2672b', w: 3 },  // orange
  { color: '#2c8a8e', w: 2 },  // teal
  { color: '#c9a42a', w: 2 },  // yellow
  { color: '#7a4b31', w: 2 },  // brown
  { color: '#b52d34', w: 3 },  // red
];

export const LIVERIES = {
  magenta: {
    label: 'Magenta',
    hull: '#c3166b', bottom: '#7a1a2b', boot: '#5d1422',
    super: '#f1f0ec', funnel: '#c3166b', funnelTop: '#1b1b1d',
    deck: '#3e4a47', lashing: '#8f9696', hatch: '#4d5654',
    brand: 'NOVA', brandColor: '#ffffff', nameColor: '#ffffff',
  },
  black: {
    label: 'Black / Red',
    hull: '#16181c', bottom: '#8d2020', boot: '#6e1818',
    super: '#efe6c8', funnel: '#efe6c8', funnelTop: '#161616',
    deck: '#3b3f3f', lashing: '#c24a1f', hatch: '#4a4f50',
    brand: 'ATLAS', brandColor: '#f4f4f4', nameColor: '#f4f4f4',
  },
  blue: {
    label: 'Deep Blue',
    hull: '#1c3a5e', bottom: '#8a2322', boot: '#6a1b1b',
    super: '#f2f2ef', funnel: '#1c3a5e', funnelTop: '#1a1a1a',
    deck: '#3d4845', lashing: '#d4a21d', hatch: '#51595a',
    brand: 'MERIDIAN', brandColor: '#ffffff', nameColor: '#ffffff',
  },
  coral: {
    label: 'Coral',
    hull: '#e2583e', bottom: '#5a1f1c', boot: '#2b2b2e',
    super: '#f4f1ea', funnel: '#e2583e', funnelTop: '#1b1b1d',
    deck: '#44504b', lashing: '#e8e2d4', hatch: '#53605b',
    brand: 'CORAL', brandColor: '#ffffff', nameColor: '#ffffff',
  },
};

export const ENV = {
  dayTime: 14.5,     // hours
  nightTime: 22.8,
  transitionSeconds: 7,
  windDirDeg: 140,   // direction the wind-sea travels towards (0 = +X)
  seaState: 1.0,
  speedKnots: 12,
};
