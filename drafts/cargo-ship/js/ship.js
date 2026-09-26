// Procedural container vessel: faired hull with bulbous bow and transom stern,
// accommodation block with bridge, engine casing + funnel, lashing bridges, hatch covers,
// deck machinery, railings and a full night lighting rig. Every dimension derives from the
// active vessel's SHIP config; the fitting positions below were authored on a 366 × 51 × 30.2 m
// reference hull (T 14.5 m) and scale to each vessel with the kL / kB / kD / kT ratios.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SHIP, HYDRO } from './config.js';
import {
  makeHullTexture, makeTransomTexture, makeFacadeTextures, makeBridgeWindowTexture,
  makeGlowTexture, makeFunnelTexture, rng,
} from './textures.js';

const { L, B, D, T } = SHIP;
const HB = B / 2;
const SS = SHIP.super;
const kL = L / 366, kB = B / 51, kD = D / 30.2, kT = T / 14.5;
export const Y_DECK = D - T;                  // main deck height above the waterline
export const Y_CARGO = Y_DECK + SHIP.hatchHeight;
export const Y_HOLD = HYDRO.tankTop - T;          // tank top (hold floor) relative to the waterline

/* ------------------------------------------------------------------ hull form */

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
export const Z_TRANSOM = 12.2 * kD;                      // transom bottom, height above keel
const X_FWD_BODY = L / 2 - 0.3 * L;           // end of parallel midbody (fwd)
const X_AFT_BODY = -L / 2 + 0.27 * L;         // start of parallel midbody (aft)
const BULB = { xc: L / 2 - 12.5 * kL, len: 11.8 * kL, zc: 6.4 * kT, rz: 5.3 * kT, ry: 3.9 * kB, back: L / 2 - 36 * kL };
const STEM = [[0, L / 2 - 17 * kL], [2.5 * kT, L / 2 - 11 * kL], [9.5 * kT, L / 2 - 8 * kL], [T, L / 2 - 5.5 * kL], [22 * kD, L / 2 - 2.3 * kL], [D + 3 * kD, L / 2 + 0.6 * kL]];

