// Container stowage model + 3D renderer.
// Addressing follows the ISO 9711 BAY-ROW-TIER convention used on real stowage plans:
//   bay  : odd = 20' slot (01, 03, 05 ...), even = 40' bay spanning two 20' slots (02 = 01+03, 06 = 05+07 ...),
//          numbered from the bow aft.
//   row  : 00 on the centreline (odd row counts), odd rows to starboard, even rows to port, counted outboard.
//   tier : on deck 82, 84, 86 ...; in the hold 02, 04, 06 ... (hold boxes are tracked and used by the metrics /
//          stowage profile, but not drawn in 3D while the hatches are closed).
import * as THREE from 'three';
import { SHIP, HYDRO, CONTAINER_TYPES, CONTAINER_WIDTH, CONTAINER_PALETTE, PORTS } from './config.js';
import { Y_CARGO, Y_HOLD, patchDeckLights } from './ship.js';
import { makeContainerAtlas, ATLAS_ROWS, ATLAS_REGIONS } from './textures.js';
import { boxColor } from './colors.js';

const STACK_GAP = 0.03; // twistlock / stacking cone clearance
export const HALF_OFFSET = CONTAINER_TYPES['20'].length / 2 + 0.038;
export const fmt = (n) => String(n).padStart(2, '0');

function containerGeometry(type) {
  const t = CONTAINER_TYPES[type];
  const g = new THREE.BoxGeometry(t.length, t.height, CONTAINER_WIDTH);
  const uv = g.attributes.uv;
  const regions = [ATLAS_REGIONS.front, ATLAS_REGIONS.door, ATLAS_REGIONS.top, ATLAS_REGIONS.top, ATLAS_REGIONS.side, ATLAS_REGIONS.side];
  for (let f = 0; f < 6; f++) {
    const [u0, u1] = regions[f];
    for (let v = 0; v < 4; v++) { const i = f * 4 + v; uv.setX(i, u0 + uv.getX(i) * (u1 - u0)); }
  }
  return g;
}

function containerMaterial(atlas, key) {
  const m = new THREE.MeshStandardMaterial({
    map: atlas.map, normalMap: atlas.normal, normalScale: new THREE.Vector2(1, 1),
    roughness: 0.6, metalness: 0.3, envMapIntensity: 0.8,
  });
  patchDeckLights(m, key, (shader) => {
    shader.uniforms.uMask = { value: atlas.mask };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aVariant;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv.y = (vMapUv.y + aVariant) / ${ATLAS_ROWS}.0;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uMask;')
      .replace('#include <map_fragment>', `
        vec4 texel = texture2D(map, vMapUv);
        float tintMask = texture2D(uMask, vMapUv).r;`)
      .replace('#include <color_fragment>', `
        #if defined(USE_INSTANCING_COLOR) || defined(USE_COLOR)
          diffuseColor.rgb *= mix(texel.rgb, texel.rgb * vColor, tintMask);
        #else
          diffuseColor.rgb *= texel.rgb;
        #endif`);
  });
  return m;
}


