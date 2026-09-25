// Open ocean: displaced Gerstner surface, Kelvin ship wake, bow wave, propeller wash, foam,
// physically based Fresnel/GGX shading and real-time planar reflections of the vessel and sky.
import * as THREE from 'three';
import { WAVES_GLSL, NUM_WAVES } from './waves.js';

const NOISE_GLSL = /* glsl */`
vec3 permute3(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;

const SHIP_WAKE_GLSL = /* glsl */`
uniform float uSpeed;       // ship speed through water (m/s)
uniform float uBowX;        // stem x at waterline
uniform float uSternX;      // transom x
uniform float uHalfBeam;
uniform vec2 uHullX;        // waterline extents (aft, fore)
uniform sampler2D uHullProfile;

float hullDist(vec2 p) {
  float t = (p.x - uHullX.x) / (uHullX.y - uHullX.x);
  float hw = texture2D(uHullProfile, vec2(clamp(t, 0.0, 1.0), 0.5)).r * uHalfBeam;
  float dz = abs(p.y) - hw;
  float dx = max(uHullX.x - p.x, p.x - uHullX.y);
  if (dx > 0.0) return length(vec2(dx, max(dz, 0.0)));
  return dz;
}

// Stationary-phase Kelvin wave pattern from a travelling pressure point.
// tan(theta) = (1 +- sqrt(1 - 8 a^2)) / (4a),  a = y/x;  phase = k0 (x + y tan) sqrt(1 + tan^2)
float kelvin(vec2 p, float originX, float lateralOffset, float amp, float footprint) {
  float d = originX - p.x;
  if (d <= 2.0) return 0.0;
  float y = max(abs(p.y) - lateralOffset, 0.0);
  float k0 = 9.81 / max(uSpeed * uSpeed, 0.25);
  float a = y / d;
  float disc = 1.0 - 8.0 * a * a;
  float inside = smoothstep(-0.35, 0.02, disc);
  if (inside <= 0.0) return 0.0;
  disc = max(disc, 0.0);
  float sq = sqrt(disc);
  float a4 = 4.0 * max(a, 1e-4);
  float tt = (1.0 - sq) / a4;
  float td = (1.0 + sq) / a4;
  float pt = k0 * (d + y * tt) * sqrt(1.0 + tt * tt);
  float pd = k0 * (d + y * td) * sqrt(1.0 + td * td);
  float kt = k0 * (1.0 + tt * tt);
  float kd = k0 * (1.0 + td * td);
  float ft = smoothstep(1.5, 4.0, 6.2832 / kt / footprint);
  float fd = smoothstep(1.5, 4.0, 6.2832 / kd / footprint);
  float cusp = 1.0 / (pow(disc, 0.25) + 0.45);
  float decay = amp / sqrt(1.0 + d / 45.0);
  return (0.5 * cos(pt) * ft + 0.8 * cos(pd) * fd) * cusp * decay * inside;
}

