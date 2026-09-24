// Central configuration for the vessel, cargo system and environment.
// Everything is in metres / seconds. Ship-local frame: +X = bow (forward), +Y = up, +Z = starboard.
// y = 0 is the design waterline.

export const SHIP = {
  name: 'DOCK PIONEER',
  port: 'MONROVIA',
  imo: 'IMO 9876543',
  L: 366,          // length overall
  B: 51,           // moulded beam
  D: 30.2,         // moulded depth (keel -> main deck)
  T: 14.5,         // design draught
  bilgeRadius: 2.6,
  forecastle: 30,  // clear foredeck length from the stem to the first bay
  // Deck layout, listed bow -> stern. 'bay' = one 40' bay (two 20' slots).
  // tiers = maximum on-deck tiers for that bay (visibility line / stack weight limits).
  layout: [
    { type: 'bay', tiers: 6 }, { type: 'bay', tiers: 7 }, { type: 'bay', tiers: 8 },
    { type: 'bay', tiers: 8 }, { type: 'bay', tiers: 9 }, { type: 'bay', tiers: 9 },
    { type: 'bay', tiers: 9 },
    { type: 'house', length: 15 },
    { type: 'bay', tiers: 10 }, { type: 'bay', tiers: 10 }, { type: 'bay', tiers: 10 },
    { type: 'bay', tiers: 10 }, { type: 'bay', tiers: 10 }, { type: 'bay', tiers: 10 },
    { type: 'bay', tiers: 10 }, { type: 'bay', tiers: 10 }, { type: 'bay', tiers: 10 },
    { type: 'bay', tiers: 10 }, { type: 'bay', tiers: 10 },
    { type: 'casing', length: 13 },
    { type: 'bay', tiers: 9 }, { type: 'bay', tiers: 8 }, { type: 'bay', tiers: 7 },
  ],
  bayPitch: 13.9,        // 40' slot + lashing bridge
  rowPitch: 2.463,       // container width + cell gap
  maxRows: 20,
  hatchHeight: 2.35,     // coaming + hatch cover above main deck
  holdTiers: 9,          // logical below-deck tiers (02..18), not rendered while hatches are closed
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

// Ports of discharge on the rotation.
export const PORTS = [
  { code: 'NLRTM', name: 'Rotterdam',  color: '#4f9fe6' },
  { code: 'DEHAM', name: 'Hamburg',    color: '#f0913a' },
  { code: 'BEANR', name: 'Antwerp',    color: '#d0506a' },
  { code: 'GBFXT', name: 'Felixstowe', color: '#63c28a' },
  { code: 'FRLEH', name: 'Le Havre',   color: '#a98ee6' },
];

// Hydrostatic / structural constants (estimates for a ~366 m, 51 m beam ULCV).
export const HYDRO = {
  rho: 1.025,              // t/m^3 sea water
  summerDraft: 16.0,       // load-line (summer) draught, m
  tankTop: 2.2,            // double-bottom height above keel, m
  holdTierPitch: 2.9,      // cell-guide slot height in the holds, m
  freeSurface: 0.3,        // free-surface GM correction, m
  deckStackLimit: 140,     // t per 40' deck stack (lashing limit)
  holdStackLimit: 250,     // t per 40' hold stack (tank-top limit)
  reeferPlugs: 1400,
  reeferKW: 6.5,           // average power draw per reefer, kW
  visibilityLimit: 500,    // SOLAS V/22 blind sector ahead of the bow, m (min(2L, 500))
  lightship: [             // weight groups: t, x-range (ship-local), vertical centre above keel
    { name: 'Hull steel',       w: 30500, x0: -178, x1: 178, vcg: 14.2, shape: 'hull' },
    { name: 'Machinery',        w: 3800,  x0: -152, x1: -122, vcg: 8.5 },
    { name: 'Accommodation',    w: 2300,  house: true, vcg: 38 },
    { name: 'Casing & funnel',  w: 900,   casing: true, vcg: 40 },
    { name: 'Hatches & lashing', w: 1900, x0: -168, x1: 152, vcg: 32 },
  ],
  consumables: [
    { name: 'Heavy fuel oil',   w: 6200, x0: -112, x1: -38, vcg: 4.5 },
    { name: 'MGO, FW & stores', w: 1700, x0: -158, x1: -126, vcg: 11 },
    { name: 'Ballast water',    w: 2400, x0: -150, x1: 150, vcg: 1.4 },
  ],
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
};

export const ENV = {
  dayTime: 14.5,     // hours
  nightTime: 22.8,
  transitionSeconds: 7,
  windDirDeg: 140,   // direction the wind-sea travels towards (0 = +X)
  seaState: 1.0,
  speedKnots: 12,
};
