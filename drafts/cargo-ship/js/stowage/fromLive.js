// Pure adapter: turn the backend's live per-vessel stowage snapshot into
// cargo.place() specs for this ship's physical bay layout. No mock data —
// every count, weight, discharge port and cargo type traces back to a real
// unit aboard the backend's `aboard` lists; only the *arrangement* onto this
// hull's cells is a deterministic, order-preserving resample (the backend
// models 64 generic bays at whatever TEU height fits its capacity, this ship
// has a fixed physical layout, so cargo is proportionally redistributed).
//
// No DOM, no three.js — safe to unit-test in Node against real API responses.

const CATEGORY_MAP = { dry: 'dry', reefer: 'reefer', hazmat: 'imdg' };

// Hold cells for one physical bay, ordered tier bottom -> top, then rows
// centreline-out (|z| ascending, tie-broken by row number).
function holdCellsFor(bay, holdTiers) {
  const rowZ = new Map(bay.rows.map((r) => [r.row, r.z]));
  const cells = [];
  for (let i = 0; i < holdTiers; i++) {
    const rowsAtTier = bay.holdRows && bay.holdRows[i];
    if (!rowsAtTier) continue;
    const tier = 2 + i * 2;
    const rows = [...rowsAtTier].sort((a, b) => {
      const za = Math.abs(rowZ.get(a) ?? 0), zb = Math.abs(rowZ.get(b) ?? 0);
      return za - zb || a - b;
    });
    for (const row of rows) cells.push({ tier, row });
  }
  return cells;
}

// Deck cells for one physical bay, ordered tier bottom -> top (82, 84, ...),
// then rows centreline-out.
function deckCellsFor(bay) {
  const rows = [...bay.rows].sort((a, b) => Math.abs(a.z) - Math.abs(b.z) || a.row - b.row);
  const cells = [];
  for (let i = 0; i < bay.tiers; i++) {
    const tier = 82 + i * 2;
    for (const r of rows) cells.push({ tier, row: r.row });
  }
  return cells;
}

// Place units two-at-a-time onto a cell list: a matching pair (same
// discharge + cargo_type) becomes one 40'/40HC box spanning the 40' bay
// number; otherwise each unit becomes its own 20' in the fore/aft half.
function placeUnits(bay, cells, units, specs) {
  let shown = 0;
  let ui = 0;
  for (const cell of cells) {
    if (ui >= units.length) break;
    const a = units[ui];
    const b = units[ui + 1];
    if (b && a.discharge === b.discharge && a.cargo_type === b.cargo_type) {
      specs.push({
        bay: bay.bay, row: cell.row, tier: cell.tier,
        type: a.cargo_type === 'reefer' ? '40HC' : '40',
        weight: a.weight_t + b.weight_t,
        category: CATEGORY_MAP[a.cargo_type] || 'dry',
        pod: a.discharge, requireSupport: false,
        // debug-only: not read by cargo.place(), kept so tests (and any
        // future stowage tooling) can verify bottom-to-top discharge order
        // without re-deriving it from the port code alone.
        _dischargeCall: a.discharge_call,
      });
      shown += 2;
      ui += 2;
    } else {
      specs.push({
        bay: bay.foreBay20, row: cell.row, tier: cell.tier, type: '20',
        weight: a.weight_t, category: CATEGORY_MAP[a.cargo_type] || 'dry',
        pod: a.discharge, requireSupport: false,
        _dischargeCall: a.discharge_call,
      });
      shown += 1;
      ui += 1;
      if (b) {
        specs.push({
          bay: bay.aftBay20, row: cell.row, tier: cell.tier, type: '20',
          weight: b.weight_t, category: CATEGORY_MAP[b.cargo_type] || 'dry',
          pod: b.discharge, requireSupport: false,
          _dischargeCall: b.discharge_call,
        });
        shown += 1;
        ui += 1;
      }
    }
  }
  return shown;
}

// stow: /api/live/vessels/{id}/stowage response.
// bays: this ship's physical bay layout (ship.layout.bays / cargo.bays) —
//   [{ index, bay, foreBay20, aftBay20, tiers, rows:[{row,z}], holdRows:[Set|array] }]
// holdTiers: number of below-deck tier levels (SHIP.holdTiers).
export function layoutFromStowage(stow, bays, holdTiers) {
  const specs = [];
  const P = bays.length;
  const B = stow.bays.length;
  let shownTEU = 0;
  let totalCapacity = 0;

  const groups = Array.from({ length: P }, () => []);
  for (let b = 0; b < B; b++) {
    const j = Math.min(P - 1, Math.floor((b * P) / B));
    groups[j].push(b);
  }

  for (let j = 0; j < P; j++) {
    const bay = bays[j];
    const backendIdx = groups[j];
    const holdCells = holdCellsFor(bay, holdTiers);
    const deckCells = deckCellsFor(bay);
    const cap = 2 * (holdCells.length + deckCells.length);
    totalCapacity += cap;
    if (backendIdx.length === 0 || cap === 0) continue;

    let units = [];
    for (const b of backendIdx) {
      const bb = stow.bays[b];
      if (bb && Array.isArray(bb.aboard)) units = units.concat(bb.aboard);
    }
    if (units.length === 0) continue;

    // stable sort: discharge_call desc, then weight_t desc (bottom of stack first)
    units = units
      .map((u, i) => ({ u, i }))
      .sort((x, y) => (y.u.discharge_call - x.u.discharge_call) || (y.u.weight_t - x.u.weight_t) || (x.i - y.i))
      .map((x) => x.u);

    const f = units.length / (backendIdx.length * stow.bay_height);
    // Capped at units.length: a real container is never drawn twice. On a
    // small vessel (its real per-bay-group capacity « this fixed hull's),
    // f * cap can exceed the number of real units aboard — the honest
    // choice is to show that group less full than its real fill fraction,
    // not to fabricate repeated containers just to fill the model hull.
    const T = Math.min(Math.round(f * cap), units.length);
    if (T <= 0) continue;

    const resampled = [];
    for (let k = 0; k < T; k++) {
      const idx = Math.min(units.length - 1, Math.floor((k * units.length) / T));
      resampled.push(units[idx]);
    }

    const holdCount = Math.round(T * (holdCells.length / (holdCells.length + deckCells.length)));
    const holdUnits = resampled.slice(0, holdCount);
    const deckUnits = resampled.slice(holdCount);

    shownTEU += placeUnits(bay, holdCells, holdUnits, specs);
    shownTEU += placeUnits(bay, deckCells, deckUnits, specs);
  }

  return {
    specs,
    summary: {
      aboardTEU: stow.aboard_teu,
      shownTEU,
      fill: totalCapacity > 0 ? shownTEU / totalCapacity : 0,
    },
  };
}