function interp(pts, z) {
  if (z <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (z <= pts[i][0]) {
    const t = (z - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
    return lerp(pts[i - 1][1], pts[i][1], t);
  }
  return pts[pts.length - 1][1];
}

export const stemX = (z) => interp(STEM, z);
export const aftX = (z) => (z >= Z_TRANSOM ? -L / 2 : -L / 2 + 24 * kL * Math.pow(1 - z / Z_TRANSOM, 0.65));
function bulbTipX(z) {
  const dz = Math.abs(z - BULB.zc);
  return dz >= BULB.rz ? -Infinity : BULB.xc + BULB.len * Math.sqrt(1 - (dz / BULB.rz) ** 2);
}
export const foreX = (z) => Math.max(stemX(z), bulbTipX(z));

function bulbHalf(x, z) {
  let s = 0;
  if (x > BULB.xc) s = Math.sqrt(Math.max(0, 1 - ((x - BULB.xc) / BULB.len) ** 2));
  else if (x > BULB.back) s = smooth(BULB.back, BULB.back + 12 * kL, x);
  if (s <= 0) return 0;
  const q = 1 - ((z - BULB.zc) / (BULB.rz * Math.max(s, 0.3))) ** 2;
  return q > 0 ? BULB.ry * s * Math.sqrt(q) : 0;
}

// Half-breadth of the moulded hull at ship-local x and height z above the keel.
export function halfBreadth(x, z) {
  const R = SHIP.bilgeRadius;
  const base = z < R ? HB - R + Math.sqrt(Math.max(0, R * R - (R - z) ** 2)) : HB;
  let w = 1;
  if (x > X_FWD_BODY) {
    const t = Math.min(1, (x - X_FWD_BODY) / (stemX(z) - X_FWD_BODY));
    w = 1 - Math.pow(t, lerp(1.75, 3.6, Math.min(1, z / (D + 3))));
  } else if (x < X_AFT_BODY) {
    const t = Math.min(1, Math.max(0, (X_AFT_BODY - x) / (X_AFT_BODY - aftX(z))));
    const m = smooth(Z_TRANSOM, Z_TRANSOM + 6 * kD, z);
    w = 1 - lerp(1, 0.14, m) * Math.pow(t, lerp(1.7, 5.5, m));
  }
  return Math.max(base * Math.max(w, 0), bulbHalf(x, z));
}

export function hullWaterlineProfile(n = 256) {
  const xAft = -L / 2, xFore = stemX(T);
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round((halfBreadth(xAft + (i / (n - 1)) * (xFore - xAft), T) / HB) * 255);
  return { data, xAft, xFore };
}

function buildHullGeometry() {
  const NI = 180, NJ = 44;
  const sides = [];
  for (const sgn of [1, -1]) {
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= NJ; j++) {
      const z = (j / NJ) * D;
      const xa = aftX(z), xf = foreX(z);
      for (let i = 0; i <= NI; i++) {
        const u = i / NI;
        const s = 0.5 - 0.5 * Math.cos(Math.PI * u);
        const x = xa + s * (xf - xa);
        const y = halfBreadth(x, z);
        pos.push(x, z - T, sgn * y);
        const ut = (x + L / 2) / L;
        const v = Math.min(z / D, 0.999);
        uv.push(sgn > 0 ? ut : 1 - ut, sgn > 0 ? 0.5 + 0.5 * v : 0.5 * v);
      }
    }
    for (let j = 0; j < NJ; j++) for (let i = 0; i < NI; i++) {
      const a = j * (NI + 1) + i, b = a + 1, c = a + NI + 1, d = c + 1;
      if (sgn > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    sides.push(g);
  }
  return mergeGeometries(sides);
}

// Forecastle bulwark rising from the deck edge towards the stem.
function buildBulwark() {
  const pos = [], uv = [], idx = [];
  const x0 = L / 2 - 52 * kL, x1 = stemX(D);
  const N = 60;
  const hgt = (x) => 2.6 * smooth(x0, x0 + 18 * kL, x);
  for (const sgn of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const x = x0 + (i / N) * (x1 - x0);
      const y = halfBreadth(x, D);
      const h = hgt(x);
      const ut = (x + L / 2) / L;
      const us = sgn > 0 ? ut : 1 - ut, vb = sgn > 0 ? 0.999 : 0.499;
      pos.push(x, Y_DECK, sgn * y, x, Y_DECK + h, sgn * (y + h * 0.12)); uv.push(us, vb, us, vb);
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildDeckGeometry(zAbove = D, yOff = 0) {
  const N = 200, pos = [], idx = [], uv = [];
  const xa = aftX(zAbove), xf = stemX(zAbove);
  for (let i = 0; i <= N; i++) {
    const x = xa + (i / N) * (xf - xa);
    const y = halfBreadth(x, zAbove);
    pos.push(x, zAbove - T + yOff, y, x, zAbove - T + yOff, -y);
    uv.push(x / 20, y / 20, x / 20, -y / 20);
  }
  for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildTransomGeometry() {
  const pos = [], uv = [], idx = [];
  const N = 20;
  for (let j = 0; j <= N; j++) {
    const z = Z_TRANSOM + (j / N) * (D - Z_TRANSOM);
    const y = halfBreadth(-L / 2, z);
    pos.push(-L / 2, z - T, y, -L / 2, z - T, -y);
    const v = (z - Z_TRANSOM) / (D - Z_TRANSOM);
    uv.push(0.5 + y / B, v, 0.5 - y / B, v);
  }
  for (let j = 0; j < N; j++) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Longitudinal profile outline of the hull (ship-local x, y) for silhouettes.
export function hullOutline(stepsZ = 24) {
  const pts = [];
  pts.push([aftX(D), D - T], [stemX(D), D - T]);
  for (let i = stepsZ; i >= 0; i--) { const z = (i / stepsZ) * D; pts.push([foreX(z), z - T]); }
  for (let i = 0; i <= stepsZ; i++) { const z = (i / stepsZ) * Z_TRANSOM; pts.push([aftX(z), z - T]); }
  pts.push([-L / 2, Z_TRANSOM - T]);
  return pts;
}

/* ------------------------------------------------------------------ deck layout / bays */

export function computeLayout() {
  const bays = [], blocks = [], bridges = [];
  let x = L / 2 - SHIP.forecastle;
  let k = 0, prevWasBay = false;
  for (const item of SHIP.layout) {
    if (item.type === 'bay') {
      const fore = x, aft = x - SHIP.bayPitch;
      if (prevWasBay) bridges.push({ x: fore, tiersFore: bays[bays.length - 1].tiers, tiersAft: item.tiers });
      const cx = (fore + aft) / 2;
      const minHB = Math.min(halfBreadth(fore - 0.8, D), halfBreadth(aft + 0.8, D)) - 1.1;
      const n = Math.min(SHIP.maxRows, Math.floor((2 * minHB) / SHIP.rowPitch));
      const rows = [];
      if (n % 2 === 1) rows.push({ row: 0, z: 0 });
      for (let i = 0; i < Math.floor(n / 2); i++) {
        const off = n % 2 === 1 ? (i + 1) * SHIP.rowPitch : (i + 0.5) * SHIP.rowPitch;
        rows.push({ row: 2 * i + 1, z: off });       // starboard: odd
        rows.push({ row: 2 * i + 2, z: -off });      // port: even
      }
      rows.sort((a, b) => a.z - b.z);
      // Hold cell guides: a row exists at a hold tier only where the hull is wide enough at both bay ends.
      const holdRows = [];
      for (let i = 0; i < SHIP.holdTiers; i++) {
        const zTop = HYDRO.tankTop + (i + 1) * HYDRO.holdTierPitch;
        const zBot = HYDRO.tankTop + i * HYDRO.holdTierPitch;
        const lim = Math.min(
          halfBreadth(fore - 0.8, zBot), halfBreadth(aft + 0.8, zBot),
          halfBreadth(fore - 0.8, zTop), halfBreadth(aft + 0.8, zTop),
        ) - 1.6;
        holdRows.push(new Set(rows.filter((r) => Math.abs(r.z) + SHIP.rowPitch / 2 <= lim).map((r) => r.row)));
      }
      bays.push({
        index: k, bay: 4 * k + 2, foreBay20: 4 * k + 1, aftBay20: 4 * k + 3,
        x: cx, fore, aft, tiers: item.tiers, rows, rowCount: n, holdRows,
      });
      k++;
      prevWasBay = true;
      x = aft;
    } else {
      blocks.push({ type: item.type, fore: x, aft: x - item.length });
      x -= item.length;
      prevWasBay = false;
    }
  }
  bridges.forEach((b) => {
    const ba = bays.find((q) => Math.abs(q.fore - b.x) < 0.01);
    const bf = bays.find((q) => Math.abs(q.aft - b.x) < 0.01);
    b.halfWidth = (Math.max(ba.rowCount, bf.rowCount) * SHIP.rowPitch) / 2 + 0.6;
    b.levels = Math.min(ba.tiers, bf.tiers) >= 9 ? 3 : 2;
  });
  return { bays, blocks, bridges };
}

/* ------------------------------------------------------------------ deck-light shader patch */

export const MAX_LAMPS = 48;
export const deckLightUniforms = {
  uLamps: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector4()) },
  uLampCount: { value: 0 },
  uLampColor: { value: new THREE.Color(1.0, 0.74, 0.45) },
  uLightsOn: { value: 0 },
  uLampSpread: { value: 0.06 },
};

// Adds cheap "many lamps" deck lighting evaluated in ship space. Geometry of non-instanced meshes
// must be authored in ship-local coordinates (mesh transform = identity under the ship group).
export function patchDeckLights(material, key = 'std', extra = null) {
  material.onBeforeCompile = (shader, renderer) => {
    if (extra) extra(shader, renderer);
    Object.assign(shader.uniforms, deckLightUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShipPos;\nvarying vec3 vShipNrm;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vShipPos = (instanceMatrix * vec4(transformed, 1.0)).xyz;
          vShipNrm = normalize(mat3(instanceMatrix) * objectNormal);
        #else
          vShipPos = transformed;
          vShipNrm = objectNormal;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vShipPos;
        varying vec3 vShipNrm;
        uniform vec4 uLamps[${MAX_LAMPS}];
        uniform int uLampCount;
        uniform vec3 uLampColor;
        uniform float uLightsOn;
        uniform float uLampSpread;
        vec3 deckLight() {
          if (uLightsOn < 0.002) return vec3(0.0);
          vec3 n = normalize(vShipNrm);
          float acc = 0.0;
          for (int i = 0; i < ${MAX_LAMPS}; i++) {
            if (i >= uLampCount) break;
            vec4 lp = uLamps[i];
            vec3 d = lp.xyz - vShipPos;
            vec3 ds = d * vec3(1.0, 1.0, uLampSpread);
            float nd = max(dot(n, normalize(d)), 0.0) * 0.8 + 0.2;
            acc += lp.w * nd / (1.0 + dot(ds, ds) * 0.03);
          }
          return uLampColor * acc * uLightsOn;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * deckLight();`);
  };
  material.customProgramCacheKey = () => `decklights-${key}`;
  return material;
}

/* ------------------------------------------------------------------ helpers */

class Bucket {
  constructor() { this.parts = new Map(); }
  add(key, geo) { if (!this.parts.has(key)) this.parts.set(key, []); this.parts.get(key).push(geo); return geo; }
  box(key, w, h, d, x, y, z, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rz) g.rotateZ(rz);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return this.add(key, g);
  }
  cyl(key, rt, rb, h, x, y, z, seg = 12, axis = 'y') {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    g.translate(x, y, z);
    return this.add(key, g);
  }
  build(materials, group, { cast = true, receive = true } = {}) {
    for (const [key, list] of this.parts) {
      const clean = list.map((g) => (g.index ? g.toNonIndexed() : g));
      clean.forEach((g) => { if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); });
      const merged = mergeGeometries(clean.map((g) => { const keep = new THREE.BufferGeometry(); ['position', 'normal', 'uv'].forEach((a) => keep.setAttribute(a, g.attributes[a])); return keep; }));
      const m = new THREE.Mesh(merged, materials[key]);
      m.castShadow = cast; m.receiveShadow = receive;
      m.name = key;
      group.add(m);
    }
  }
}

// Box with UVs in metres / tile size (for repeating facade textures)
function facadeBox(w, h, d, tileW, tileH) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, uv.getX(i) * dims[f][0] / tileW, uv.getY(i) * dims[f][1] / tileH);
  }
  return g;
}

/* ------------------------------------------------------------------ ship */

export class Ship {
  constructor(liveryKey, liveries) {
    this.liveries = liveries;
    this.group = new THREE.Group();
    this.group.rotation.order = 'YZX';
    this.layout = computeLayout();
    this.cargoRoot = new THREE.Group();
    this.group.add(this.cargoRoot);
    this.bowX = stemX(T);
    this.sternX = -L / 2;
    this.halfBeam = HB;
    this.radars = [];
    this.navLights = [];
    this.lampList = [];
    this.lightsOn = -1;
    this.glowTex = makeGlowTexture();
    this.createMaterials(liveries[liveryKey]);
    this.buildHull();
    this.buildDeckGear();
    this.buildHouse();
    this.buildCasing();
    this.buildLashingAndHatches();
    this.buildRailings();
    this.buildLights();
    this.liveryKey = liveryKey;
  }

  createMaterials(lv) {
    const facade = makeFacadeTextures(lv.super);
    const bridge = makeBridgeWindowTexture();
    const std = (o) => new THREE.MeshStandardMaterial(o);
    this.facadeTex = facade;
    this.mat = {
      hull: std({ map: makeHullTexture(lv), roughness: 0.52, metalness: 0.15, side: THREE.DoubleSide }),
      transom: std({ map: makeTransomTexture(lv), roughness: 0.5, metalness: 0.15, side: THREE.DoubleSide }),
      deck: patchDeckLights(std({ color: lv.deck, roughness: 0.85, metalness: 0.1 })),
      facade: patchDeckLights(std({ map: facade.map, roughnessMap: facade.roughness, emissiveMap: facade.emissive, emissive: new THREE.Color(1, 0.85, 0.65), emissiveIntensity: 0, metalness: 0.1, roughness: 1 })),
      bridge: std({ map: bridge.map, emissiveMap: bridge.emissive, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, roughness: 0.25, metalness: 0.3 }),
      super: patchDeckLights(std({ color: lv.super, roughness: 0.55, metalness: 0.1 })),
      funnel: std({ map: makeFunnelTexture(lv), roughness: 0.5, metalness: 0.1 }),
      dark: std({ color: '#1d1f22', roughness: 0.6, metalness: 0.4 }),
      steel: patchDeckLights(std({ color: '#7d8386', roughness: 0.55, metalness: 0.5 })),
      lashing: patchDeckLights(std({ color: lv.lashing, roughness: 0.6, metalness: 0.3 })),
      hatch: patchDeckLights(std({ color: lv.hatch, roughness: 0.7, metalness: 0.25 })),
      orange: std({ color: '#ff6a13', roughness: 0.45, metalness: 0.05 }),
      white: std({ color: '#f2f2ee', roughness: 0.4, metalness: 0.05 }),
      rail: std({ color: '#d9d9d2', roughness: 0.5, metalness: 0.4 }),
      winch: patchDeckLights(std({ color: '#3b5a3f', roughness: 0.6, metalness: 0.3 })),
      yellow: std({ color: '#d8b21e', roughness: 0.5, metalness: 0.2 }),
    };
  }

  setLivery(key) {
    const lv = this.liveries[key];
    if (!lv) return;
    this.liveryKey = key;
    const swap = (m, t) => { if (m.map) m.map.dispose(); m.map = t; m.needsUpdate = true; };
    swap(this.mat.hull, makeHullTexture(lv));
    swap(this.mat.transom, makeTransomTexture(lv));
    swap(this.mat.funnel, makeFunnelTexture(lv));
    const f = makeFacadeTextures(lv.super);
    swap(this.mat.facade, f.map);
    this.mat.deck.color.set(lv.deck);
    this.mat.super.color.set(lv.super);
    this.mat.lashing.color.set(lv.lashing);
    this.mat.hatch.color.set(lv.hatch);
  }

  buildHull() {
    const hull = new THREE.Mesh(buildHullGeometry(), this.mat.hull);
    const bulwark = new THREE.Mesh(buildBulwark(), this.mat.hull);
    const deck = new THREE.Mesh(buildDeckGeometry(), this.mat.deck);
    const transom = new THREE.Mesh(buildTransomGeometry(), this.mat.transom);
    for (const m of [hull, bulwark, deck, transom]) { m.castShadow = true; m.receiveShadow = true; this.group.add(m); }
  }

  buildDeckGear() {
    const b = new Bucket();
    const { bays } = this.layout;
    const firstFore = bays[0].fore;
    // breakwater: V-shaped wall ahead of bay 01
    const xb = firstFore + 3;
    const hbw = halfBreadth(xb, D) - 0.6;
    const len = Math.hypot(hbw, 6);
    const ang = Math.atan2(6, hbw);
    for (const s of [1, -1]) {
      b.box('super', len, 7, 0.35, xb + 3, Y_DECK + 3.5, s * hbw / 2, s * ang);
      for (let i = 0; i < 9; i++) { // stiffeners
        const t = (i + 0.5) / 9;
        b.box('super', 0.25, 7, 1.4, xb + 6 - t * 6 - 0.9, Y_DECK + 3.5, s * t * hbw, s * ang);
      }
    }
    // foremast
    const fx = L / 2 - 11 * kL;
    b.cyl('super', 0.35, 0.7, 16, fx, Y_DECK + 8, 0);
    b.box('super', 2.4, 0.2, 2.4, fx, Y_DECK + 12, 0);
    b.box('super', 3.6, 0.25, 0.25, fx, Y_DECK + 14.5, 0);
    this.foremastTop = new THREE.Vector3(fx, Y_DECK + 16.3, 0);
    // windlasses, chain pipes, mooring winches
    for (const s of [1, -1]) {
      const wx = L / 2 - 19 * kL, wz = s * 6.5 * kB;
      b.box('winch', 3.2, 1.4, 4.2, wx, Y_DECK + 0.7, wz);
      b.cyl('winch', 1.2, 1.2, 1.6, wx, Y_DECK + 2.1, wz - s * 0.8, 20, 'z');
      b.cyl('dark', 0.9, 0.9, 0.8, wx, Y_DECK + 2.1, wz + s * 1.3, 16, 'z');
      b.cyl('dark', 0.35, 0.35, 9, wx + 4.3, Y_DECK + 0.3, wz + s * 3.6, 8, 'x');
      for (const mx of [L / 2 - 30 * kL, L / 2 - 40 * kL, -L / 2 + 9 * kL, -L / 2 + 17 * kL]) {
        const mz = s * (halfBreadth(mx, D) * 0.45);
        b.box('winch', 2.4, 1.1, 3.4, mx, Y_DECK + 0.55, mz);
        b.cyl('winch', 0.9, 0.9, 2.6, mx, Y_DECK + 1.8, mz, 18, 'z');
        b.cyl('dark', 1.0, 1.0, 0.12, mx, Y_DECK + 1.8, mz + 1.35, 18, 'z');
        b.cyl('dark', 1.0, 1.0, 0.12, mx, Y_DECK + 1.8, mz - 1.35, 18, 'z');
      }
      // bollards + fairleads along the edges fore & aft
      for (const bx of [L / 2 - 26 * kL, L / 2 - 36 * kL, L / 2 - 46 * kL, -L / 2 + 5 * kL, -L / 2 + 13 * kL, -L / 2 + 21 * kL, -60 * kL, 0, 60 * kL]) {
        const bz = s * (halfBreadth(bx, D) - 1.4);
        b.box('dark', 1.6, 0.35, 0.8, bx, Y_DECK + 0.17, bz);
        b.cyl('dark', 0.3, 0.3, 0.9, bx - 0.45, Y_DECK + 0.6, bz, 10);
        b.cyl('dark', 0.3, 0.3, 0.9, bx + 0.45, Y_DECK + 0.6, bz, 10);
      }
    }
    // stern bulwark + stern light post
    for (let i = 0; i < 12; i++) {
      const z0 = -HB * 0.84 + (i / 12) * HB * 1.68, z1 = z0 + (HB * 1.68) / 12;
      b.box('super', 0.25, 1.4, z1 - z0, -L / 2 + 0.3, Y_DECK + 0.7, (z0 + z1) / 2);
    }
    b.cyl('super', 0.15, 0.2, 5, -L / 2 + 1.5, Y_DECK + 2.5, 0);
    this.sternLightPos = new THREE.Vector3(-L / 2 + 1.5, Y_DECK + 5.2, 0);
    // pedestal deck cranes (geared vessels): port-side pedestal in the gap between
    // two hatches, slewing cab, and a jib raised forward over the stack
    this.cranes = [];
    for (const blk of this.layout.blocks.filter((q) => q.type === 'crane')) {
      const cx = (blk.fore + blk.aft) / 2, cz = -(HB - 3.2);
      const pedH = 9 + Math.max(...this.layout.bays.map((q) => q.tiers)) * 1.1;
      const top = Y_DECK + pedH;
      b.cyl('yellow', 1.5, 1.8, pedH, cx, Y_DECK + pedH / 2, cz, 18);
      b.box('yellow', 5, 4, 4.2, cx, top + 2, cz);                              // slewing house
      b.box('dark', 1.8, 1.4, 0.1, cx + 1.2, top + 2.6, cz + 2.12);            // cab window
      const jib = 26, ang = 0.42;
      const g = new THREE.BoxGeometry(jib, 0.9, 1.1);
      g.translate(jib / 2, 0, 0); g.rotateZ(ang); g.translate(cx + 1.5, top + 1, cz + 1);
      b.add('yellow', g);
      b.box('yellow', 1, 3.2, 1, cx - 1.5, top + 5.4, cz);                      // A-frame
      const tipX = cx + 1.5 + jib * Math.cos(ang), tipY = top + 1 + jib * Math.sin(ang);
      b.cyl('dark', 0.06, 0.06, tipY - top - 2, tipX, (tipY + top + 2) / 2, cz + 1, 4);   // hoist wire
      b.box('dark', 1.2, 0.5, 2.4, tipX, top + 2, cz + 1);                      // hook block
      this.cranes.push({ x: cx, z: cz, top, tipX, tipY });
    }
    // access walkways along the side (catwalk along the hatch coamings)
    b.build(this.mat, this.group);
  }

  buildHouse() {
    const blk = this.layout.blocks.find((q) => q.type === 'house');
    const xc = (blk.fore + blk.aft) / 2, depth = blk.fore - blk.aft;
    this.house = blk;
    const b = new Bucket();
    const tile = [24, 23.2];
    const fb = (w, h, d, x, y, z) => { const g = facadeBox(w, h, d, tile[0], tile[1]); g.translate(x, y, z); b.add('facade', g); };
    const towerTop = Y_DECK + SS.towerH;
    fb(SS.baseW, 6, depth - 0.5, xc, Y_DECK + 3, 0);                     // stores / base
    fb(SS.towerW, towerTop - Y_DECK - 6, depth - 2, xc, (towerTop + Y_DECK + 6) / 2, 0); // accommodation tower
    fb(18 * kB, 5, depth - 4, xc - 1, towerTop + 2.5 + 3.6, 0);         // wheelhouse top deck
    // bridge (full width, windows)
    const bw = B + 3.2, bd = 9, bh = 3.8, bx = blk.fore - bd / 2;
    const bg = facadeBox(bd, bh, bw, 6, 3.8);
    bg.translate(bx, towerTop + bh / 2, 0);
    b.add('bridge', bg);
    b.box('super', bd + 0.8, 0.35, bw + 0.8, bx, towerTop + bh + 0.17, 0);       // bridge roof
    b.box('super', bd + 0.4, 0.5, bw, bx, towerTop - 0.25, 0);                  // bridge floor slab
    for (const s of [1, -1]) {                                                   // wing supports
      b.box('super', 1.2, 0.6, (bw - SS.towerW) / 2, bx, towerTop - 0.8, s * (SS.towerW / 2 + (bw - SS.towerW) / 4));
      b.box('super', 0.6, 5, 0.6, bx - 2, towerTop - 3, s * (SS.towerW / 2 + 0.5), 0, s * 0.0);
    }
    // radar mast
    const mx = xc - 1, my = towerTop + 8.6;
    b.box('super', 1.0, 10, 1.0, mx, my + 5, 0);
    b.box('super', 2.6, 0.25, 9 * kB, mx, my + 5.5, 0);
    b.box('super', 2.2, 0.25, 6, mx, my + 8.6, 0);
    b.box('super', 0.2, 3.5, 0.2, mx, my + 11.5, 0);
    this.mastTop = new THREE.Vector3(mx, my + 13.4, 0);
    for (const [dz, dy] of [[3.2, 5.9], [-2.2, 9.0]]) {
      const radar = new THREE.Group();
      radar.position.set(mx, my + dy, dz);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 5.5), this.mat.white);
      bar.position.y = 0.55; bar.castShadow = true;
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.6, 10), this.mat.dark);
      ped.position.y = 0.2;
      radar.add(bar, ped);
      this.group.add(radar);
      this.radars.push({ obj: radar, speed: dz > 0 ? 2.6 : 2.1 });
    }
    // sat domes + whip antennas
    for (const [dx, dz] of [[-3, 7 * kB], [-3, -7 * kB], [2, 8.5 * kB]]) {
      b.cyl('super', 0.18, 0.18, 1.6, xc + dx, towerTop + 8.6 + 0.8, dz, 8);
      const s = new THREE.SphereGeometry(0.95, 18, 12); s.translate(xc + dx, towerTop + 8.6 + 2.2, dz); b.add('white', s);
    }
    for (let i = 0; i < 5; i++) b.cyl('dark', 0.03, 0.05, 6, xc - 4 + i * 1.6, towerTop + 11.6, (-8 + (i % 2) * 16) * kB, 5);
    // rescue boat + davit on starboard
    const boat = new THREE.CapsuleGeometry(1.4, 5.5, 6, 12); boat.rotateZ(Math.PI / 2); boat.scale(1, 0.7, 1);
    const boatZ = SS.towerW / 2 + 1.6, boatY = Y_DECK + 13 * (SS.towerH / 38);
    boat.translate(xc + 1, boatY, boatZ); b.add('orange', boat);
    b.box('super', 0.5, 5, 0.5, xc + 4, boatY + 0.5, boatZ - 1.2);
    b.box('super', 0.5, 0.5, 2.8, xc + 4, boatY + 3, boatZ);
    // funnel-like mast casing for pipes on top of the tower
    b.box('super', 2.5, 4, 2.5, xc - 5, towerTop + 7.5, -3);
    b.build(this.mat, this.group);
    this.bridgeWing = { x: blk.fore - 3, y: towerTop + 2.2, z: bw / 2 + 0.2 };
    this.towerTop = towerTop;
  }

  buildCasing() {
    const blk = this.layout.blocks.find((q) => q.type === 'casing');
    const xc = (blk.fore + blk.aft) / 2, depth = blk.fore - blk.aft;
    this.casing = blk;
    const b = new Bucket();
    const cg = facadeBox(depth - 0.6, SS.casingH, SS.casingW, 24, 23.2);
    cg.translate(xc, Y_DECK + SS.casingH / 2, 0);
    b.add('super', cg);
    // louvres
    for (const s of [1, -1]) for (let i = 0; i < 4; i++) b.box('dark', 1.8, 2.2, 0.1, xc - 4 + i * 2.6, Y_DECK + SS.casingH * 0.75, s * (SS.casingW / 2 + 0.05));
    // funnel
    const fr = SS.funnelR, fBase = Y_DECK + SS.casingH, fTop = fBase + SS.funnelH;
    const fcx = xc - 0.5;
    let pipeX = xc - 0.7;                       // exhaust pipe cluster centre (moves aft on a raked funnel)
    if (SS.funnel === 'twin') {
      // two slim stacks side by side, joined by a crossbar
      for (const s of [1, -1]) {
        const g = new THREE.CylinderGeometry(fr * 0.42, fr * 0.48, SS.funnelH, 20, 1);
        g.translate(fcx, fBase + SS.funnelH / 2, s * fr * 0.62);
        b.add('funnel', g);
        b.cyl('dark', 0.8, 0.8, 2.4, fcx, fTop + 0.6, s * fr * 0.62, 14);
      }
      b.box('super', fr * 0.5, 0.8, fr * 1.3, fcx, fBase + SS.funnelH * 0.62, 0);
    } else if (SS.funnel === 'raked' || SS.funnel === 'square') {
      // box funnel; 'raked' shears it aft with height (a classic older profile)
      const rake = SS.funnel === 'raked' ? 0.32 : 0;
      const g = new THREE.BoxGeometry(fr * 1.5, SS.funnelH, fr * 1.55, 1, 4, 1);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) - (pos.getY(i) + SS.funnelH / 2) * rake);
      g.computeVertexNormals();
      g.translate(fcx, fBase + SS.funnelH / 2, 0);
      b.add('funnel', g);
      pipeX = fcx - SS.funnelH * rake - 0.2;
      for (let i = 0; i < 2; i++) b.cyl('dark', 0.7, 0.7, 2.6, pipeX, fTop + 0.8, i ? 1.3 : -1.3, 14);
    } else {
      const fg = new THREE.CylinderGeometry(fr * (6.5 / 7.2), fr, SS.funnelH, 24, 1);
      fg.scale(0.75, 1, 1.05);
      fg.translate(fcx, fBase + SS.funnelH / 2, 0);
      b.add('funnel', fg);
      for (let i = 0; i < 4; i++) {
        b.cyl('dark', 0.85, 0.85, 3.2, xc - 2 + (i % 2) * 2.6, fTop + 0.4, (i < 2 ? -1.6 : 1.6), 14);
      }
    }
    this.funnelTop = new THREE.Vector3(pipeX - 0.1, fTop + 2, 0);
    // free-fall lifeboat on the aft face
    const lb = new THREE.CapsuleGeometry(1.7, 6.5, 6, 14);
    lb.rotateZ(Math.PI / 2 + 0.55);
    const lbz = SS.casingW / 4;
    lb.translate(blk.aft - 3.2, Y_DECK + 7.5, lbz);
    b.add('orange', lb);
    b.box('steel', 7, 0.4, 3.6, blk.aft - 3.2, Y_DECK + 5.4, lbz, 0, 0.55);
    b.box('steel', 0.4, 6, 0.4, blk.aft - 5.8, Y_DECK + 3, lbz - 1.7);
    b.box('steel', 0.4, 6, 0.4, blk.aft - 5.8, Y_DECK + 3, lbz + 1.7);
    b.build(this.mat, this.group);
  }

  buildLashingAndHatches() {
    const b = new Bucket();
    const { bays, bridges } = this.layout;
    for (const bay of bays) {
      const w = bay.rowCount * SHIP.rowPitch;
      const len = SHIP.bayPitch - 1.3;
      b.box('deck', len + 0.4, 1.6, w + 1.6, bay.x, Y_DECK + 0.8, 0);            // coaming
      const pz = [-w / 3, 0, w / 3];
      for (const z of pz) b.box('hatch', len, 0.72, w / 3 - 0.1, bay.x, Y_DECK + 1.6 + 0.36, z); // pontoons
      b.box('hatch', 0.3, 0.12, w, bay.x - len / 2 + 0.6, Y_CARGO - 0.05, 0);
      b.box('hatch', 0.3, 0.12, w, bay.x + len / 2 - 0.6, Y_CARGO - 0.05, 0);
    }
    this.lampSpots = [];
    const R = rng(3);
    bridges.forEach((br, i) => {
      const lh = 2.85, H = br.levels * lh;
      const hw = br.halfWidth;
      const nPost = Math.round((hw * 2) / 4.9);
      for (let p = 0; p <= nPost; p++) {
        const z = -hw + (p / nPost) * hw * 2;
        for (const dx of [-0.55, 0.55]) b.box('lashing', 0.22, H + 1.1, 0.22, br.x + dx, Y_CARGO + (H + 1.1) / 2, z);
        if (p % 2 === 0) {
          this.lampSpots.push({ pos: new THREE.Vector3(br.x + 0.75, Y_CARGO + H + 0.9, z), delay: 0.15 + i * 0.025 + R() * 0.03 });
          this.lampSpots.push({ pos: new THREE.Vector3(br.x - 0.75, Y_CARGO + H + 0.9, z), delay: 0.15 + i * 0.025 + R() * 0.03 });
        }
      }
      for (let l = 1; l <= br.levels; l++) {
        const y = Y_CARGO + l * lh;
        b.box('lashing', 1.3, 0.12, hw * 2, br.x, y, 0);
        b.box('lashing', 0.06, 0.06, hw * 2, br.x - 0.62, y + 1.05, 0);
        b.box('lashing', 0.06, 0.06, hw * 2, br.x + 0.62, y + 1.05, 0);
        b.box('lashing', 0.04, 0.2, hw * 2, br.x - 0.62, y + 0.15, 0);
        b.box('lashing', 0.04, 0.2, hw * 2, br.x + 0.62, y + 0.15, 0);
      }
      // lamp heads
      for (let p = 0; p <= nPost; p += 2) {
        const z = -hw + (p / nPost) * hw * 2;
        b.box('dark', 0.45, 0.35, 0.5, br.x + 0.75, Y_CARGO + H + 0.9, z);
        b.box('dark', 0.45, 0.35, 0.5, br.x - 0.75, Y_CARGO + H + 0.9, z);
      }
      // stanchions for lashing rods at hatch level
      b.box('lashing', 1.2, 0.8, hw * 2, br.x, Y_CARGO + 0.4, 0);
    });
    // catwalks along the hatch coamings (outboard)
    for (const s of [1, -1]) {
      const xs = bays[0].fore, xe = bays[bays.length - 1].aft;
      b.box('deck', 0.12, 0.9, 0.08, (xs + xe) / 2, Y_DECK + 1.9, s * (HB - 0.6));
    }
    b.build(this.mat, this.cargoRoot);
  }

  buildRailings() {
    const posts = [];
    const railPts = { 1: [], '-1': [] };
    for (const s of [1, -1]) {
      for (let x = -L / 2 + 1; x < L / 2 - 50 * kL; x += 2.2) {
        const z = s * (halfBreadth(x, D) - 0.15);
        posts.push(new THREE.Vector3(x, Y_DECK, z));
        railPts[s].push(new THREE.Vector3(x, 0, z));
      }
    }
    const house = this.house;
    const bw = B + 3.2, bx = house.fore - 4.5, y = this.towerTop + 3.8 + 0.35;
    const around = [];
    const rx0 = bx - 4.8, rx1 = bx + 4.8, rz = bw / 2 + 0.3;
    for (let z = -rz; z <= rz; z += 2.2) { around.push(new THREE.Vector3(rx0, y, z)); around.push(new THREE.Vector3(rx1, y, z)); }
    const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.1, 5);
    postGeo.translate(0, 0.55, 0);
    const all = posts.concat(around);
    const im = new THREE.InstancedMesh(postGeo, this.mat.rail, all.length);
    const m4 = new THREE.Matrix4();
    all.forEach((p, i) => im.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
    this.group.add(im);
    const tubes = [];
    for (const s of ['1', '-1']) for (const h of [0.55, 1.1]) {
      const pts = railPts[s].map((p) => new THREE.Vector3(p.x, Y_DECK + h, p.z));
      tubes.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.03, 4));
    }
    for (const h of [0.55, 1.1]) {
      const loop = [[rx0, -rz], [rx1, -rz], [rx1, rz], [rx0, rz], [rx0, -rz]].map(([a, c]) => new THREE.Vector3(a, y + h, c));
      tubes.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loop, false, 'catmullrom', 0), 40, 0.03, 4));
    }
    const rails = new THREE.Mesh(mergeGeometries(tubes.map((t) => t.toNonIndexed())), this.mat.rail);
    this.group.add(rails);
  }

  buildLights() {
    const house = this.house, casing = this.casing;
    const spots = this.lampSpots;
    const R = rng(11);
    // accommodation front / sides floodlights and deck-edge lamps
    const kH = SS.towerH / 38, casingLampY = Y_DECK + SS.casingH * 0.9;
    for (let lvl = 0; lvl < 4; lvl++) {
      for (const z of [-12, -4, 4, 12]) spots.push({ pos: new THREE.Vector3(house.fore + 0.2, Y_DECK + (8 + lvl * 8) * kH, z * kB), delay: 0.05 + R() * 0.05 });
    }
    for (const z of [-12, 0, 12]) spots.push({ pos: new THREE.Vector3(house.aft - 0.2, Y_DECK + 10 * kH, z * kB), delay: 0.07 });
    for (const z of [-10, 0, 10]) {
      spots.push({ pos: new THREE.Vector3(casing.fore + 0.2, casingLampY, z * kB), delay: 0.1 });
      spots.push({ pos: new THREE.Vector3(casing.aft - 0.2, casingLampY, z * kB), delay: 0.1 });
    }
    for (let x = -L / 2 + 12; x < L / 2 - 40 * kL; x += 18) {
      for (const s of [1, -1]) spots.push({ pos: new THREE.Vector3(x, Y_DECK + 3.2, s * (halfBreadth(x, D) - 0.4)), delay: 0.3 + R() * 0.2 });
    }
    spots.push({ pos: new THREE.Vector3(this.foremastTop.x, Y_DECK + 12.2, 0), delay: 0.02 });

    const bulb = new THREE.SphereGeometry(0.26, 8, 6);
    this.bulbs = new THREE.InstancedMesh(bulb, new THREE.MeshBasicMaterial({ color: 0xffffff }), spots.length);
    const m4 = new THREE.Matrix4();
    spots.forEach((s, i) => { this.bulbs.setMatrixAt(i, m4.makeTranslation(s.pos.x, s.pos.y, s.pos.z)); this.bulbs.setColorAt(i, new THREE.Color(0.2, 0.2, 0.2)); });
    this.bulbs.frustumCulled = false;
    this.group.add(this.bulbs);

    // virtual lamps for the deck-light shader: one per lashing bridge + structure floods
    const lamps = [];
    this.layout.bridges.forEach((br) => lamps.push([br.x, Y_CARGO + br.levels * 2.85 + 0.9, 0, 1.0]));
    for (let lvl = 0; lvl < 3; lvl++) lamps.push([house.fore + 1, Y_DECK + (8 + lvl * 10) * kH, 0, 1.6]);
    lamps.push([house.aft - 1, Y_DECK + 10 * kH, 0, 1.2]);
    lamps.push([casing.fore + 1, casingLampY, 0, 1.3]);
    lamps.push([casing.aft - 1, casingLampY, 0, 1.3]);
    lamps.push([this.layout.bays[0].fore + 2, Y_DECK + 10, 0, 1.2]);
    lamps.push([L / 2 - 20 * kL, Y_DECK + 8, 0, 0.8]);
    lamps.push([-L / 2 + 10, Y_DECK + 6, 0, 0.8]);
    const u = deckLightUniforms;
    lamps.slice(0, MAX_LAMPS).forEach((l, i) => u.uLamps.value[i].set(...l));
    u.uLampCount.value = Math.min(lamps.length, MAX_LAMPS);

    // navigation lights (COLREG sectors)
    const wing = this.bridgeWing;
    const nav = (pos, color, sector, size = 5) => {
      const mat = new THREE.SpriteMaterial({ map: this.glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      const sp = new THREE.Sprite(mat);
      sp.position.copy(pos); sp.scale.setScalar(size);
      this.group.add(sp);
      this.navLights.push({ sprite: sp, color: new THREE.Color(color), sector });
      return sp;
    };
    nav(new THREE.Vector3(wing.x, wing.y, -wing.z), 0xff2a1a, { from: 0, to: 112.5, side: -1 });   // port: red
    nav(new THREE.Vector3(wing.x, wing.y, wing.z), 0x20ff60, { from: 0, to: 112.5, side: 1 });     // starboard: green
    nav(this.foremastTop, 0xfff4e0, { from: 0, to: 112.5, side: 0 }, 6);                        // fwd masthead
    nav(this.mastTop, 0xfff4e0, { from: 0, to: 112.5, side: 0 }, 6);                            // main masthead
    nav(this.sternLightPos, 0xfff4e0, { from: 112.5, to: 180, side: 0 }, 5);                     // stern light
    nav(this.funnelTop.clone().add(new THREE.Vector3(0, 1, 0)), 0xff3030, null, 3);           // aviation warning

    this.sideLights = [
      new THREE.PointLight(0xff2a1a, 0, 45, 2),
      new THREE.PointLight(0x20ff60, 0, 45, 2),
    ];
    this.sideLights[0].position.set(wing.x, wing.y, -wing.z + 0.8);
    this.sideLights[1].position.set(wing.x, wing.y, wing.z - 0.8);
    this.group.add(...this.sideLights);

    // floodlights from the accommodation onto the forward cargo
    this.floods = [];
    for (const z of [-9 * kB, 9 * kB]) {
      const s = new THREE.SpotLight(0xffd6a0, 0, 220, 0.55, 0.7, 1.6);
      s.position.set(house.fore + 0.5, this.towerTop - 4, z);
      s.target.position.set(house.fore + 70, Y_CARGO + 8, z * 1.5);
      this.group.add(s, s.target);
      this.floods.push(s);
    }
  }

  update(dt, t, env, camera) {
    for (const r of this.radars) r.obj.rotation.y += r.speed * dt;
    const on = env.lightsOn;

    if (Math.abs(on - this.lightsOn) > 0.0005) {
      this.lightsOn = on;
      const c = new THREE.Color();
      this.lampSpots.forEach((s, i) => {
        const k = smooth(s.delay, s.delay + 0.08, on);
        const flick = k > 0 && k < 1 ? (Math.sin(i * 12.9 + t * 60) > 0.3 ? 1 : 0.25) : 1;
        const e = k * flick;
        c.setRGB(0.25 + 22 * e, 0.25 + 15 * e, 0.22 + 8 * e);
        this.bulbs.setColorAt(i, c);
      });
      this.bulbs.instanceColor.needsUpdate = true;
      deckLightUniforms.uLightsOn.value = smooth(0.1, 0.7, on);
      this.mat.facade.emissiveIntensity = 2.2 * smooth(0.0, 0.5, on);
      this.mat.bridge.emissiveIntensity = 0.6 * smooth(0.0, 0.5, on);
      this.floods.forEach((f) => (f.intensity = 9000 * smooth(0.05, 0.3, on)));
      this.sideLights.forEach((l) => (l.intensity = 400 * on));
    }

    // navigation light visibility by sector (relative bearing of the camera from the ship)
    const local = this.group.worldToLocal(camera.position.clone());
    const bearing = THREE.MathUtils.radToDeg(Math.atan2(local.z, local.x)); // 0 = dead ahead, + = starboard
    for (const n of this.navLights) {
      let vis = 1;
      if (n.sector) {
        const ab = Math.abs(bearing);
        vis = ab >= n.sector.from - 2 && ab <= n.sector.to + 2 ? 1 : 0;
        if (n.sector.side === 1 && bearing < -2) vis = 0;
        if (n.sector.side === -1 && bearing > 2) vis = 0;
      }
      const blink = n.sector ? 1 : (Math.sin(t * 3) > 0 ? 1 : 0.1);
      const k = on * vis * blink;
      n.sprite.material.color.copy(n.color).multiplyScalar(6 * k);
      n.sprite.visible = k > 0.01;
    }
  }
}