export class Cargo {
  constructor(ship) {
    this.ship = ship;
    this.bays = ship.layout.bays;
    this.byNumber = new Map();
    this.bays.forEach((b) => { this.byNumber.set(b.bay, b); this.byNumber.set(b.foreBay20, b); this.byNumber.set(b.aftBay20, b); });
    // occupancy[bayIndex] -> Map(row -> Map(tier -> { fore, aft }))
    this.occ = this.bays.map(() => new Map());
    this.boxes = new Map(); // id -> box
    this.listeners = new Set();
    this.nextId = 1;
    this.dirty = false;
    this.version = 0;
    this.highlightId = null;
    this.colorMode = 'livery';

    const atlas20 = makeContainerAtlas(CONTAINER_TYPES['20'].length);
    const atlas40 = makeContainerAtlas(CONTAINER_TYPES['40'].length);
    const cap40 = this.bays.reduce((s, b) => s + b.rowCount * b.tiers, 0);
    this.meshes = {};
    for (const [type, atlas, cap] of [['20', atlas20, cap40 * 2], ['40', atlas40, cap40], ['40HC', atlas40, cap40]]) {
      const geo = containerGeometry(type);
      geo.setAttribute('aVariant', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
      const mesh = new THREE.InstancedMesh(geo, containerMaterial(atlas, `box${type === '20' ? 20 : 40}`), cap);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.instances = [];
      ship.cargoRoot.add(mesh);
      this.meshes[type] = mesh;
    }
  }

  /* ---------------------------------------------------------------- addressing */

  resolve(bayNo, half) {
    const bay = this.byNumber.get(bayNo);
    if (!bay) throw new Error(`Unknown bay ${fmt(bayNo)}`);
    if (bayNo === bay.foreBay20) return { bay, half: 'fore' };
    if (bayNo === bay.aftBay20) return { bay, half: 'aft' };
    return { bay, half: half || 'both' };
  }

  bayNumberOf(box) {
    const bay = this.bays[box.bayIndex];
    return box.half === 'both' ? bay.bay : box.half === 'fore' ? bay.foreBay20 : bay.aftBay20;
  }

  deckTiers(bay) { return Array.from({ length: bay.tiers }, (_, i) => 82 + i * 2); }
  holdTiers() { return Array.from({ length: SHIP.holdTiers }, (_, i) => 2 + i * 2); }
  isDeckTier(t) { return t >= 80; }

  cell(bayIndex, row, tier, create = false) {
    const rows = this.occ[bayIndex];
    if (!rows.has(row)) { if (!create) return null; rows.set(row, new Map()); }
    const tiers = rows.get(row);
    if (!tiers.has(tier)) { if (!create) return null; tiers.set(tier, { fore: null, aft: null }); }
    return tiers.get(tier);
  }

  validSlot(bay, row, tier) {
    if (tier % 2 !== 0) return false;
    if (tier >= 82) return tier <= 80 + bay.tiers * 2 && bay.rows.some((r) => r.row === row);
    const i = tier / 2 - 1;
    return i >= 0 && i < SHIP.holdTiers && bay.holdRows[i].has(row);
  }

  /* ---------------------------------------------------------------- mutations */

  // spec: { bay, row, tier, type: '20'|'40'|'40HC', weight, category, pod, color, variant, id, half, requireSupport }
  place(spec) {
    const type = spec.type || '40HC';
    const def = CONTAINER_TYPES[type];
    if (!def) throw new Error(`Unknown container type ${type}`);
    let { bay, half } = this.resolve(spec.bay, spec.half);
    if (type !== '20' && half !== 'both') return this.fail(`A ${type} needs an even (40') bay number`);
    if (type === '20' && half === 'both') half = 'fore';
    if (!this.validSlot(bay, spec.row, spec.tier)) return this.fail(`Slot ${this.slotId(bay, half, spec.row, spec.tier)} does not exist`);
    const c = this.cell(bay.index, spec.row, spec.tier, true);
    const halves = half === 'both' ? ['fore', 'aft'] : [half];
    if (halves.some((h) => c[h])) return this.fail(`Slot ${this.slotId(bay, half, spec.row, spec.tier)} is occupied`);
    if (spec.requireSupport !== false && spec.tier !== 82 && spec.tier !== 2) {
      const below = this.cell(bay.index, spec.row, spec.tier - 2);
      if (!below || halves.some((h) => !below[h])) return this.fail(`Nothing to stack on below ${this.slotId(bay, half, spec.row, spec.tier)}`);
      if (type === '20' && below[half] && below[half].type !== '20') return this.fail('A 20\' cannot be stowed on top of a 40\'');
    }
    const category = spec.category || 'dry';
    const weight = Math.min(def.maxGross, Math.max(def.tare, spec.weight ?? def.tare));
    const box = {
      id: spec.id || `C${String(this.nextId++).padStart(5, '0')}`,
      bayIndex: bay.index, half, row: spec.row, tier: spec.tier, type,
      weight: Math.round(weight * 10) / 10,
      category,
      pod: spec.pod || PORTS[0].code,
      color: spec.color || this.randomColor(Math.random),
      variant: spec.variant ?? Math.floor(Math.random() * ATLAS_ROWS),
      shade: spec.shade ?? 0.92 + Math.random() * 0.14,
    };
    halves.forEach((h) => (c[h] = box));
    this.boxes.set(box.id, box);
    this.touch();
    return box;
  }

  remove(spec, { cascade = false } = {}) {
    const { bay, half } = this.resolve(spec.bay, spec.half);
    const c = this.cell(bay.index, spec.row, spec.tier);
    if (!c) return [];
    const targets = new Set(half === 'both' ? [c.fore, c.aft] : [c[half]]);
    targets.delete(null);
    const removed = [];
    for (const box of targets) {
      const above = this.cell(bay.index, spec.row, spec.tier + 2);
      const halves = box.half === 'both' ? ['fore', 'aft'] : [box.half];
      const blockers = new Set(above && this.isDeckTier(spec.tier) === this.isDeckTier(spec.tier + 2) ? halves.map((h) => above[h]).filter(Boolean) : []);
      if (blockers.size) {
        if (!cascade) { this.fail(`Container ${[...blockers][0].id} is stowed on top`); continue; }
        for (const bl of blockers) removed.push(...this.removeById(bl.id, { cascade }));
      }
      if (box.half === 'both') { c.fore = null; c.aft = null; } else c[box.half] = null;
      this.boxes.delete(box.id);
      removed.push(box);
    }
    this.touch();
    return removed;
  }

  removeById(id, opts) {
    const b = this.boxes.get(id);
    return b ? this.remove({ bay: this.bayNumberOf(b), row: b.row, tier: b.tier }, opts) : [];
  }

  topTier(bayNo, row, deck = true) {
    const { bay, half } = this.resolve(bayNo);
    let top = null;
    for (const t of deck ? this.deckTiers(bay) : this.holdTiers()) {
      const c = this.cell(bay.index, row, t);
      if (c && (half === 'both' ? c.fore || c.aft : c[half])) top = t;
    }
    return top;
  }

  clearBay(bayNo, { hold = false } = {}) {
    const { bay } = this.resolve(bayNo);
    for (const box of [...this.boxes.values()]) {
      if (box.bayIndex !== bay.index || (!hold && !this.isDeckTier(box.tier))) continue;
      this.boxes.delete(box.id);
      const c = this.cell(bay.index, box.row, box.tier);
      if (box.half === 'both') { c.fore = null; c.aft = null; } else c[box.half] = null;
    }
    this.touch();
  }

  clear({ hold = false } = {}) {
    if (hold) {
      this.boxes.clear();
      this.occ = this.bays.map(() => new Map());
      this.touch();
    } else this.bays.forEach((b) => this.clearBay(b.bay));
  }

  randomColor(R) {
    const total = CONTAINER_PALETTE.reduce((s, p) => s + p.w, 0);
    let x = R() * total;
    for (const p of CONTAINER_PALETTE) { x -= p.w; if (x <= 0) return p.color; }
    return CONTAINER_PALETTE[0].color;
  }

  /* ---------------------------------------------------------------- geometry */

  // Physical placement of every box in one (bay, row) cell column: hold and deck stacks, bottom-up.
  // Each entry: { box, x (centre), y (bottom, ship-local, m from design WL), h, len, z }
  stackLayout(bayIndex, row) {
    const bay = this.bays[bayIndex];
    const r = bay.rows.find((q) => q.row === row);
    const out = { deck: [], hold: [] };
    const tiers = this.occ[bayIndex].get(row);
    if (!tiers || !r) return out;
    const run = (list, base, target) => {
      let hF = base, hA = base;
      for (const t of list) {
        const c = tiers.get(t);
        if (!c || (!c.fore && !c.aft)) continue;
        const put = (box, x, y0) => {
          const def = CONTAINER_TYPES[box.type];
          target.push({ box, x, y: y0, h: def.height, len: def.length, z: r.z });
          return y0 + def.height + STACK_GAP;
        };
        if (c.fore && c.fore === c.aft) { const y = Math.max(hF, hA); hF = hA = put(c.fore, bay.x, y); }
        else {
          if (c.fore) hF = put(c.fore, bay.x + HALF_OFFSET, hF);
          if (c.aft) hA = put(c.aft, bay.x - HALF_OFFSET, hA);
        }
      }
    };
    run(this.holdTiers(), Y_HOLD, out.hold);
    run(this.deckTiers(bay), Y_CARGO, out.deck);
    return out;
  }

  // All placements (optionally filtered), used by metrics and the profile view.
  placements(filter) {
    const out = [];
    this.bays.forEach((bay, bi) => {
      for (const r of bay.rows) {
        const s = this.stackLayout(bi, r.row);
        for (const p of s.hold) if (!filter || filter(p)) out.push({ ...p, onDeck: false, bay });
        for (const p of s.deck) if (!filter || filter(p)) out.push({ ...p, onDeck: true, bay });
      }
    });
    return out;
  }

  /* ---------------------------------------------------------------- queries */

  slotId(bay, half, row, tier) {
    const bn = half === 'both' ? bay.bay : half === 'fore' ? bay.foreBay20 : bay.aftBay20;
    return `${fmt(bn)}${fmt(row)}${fmt(tier)}`;
  }

  describe(box) {
    const bay = this.bays[box.bayIndex];
    return { ...box, slot: this.slotId(bay, box.half, box.row, box.tier), bayNumber: this.bayNumberOf(box) };
  }

  list() { return [...this.boxes.values()].map((b) => this.describe(b)); }

  get(bayNo, row, tier) {
    const { bay, half } = this.resolve(bayNo);
    const c = this.cell(bay.index, row, tier);
    if (!c) return null;
    const b = half === 'both' ? c.fore || c.aft : c[half];
    return b ? this.describe(b) : null;
  }

  stats() {
    let teu = 0, n = 0, deckTeu = 0;
    for (const b of this.boxes.values()) {
      const t = CONTAINER_TYPES[b.type].teu;
      teu += t; n++;
      if (this.isDeckTier(b.tier)) deckTeu += t;
    }
    const capacity = this.bays.reduce((s, b) => s + b.rowCount * b.tiers * 2, 0);
    return { containers: n, teu, deckTeu, deckCapacityTEU: capacity };
  }

  // Every row that exists anywhere on the ship, starboard outboard -> port outboard.
  allRows() {
    const m = new Map();
    for (const b of this.bays) for (const r of b.rows) m.set(r.row, r.z);
    return [...m.entries()].map(([row, z]) => ({ row, z })).sort((a, b) => b.z - a.z);
  }

  bayInfo() {
    return this.bays.map((b) => ({
      bay: b.bay, bays20: [b.foreBay20, b.aftBay20], rows: b.rows.map((r) => r.row), maxDeckTier: 80 + b.tiers * 2,
      x: b.x, containers: [...this.boxes.values()].filter((q) => q.bayIndex === b.index).length,
    }));
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  fail(msg) { this.lastError = msg; console.warn(`[cargo] ${msg}`); return null; }

  touch() {
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => {
      this.dirty = false;
      this.version++;
      this.rebuild();
      this.listeners.forEach((f) => f(this.stats()));
    });
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this.rebuild();
    this.listeners.forEach((f) => f(this.stats(), { colorOnly: true }));
  }

  /* ---------------------------------------------------------------- rendering */

  rebuild() {
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const counts = { '20': 0, '40': 0, '40HC': 0 };
    for (const m of Object.values(this.meshes)) m.userData.instances = [];
    this.bays.forEach((bay, bi) => {
      for (const r of bay.rows) {
        for (const p of this.stackLayout(bi, r.row).deck) {
          const box = p.box;
          const mesh = this.meshes[box.type];
          const i = counts[box.type]++;
          m4.makeTranslation(p.x, p.y + p.h / 2, p.z);
          mesh.setMatrixAt(i, m4);
          col.set(boxColor(box, this.colorMode)).multiplyScalar((this.colorMode === 'livery' ? box.shade : 1) * (box.id === this.highlightId ? 1.9 : 1));
          mesh.setColorAt(i, col);
          mesh.geometry.attributes.aVariant.setX(i, this.colorMode === 'livery' ? box.variant : 0);
          mesh.userData.instances[i] = box.id;
        }
      }
    });
    for (const [type, mesh] of Object.entries(this.meshes)) {
      mesh.count = counts[type];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.attributes.aVariant.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  pick(raycaster) {
    const hits = raycaster.intersectObjects(Object.values(this.meshes), false);
    if (!hits.length) return null;
    const h = hits[0];
    const box = this.boxes.get(h.object.userData.instances[h.instanceId]);
    return box ? { box: this.describe(box), point: h.point, face: h.face } : null;
  }

  setHighlight(id) {
    if (id === this.highlightId) return;
    this.highlightId = id;
    this.rebuild();
  }
}