float wakeHeight(vec2 p, float footprint) {
  if (uSpeed < 0.2) return 0.0;
  float amp = 0.0095 * uSpeed * uSpeed;
  float h = kelvin(p, uBowX - 4.0, uHalfBeam * 0.8, amp, footprint);
  h -= kelvin(p, uSternX + 30.0, uHalfBeam * 0.9, amp * 0.45, footprint);
  // bow wave piled against the stem and the trough along the shoulders
  float head = uSpeed * uSpeed / (2.0 * 9.81);
  float dH = hullDist(p);
  float side = exp(-max(dH, 0.0) / 7.0);
  float bx = p.x - uBowX;
  h += 0.5 * head * side * exp(-pow(max(bx, 0.0) / 7.0, 2.0)) * exp(-pow(min(bx, 0.0) / 40.0, 2.0));
  h -= 0.22 * head * side * exp(-pow((bx + 110.0) / 70.0, 2.0));
  return h;
}
`;

const VERT = /* glsl */`
${WAVES_GLSL}
${SHIP_WAKE_GLSL}
uniform vec2 uOffset;
uniform mat4 uTextureMatrix;
varying vec3 vWorld;
varying vec2 vOcean;
varying vec2 vLocal;
varying vec4 vRefl;
varying float vDisp;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float dist = length(wp.xz - cameraPosition.xz);
  float spacing = 5.5 + dist * 0.022;
  vec2 op = wp.xz + uOffset;
  vec3 d = gerstnerDisplace(op, spacing) * (1.0 - smoothstep(2500.0, 7000.0, dist));
  float wh = wakeHeight(wp.xz, spacing) * (1.0 - smoothstep(1800.0, 3500.0, dist));
  vec3 pos = wp.xyz + d + vec3(0.0, wh, 0.0);
  vWorld = pos;
  vOcean = op;
  vLocal = wp.xz;
  vDisp = pos.y;
  vRefl = uTextureMatrix * vec4(wp.x, 0.0, wp.z, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;

const FRAG = /* glsl */`
${WAVES_GLSL}
${SHIP_WAKE_GLSL}
${NOISE_GLSL}
uniform sampler2D uReflection;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform vec3 uSkyAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uDeep;
uniform vec3 uScatter;
uniform vec3 uAerated;
uniform float uPixelAngle;
uniform float uWhitecaps;
uniform vec4 uRipA[12];   // dir.x, dir.z, k, omega
uniform float uRipAmp[12];
varying vec3 vWorld;
varying vec2 vOcean;
varying vec2 vLocal;
varying vec4 vRefl;
varying float vDisp;

const float PI = 3.14159265;

vec2 rippleSlope(vec2 p, float footprint, float calm) {
  vec2 g = vec2(0.0);
  float pat1 = 0.65 + 0.55 * snoise(p * 0.0035 + uTime * 0.004);
  float pat2 = 0.7 + 0.5 * snoise(p * 0.017 - uTime * 0.01);
  for (int i = 0; i < 12; i++) {
    vec4 w = uRipA[i];
    float lam = 6.2832 / w.z;
    float f = smoothstep(1.0, 3.5, lam / footprint);
    float ph = w.z * dot(w.xy, p) - w.w * uTime + float(i) * 2.17;
    g += w.xy * cos(ph) * uRipAmp[i] * f * (i < 6 ? pat1 : pat2);
  }
  // non-periodic micro chop
  float fN = smoothstep(0.6, 2.5, 3.0 / footprint);
  float e = 0.35;
  float n0 = snoise(p * 0.33 + vec2(uTime * 0.12, uTime * 0.05));
  float nx = snoise((p + vec2(e, 0.0)) * 0.33 + vec2(uTime * 0.12, uTime * 0.05));
  float nz = snoise((p + vec2(0.0, e)) * 0.33 + vec2(uTime * 0.12, uTime * 0.05));
  g += vec2(nx - n0, nz - n0) / e * 0.09 * fN * pat2;
  return g * (1.0 - calm * 0.75);
}

float foamTexture(vec2 p, float footprint) {
  float n = snoise(p * 0.07 + vec2(uTime * 0.015, 0.0)) * 0.5
          + snoise(p * 0.23 - vec2(0.0, uTime * 0.04)) * 0.3
          + snoise(p * 0.9 + vec2(uTime * 0.1)) * 0.2 * smoothstep(0.5, 2.0, 2.0 / footprint)
          + snoise(p * 2.7) * 0.12 * smoothstep(0.5, 2.0, 0.7 / footprint);
  return n * 0.5 + 0.5;
}

float ggx(float NdH, float a) {
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

void main() {
  vec3 V = cameraPosition - vWorld;
  float dist = length(V);
  V /= dist;
  float fp = max(dist * uPixelAngle / sqrt(max(abs(V.y), 0.03)), 0.02);

  // ---------- surface normal: swell + wake + ripples
  float jac;
  vec3 N = gerstnerNormal(vOcean, fp, jac);
  float e = max(0.75, fp);
  float h0 = wakeHeight(vLocal, fp);
  float hx = wakeHeight(vLocal + vec2(e, 0.0), fp);
  float hz = wakeHeight(vLocal + vec2(0.0, e), fp);
  vec2 wakeSlope = vec2(hx - h0, hz - h0) / e;

  // ---------- ship-relative foam fields
  float speedF = clamp(uSpeed / 8.0, 0.0, 1.6);
  float dH = hullDist(vLocal);
  float hullBand = exp(-max(dH, 0.0) / 2.2);
  float bowZone = smoothstep(uBowX - 120.0, uBowX - 4.0, vLocal.x);
  float dBow = uBowX - vLocal.x;
  float bowSpread = exp(-max(dH, 0.0) / (3.0 + max(dBow, 0.0) * 0.05)) * smoothstep(uBowX - 190.0, uBowX - 8.0, vLocal.x);
  float foamAmt = hullBand * (0.28 + 0.3 * speedF) + (hullBand * bowZone * 0.9 + bowSpread * 0.55) * speedF;

  float ds = uSternX - vLocal.x;
  float core = 0.0, aer = 0.0, calm = 0.0;
  if (ds > -25.0) {
    float dsp = max(ds, 0.0);
    float w = uHalfBeam * 0.5 + dsp * 0.085;
    core = exp(-pow(vLocal.y / w, 2.0) * 1.7) * smoothstep(-25.0, 6.0, ds);
    foamAmt += core * exp(-dsp / (110.0 + 360.0 * speedF)) * (0.35 + 0.9 * speedF);
    aer = core * exp(-dsp / (450.0 + 1100.0 * speedF)) * min(speedF * 1.3, 1.0);
    calm = core * exp(-dsp / 2600.0) * min(speedF, 1.0);
  }
  float yl = max(abs(vLocal.y) - uHalfBeam * 0.8, 0.0);
  float r = yl / (max(dBow, 1.0) * 0.3536);
  foamAmt += exp(-pow((r - 1.0) * 12.0, 2.0)) * exp(-max(dBow, 0.0) / 260.0) * speedF * 0.45 * step(0.0, dBow);
  float whitecap = smoothstep(0.78, 0.25, jac) * uWhitecaps * (1.0 - calm);
  foamAmt += whitecap;
  foamAmt = clamp(foamAmt, 0.0, 1.2);

  vec2 slope = rippleSlope(vOcean, fp, calm + clamp(foamAmt, 0.0, 1.0) * 0.4);
  N = normalize(vec3(N.x - wakeSlope.x - slope.x, N.y, N.z - wakeSlope.y - slope.y));

  float ft = foamTexture(vOcean, fp);
  float farFade = smoothstep(4.0, 20.0, fp);
  float foam = mix(smoothstep(1.0 - foamAmt * 0.85, 1.12 - foamAmt * 0.85, ft) * min(foamAmt * 1.6, 1.0), foamAmt * 0.45, farFade);
  foam = clamp(foam, 0.0, 1.0);

  // ---------- lighting
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  F = mix(F, 0.02, foam);

  vec2 ruv = vRefl.xy / vRefl.w;
  ruv += N.xz * 0.05 / (1.0 + dist * 0.0015);
  vec3 refl = texture2D(uReflection, clamp(ruv, 0.001, 0.999)).rgb;

  vec3 L = uSunDir;
  float sunUp = max(L.y, 0.0);
  vec3 ambient = uSkyAmbient;
  vec3 body = uDeep * (ambient * 0.9 + uSunColor * 0.04 * sunUp);
  // light transmitted through wave crests (subsurface scattering)
  float crest = clamp(vDisp * 0.6 + 0.35, 0.0, 1.6);
  float back = pow(max(dot(-V, normalize(vec3(L.x, 0.0, L.z) + vec3(0.0, 0.15, 0.0))), 0.0), 3.0);
  body += uScatter * (uSunColor * (0.012 + 0.05 * back) * crest + ambient * 0.12 * crest);
  body = mix(body, uAerated * (ambient * 0.8 + uSunColor * 0.06 * sunUp), aer * 0.85);

  vec3 col = mix(body, refl, F);

  float rough = mix(0.075, 0.24, smoothstep(0.3, 6.0, fp));
  vec3 H = normalize(L + V);
  float NdL = max(dot(N, L), 0.0);
  float spec = ggx(max(dot(N, H), 0.0), rough * rough) * NdL * (0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0)) / (4.0 * max(NdV, 0.1));
  col += uSunColor * min(spec, 60.0) * (1.0 - foam);

  vec3 Hm = normalize(uMoonDir + V);
  float NdLm = max(dot(N, uMoonDir), 0.0);
  float specM = ggx(max(dot(N, Hm), 0.0), 0.028) * NdLm * (0.02 + 0.98 * pow(1.0 - max(dot(Hm, V), 0.0), 5.0)) / (4.0 * max(NdV, 0.1));
  col += uMoonColor * min(specM, 40.0) * (1.0 - foam);

  vec3 foamCol = vec3(0.92, 0.95, 0.96) * (ambient * 1.1 + uSunColor * (0.08 + 0.22 * max(dot(N, L), 0.0)) * sunUp + uMoonColor * 0.15);
  col = mix(col, foamCol, foam);

  float fog = 1.0 - exp(-dist * uFogDensity);
  col = mix(col, uFogColor, fog * 0.85);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Non-uniform radial-ish grid: ~5.5 m spacing near the camera, stretching out to ~30 km.
function buildOceanGeometry(N = 512) {
  const f = (u) => Math.sign(u) * (1500 * Math.abs(u) + 30000 * Math.pow(Math.abs(u), 4));
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  let k = 0;
  for (let j = 0; j <= N; j++) {
    const z = f(j / N * 2 - 1);
    for (let i = 0; i <= N; i++) {
      pos[k++] = f(i / N * 2 - 1); pos[k++] = 0; pos[k++] = z;
    }
  }
  const idx = new Uint32Array(N * N * 6);
  k = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

class PlanarReflection {
  constructor(scale = 0.5) {
    this.scale = scale;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 });
    this.camera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
    this._v = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._n = new THREE.Vector3(0, 1, 0);
  }

  setSize(w, h) { this.rt.setSize(Math.max(1, Math.round(w * this.scale)), Math.max(1, Math.round(h * this.scale))); }

  render(renderer, scene, camera) {
    const n = this._n, cam = this.camera;
    const camPos = this._v.setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y < 0) return;
    const view = new THREE.Vector3(camPos.x, -camPos.y, camPos.z); // camera mirrored about y = 0
    this._rot.extractRotation(camera.matrixWorld);
    this._look.set(0, 0, -1).applyMatrix4(this._rot).add(camPos);
    this._target.set(this._look.x, -this._look.y, this._look.z);
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(this._rot);
    cam.up.y *= -1;
    cam.lookAt(this._target);
    cam.far = camera.far; cam.near = camera.near;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);

    // oblique near plane: clip everything below the water plane
    this._plane.setFromNormalAndCoplanarPoint(n, new THREE.Vector3(0, -0.4, 0));
    this._plane.applyMatrix4(cam.matrixWorldInverse);
    const clip = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const p = cam.projectionMatrix.elements;
    const q = this._q;
    q.x = (Math.sign(clip.x) + p[8]) / p[0];
    q.y = (Math.sign(clip.y) + p[9]) / p[5];
    q.z = -1.0;
    q.w = (1.0 + p[10]) / p[14];
    clip.multiplyScalar(2.0 / clip.dot(q));
    p[2] = clip.x; p[6] = clip.y; p[10] = clip.z + 1.0; p[14] = clip.w;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT);
  }
}

export class Ocean {
  constructor({ waves, hullProfile, ship }) {
    this.waves = waves;
    this.reflection = new PlanarReflection(0.5);
    const profTex = new THREE.DataTexture(hullProfile.data, hullProfile.data.length, 1, THREE.RedFormat, THREE.UnsignedByteType);
    profTex.magFilter = profTex.minFilter = THREE.LinearFilter;
    profTex.needsUpdate = true;

    // capillary / short gravity ripples for the detail normal
    const rip = [], ripAmp = [];
    for (let i = 0; i < 12; i++) {
      const lambda = 9.5 * Math.pow(0.72, i);
      const k = 2 * Math.PI / lambda;
      const a = THREE.MathUtils.degToRad(waves.windDirDeg + (i % 2 ? 1 : -1) * (15 + i * 9 % 50));
      rip.push(new THREE.Vector4(Math.cos(a), Math.sin(a), k, Math.sqrt(9.81 * k + 0.074 * k * k * k / 1000)));
      ripAmp.push(0.075 * (i < 4 ? 1.1 : 0.9));
    }

    this.uniforms = {
      uTime: { value: 0 },
      uWaveA: { value: Array.from({ length: NUM_WAVES }, () => new THREE.Vector4()) },
      uWaveB: { value: Array.from({ length: NUM_WAVES }, () => new THREE.Vector4()) },
      uOffset: { value: new THREE.Vector2() },
      uTextureMatrix: { value: this.reflection.textureMatrix },
      uReflection: { value: this.reflection.rt.texture },
      uSpeed: { value: 6 },
      uBowX: { value: ship.bowX },
      uSternX: { value: ship.sternX },
      uHalfBeam: { value: ship.halfBeam },
      uHullX: { value: new THREE.Vector2(hullProfile.xAft, hullProfile.xFore) },
      uHullProfile: { value: profTex },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(5, 5, 5) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonColor: { value: new THREE.Color(0, 0, 0) },
      uSkyAmbient: { value: new THREE.Color(0.4, 0.5, 0.7) },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogDensity: { value: 0.00004 },
      uDeep: { value: new THREE.Color(0.012, 0.05, 0.095) },
      uScatter: { value: new THREE.Color(0.05, 0.3, 0.3) },
      uAerated: { value: new THREE.Color(0.12, 0.34, 0.36) },
      uPixelAngle: { value: 0.001 },
      uWhitecaps: { value: 0.35 },
      uRipA: { value: rip },
      uRipAmp: { value: ripAmp },
    };
    this.syncWaves();

    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });
    this.mesh = new THREE.Mesh(buildOceanGeometry(512), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;

    this.spray = new BowSpray(ship);
  }

  syncWaves() {
    this.waves.uniformA.forEach((a, i) => this.uniforms.uWaveA.value[i].fromArray(a));
    this.waves.uniformB.forEach((b, i) => this.uniforms.uWaveB.value[i].fromArray(b));
    this.uniforms.uWhitecaps.value = THREE.MathUtils.clamp((this.waves.seaState - 0.6) * 0.5, 0, 0.8);
  }

  setSize(w, h, camera) {
    this.reflection.setSize(w, h);
    this.uniforms.uPixelAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / h;
  }

  update(dt, t, camera, { offset, speed, env }) {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uOffset.value.set(offset.x, offset.y);
    u.uSpeed.value = speed;
    this.mesh.position.set(Math.round(camera.position.x / 16) * 16, 0, Math.round(camera.position.z / 16) * 16);
    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(env.sunColor);
    u.uMoonDir.value.copy(env.moonDir);
    u.uMoonColor.value.copy(env.moonColor);
    u.uSkyAmbient.value.copy(env.skyAmbient);
    u.uFogColor.value.copy(env.fogColor);
    this.spray.update(dt, speed, env);
  }

  renderReflection(renderer, scene, camera, hide = []) {
    this.mesh.visible = false;
    hide.forEach((o) => (o.visible = false));
    this.reflection.render(renderer, scene, camera);
    this.mesh.visible = true;
    hide.forEach((o) => (o.visible = true));
  }
}

// Spray and spindrift thrown off the stem.
class BowSpray {
  constructor(ship) {
    this.count = 900;
    this.ship = ship;
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    this.maxLife = new Float32Array(this.count);
    this.size = new Float32Array(this.count);
    this.alpha = new Float32Array(this.count);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uScale: { value: 800 } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / -mv.z; vA = aAlpha; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vA;
        void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
          gl_FragColor = vec4(uColor, vA * smoothstep(0.25, 0.0, d));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.acc = 0;
  }

  update(dt, speed, env) {
    const c = this.material.uniforms.uColor.value;
    c.copy(env.skyAmbient).multiplyScalar(1.2).add(new THREE.Color().copy(env.sunColor).multiplyScalar(0.25 * Math.max(env.sunDir.y, 0)));
    const rate = Math.max(0, speed - 1.5) * 32;
    this.acc += rate * dt;
    const bowX = this.ship.bowX;
    for (let i = 0; i < this.count && this.acc >= 1; i++) {
      if (this.life[i] > 0) continue;
      this.acc -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      const along = Math.random() * 30;
      this.pos[i * 3] = bowX - 3 - along;
      this.pos[i * 3 + 1] = 0.3 + Math.random() * 1.2;
      this.pos[i * 3 + 2] = side * (1.5 + along * 0.35 + Math.random());
      const s = speed / 8;
      this.vel[i * 3] = -speed * (0.6 + Math.random() * 0.3);
      this.vel[i * 3 + 1] = (1.5 + Math.random() * 3.5) * s;
      this.vel[i * 3 + 2] = side * (1.5 + Math.random() * 3) * s;
      this.maxLife[i] = this.life[i] = 0.9 + Math.random() * 1.4;
      this.size[i] = 0.4 + Math.random() * 1.2;
    }
    this.acc = Math.min(this.acc, 50);
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9.81 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < -0.2) this.life[i] = 0;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.max(0, Math.min(1, t * 2)) * 0.55;
      this.size[i] += dt * 1.2;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}
