// Gerstner wave field shared by the GPU ocean surface and the CPU buoyancy solver.
// One definition -> the ship floats on exactly the water that is rendered.

export const G = 9.81;
export const NUM_WAVES = 8;

// wavelength (m), amplitude (m), direction offset from wind (deg), steepness 0..1
const SPECTRUM = [
  [236, 0.80, 28, 0.20],   // long swell: drives the slow heave / roll of the hull
  [148, 0.52, -16, 0.30],
  [96, 0.36, 9, 0.42],
  [63, 0.25, -31, 0.50],
  [42, 0.17, 38, 0.55],
  [28, 0.11, -12, 0.60],
  [19, 0.07, 21, 0.60],
  [12.5, 0.045, -42, 0.60],
];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WaveField {
  constructor({ windDirDeg = 140, seaState = 1 } = {}) {
    this.windDirDeg = windDirDeg;
    this.seaState = seaState;
    this.waves = [];
    this.uniformA = Array.from({ length: NUM_WAVES }, () => [0, 0, 0, 0]);
    this.uniformB = Array.from({ length: NUM_WAVES }, () => [0, 0, 0, 0]);
    this.build();
  }

  build() {
    const rnd = mulberry32(7);
    this.waves = SPECTRUM.map(([lambda, amp, off, steep]) => {
      const k = (2 * Math.PI) / lambda;
      const omega = Math.sqrt(G * k); // deep-water dispersion relation
      const a = ((this.windDirDeg + off) * Math.PI) / 180;
      const A = amp * this.seaState;
      const Q = A > 0 ? Math.min(1, steep / (k * A * NUM_WAVES)) : 0;
      return { lambda, k, omega, dx: Math.cos(a), dz: Math.sin(a), A, Q, phase: rnd() * Math.PI * 2 };
    });
    this.waves.forEach((w, i) => {
      this.uniformA[i] = [w.dx, w.dz, w.k, w.omega];
      this.uniformB[i] = [w.A, w.Q, w.phase, w.lambda];
    });
  }

  setSeaState(s) { this.seaState = s; this.build(); }

  // Displacement of an undisplaced surface point (x, z) at time t.
  displacement(x, z, t, out = { x: 0, y: 0, z: 0 }) {
    out.x = 0; out.y = 0; out.z = 0;
    for (const w of this.waves) {
      const th = w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase;
      const c = Math.cos(th), s = Math.sin(th);
      out.x += w.Q * w.A * w.dx * c;
      out.z += w.Q * w.A * w.dz * c;
      out.y += w.A * s;
    }
    return out;
  }

  // Surface elevation at world (x, z): invert the horizontal Gerstner shift by fixed-point iteration.
  heightAt(x, z, t) {
    const d = { x: 0, y: 0, z: 0 };
    let px = x, pz = z;
    for (let i = 0; i < 4; i++) {
      this.displacement(px, pz, t, d);
      px = x - d.x; pz = z - d.z;
    }
    return this.displacement(px, pz, t, d).y;
  }
}

export const WAVES_GLSL = /* glsl */`
#define NW ${NUM_WAVES}
uniform vec4 uWaveA[NW]; // dir.x, dir.z, k, omega
uniform vec4 uWaveB[NW]; // amplitude, Q, phase, wavelength
uniform float uTime;

// lodSpacing: approximate mesh spacing (m) at this vertex; waves shorter than ~4 samples fade out.
vec3 gerstnerDisplace(vec2 p, float lodSpacing) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < NW; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    float f = smoothstep(2.5, 5.0, b.w / lodSpacing);
    float th = a.z * dot(a.xy, p) - a.w * uTime + b.z;
    float A = b.x * f;
    float c = cos(th);
    d.xz += b.y * A * a.xy * c;
    d.y += A * sin(th);
  }
  return d;
}

// Analytic normal + horizontal Jacobian (J < 1 => crest compression, used for whitecaps)
vec3 gerstnerNormal(vec2 p, float footprint, out float jac) {
  float nx = 0.0, nz = 0.0, ny = 0.0, jxx = 0.0, jzz = 0.0, jxz = 0.0;
  for (int i = 0; i < NW; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    float f = smoothstep(1.0, 4.0, b.w / footprint);
    float th = a.z * dot(a.xy, p) - a.w * uTime + b.z;
    float c = cos(th), s = sin(th);
    float wa = a.z * b.x * f;
    nx += a.x * wa * c;
    nz += a.y * wa * c;
    float qs = b.y * wa * s;
    ny += qs;
    jxx += qs * a.x * a.x;
    jzz += qs * a.y * a.y;
    jxz += qs * a.x * a.y;
  }
  jac = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
  return normalize(vec3(-nx, 1.0 - ny, -nz));
}
`;
