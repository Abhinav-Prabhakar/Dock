// Seakeeping model: the hull's waterplane samples the same Gerstner field that is rendered, and
// heave / pitch / roll respond as damped oscillators with realistic natural periods for the active hull
// (tuned on the 366 m reference hull; heave/pitch periods scale with √L like any wave-following hull, roll comes from GM).
// Long hulls average out short waves, so motions stay small and slow — as they do in reality.
import { SHIP } from './config.js';
import { halfBreadth } from './ship.js';

const KNOT = 0.514444;

class Oscillator {
  constructor(period, damping) { this.w = (2 * Math.PI) / period; this.z = damping; this.x = 0; this.v = 0; }
  step(target, dt) {
    const a = this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

export class ShipMotion {
  constructor(waves) {
    this.waves = waves;
    const kP = Math.sqrt(SHIP.L / 366);
    this.heave = new Oscillator(9.5 * kP, 0.28);
    this.pitch = new Oscillator(8.5 * kP, 0.3);
    this.roll = new Oscillator(23, 0.06);
    this.yaw = new Oscillator(60, 0.5);
    this.speed = 0;               // m/s through the water
    this.targetKnots = 12;
    this.distance = 0;            // along-track distance travelled (m)
    this.time = 0;
    // waterplane sample points, weighted by local breadth
    this.samples = [];
    const nx = 13, nz = 5;
    for (let i = 0; i < nx; i++) {
      const x = -SHIP.L / 2 + 8 + (i / (nx - 1)) * (SHIP.L - 22);
      const hb = halfBreadth(x, SHIP.T);
      for (let j = 0; j < nz; j++) {
        const z = (j / (nz - 1) * 2 - 1) * hb * 0.9;
        this.samples.push({ x, z, w: hb });
      }
    }
    const sw = this.samples.reduce((s, p) => s + p.w, 0);
    this.xc = this.samples.reduce((s, p) => s + p.x * p.w, 0) / sw;
    this.state = { heave: 0, pitch: 0, roll: 0, yaw: 0, speed: 0 };
    this.static = { sinkage: 0, pitch: 0, roll: 0 };
    this.staticTarget = { sinkage: 0, pitch: 0, roll: 0 };
  }

  // Loading condition from the metrics engine: equilibrium sinkage, trim, list and roll period.
  setStatic({ sinkage, pitch, roll, rollPeriod }) {
    Object.assign(this.staticTarget, { sinkage, pitch, roll });
    if (rollPeriod) this.roll.w = (2 * Math.PI) / rollPeriod;
  }

  setSpeedKnots(k) { this.targetKnots = k; }

  update(dt) {
    dt = Math.min(dt, 0.1);
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.time += h;
      // big ships change speed slowly
      const target = this.targetKnots * KNOT;
      this.speed += (target - this.speed) * Math.min(1, h / 9);
      this.distance += this.speed * h;
    }
    // wave forcing from the hull's waterplane (evaluated once per frame)
    let sw = 0, sh = 0, sxh = 0, sxx = 0, szh = 0, szz = 0;
    const t = this.time, ox = this.distance;
    for (const p of this.samples) {
      const hgt = this.waves.heightAt(p.x + ox, p.z, t);
      const dx = p.x - this.xc;
      sw += p.w; sh += p.w * hgt;
      sxh += p.w * dx * hgt; sxx += p.w * dx * dx;
      szh += p.w * p.z * hgt; szz += p.w * p.z * p.z;
    }
    const st0 = this.static, stT = this.staticTarget, ease = Math.min(1, dt / 2.5);
    for (const k of ['sinkage', 'pitch', 'roll']) st0[k] += (stT[k] - st0[k]) * ease;
    const kn = this.speed / KNOT;
    const squat = -0.0012 * kn * kn;
    const trim = -0.00001 * kn * kn;             // slight trim by the stern at speed
    const heaveT = sh / sw + squat + st0.sinkage;
    const pitchT = Math.atan(sxh / sxx) + trim + st0.pitch;
    const rollT = -Math.atan(szh / szz) * 0.8 + st0.roll;
    for (let s = 0; s < steps; s++) {
      this.heave.step(heaveT, h);
      this.pitch.step(pitchT, h);
      this.roll.step(rollT, h);
      this.yaw.step(0.0025 * Math.sin(t * 0.07) + 0.4 * this.roll.x * 0.05, h);
    }
    const st = this.state;
    st.heave = this.heave.x; st.pitch = this.pitch.x; st.roll = this.roll.x; st.yaw = this.yaw.x; st.speed = this.speed;
    return st;
  }

  apply(group) {
    group.position.set(0, this.heave.x, 0);
    group.rotation.set(this.roll.x, this.yaw.x, this.pitch.x);
  }
}
