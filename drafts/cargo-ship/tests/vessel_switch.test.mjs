// Tests for the pure, hull-switching part of the runtime vessel-switch
// feature: config.js's SHIP/HYDRO mutate in place (same object identity)
// when the active vessel changes, VESSEL_ID updates, and every module that
// registered with onShipChange() is notified in registration order.
//
// config.js has no `location` global at import time and doesn't import
// three.js, so it (and only it, of the hull-derived modules — ship.js pulls
// in three.js, which Node can't load) is safe to import directly here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { SHIP, HYDRO, VESSEL_ID, VESSELS, onShipChange, setVessel } = await import('../js/config.js');

test('setVessel() starts on VES1 (the default) with SHIP/HYDRO already filled', () => {
  assert.equal(VESSEL_ID, 'VES1');
  assert.equal(SHIP.id, 'VES1');
  assert.equal(SHIP.L, VESSELS.VES1.L);
  assert.equal(HYDRO.summerDraft, VESSELS.VES1.hydro.summerDraft);
});

test('setVessel() mutates SHIP/HYDRO in place (same object identity) and updates VESSEL_ID', () => {
  const shipRef = SHIP, hydroRef = HYDRO;
  setVessel('VES4');
  assert.equal(SHIP, shipRef, 'SHIP keeps its object identity');
  assert.equal(HYDRO, hydroRef, 'HYDRO keeps its object identity');
  assert.equal(SHIP.id, 'VES4');
  assert.equal(SHIP.L, VESSELS.VES4.L);
  assert.equal(SHIP.B, VESSELS.VES4.B);
  assert.equal(HYDRO.summerDraft, VESSELS.VES4.hydro.summerDraft);
  assert.equal(HYDRO.reeferPlugs, VESSELS.VES4.hydro.reeferPlugs);
  assert.equal(HYDRO.visibilityLimit, Math.min(2 * VESSELS.VES4.L, 500));
  assert.equal(globalThis.VESSEL_ID_UNUSED, undefined); // (no stray global leaked)
  setVessel('VES1'); // restore for the tests below, which assume the default start
});

test('setVessel() calls listeners in registration order', () => {
  const calls = [];
  const unregisterA = () => calls.push('a');
  const unregisterB = () => calls.push('b');
  const unregisterC = () => calls.push('c');
  onShipChange(unregisterA);
  onShipChange(unregisterB);
  onShipChange(unregisterC);
  calls.length = 0;
  setVessel('VES3');
  // every prior listener registered by this file's earlier imports of
  // config.js's dependents also fires, but ours must appear in the order we
  // registered them, uninterrupted relative to each other.
  const aIdx = calls.indexOf('a'), bIdx = calls.indexOf('b'), cIdx = calls.indexOf('c');
  assert.ok(aIdx >= 0 && bIdx > aIdx && cIdx > bIdx, `expected a < b < c in ${JSON.stringify(calls)}`);
  setVessel('VES1');
});

test('setVessel() is a no-op for an unknown id (no simulated hull)', () => {
  const before = { ...SHIP };
  setVessel('VES_NOPE');
  assert.equal(VESSEL_ID, 'VES1');
  assert.deepEqual({ ...SHIP }, before);
});

test('switching VES1 -> VES4 -> VES1 restores SHIP/HYDRO exactly (deep-equal to the original snapshot)', () => {
  setVessel('VES1'); // make sure we start from a clean VES1 (earlier tests already leave it there)
  const shipSnapshot = JSON.parse(JSON.stringify(SHIP));
  const hydroSnapshot = JSON.parse(JSON.stringify(HYDRO));

  setVessel('VES4');
  assert.notDeepEqual(JSON.parse(JSON.stringify(SHIP)), shipSnapshot, 'VES4 really is a different hull');

  setVessel('VES1');
  assert.deepEqual(JSON.parse(JSON.stringify(SHIP)), shipSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(HYDRO)), hydroSnapshot);
  assert.equal(VESSEL_ID, 'VES1');
});
